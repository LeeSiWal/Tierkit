import path from "node:path";
import { loadConfig } from "../config/loadConfig.js";
import { explainRoute } from "./explainRoute.js";
import { buildTaskContext, type RunMode } from "../context/TaskContextBuilder.js";
import { redactSecrets } from "../security/SecretRedactor.js";
import { pickProviderClient } from "../model/providers/index.js";
import type { ProviderClient } from "../model/providers/types.js";
import type { ChatMessage, StreamEvent } from "../model/providers/chatTypes.js";
import type { ModelProfile, ModelTier } from "../model/ModelProfile.js";
import type { RouteDecision } from "../model/ModelRouter.js";
import { appendUsage, estimateCost, type UsageRecord } from "../runtime/usageLog.js";
import { checkBudget } from "../runtime/budget.js";
import { readRegistry } from "../plugin/PluginRegistry.js";
import { resolveEffectiveFreedom, checkSessionGate } from "../runtime/session/sessionPolicy.js";
import { readCurrentSession } from "../runtime/session/sessionStore.js";

export interface RunRouteInput {
  task: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Force a specific profile id, bypassing the router. */
  profileId?: string;
  /** Restrict tier picking: `local-only` skips remote profiles; `private` allows private-remote. */
  tierConstraint?: "local-only" | "private" | "none";
  mode?: RunMode;
  maxTokens?: number;
  temperature?: number;
  /** Hints forwarded to RiskScorer when picking via router. */
  filesTouchedEstimate?: number;
  involvesSecrets?: boolean;
  involvesProductionInfra?: boolean;
  /** Inject a provider client (used in tests). */
  clientFactory?: (profile: ModelProfile) => ProviderClient | undefined;
}

export interface RunRouteContext {
  profileId: string;
  profile: ModelProfile;
  decision: RouteDecision;
  systemPrompt: string;
  messages: ChatMessage[];
  redactionHits: { ruleId: string; count: number }[];
  budgetStatus: "ok" | "warn" | "block";
  budgetReason?: string;
  /** v1.2: soft warning from the session gate (e.g. guided plugin without session). */
  workflowWarning?: string;
}

export interface RunRouteFail {
  ok: false;
  code: string;
  message: string;
  /** Partial context that was prepared before the failure (helpful for diagnostics). */
  context?: Partial<RunRouteContext>;
}

export interface RunRouteOk {
  ok: true;
  context: RunRouteContext;
  /** Stream of events. Always emits one `start`, deltas, optional `usage`, exactly one terminator. */
  stream: AsyncIterable<StreamEvent>;
  /** Resolves with the consolidated text once the stream is fully consumed. Callers must consume `stream` to drive this. */
  done: Promise<RunRouteDone>;
}

export interface RunRouteDone {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  failureCode?: string;
}

export type RunRouteResult = RunRouteOk | RunRouteFail;

/**
 * Execute a task through the Tierkit pipeline:
 *  1. Resolve config + profile (via router or explicit `--profile`).
 *  2. Build the message context for the requested `mode`.
 *  3. Apply secret redaction when the profile is on a remote tier.
 *  4. Check the budget — refuse on `block`.
 *  5. Stream from the provider; tee the events so the caller can render in real time
 *     while we tally tokens for the usage log.
 *  6. Append a usage record (success or failure) when the stream terminates.
 *
 * Returns immediately with the prepared context + an AsyncIterable. The caller consumes
 * the stream (printing deltas, building UI, etc.); the `done` promise resolves with the
 * final totals after the stream emits its terminator.
 */
export async function runRoute(input: RunRouteInput): Promise<RunRouteResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const mode: RunMode = input.mode ?? "execute";

  // With bundled defaults, profile lookup can succeed even without a workspace config file.
  const cfg = await loadConfig(projectRoot);

  // v1.2 — workflow gate. Computed before profile resolution so a blocked session refuses
  // before we waste any provider calls or token budget.
  let gateWarning: string | undefined;
  try {
    const registry = await readRegistry(projectRoot);
    const manifestsById = new Map(registry.plugins.map((p) => [p.id, p.manifest]));
    const effectiveFreedom = resolveEffectiveFreedom(cfg.config.activePlugins, manifestsById);
    if (effectiveFreedom !== "free") {
      const session = await readCurrentSession(projectRoot);
      const filesTouched = input.filesTouchedEstimate ?? 0;
      const gate = checkSessionGate({
        freedom: effectiveFreedom,
        mode,
        ...(session ? { session } : {}),
        multiFile: filesTouched >= 3,
      });
      if (!gate.allowed) {
        return {
          ok: false,
          code: gate.code ?? "workflow-gate-blocked",
          message: gate.reason ?? `workflow gate blocked by freedom level "${effectiveFreedom}"`,
        };
      }
      if (gate.warning) gateWarning = gate.warning;
    }
  } catch (err) {
    // Registry/session corruption should not break route run for free-tier users.
    // Re-throw only when we know it's not an ENOENT.
    if ((err as NodeJS.ErrnoException).code && (err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  // Resolve the profile.
  let profile: ModelProfile | undefined;
  let profileId: string | undefined;
  let decision: RouteDecision | undefined;

  if (input.profileId) {
    profile = cfg.config.modelProfiles[input.profileId];
    if (!profile) {
      const known = Object.keys(cfg.config.modelProfiles);
      return {
        ok: false,
        code: "unknown-profile",
        message: `unknown profile "${input.profileId}". Known: ${known.join(", ") || "(none)"}`,
      };
    }
    profileId = input.profileId;
    // Synthesize a decision describing the forced choice.
    decision = {
      tier: profile.kind,
      profileId,
      score: 0,
      reasons: [`profile forced via --profile ${input.profileId}`],
      requiresApproval: profile.kind === "public-cloud" ? true : Boolean(profile.requiresApproval),
      mode: profile.kind === "public-cloud" ? (profile.defaultMode ?? "review-only") : "execute",
      escalationChain: [{ id: profileId, tier: profile.kind, isEscalation: false }],
    };
  } else {
    const explained = await explainRoute({
      cwd: projectRoot,
      task: input.task,
      ...(input.filesTouchedEstimate !== undefined ? { filesTouchedEstimate: input.filesTouchedEstimate } : {}),
      ...(input.involvesSecrets !== undefined ? { involvesSecrets: input.involvesSecrets } : {}),
      ...(input.involvesProductionInfra !== undefined ? { involvesProductionInfra: input.involvesProductionInfra } : {}),
    });
    decision = explained.decision;

    let chosenTier: ModelTier | undefined = decision.tier;
    if (input.tierConstraint === "local-only") chosenTier = "local-device";
    else if (input.tierConstraint === "private" && decision.tier === "public-cloud") chosenTier = "private-remote";

    const candidate = pickFirstProfileOfTier(cfg.config.modelProfiles, chosenTier);
    if (!candidate) {
      return {
        ok: false,
        code: "no-profile-for-tier",
        message: `no profile of tier "${chosenTier}" is configured${input.tierConstraint ? ` (tier constraint: ${input.tierConstraint})` : ""}`,
      };
    }
    profile = candidate.profile;
    profileId = candidate.id;
    // Reflect the (possibly constrained) chosen tier in the decision we surface.
    decision = { ...decision, tier: chosenTier, profileId };
  }

  // Build the message context for the chosen mode.
  const { messages: rawMessages, systemPrompt } = buildTaskContext({ task: input.task, mode });

  // Redact when going remote (default-on; respects security.redactSecretsForRemote).
  const isRemote = profile.kind !== "local-device";
  const shouldRedact = isRemote && cfg.config.security.redactSecretsForRemote !== false;
  const redactionHits: { ruleId: string; count: number }[] = [];
  let messages = rawMessages;
  if (shouldRedact) {
    messages = rawMessages.map((m) => {
      const r = redactSecrets(m.content);
      for (const h of r.hits) {
        const existing = redactionHits.find((x) => x.ruleId === h.ruleId);
        if (existing) existing.count += h.count;
        else redactionHits.push({ ...h });
      }
      return { ...m, content: r.text };
    });
  }

  // Budget gate.
  const usageLogPath = path.join(projectRoot, cfg.config.runtime.dataDir, "usage.jsonl");
  const budget = await checkBudget(usageLogPath, cfg.config.budget);
  if (budget.status === "block") {
    return { ok: false, code: "budget-exceeded", message: budget.reason ?? "budget exceeded" };
  }

  // Resolve provider client (real or injected).
  const client = (input.clientFactory ? input.clientFactory(profile) : undefined) ?? pickProviderClient(profile);
  if (!client) {
    return {
      ok: false,
      code: "not-implemented",
      message: `provider "${profile.provider}" has no Tierkit client`,
    };
  }

  const context: RunRouteContext = {
    profileId,
    profile,
    decision: decision!,
    systemPrompt,
    messages,
    redactionHits,
    budgetStatus: budget.status,
    ...(gateWarning ? { workflowWarning: gateWarning } : {}),
    ...(budget.reason ? { budgetReason: budget.reason } : {}),
  };

  const chatRequest = {
    messages,
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  };

  // Tee the stream: consumer sees raw events, we tally totals + write usage log on `end`/`error`.
  let resolveDone!: (d: RunRouteDone) => void;
  const done = new Promise<RunRouteDone>((resolve) => {
    resolveDone = resolve;
  });

  async function* teedStream(): AsyncIterable<StreamEvent> {
    let textParts: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let latencyMs = 0;
    let failureCode: string | undefined;
    let ok = true;

    try {
      for await (const evt of client!.stream(profile!, chatRequest, env)) {
        switch (evt.type) {
          case "delta":
            textParts.push(evt.text);
            break;
          case "usage":
            if (evt.inputTokens !== undefined) inputTokens = evt.inputTokens;
            if (evt.outputTokens !== undefined) outputTokens = evt.outputTokens;
            break;
          case "end":
            latencyMs = evt.latencyMs;
            break;
          case "error":
            ok = false;
            failureCode = evt.code;
            latencyMs = evt.latencyMs;
            break;
          default:
            break;
        }
        yield evt;
      }
    } finally {
      const text = textParts.join("");
      const costUsd = ok ? estimateCost(profile!, inputTokens, outputTokens) : 0;
      const record: UsageRecord = {
        timestamp: new Date().toISOString(),
        profileId: profileId!,
        provider: profile!.provider,
        model: profile!.model,
        tier: profile!.kind,
        inputTokens,
        outputTokens,
        costUsd,
        latencyMs,
        ok,
        ...(failureCode ? { failureCode } : {}),
      };
      await appendUsage(usageLogPath, record);
      resolveDone({
        text,
        inputTokens,
        outputTokens,
        costUsd,
        latencyMs,
        ...(failureCode ? { failureCode } : {}),
      });
    }
  }

  return { ok: true, context, stream: teedStream(), done };
}

function pickFirstProfileOfTier(
  profiles: Record<string, ModelProfile>,
  tier: ModelTier,
): { id: string; profile: ModelProfile } | undefined {
  for (const [id, profile] of Object.entries(profiles)) {
    if (profile.kind === tier) return { id, profile };
  }
  return undefined;
}
