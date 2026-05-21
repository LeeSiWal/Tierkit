/**
 * Profile viability — "can we actually use this model profile right now?"
 *
 * Cheap pre-flight check called before walking the auto-route fallback chain. The point
 * is to skip candidates that are guaranteed to fail (model not pulled, env var missing)
 * BEFORE we burn a full request round-trip on them. Returning success here doesn't promise
 * the call will succeed — the model could still be busy, rate-limited, or crash mid-stream
 * — but a "not viable" verdict is reliably actionable.
 *
 * Checks by tier:
 *   - **subprocess transport**: spawn `transport.command transport.healthCheckArgs`, wait for
 *     exit 0. ENOENT/EACCES → cli-not-found; non-zero exit or timeout → cli-healthcheck-failed.
 *   - **local-device + ollama**: probe `{baseUrl}/api/tags`, confirm the profile's model
 *     appears in the installed list (exact match OR with a `:tag` suffix).
 *   - **private-remote / public-cloud**: confirm the `apiKeyEnv` env var is set.
 *
 * We use a short timeout (1.5s) so a hung probe doesn't delay routing. If the probe times
 * out, we mark the profile non-viable — same effect as if Ollama were down.
 */
import { spawn } from "node:child_process";
import type { ModelProfile } from "./ModelProfile.js";

export interface ViabilityResult {
  viable: boolean;
  /** Why not, when viable === false. Useful for logging / error messages. */
  reason?:
    | "missing-api-key"
    | "ollama-unreachable"
    | "model-not-installed"
    | "cli-not-found"
    | "cli-healthcheck-failed";
}

const PROBE_TIMEOUT_MS = 1500;

interface OllamaTagsResponse {
  models?: { name: string }[];
}

export async function checkProfileViability(
  profile: ModelProfile,
  env: Record<string, string | undefined>,
): Promise<ViabilityResult> {
  // ── Subprocess transport: spawn healthcheck command and check exit code. ───
  if (profile.transport?.type === "subprocess") {
    const t = profile.transport;
    const probeTimeout = Math.min(1500, t.timeoutMs);
    const result = await new Promise<
      { ok: true } | { ok: false; reason: "cli-not-found" | "cli-healthcheck-failed" }
    >((resolve) => {
      let settled = false;
      let timed = false;
      const finish = (
        r: { ok: true } | { ok: false; reason: "cli-not-found" | "cli-healthcheck-failed" },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const child = spawn(t.command, t.healthCheckArgs, { stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => {
        timed = true;
        try { child.kill("SIGKILL"); } catch { /* */ }
      }, probeTimeout);
      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT" || err.code === "EACCES") {
          finish({ ok: false, reason: "cli-not-found" });
        } else {
          finish({ ok: false, reason: "cli-healthcheck-failed" });
        }
      });
      child.on("close", (code) => {
        if (timed) return finish({ ok: false, reason: "cli-healthcheck-failed" });
        finish(code === 0 ? { ok: true } : { ok: false, reason: "cli-healthcheck-failed" });
      });
      // Drain stdio so the child does not block on a full pipe buffer.
      child.stdout!.resume();
      child.stderr!.resume();
    });
    return result.ok ? { viable: true } : { viable: false, reason: result.reason };
  }

  // ── Remote tiers: API key must be set. (Cheap — no network.) ──────────────
  if (profile.kind !== "local-device") {
    if (profile.apiKeyEnv && !env[profile.apiKeyEnv]) {
      return { viable: false, reason: "missing-api-key" };
    }
    return { viable: true };
  }

  // ── Local Ollama: probe the installed-model list. ─────────────────────────
  if (profile.provider === "ollama" && profile.baseUrl) {
    try {
      const res = await fetch(`${profile.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) return { viable: false, reason: "ollama-unreachable" };
      const body = (await res.json()) as OllamaTagsResponse;
      const models = body.models ?? [];
      // Exact match OR prefix-with-colon (so "qwen2.5-coder:7b" matches the user's
      // installed entry whether it's stored as "qwen2.5-coder:7b" or just "qwen2.5-coder").
      const found = models.some((m) => m.name === profile.model || m.name.startsWith(profile.model + ":"));
      return found ? { viable: true } : { viable: false, reason: "model-not-installed" };
    } catch {
      return { viable: false, reason: "ollama-unreachable" };
    }
  }

  // Local profile with unknown provider — assume viable; the actual call will surface any error.
  return { viable: true };
}

/**
 * Check a batch of profile ids and return `{ viable: [], nonViable: [] }` lists. Used by
 * the auto-route fallback to prefer viable candidates without losing any (if all are
 * non-viable, the caller still gets the informative provider error).
 */
export async function partitionByViability<T extends { id: string }>(
  candidates: T[],
  resolveProfile: (id: string) => ModelProfile | undefined,
  env: Record<string, string | undefined>,
): Promise<{ viable: T[]; nonViable: T[] }> {
  const checks = await Promise.all(
    candidates.map(async (c) => {
      const p = resolveProfile(c.id);
      if (!p) return { c, viable: false };
      const v = await checkProfileViability(p, env);
      return { c, viable: v.viable };
    }),
  );
  return {
    viable: checks.filter((r) => r.viable).map((r) => r.c),
    nonViable: checks.filter((r) => !r.viable).map((r) => r.c),
  };
}
