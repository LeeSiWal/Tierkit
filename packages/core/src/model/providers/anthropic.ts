import type { ModelProfile } from "../ModelProfile.js";
import type { ProbeResult, ProviderClient } from "./types.js";
import type { ChatRequest, ChatResult, ChatMessage, StreamEvent } from "./chatTypes.js";
import { iterSSE } from "./streamUtils.js";

interface AnthropicSSEEvent {
  type?: string;
  delta?: { type?: string; text?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface AnthropicMessagesResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Anthropic probe: `GET https://api.anthropic.com/v1/models` (or `{baseUrl}/v1/models` if custom).
 * Anthropic added a model-list endpoint in late 2024, so this is the cheapest available probe.
 * Auth header: `x-api-key`. Requires `anthropic-version` header.
 */
export class AnthropicClient implements ProviderClient {
  async probe(profile: ModelProfile, env: Record<string, string | undefined>): Promise<ProbeResult> {
    if (!profile.apiKeyEnv) {
      return {
        ok: false,
        code: "missing-api-key",
        message: "anthropic profile must declare apiKeyEnv",
        latencyMs: 0,
      };
    }
    const key = env[profile.apiKeyEnv];
    if (!key || key.length === 0) {
      return {
        ok: false,
        code: "missing-api-key",
        message: `environment variable "${profile.apiKeyEnv}" is not set or empty`,
        latencyMs: 0,
      };
    }

    const base = profile.baseUrl ?? "https://api.anthropic.com";
    const url = `${base.endsWith("/") ? base.slice(0, -1) : base}/v1/models`;
    const start = performance.now();
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          Accept: "application/json",
        },
      });
      const latencyMs = Math.round(performance.now() - start);
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          code: "unauthorized",
          message: `anthropic rejected credentials (${res.status})`,
          latencyMs,
          status: res.status,
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          code: "bad-status",
          message: `anthropic responded with ${res.status} ${res.statusText}`,
          latencyMs,
          status: res.status,
        };
      }
      const body = (await res.json()) as { data?: { id: string }[] };
      const models = body.data ?? [];
      const modelAvailable = models.some((m) => m.id === profile.model || m.id.startsWith(profile.model));
      return {
        ok: true,
        modelCount: models.length,
        modelAvailable,
        latencyMs,
        note: modelAvailable
          ? `model "${profile.model}" is available`
          : `${models.length} model(s) listed; "${profile.model}" not an exact match`,
      };
    } catch (err) {
      return {
        ok: false,
        code: "unreachable",
        message: `cannot reach anthropic: ${(err as Error).message}`,
        latencyMs: Math.round(performance.now() - start),
      };
    }
  }

  async chat(
    profile: ModelProfile,
    request: ChatRequest,
    env: Record<string, string | undefined>,
  ): Promise<ChatResult> {
    if (!profile.apiKeyEnv) {
      return { ok: false, code: "missing-api-key", message: "anthropic profile must declare apiKeyEnv", latencyMs: 0 };
    }
    const key = env[profile.apiKeyEnv];
    if (!key || key.length === 0) {
      return {
        ok: false,
        code: "missing-api-key",
        message: `environment variable "${profile.apiKeyEnv}" is not set or empty`,
        latencyMs: 0,
      };
    }

    // Anthropic separates "system" from "messages" — pull system out of the array.
    const systemParts: string[] = [];
    const messages: ChatMessage[] = [];
    for (const m of request.messages) {
      if (m.role === "system") systemParts.push(m.content);
      else messages.push(m);
    }

    const base = profile.baseUrl ?? "https://api.anthropic.com";
    const url = `${base.endsWith("/") ? base.slice(0, -1) : base}/v1/messages`;
    const body = {
      model: profile.model,
      max_tokens: request.maxTokens ?? 1024,
      messages,
      ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
    const start = performance.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
      });
      const latencyMs = Math.round(performance.now() - start);
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          code: "unauthorized",
          message: `anthropic rejected credentials (${res.status})`,
          latencyMs,
          status: res.status,
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          code: "bad-status",
          message: `anthropic responded with ${res.status} ${res.statusText}`,
          latencyMs,
          status: res.status,
        };
      }
      const parsed = (await res.json()) as AnthropicMessagesResponse;
      const text = (parsed.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      return {
        ok: true,
        text,
        usage: {
          inputTokens: parsed.usage?.input_tokens ?? 0,
          outputTokens: parsed.usage?.output_tokens ?? 0,
        },
        latencyMs,
        model: profile.model,
      };
    } catch (err) {
      return {
        ok: false,
        code: "unreachable",
        message: `cannot reach anthropic: ${(err as Error).message}`,
        latencyMs: Math.round(performance.now() - start),
      };
    }
  }

  async *stream(
    profile: ModelProfile,
    request: ChatRequest,
    env: Record<string, string | undefined>,
  ): AsyncIterable<StreamEvent> {
    if (!profile.apiKeyEnv) {
      yield {
        type: "error",
        code: "missing-api-key",
        message: "anthropic profile must declare apiKeyEnv",
        latencyMs: 0,
      };
      return;
    }
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
    yield { type: "start", model: profile.model, provider: "anthropic" };

    const systemParts: string[] = [];
    const messages: ChatMessage[] = [];
    for (const m of request.messages) {
      if (m.role === "system") systemParts.push(m.content);
      else messages.push(m);
    }
    const base = profile.baseUrl ?? "https://api.anthropic.com";
    const url = `${base.endsWith("/") ? base.slice(0, -1) : base}/v1/messages`;
    const body = {
      model: profile.model,
      max_tokens: request.maxTokens ?? 1024,
      messages,
      stream: true,
      ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };

    const start = performance.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      yield {
        type: "error",
        code: "unreachable",
        message: `cannot reach anthropic: ${(err as Error).message}`,
        latencyMs: Math.round(performance.now() - start),
      };
      return;
    }
    if (res.status === 401 || res.status === 403) {
      yield {
        type: "error",
        code: "unauthorized",
        message: `anthropic rejected credentials (${res.status})`,
        latencyMs: Math.round(performance.now() - start),
        status: res.status,
      };
      return;
    }
    if (!res.ok) {
      yield {
        type: "error",
        code: "bad-status",
        message: `anthropic responded with ${res.status} ${res.statusText}`,
        latencyMs: Math.round(performance.now() - start),
        status: res.status,
      };
      return;
    }

    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    try {
      for await (const evt of iterSSE<AnthropicSSEEvent>(res.body)) {
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
          yield { type: "delta", text: evt.delta.text };
        } else if (evt.type === "message_start" && evt.message?.usage) {
          inputTokens = evt.message.usage.input_tokens;
        } else if (evt.type === "message_delta" && evt.usage) {
          if (evt.usage.output_tokens !== undefined) outputTokens = evt.usage.output_tokens;
          if (evt.usage.input_tokens !== undefined) inputTokens = evt.usage.input_tokens;
        }
      }
    } catch (err) {
      yield {
        type: "error",
        code: "stream-error",
        message: `anthropic stream broke mid-flight: ${(err as Error).message}`,
        latencyMs: Math.round(performance.now() - start),
      };
      return;
    }
    if (inputTokens !== undefined || outputTokens !== undefined) {
      yield {
        type: "usage",
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      };
    }
    yield { type: "end", latencyMs: Math.round(performance.now() - start) };
  }
}
