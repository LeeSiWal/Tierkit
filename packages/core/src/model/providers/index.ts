import type { ModelProfile } from "../ModelProfile.js";
import type { ProviderClient } from "./types.js";
import { OllamaClient } from "./ollama.js";
import { OpenAICompatibleClient } from "./openaiCompatible.js";
import { AnthropicClient } from "./anthropic.js";

/**
 * Pick the probe client for a model profile based on its `provider` field.
 * Returns `undefined` for providers we have not yet implemented; callers should
 * surface `not-implemented` rather than guessing.
 */
export function pickProviderClient(profile: ModelProfile): ProviderClient | undefined {
  const p = profile.provider.toLowerCase();
  if (p === "ollama") return new OllamaClient();
  if (p === "openai" || p === "openai-compatible") return new OpenAICompatibleClient();
  if (p === "anthropic") return new AnthropicClient();
  return undefined;
}

export { OllamaClient, OpenAICompatibleClient, AnthropicClient };
export type { ProbeResult, ProbeOk, ProbeFail, ProviderClient } from "./types.js";
export { ProviderError } from "./types.js";
