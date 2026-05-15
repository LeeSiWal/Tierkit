import type { FreedomLevel, PluginManifest } from "../../plugin/PluginManifest.js";
import type { RunMode } from "../../context/TaskContextBuilder.js";
import type { ExecutionSession } from "./ExecutionSession.js";

/**
 * Return the strictest freedom level across installed+active plugins. If no plugins are
 * active (or `activePlugins` is empty), returns `"free"` — i.e. no enforcement.
 *
 * Strictness order: strict > balanced > guided > free.
 */
export function resolveEffectiveFreedom(
  activePluginIds: string[],
  installedManifestsById: Map<string, PluginManifest>,
): FreedomLevel {
  const order: Record<FreedomLevel, number> = { free: 0, guided: 1, balanced: 2, strict: 3 };
  let best: FreedomLevel = "free";
  for (const id of activePluginIds) {
    const m = installedManifestsById.get(id);
    if (!m) continue;
    if (order[m.freedom.level] > order[best]) best = m.freedom.level;
  }
  return best;
}

export interface GateInput {
  freedom: FreedomLevel;
  mode: RunMode;
  session?: ExecutionSession;
  /** Hint forwarded from the caller; balanced gates multi-file execute. */
  multiFile: boolean;
}

export interface GateResult {
  allowed: boolean;
  /** Hint surfaced when allowed=true; lets callers warn even when not blocking (guided). */
  warning?: string;
  /** Stable code for tests and scripting (`no-session`, `plan-not-approved`, `wrong-state`, ...). */
  code?: string;
  reason?: string;
}

/**
 * Decide whether a `route run` invocation should proceed given the current session state
 * and the active plugins' effective freedom level.
 *
 * Rules (alpha v1.2):
 * - `free`     — always allowed, no warning.
 * - `guided`   — always allowed; attaches a soft warning when called without a session.
 * - `balanced` — `mode=execute` + multi-file: block unless there's an active session in
 *                `implementing`. `mode=plan` and `mode=review` always allowed.
 * - `strict`   — `mode=execute` requires `state=implementing` AND `planApproved=true`.
 *                `mode=review` requires `state=reviewing` (or `implementing`).
 *                `mode=plan` requires `state=planning`. Otherwise block.
 */
export function checkSessionGate(input: GateInput): GateResult {
  const { freedom, mode, session, multiFile } = input;

  if (freedom === "free") return { allowed: true };

  if (freedom === "guided") {
    if (!session && mode !== "plan") {
      return {
        allowed: true,
        warning: `guided plugin active but no session — consider \`tierkit session start "<task>"\` first`,
      };
    }
    return { allowed: true };
  }

  // Session required:
  //  - strict: always
  //  - balanced: only when the request is multi-file execute (the case the rule actually targets)
  const balancedNeedsSession = freedom === "balanced" && mode === "execute" && multiFile;
  if (!session) {
    if (freedom === "strict") {
      return {
        allowed: false,
        code: "no-session",
        reason: `freedom level "strict" requires an active session. Run \`tierkit session start "<task>"\`.`,
      };
    }
    if (balancedNeedsSession) {
      return {
        allowed: false,
        code: "no-session",
        reason: `freedom level "balanced" refuses multi-file execute without a session. Run \`tierkit session start "<task>"\` and \`tierkit session advance implementing\` first.`,
      };
    }
    // balanced + single-file / plan / review without session → fine
    return { allowed: true };
  }

  if (session.state === "abandoned" || session.state === "done") {
    return {
      allowed: false,
      code: "session-closed",
      reason: `session "${session.id}" is ${session.state}. Start a new one with \`tierkit session start "<task>"\`.`,
    };
  }

  if (freedom === "balanced") {
    if (mode === "execute" && multiFile && session.state !== "implementing") {
      return {
        allowed: false,
        code: "wrong-state",
        reason: `balanced: multi-file execute requires session.state="implementing" (current: "${session.state}"). Run \`tierkit session advance implementing\` after planning.`,
      };
    }
    return { allowed: true };
  }

  // strict
  if (mode === "plan" && session.state !== "planning") {
    return {
      allowed: false,
      code: "wrong-state",
      reason: `strict: --mode plan requires session.state="planning" (current: "${session.state}").`,
    };
  }
  if (mode === "execute") {
    if (!session.planApproved) {
      return {
        allowed: false,
        code: "plan-not-approved",
        reason: `strict: --mode execute requires the plan to be approved. Run \`tierkit session approve-plan\` first.`,
      };
    }
    if (session.state !== "implementing") {
      return {
        allowed: false,
        code: "wrong-state",
        reason: `strict: --mode execute requires session.state="implementing" (current: "${session.state}"). Run \`tierkit session advance implementing\`.`,
      };
    }
  }
  if (mode === "review" && session.state !== "reviewing" && session.state !== "implementing") {
    return {
      allowed: false,
      code: "wrong-state",
      reason: `strict: --mode review requires session.state in {implementing, reviewing} (current: "${session.state}").`,
    };
  }
  return { allowed: true };
}
