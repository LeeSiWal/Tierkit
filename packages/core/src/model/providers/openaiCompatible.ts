import type { ModelProfile } from "../ModelProfile.js";
import type { ProbeResult, ProviderClient } from "./types.js";
import type { ChatRequest, ChatResult, StreamEvent, ChatMessage, ToolCall } from "./chatTypes.js";
import { iterSSE } from "./streamUtils.js";

interface ModelsResponse {
  data?: { id: string }[];
}

/**
 * Read the body of a non-2xx response and try to extract a human-readable reason. OpenAI
 * and OpenAI-compatible APIs (Gemini's openai-compat endpoint, vLLM, etc.) typically return
 * `{"error":{"message":"…"}}` or `{"error":"…"}`. We read the body once, try JSON, fall
 * back to raw text. Returned string is short — caller decides how to format it.
 *
 * Why this matters: a bare "400 Bad Request" gives the user nothing to act on. Gemini's
 * actual response for an unknown model is "Model gemini-3.1-flash-lite not found" — much
 * more useful when surfaced.
 */
async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return "";
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } | string };
      const e = parsed.error;
      if (typeof e === "string") return e;
      if (e && typeof e === "object" && typeof e.message === "string") return e.message;
    } catch {
      // not JSON — fall through to raw text
    }
    // Truncate raw HTML/text bodies (common when a misconfigured baseUrl hits a non-API
    // endpoint). Keep enough to be useful but not flood the log/toast.
    return text.length > 240 ? text.slice(0, 240) + "…" : text;
  } catch {
    return "";
  }
}

function bad(status: number, statusText: string, body: string, provider: string): string {
  const head = `${provider} responded with ${status} ${statusText}`;
  return body ? `${head} — ${body}` : head;
}

type OpenAIWireContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface OpenAIWireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIWireContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ChatCompletionsResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ChatCompletionsStreamChunk {
  choices?: {
    delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; type?: "function"; function?: { name?: string; arguments?: string } }> };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Convert Tierkit's ChatMessage[] to the OpenAI wire format. Most fields are 1:1; the only
 * tricky bit is that OpenAI puts `tool_calls` on the assistant message and `tool_call_id`
 * on the tool message — both of those land at the top level here.
 */
function toOpenAIWireMessages(messages: ChatMessage[]): OpenAIWireMessage[] {
  return messages.map((m): OpenAIWireMessage => {
    // Vision: user turn with images becomes a content-parts array. Text part comes last
    // so the user's instructions trail the visual context — same convention vision-trained
    // models expect (Claude / GPT-4V both work either way, but trailing-text is more common).
    if (m.role === "user" && m.images && m.images.length > 0) {
      const parts: OpenAIWireContentPart[] = m.images.map((img) => ({
        type: "image_url" as const,
        image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
      }));
      if (m.content && m.content.length > 0) parts.push({ type: "text", text: m.content });
      const out: OpenAIWireMessage = { role: m.role, content: parts };
      return out;
    }
    const out: OpenAIWireMessage = { role: m.role, content: m.content };
    if (m.toolCalls && m.toolCalls.length > 0) out.tool_calls = m.toolCalls;
    if (m.toolCallId) out.tool_call_id = m.toolCallId;
    return out;
  });
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
          message: bad(res.status, res.statusText, await readErrorBody(res), profile.provider),
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
    const body: Record<string, unknown> = {
      model: profile.model,
      messages: toOpenAIWireMessages(request.messages),
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
    if (request.tools && request.tools.length > 0) body.tools = request.tools;
    if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
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
          message: bad(res.status, res.statusText, await readErrorBody(res), profile.provider),
          latencyMs,
          status: res.status,
        };
      }
      const parsed = (await res.json()) as ChatCompletionsResponse;
      const text = parsed.choices?.[0]?.message?.content ?? "";
      const toolCalls = parsed.choices?.[0]?.message?.tool_calls;
      const finishReason = parsed.choices?.[0]?.finish_reason;
      return {
        ok: true,
        text,
        usage: {
          inputTokens: parsed.usage?.prompt_tokens ?? 0,
          outputTokens: parsed.usage?.completion_tokens ?? 0,
        },
        usageSource: "provider-reported",
        latencyMs,
        model: profile.model,
        ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
        ...(finishReason === "stop" || finishReason === "length" || finishReason === "tool_calls" || finishReason === "content_filter"
          ? { finishReason: finishReason as "stop" | "length" | "tool_calls" | "content_filter" }
          : {}),
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
    const body: Record<string, unknown> = {
      model: profile.model,
      messages: toOpenAIWireMessages(request.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
    if (request.tools && request.tools.length > 0) body.tools = request.tools;
    if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
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
        message: bad(res.status, res.statusText, await readErrorBody(res), profile.provider),
        latencyMs: Math.round(performance.now() - start),
        status: res.status,
      };
      return;
    }
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    // OpenAI streams tool calls as delta fragments keyed by `index`. We accumulate per-index
    // and emit a `tool_call` event when each is complete (we use a heuristic: once we see
    // a new index OR the stream ends without arguments having grown — at end of stream).
    const toolCallBuffers: Record<number, { id?: string; name?: string; arguments: string }> = {};
    try {
      for await (const chunk of iterSSE<ChatCompletionsStreamChunk>(res.body)) {
        const choice = chunk.choices?.[0];
        const delta = choice?.delta?.content;
        if (delta && delta.length > 0) yield { type: "delta", text: delta };
        if (choice?.delta?.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            const buf = toolCallBuffers[tc.index] ?? { arguments: "" };
            if (tc.id) buf.id = tc.id;
            if (tc.function?.name) buf.name = tc.function.name;
            if (tc.function?.arguments) buf.arguments += tc.function.arguments;
            toolCallBuffers[tc.index] = buf;
          }
        }
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens;
          completionTokens = chunk.usage.completion_tokens;
        }
      }
      // End of stream: flush any tool call buffers.
      for (const buf of Object.values(toolCallBuffers)) {
        if (buf.name) {
          yield {
            type: "tool_call",
            toolCall: {
              id: buf.id ?? `call_${Date.now().toString(36)}`,
              type: "function",
              function: { name: buf.name, arguments: buf.arguments || "{}" },
            },
          };
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
