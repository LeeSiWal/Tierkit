/**
 * Auto-discover model profiles from a running Ollama instance.
 *
 * Why this exists: the bundled defaults (`localCoder` → qwen2.5-coder:7b, `localFast` →
 * llama3.2:3b) only help users who happen to have those exact models pulled. Many users
 * have completely different models (gemma, mistral-nemo, deepseek-coder, etc.) and end
 * up with no viable local-device profile out of the box. This discovery layer probes
 * `/api/tags` and synthesizes one profile per installed chat-capable model, so whatever
 * the user has pulled becomes immediately usable through Tierkit's auto-routing.
 *
 * Behavior:
 *   - Probes `{baseUrl}/api/tags` with a 1s timeout (off-machine Ollama is fine but slow)
 *   - Filters out embedding-only models (heuristic by name; we can't actually call them
 *     for chat, so they would just produce 404s in the fallback chain)
 *   - Generates a profile per surviving model with id `ollama:<sanitized-model-name>`
 *   - Caches the result for `CACHE_TTL_MS` (30s) to avoid hitting Ollama on every
 *     `loadConfig()` call (which happens on every llm-call, route-explain, etc.)
 *
 * Opt out:
 *   - `runtime.discoverOllamaModels: false` in tierkit.config.json
 *   - Or `TIERKIT_NO_DISCOVERY=1` env var (test setup uses this for isolation)
 *
 * Discovered profiles show up alongside bundled / user / workspace profiles with
 * source `"discovered"` — so the sidebar can label them differently.
 */
import type { ModelProfile } from "./ModelProfile.js";

const DEFAULT_OLLAMA_BASE = "http://127.0.0.1:11434";
const PROBE_TIMEOUT_MS = 1000;
const CACHE_TTL_MS = 30_000;
/** Negative-result TTL: when no candidate answered, suppress re-probes for this long.
 *  Shorter than the positive TTL so a freshly-started Ollama gets picked up reasonably
 *  fast (e.g. user launches Ollama, refreshes the GUI). Longer than zero so a burst of
 *  concurrent loadConfig calls doesn't all repeatedly stampede unreachable hosts. */
const NEGATIVE_CACHE_TTL_MS = 5_000;

interface OllamaModelEntry {
  name: string;
  size?: number;
  details?: { family?: string; parameter_size?: string };
}

interface OllamaTagsResponse {
  models?: OllamaModelEntry[];
}

let cache: { at: number; baseUrl: string; profiles: Record<string, ModelProfile> } | null = null;
/** In-flight probe shared across concurrent callers. When set, callers await this
 *  promise instead of launching their own probe — a burst of concurrent loadConfig
 *  calls (the GUI's refreshAll fires ~14 in parallel) collapses to ONE probe. */
let inflightProbe: Promise<Record<string, ModelProfile>> | null = null;

export interface DiscoverOptions {
  /** Ollama base URL. When set, probes ONLY this URL. When unset, probes a
   *  list of candidates (env + Docker host gateways + localhost) and uses
   *  the first that returns models. */
  baseUrl?: string;
  /** Force a fresh probe even if the cache is fresh. */
  force?: boolean;
}

/**
 * v0.21.12: build the list of Ollama base URLs to probe when none is specified.
 *
 * Order matters — the first one that returns ≥1 model wins. Designed for the
 * "daemon runs in a container, Ollama runs on the host" case (code-server,
 * devcontainers, Docker Desktop on Mac/Windows) where 127.0.0.1 inside the
 * container has nothing on port 11434 but the host's Ollama is reachable via
 * the standard host gateway names.
 */
function getCandidateBaseUrls(opts: DiscoverOptions): string[] {
  if (opts.baseUrl) return [opts.baseUrl];
  const out: string[] = [];
  // 1. User env override (also the standard Ollama client convention).
  const envHost = process.env.OLLAMA_HOST;
  if (envHost && envHost.length > 0) {
    out.push(/^https?:\/\//.test(envHost) ? envHost : `http://${envHost}`);
  }
  // 2. Localhost — same machine as the daemon.
  out.push(DEFAULT_OLLAMA_BASE);
  // 3. Docker / Podman / Linux Docker host gateways. These are name-resolved
  //    special hosts that point back at the container host on the corresponding
  //    runtime — the standard escape hatch from a container to host services.
  out.push("http://host.docker.internal:11434");    // Docker Desktop (Mac/Win)
  out.push("http://host.containers.internal:11434"); // Podman
  out.push("http://172.17.0.1:11434");               // Linux Docker default bridge gateway
  return Array.from(new Set(out));
}

async function probeOne(baseUrl: string): Promise<{ baseUrl: string; profiles: Record<string, ModelProfile> } | null> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as OllamaTagsResponse;
    const models = body.models ?? [];
    const profiles: Record<string, ModelProfile> = {};
    for (const m of models) {
      if (!isUsableForChat(m)) continue;
      const id = sanitizeId(m.name);
      const goodAt = inferGoodAt(m.name);
      const notGoodAt = inferNotGoodAt(m.name);
      profiles[id] = {
        kind: "local-device",
        provider: "ollama",
        model: m.name,
        baseUrl,
        roles: detectRoles(m.name),
        ...(goodAt.length > 0 ? { goodAt } : {}),
        ...(notGoodAt.length > 0 ? { notGoodAt } : {}),
        cost: { type: "free" },
      };
    }
    return { baseUrl, profiles };
  } catch {
    return null;
  }
}

export async function discoverOllamaProfiles(opts: DiscoverOptions = {}): Promise<Record<string, ModelProfile>> {
  if (process.env.TIERKIT_NO_DISCOVERY === "1") return {};

  // Cache hit — honored for BOTH positive and negative results. Empty cache used
  // to force a re-probe on every call, which on long-running daemons (the VS Code
  // in-process daemon) caused concurrent loadConfig calls to each fan out 4 fetches
  // to unreachable Docker host gateways and exhaust the undici connection pool.
  // With the negative TTL gate, a single missing-Ollama burst now collapses to one
  // probe + 4 cached returns, instead of hundreds of stranded TCP connects.
  if (cache && !opts.force) {
    const age = Date.now() - cache.at;
    const ttl = Object.keys(cache.profiles).length > 0 ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
    if (age < ttl) return cache.profiles;
  }

  // Coalesce concurrent callers onto a single probe. The GUI's refreshAll fires
  // ~14 parallel loadConfig calls; without this, each one independently launches
  // 4 fetches → 56 concurrent connect()s, several of them to unroutable IPs.
  if (inflightProbe && !opts.force) return inflightProbe;

  const candidates = getCandidateBaseUrls(opts);
  const probe = (async (): Promise<Record<string, ModelProfile>> => {
    // Probe all candidates in parallel, but RETURN AS SOON AS one of them succeeds
    // with ≥1 model. Critical for the macOS/Linux case where localhost Ollama
    // responds in ~15ms but Docker bridge gateway IPs (e.g. 172.17.0.1) blackhole
    // the TCP connect and AbortSignal.timeout(1000) doesn't actually cancel the
    // OS-level connect promptly — it can sit for 3+ seconds. Waiting for all
    // probes to settle stalls the daemon's loadConfig by that worst-case.
    //
    // Implementation: a manual Promise that resolves on the first successful
    // probe, or after all probes settle (whichever is sooner). The slow probes
    // keep running in the background and their AbortSignals will eventually
    // tear them down — we just don't wait for them.
    const winnerOrSettled = await new Promise<{ baseUrl: string; profiles: Record<string, ModelProfile> } | null>((resolve) => {
      let pendingCount = candidates.length;
      let resolved = false;
      const allResults: Array<{ baseUrl: string; profiles: Record<string, ModelProfile> } | null> = [];
      if (candidates.length === 0) { resolve(null); return; }
      for (const url of candidates) {
        probeOne(url).then((r) => {
          allResults.push(r);
          if (!resolved && r && Object.keys(r.profiles).length > 0) {
            resolved = true;
            resolve(r);
            return;
          }
          if (--pendingCount === 0 && !resolved) {
            resolved = true;
            // No successful probe — pick the first non-null (e.g. Ollama up but
            // returned 0 models) for cache provenance, else null.
            resolve(allResults.find((x) => x !== null) ?? null);
          }
        });
      }
    });

    if (winnerOrSettled && Object.keys(winnerOrSettled.profiles).length > 0) {
      cache = { at: Date.now(), baseUrl: winnerOrSettled.baseUrl, profiles: winnerOrSettled.profiles };
      return winnerOrSettled.profiles;
    }
    // Nothing useful — keep an empty cache so the TTL gate kicks in and we
    // don't probe every single llm-call when Ollama is truly absent.
    cache = { at: Date.now(), baseUrl: candidates[0] ?? DEFAULT_OLLAMA_BASE, profiles: {} };
    return {};
  })();

  inflightProbe = probe;
  try {
    return await probe;
  } finally {
    // Clear the in-flight only if it's still ours (a parallel forced probe could
    // have replaced it). Without this guard, a force probe completing after a
    // non-force probe would null out the wrong reference.
    if (inflightProbe === probe) inflightProbe = null;
  }
}

/** Embedding-only models can't serve `/api/chat`, so we filter them out. Heuristic: model name. */
function isUsableForChat(m: OllamaModelEntry): boolean {
  const name = m.name.toLowerCase();
  // Common embedding-only families. If a chat model name happens to contain "embed",
  // that's an unfortunate false positive — easy to allowlist later if needed.
  if (name.includes("embed")) return false;
  if (name.startsWith("nomic-embed")) return false;
  if (name.startsWith("bge-")) return false;
  if (name.startsWith("snowflake-arctic-embed")) return false;
  return true;
}

/**
 * Best-effort goodAt tags based on model name. Used by the router to sort profiles
 * within a tier — a profile whose goodAt matches the detected task type bubbles to the
 * front. Conservative: only return tags we have strong evidence the model handles well
 * (based on the model's training corpus / family). Unknown families get an empty array,
 * which keeps them as "neutral" in the router's sort (better than an anti-fit signal).
 */
function inferGoodAt(name: string): string[] {
  return Array.from(inferCapabilities(name).good);
}

/**
 * Companion to inferGoodAt: returns task types the model is KNOWN to handle poorly.
 * The router hard-filters these out — they stay visible in the GUI list (so the user can
 * still pick them explicitly) but never enter the auto-route chain for those task types.
 * Used by discovery + by `local-coder-first` preset to keep small / generic models out of
 * code-review / refactor / plan chains.
 */
function inferNotGoodAt(name: string): string[] {
  return Array.from(inferCapabilities(name).bad);
}

/**
 * Single pass over the model name → produce both goodAt + notGoodAt sets. Keeping the
 * heuristic in one place avoids drift between the two functions.
 *
 * Capability tiers by model name:
 *  - small (<7B, "tiny", "small", "nano"): summarize + translate are fine. code-* + plan
 *    are explicitly weak.
 *  - mid 7B-13B general (not coder): no opinion either way (neutral).
 *  - mid 7B-13B coder: code-generation + refactor are fine. code-review still risky →
 *    notGoodAt (review needs more capability).
 *  - large 14B+ coder (qwen-coder/deepseek-coder/codestral/...): goodAt all code-* + plan.
 *  - large 14B+ general (llama-70b/mixtral/mistral-large): goodAt plan.
 *  - Qwen / Yi / EXAONE: also tag "korean" (training corpus signal).
 *
 * Anything we can't classify is left empty (neutral) — better than a wrong tag.
 */
function inferCapabilities(name: string): { good: Set<string>; bad: Set<string> } {
  const lower = name.toLowerCase();
  const good = new Set<string>();
  const bad = new Set<string>();

  const isCoder =
    lower.includes("coder") ||
    lower.includes("codestral") ||
    lower.includes("codellama") ||
    lower.includes("deepseek-coder") ||
    lower.includes("starcoder") ||
    lower.includes("granite-code") ||
    lower.includes("codeqwen");

  const isSmall = /\b(0\.5b|1b|1\.5b|2b|3b|4b|5b|tiny|small|nano)\b/.test(lower);
  const isLarge =
    /\b(70b|72b|405b|405)\b/.test(lower) ||
    lower.includes("mistral-large") ||
    lower.includes("mixtral") ||
    /qwen.*(?:14b|22b|30b|32b|34b|72b)/.test(lower) ||
    /\b(14b|22b|30b|32b|34b)\b/.test(lower);

  const isKorean =
    lower.startsWith("qwen") ||
    lower.includes("qwen3") ||
    lower.includes("qwen2.5") ||
    lower.startsWith("yi") ||
    lower.includes("exaone");

  if (isCoder && isLarge) {
    good.add("code-generation");
    good.add("refactor");
    good.add("code-review");
    good.add("plan");
  } else if (isCoder && !isSmall) {
    // 7B–13B coder: capable of generation/refactor but code-review needs more.
    good.add("code-generation");
    good.add("refactor");
    bad.add("code-review");
  } else if (isLarge && !isCoder) {
    // 70B-class generic — strong on plan, not specifically coder-tuned but capable.
    good.add("plan");
  } else if (!isCoder && !isSmall && !isLarge) {
    // 7B-13B non-coder generic models (gemma, mistral 7b, llama3 8b,
    // command-r 35b, exaone, etc.). Capable for summarization and translation
    // but NOT reliable for coding work without explicit user opt-in. Users who
    // want one of these for code-review can override `notGoodAt` in their
    // workspace config.
    good.add("summarize");
    good.add("translate");
    bad.add("code-generation");
    bad.add("refactor");
    bad.add("code-review");
    bad.add("plan");
  }

  if (isSmall) {
    good.add("summarize");
    good.add("translate");
    // Hard exclusion from coding chains. Better to escalate than ship 3B code work.
    bad.add("code-generation");
    bad.add("refactor");
    bad.add("code-review");
    bad.add("plan");
  }

  if (isKorean) good.add("korean");

  return { good, bad };
}

/** Best-effort role tags based on model name. */
function detectRoles(name: string): string[] {
  const lower = name.toLowerCase();
  const roles: string[] = [];
  if (lower.includes("coder") || lower.includes("code")) roles.push("code");
  if (lower.includes("vision") || lower.includes("vl")) roles.push("vision");
  if (lower.includes("instruct") || lower.includes("chat")) roles.push("chat");
  // If nothing matched, assume general chat.
  if (roles.length === 0) roles.push("chat");
  return roles;
}

/**
 * Turn "qwen2.5-coder:7b" into a profile-id-safe string like "ollama-qwen2-5-coder-7b".
 * Tierkit's profile-add validator only allows `[A-Za-z][A-Za-z0-9_-]*`, so we strip
 * colons, dots, slashes, and collapse runs of separators.
 */
function sanitizeId(modelName: string): string {
  const slug = modelName
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .toLowerCase();
  return `ollama-${slug}`;
}

/** Test introspection — clears the cache so subsequent calls re-probe. */
export function _clearDiscoveryCacheForTests(): void {
  cache = null;
  inflightProbe = null;
}
