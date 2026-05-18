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

interface OllamaModelEntry {
  name: string;
  size?: number;
  details?: { family?: string; parameter_size?: string };
}

interface OllamaTagsResponse {
  models?: OllamaModelEntry[];
}

let cache: { at: number; baseUrl: string; profiles: Record<string, ModelProfile> } | null = null;

export interface DiscoverOptions {
  /** Ollama base URL. Defaults to `http://127.0.0.1:11434`. */
  baseUrl?: string;
  /** Force a fresh probe even if the cache is fresh. */
  force?: boolean;
}

export async function discoverOllamaProfiles(opts: DiscoverOptions = {}): Promise<Record<string, ModelProfile>> {
  if (process.env.TIERKIT_NO_DISCOVERY === "1") return {};
  const baseUrl = opts.baseUrl ?? DEFAULT_OLLAMA_BASE;

  if (cache && !opts.force && cache.baseUrl === baseUrl && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.profiles;
  }

  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) {
      cache = { at: Date.now(), baseUrl, profiles: {} };
      return {};
    }
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
    cache = { at: Date.now(), baseUrl, profiles };
    return profiles;
  } catch {
    // Ollama not running, network glitch, etc. — return empty silently. Discovery is
    // best-effort; absence of profiles isn't an error condition for the caller.
    return cache?.baseUrl === baseUrl ? cache.profiles : {};
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
}
