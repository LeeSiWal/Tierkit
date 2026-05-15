import type { ModelProfile } from "../ModelProfile.js";
import type { ProbeResult, ProviderClient } from "./types.js";
import type { ChatRequest, ChatResult, StreamEvent } from "./chatTypes.js";
import { iterSSE } from "./streamUtils.js";

interface ModelsResponse {
  data?: { id: string }[];
}

interface ChatCompletionsResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ChatCompletionsStreamChunk {
  choices?: { delta?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Probe for `openai` and `openai-compatible` providers.
 * Endpoint: `GET {baseUrl}/models` (or `/v1/models` if baseUrl doesn't already end in `/v1`).
 * Requires a Bearer token resolved from `profile.apiKeyEnv`. If the env var is missing,
 * returns a clean `missing-api-key` failure rather than sending an empty auth header.
 */
export class OpenAICompatibleClient implements ProviderClient {
  async probe(profile: ModelProfile, env: Record<string, string | undefined>): Promise<ProbeResult> {
    if (!profile.baseUrl) {
      return {
        ok: false,
        code: "missing-base-url",
        message: `${profile.provider} profile requires baseUrl`,
        latencyMs: 0,
      };
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (profile.apiKeyEnv) {
      const key = env[profile.apiKeyEnv];
      if (!key || key.length === 0) {
        return {
          ok: false,
          code: "missing-api-key",
          message: `environment variable "${profile.apiKeyEnv}" is not set or empty`,
          latencyMs: 0,
        };
      }
      headers["Authorization"] = `Bearer ${key}`;
    }

    const url = buildModelsUrl(profile.baseUrl);
    const start = performance.now();
    try {
      const res = await fetch(url, { method: "GET", headers });
      const latencyMs = Math.round(performance.now() - start);
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          code: "unauthorized",
          message: `${profile.provider} rejected credentials (${res.status})`,
          latencyMs,
          status: res.status,
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          code: "bad-status",
          message: `${profile.provider} responded with ${res.status} ${res.statusText}`,
          latencyMs,
          status: res.status,
        };
      }
      const body = (await res.json()) as ModelsResponse;
      const models = body.data ?? [];
      const modelCount = models.length;
      const modelAvailable = models.some((m) => m.id === profile.model);
      return {
        ok: true,
        modelCount,
        modelAvailable,
        latencyMs,
        note: modelAvailable
          ? `model "${profile.model}" is available (${modelCount} listed)`
          : modelCount > 0
            ? `${modelCount} model(s) listed but "${profile.model}" is NOT one of them`
            : `provider returned an empty model list`,
      };
    } catch (err) {
      return {
        ok: false,
        code: "unreachable",
        message: `cannot reach ${profile.provider} at ${profile.baseUrl}: ${(err as Error).message}`,
        latencyMs: Math.round(performance.now() - start),
      };
    }
  }

  async chat(
    profile: ModelProfile,
    request: ChatRequest,
    env: Record<string, string | undefined>,
  ): Promise<ChatResult> {
    if (!profile.baseUrl) {
      return { ok: false, code: "missing-base-url", message: `${profile.provider} profile requires baseUrl`, latencyMs: 0 };
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      Accept: "application/json",
    };
    if (profile.apiKeyEnv) {
      const key = env[profile.apiKeyEnv];
      if (!key || key.length === 0) {
        return {
          ok: false,
          code: "missing-api-key",
          message: `environment variable "${profile.apiKeyEnv}" is not set or empty`,
          latencyMs: 0,
        };
      }
      headers["Authorization"] = `Bearer ${key}`;
    }
    const url = buildChatUrl(profile.baseUrl);
    const body = {
      model: profile.model,
      messages: request.messages,
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
    const start = performance.now();
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      const latencyMs = Math.round(performance.now() - start);
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          code: "unauthorized",
          message: `${profile.provider} rejected credentials (${res.status})`,
          latencyMs,
          status: res.status,
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          code: "bad-status",
          message: `${profile.provider} responded with ${res.status} ${res.statusText}`,
          latencyMs,
          status: res.status,
        };
      }
      const parsed = (await res.json()) as ChatCompletionsResponse;
      const text = parsed.choices?.[0]?.message?.content ?? "";
      return {
        ok: true,
        text,
        usage: {
          inputTokens: parsed.usage?.prompt_tokens ?? 0,
          outputTokens: parsed.usage?.completion_tokens ?? 0,
        },
        latencyMs,
        model: profile.model,
      };
    } catch (err) {
      return {
        ok: false,
        code: "unreachable",
        message: `cannot reach ${profile.provider} at ${profile.baseUrl}: ${(err as Error).message}`,
        latencyMs: Math.round(performance.now() - start),
      };
    }
  }

  async *stream(
    profile: ModelProfile,
    request: ChatRequest,
    env: Record<string, string | undefined>,
  ): AsyncIterable<StreamEvent> {
    if (!profile.baseUrl) {
      yield {
        type: "error",
        code: "missing-base-url",
        message: `${profile.provider} profile requires baseUrl`,
        latencyMs: 0,
      };
      return;
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      Accept: "text/event-stream",
    };
    if (profile.apiKeyEnv) {
      const key = env[profile.apiKeyEnv];
      if (!key || key.length === 0) {
        yield {
          type: "error",
          code: "missing-api-key",
          message: `environment variable "${profile.apiKeyEnv}" is not set or empty`,
          latencyMs: 0,
        };
        return;
      }
      headers["Authorization"] = `Bearer ${key}`;
    }
    yield { type: "start", model: profile.model, provider: profile.provider };

    const url = buildChatUrl(profile.baseUrl);
    const body = {
      model: profile.model,
      messages: request.messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
    const start = performance.now();
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (err) {
      yield {
        type: "error",
        code: "unreachable",
        message: `cannot reach ${profile.provider} at ${profile.baseUrl}: ${(err as Error).message}`,
        latencyMs: Math.round(performance.now() - start),
      };
      return;
    }
    if (res.status === 401 || res.status === 403) {
      yield {
        type: "error",
        code: "unauthorized",
        message: `${profile.provider} rejected credentials (${res.status})`,
        latencyMs: Math.round(performance.now() - start),
        status: res.status,
      };
      return;
    }
    if (!res.ok) {
      yield {
        type: "error",
        code: "bad-status",
        message: `${profile.provider} responded with ${res.status} ${res.statusText}`,
        latencyMs: Math.round(performance.now() - start),
        status: res.status,
      };
      return;
    }
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    try {
      for await (const chunk of iterSSE<ChatCompletionsStreamChunk>(res.body)) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta && delta.length > 0) yield { type: "delta", text: delta };
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens;
          completionTokens = chunk.usage.completion_tokens;
        }
      }
    } catch (err) {
      yield {
        type: "error",
        code: "stream-error",
        message: `${profile.provider} stream broke mid-flight: ${(err as Error).message}`,
        latencyMs: Math.round(performance.now() - start),
      };
      return;
    }
    if (promptTokens !== undefined || completionTokens !== undefined) {
      yield {
        type: "usage",
        ...(promptTokens !== undefined ? { inputTokens: promptTokens } : {}),
        ...(completionTokens !== undefined ? { outputTokens: completionTokens } : {}),
      };
    }
    yield { type: "end", latencyMs: Math.round(performance.now() - start) };
  }
}

function buildChatUrl(baseUrl: string): string {
  const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${trimmed}/chat/completions`;
}

function buildModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  if (trimmed.endsWith("/v1") || trimmed.endsWith("/v2")) {
    return `${trimmed}/models`;
  }
  return `${trimmed}/models`;
}
