import type { ModelProfile } from "../ModelProfile.js";
import type { ProviderClient } from "./types.js";
import { OllamaClient } from "./ollama.js";
import { OpenAICompatibleClient } from "./openaiCompatible.js";
import { AnthropicClient } from "./anthropic.js";
import { ClaudeCodeProvider } from "./claudeCode.js";
import { MockModelClient } from "./mock.js";

/**
 * Pick the probe client for a model profile based on its `provider` field.
 * Returns `undefined` for providers we have not yet implemented; callers should
 * surface `not-implemented` rather than guessing.
 *
 * Note: `mock` is intentionally registered for tests + dry-runs. It returns deterministic
 * canned responses without touching the network. Production profiles should never use it.
 */
export function pickProviderClient(profile: ModelProfile): ProviderClient | undefined {
  const p = profile.provider.toLowerCase();
  if (p === "ollama") return new OllamaClient();
  if (p === "openai" || p === "openai-compatible") return new OpenAICompatibleClient();
  if (p === "anthropic") return new AnthropicClient();
  if (p === "claude-code") return new ClaudeCodeProvider();
  if (p === "mock") return new MockModelClient();
  return undefined;
}

export { OllamaClient, OpenAICompatibleClient, AnthropicClient, ClaudeCodeProvider, MockModelClient };
export type { ProbeResult, ProbeOk, ProbeFail, ProviderClient } from "./types.js";
export { ProviderError } from "./types.js";
