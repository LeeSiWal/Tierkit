/**
 * makeRefineCallback — adapt any ProviderClient (Ollama, OpenAI-compatible,
 * Anthropic, Claude Code subprocess, Mock) into the `(prompt: string) =>
 * Promise<string>` signature that `compressCommand` expects for its optional
 * `refine` step.
 *
 * Why? compressCommand was designed to be transport-agnostic. It doesn't know
 * about HTTP, Ollama-specific JSON schemas, streaming, env-passing, etc. —
 * that's all this file's job.
 *
 * Failure semantics:
 *   - Provider unreachable (e.g., Ollama not running)  → throws.
 *   - Provider returns ok:false                        → throws.
 *   - Provider hangs past timeoutMs (default 30s)      → throws.
 *
 * compressCommand catches the throw and falls back to the rule-only brief,
 * appending the failure reason to the result's `uncertainty[]`. So users
 * never see a hard error from a missing refine model — they just see "LLM
 * refinement failed; using rule-based brief."
 *
 * System prompt strategy:
 *   The default prompt forbids inventing new requirements / constraints /
 *   identifiers — preventing the most common LLM failure (hallucinated
 *   "should also validate input" style additions). We're using the LLM as
 *   a *compressor*, not a *suggester*.
 */
import { pickProviderClient } from "../model/providers/index.js";
import type { ModelProfile } from "../model/ModelProfile.js";

const DEFAULT_SYSTEM_PROMPT = [
  "You rewrite a task brief to be MORE compact without losing any explicit requirement, constraint, or named symbol.",
  "Rules:",
  "1. Preserve every requirement (verbs like add/implement/fix and what they refer to).",
  "2. Preserve every constraint (must/do not/keep/avoid clauses).",
  "3. Preserve every identifier name (functions, files, types, constants).",
  "4. Do NOT invent new requirements or constraints.",
  "5. Do NOT add commentary, examples, or explanations.",
  "6. Keep the same Markdown headings the input uses.",
  "7. Output MUST be shorter than the input.",
].join("\n");

export interface MakeRefineCallbackOptions {
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  /** Hard wall-clock cap. The provider call is wrapped in a race against this timeout. */
  timeoutMs?: number;
  /** Env passed to the provider (defaults to {}). */
  env?: Record<string, string | undefined>;
}

/**
 * Build a `refine(prompt) => Promise<string>` suitable for `compressCommand({ refine })`.
 *
 * The callback runs a single non-streaming chat through the profile's provider client.
 * On any provider failure it throws; `compressCommand` catches and falls back to the
 * rule-only brief (with `uncertainty` annotated). Callers never need to handle the
 * failure path themselves.
 */
export function makeRefineCallback(
  profile: ModelProfile,
  options: MakeRefineCallbackOptions = {},
): (prompt: string) => Promise<string> {
  const client = pickProviderClient(profile);
  if (!client) {
    // Defer the error to call-time so the orchestrator can decide whether to
    // surface it or fall back. This matches the contract of every other callback
    // path — the caller catches.
    return async () => {
      throw new Error(`no provider client for transport "${profile.provider}"`);
    };
  }
  const sys = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const temperature = options.temperature ?? 0.2;
  const maxTokens = options.maxTokens ?? 800;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const env = options.env ?? {};

  return async (prompt: string): Promise<string> => {
    const chatPromise = client.chat(
      profile,
      {
        messages: [
          { role: "system", content: sys },
          { role: "user", content: prompt },
        ],
        temperature,
        maxTokens,
      },
      env,
    );
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`refine timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    const result = await Promise.race([chatPromise, timeoutPromise]);
    if (!result.ok) {
      throw new Error(`${result.code}: ${result.message}`);
    }
    return result.text;
  };
}
