/**
 * Best-effort Ollama auto-launch.
 *
 * If the Tierkit daemon needs to call an Ollama-backed profile and `http://127.0.0.1:11434`
 * doesn't respond, this module shells out to `ollama serve` to start it. The spawned process
 * is tracked in module state so we can shut it down cleanly when the Tierkit daemon stops
 * (called from `Server.close()`).
 *
 * Behavior:
 *   - We only spawn if a quick reachability probe fails. If Ollama is already running
 *     (system service, tray app on Windows/Mac, manual `ollama serve` in a terminal), we
 *     leave it alone — and we will NOT kill it on shutdown because we didn't start it.
 *   - The spawn is non-detached so the child dies with the parent in most cases anyway;
 *     `shutdownSpawnedOllama()` is the explicit clean path.
 *   - Disabled when `TIERKIT_DISABLE_AUTO_LAUNCH=1` (used by tests so they never accidentally
 *     spawn the real Ollama binary during CI).
 */
import { spawn, type ChildProcess } from "node:child_process";

let spawnedChild: ChildProcess | undefined;
let lastAttemptAt = 0;
const COOLDOWN_MS = 2_000;

const PROBE_TIMEOUT_MS = 800;
const WAIT_FOR_UP_TIMEOUT_MS = 12_000;
const POLL_INTERVAL_MS = 250;

function disabled(): boolean {
  return process.env.TIERKIT_DISABLE_AUTO_LAUNCH === "1";
}

/** Returns true if `${baseUrl}/api/tags` responds successfully within `PROBE_TIMEOUT_MS`. */
async function isOllamaUp(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Probe Ollama; if down, spawn `ollama serve` and wait briefly for it to come up. Returns:
 *   - `{ ok: true, spawned: false }` — already running, nothing to do
 *   - `{ ok: true, spawned: true }` — we started it; will shutdown on `shutdownSpawnedOllama()`
 *   - `{ ok: false, reason }` — could not start (ollama binary not on PATH, hang, etc.)
 */
export async function tryEnsureOllamaRunning(baseUrl: string): Promise<{ ok: boolean; spawned: boolean; reason?: string }> {
  if (disabled()) return { ok: await isOllamaUp(baseUrl), spawned: false };
  if (await isOllamaUp(baseUrl)) return { ok: true, spawned: false };

  // Cooldown so we don't fork a binary on every consecutive failure inside a tight loop.
  if (Date.now() - lastAttemptAt < COOLDOWN_MS) {
    return { ok: false, spawned: false, reason: "auto-launch in cooldown" };
  }
  lastAttemptAt = Date.now();

  // If we already spawned a child but the probe says it's not up, the child may have crashed.
  // Clear the handle so we can respawn cleanly.
  if (spawnedChild && spawnedChild.exitCode !== null) {
    spawnedChild = undefined;
  }
  if (spawnedChild) {
    // Already attempting; just wait for it to come up.
    return waitForUp(baseUrl, true);
  }

  try {
    spawnedChild = spawn("ollama", ["serve"], {
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (err) {
    spawnedChild = undefined;
    return { ok: false, spawned: false, reason: (err as Error).message };
  }

  spawnedChild.on("exit", () => {
    spawnedChild = undefined;
  });
  spawnedChild.on("error", () => {
    spawnedChild = undefined;
  });

  // Detach our reference from Node's event loop so the parent can exit cleanly; we still
  // hold the handle for explicit kill.
  spawnedChild.unref?.();

  return waitForUp(baseUrl, true);
}

async function waitForUp(baseUrl: string, spawned: boolean): Promise<{ ok: boolean; spawned: boolean; reason?: string }> {
  const deadline = Date.now() + WAIT_FOR_UP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isOllamaUp(baseUrl)) return { ok: true, spawned };
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { ok: false, spawned, reason: "ollama did not become ready within 12s" };
}

/**
 * Kill the Ollama process we spawned, if any. No-op if we didn't spawn one (e.g., user had
 * Ollama running already as a system service / tray app). Called from `Server.close()` so
 * when the Tierkit daemon goes down — which on a VS Code install means when VS Code closes
 * — the Ollama instance we started goes with it.
 */
export async function shutdownSpawnedOllama(): Promise<void> {
  const child = spawnedChild;
  if (!child) return;
  spawnedChild = undefined;
  try {
    // On Windows, SIGTERM behaves like a hard terminate via TerminateProcess. On POSIX,
    // SIGTERM lets ollama clean up its model cache and unload weights.
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}

/** Test introspection. */
export function _hasSpawnedChildForTests(): boolean {
  return !!spawnedChild;
}
