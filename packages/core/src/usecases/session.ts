import {
  ExecutionSessionSchema,
  SESSION_STATES,
  type ExecutionSession,
  type SessionState,
} from "../runtime/session/ExecutionSession.js";
import {
  readCurrentSession,
  readSession,
  setCurrentSessionId,
  writeSession,
  newSessionId,
} from "../runtime/session/sessionStore.js";
import { resolveEffectiveFreedom } from "../runtime/session/sessionPolicy.js";
import { loadConfig } from "../config/loadConfig.js";
import { readRegistry } from "../plugin/PluginRegistry.js";
import { TierkitError } from "../errors/TierkitError.js";
import type { FreedomLevel } from "../plugin/PluginManifest.js";

export class SessionError extends TierkitError {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SessionError";
    this.code = code;
  }
}

async function effectiveFreedomFor(projectRoot: string): Promise<FreedomLevel> {
  const cfg = await loadConfig(projectRoot);
  const registry = await readRegistry(projectRoot);
  const byId = new Map(registry.plugins.map((p) => [p.id, p.manifest]));
  return resolveEffectiveFreedom(cfg.config.activePlugins, byId);
}

export async function getEffectiveFreedom(cwd?: string): Promise<FreedomLevel> {
  return effectiveFreedomFor(cwd ?? process.cwd());
}

export interface StartSessionInput {
  task: string;
  cwd?: string;
  /** Override the freedom level captured into the session. Defaults to the project's effective freedom. */
  freedom?: FreedomLevel;
}

export interface StartSessionResult {
  session: ExecutionSession;
  /** When true, the new session replaced a still-open prior session (which was abandoned). */
  replacedPrevious: boolean;
}

export async function startSession(input: StartSessionInput): Promise<StartSessionResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const freedom = input.freedom ?? (await effectiveFreedomFor(projectRoot));

  // Abandon any open session so there is only ever one "current" at a time.
  let replacedPrevious = false;
  const previous = await readCurrentSession(projectRoot);
  if (previous && previous.state !== "done" && previous.state !== "abandoned") {
    const abandoned: ExecutionSession = {
      ...previous,
      state: "abandoned",
      updatedAt: new Date().toISOString(),
      history: [
        ...previous.history,
        {
          timestamp: new Date().toISOString(),
          from: previous.state,
          to: "abandoned",
          reason: "superseded by new session",
        },
      ],
    };
    await writeSession(projectRoot, abandoned);
    replacedPrevious = true;
  }

  const now = new Date().toISOString();
  const session = ExecutionSessionSchema.parse({
    id: newSessionId(),
    task: input.task,
    createdAt: now,
    updatedAt: now,
    state: "planning",
    planApproved: false,
    reviewApproved: false,
    freedom,
    history: [{ timestamp: now, from: null, to: "planning", reason: "session start" }],
  });
  await writeSession(projectRoot, session);
  await setCurrentSessionId(projectRoot, session.id);
  return { session, replacedPrevious };
}

export interface GetCurrentSessionInput {
  cwd?: string;
}

export interface GetCurrentSessionResult {
  session?: ExecutionSession;
  freedom: FreedomLevel;
}

export async function getCurrentSession(input: GetCurrentSessionInput = {}): Promise<GetCurrentSessionResult> {
  const projectRoot = input.cwd ?? process.cwd();
  const session = await readCurrentSession(projectRoot);
  const freedom = await effectiveFreedomFor(projectRoot);
  return { ...(session ? { session } : {}), freedom };
}

export interface AdvanceSessionInput {
  cwd?: string;
  toState: SessionState;
  reason?: string;
}

export async function advanceSession(input: AdvanceSessionInput): Promise<ExecutionSession> {
  if (!SESSION_STATES.includes(input.toState)) {
    throw new SessionError("invalid-state", `unknown session state "${input.toState}"`);
  }
  const projectRoot = input.cwd ?? process.cwd();
  const current = await readCurrentSession(projectRoot);
  if (!current) throw new SessionError("no-session", "no current session — run `tierkit session start \"<task>\"` first");

  const now = new Date().toISOString();
  const next: ExecutionSession = {
    ...current,
    state: input.toState,
    updatedAt: now,
    history: [...current.history, { timestamp: now, from: current.state, to: input.toState, ...(input.reason ? { reason: input.reason } : {}) }],
  };
  await writeSession(projectRoot, next);
  if (next.state === "done" || next.state === "abandoned") {
    await setCurrentSessionId(projectRoot, null);
  }
  return next;
}

export interface ApprovePlanInput {
  cwd?: string;
}

export async function approvePlan(input: ApprovePlanInput = {}): Promise<ExecutionSession> {
  const projectRoot = input.cwd ?? process.cwd();
  const current = await readCurrentSession(projectRoot);
  if (!current) throw new SessionError("no-session", "no current session");
  if (current.state !== "planning") {
    throw new SessionError(
      "wrong-state",
      `approve-plan requires state="planning" (current: "${current.state}")`,
    );
  }
  const now = new Date().toISOString();
  const next: ExecutionSession = {
    ...current,
    planApproved: true,
    updatedAt: now,
    history: [...current.history, { timestamp: now, from: current.state, to: current.state, reason: "plan approved" }],
  };
  await writeSession(projectRoot, next);
  return next;
}

export interface AbandonSessionInput {
  cwd?: string;
  reason?: string;
}

export async function abandonSession(input: AbandonSessionInput = {}): Promise<ExecutionSession | undefined> {
  const projectRoot = input.cwd ?? process.cwd();
  const current = await readCurrentSession(projectRoot);
  if (!current) return undefined;
  const now = new Date().toISOString();
  const next: ExecutionSession = {
    ...current,
    state: "abandoned",
    updatedAt: now,
    history: [
      ...current.history,
      { timestamp: now, from: current.state, to: "abandoned", ...(input.reason ? { reason: input.reason } : {}) },
    ],
  };
  await writeSession(projectRoot, next);
  await setCurrentSessionId(projectRoot, null);
  return next;
}

export { readSession };
