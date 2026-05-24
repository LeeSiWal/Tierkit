import type { ServerResponse } from "node:http";
import { computeTierkitMcpSavings, resolveSavingsBaseline } from "./tierkitSavings.js";
import type { TierkitConfig } from "../config/TierkitConfig.js";

interface StartOptions {
  /** Re-resolved on every broadcast so profile edits take effect live. */
  getConfig: () => TierkitConfig;
  /** Workspace root used by the periodic heartbeat. */
  workspaceRootForHeartbeat?: string;
  /** Override the home dir (test fixture). */
  homeDirOverride?: string;
}

const HEARTBEAT_MS = 30_000;

const subscribers = new Set<ServerResponse>();
let heartbeat: NodeJS.Timeout | null = null;
let opts: StartOptions | null = null;

/**
 * Last successfully built payload frame (pre-formatted `data: ...\n\n`).
 * Written synchronously on heartbeat ticks so the write completes within
 * the same event-loop turn that the fake-timer tick yields — the async
 * refresh then updates it for the next tick.
 */
let cachedFrame: string | null = null;

export function start(o: StartOptions): void {
  opts = o;
  if (heartbeat) clearInterval(heartbeat);
  if (o.workspaceRootForHeartbeat) {
    const root = o.workspaceRootForHeartbeat;
    heartbeat = setInterval(() => {
      // Write the cached frame synchronously so the subscriber sees it
      // immediately (important under fake timers).  Then refresh the cache
      // in the background so the next heartbeat carries a fresh snapshot.
      flushCachedFrame();
      void refreshCache(root);
    }, HEARTBEAT_MS);
    // Allow the process to exit even if the heartbeat is pending.
    heartbeat.unref?.();
  }
}

export function stop(): void {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  for (const res of subscribers) {
    try { res.end(); } catch { /* socket closed */ }
  }
  subscribers.clear();
  cachedFrame = null;
  opts = null;
}

/**
 * Register an SSE response as a subscriber and immediately push the current
 * snapshot so the client sees state without waiting for the next event.
 */
export async function subscribe(res: ServerResponse, workspaceRoot: string): Promise<void> {
  subscribers.add(res);
  await pushTo(res, workspaceRoot);
}

/**
 * Compute the current snapshot once and write it to every subscriber.
 * Subscribers whose write throws are removed.
 */
export async function broadcast(workspaceRoot: string): Promise<void> {
  if (!opts) return;
  let payload: string;
  try {
    payload = await buildPayload(workspaceRoot);
  } catch (err) {
    console.error("[tierkit] savingsBroadcaster.broadcast: computeTierkitMcpSavings threw:", err);
    return;
  }
  const frame = `data: ${payload}\n\n`;
  cachedFrame = frame;
  writeFrame(frame);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Write a pre-formatted frame to all subscribers synchronously. */
function writeFrame(frame: string): void {
  for (const res of [...subscribers]) {
    try {
      if (res.writableEnded || res.destroyed) {
        subscribers.delete(res);
        continue;
      }
      res.write(frame);
    } catch {
      subscribers.delete(res);
    }
  }
}

/** Write the cached frame (if any) synchronously — used by the heartbeat. */
function flushCachedFrame(): void {
  if (cachedFrame) writeFrame(cachedFrame);
}

/** Rebuild the payload and update the cache asynchronously. */
async function refreshCache(workspaceRoot: string): Promise<void> {
  if (!opts) return;
  try {
    const payload = await buildPayload(workspaceRoot);
    cachedFrame = `data: ${payload}\n\n`;
  } catch (err) {
    console.error("[tierkit] savingsBroadcaster.refreshCache threw:", err);
  }
}

async function pushTo(res: ServerResponse, workspaceRoot: string): Promise<void> {
  if (!opts) return;
  let payload: string;
  try { payload = await buildPayload(workspaceRoot); }
  catch (err) {
    console.error("[tierkit] savingsBroadcaster.pushTo: computeTierkitMcpSavings threw:", err);
    subscribers.delete(res);
    return;
  }
  const frame = `data: ${payload}\n\n`;
  cachedFrame = frame;
  try { res.write(frame); }
  catch { subscribers.delete(res); }
}

async function buildPayload(workspaceRoot: string): Promise<string> {
  const cfg = opts!.getConfig();
  const { baselineId, baseProfile, inputUsdPerMillion } = resolveSavingsBaseline(cfg);
  const summary = await computeTierkitMcpSavings(
    workspaceRoot,
    inputUsdPerMillion,
    opts!.homeDirOverride ? { homeDirOverride: opts!.homeDirOverride } : {},
  );
  return JSON.stringify({
    type: "savings-snapshot",
    summary: {
      ok: true,
      baselineProfileId: baselineId,
      baselineProvider: baseProfile?.provider,
      inputUsdPerMillion,
      ...summary,
    },
  });
}

// Test-only access — exported so the integration test in Task 4 can assert
// the subscriber set size from outside the module.
export function _subscriberCount(): number {
  return subscribers.size;
}
