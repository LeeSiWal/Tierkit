import type { ModelProfile } from "../ModelProfile.js";
import type { ProbeResult, ProviderClient } from "./types.js";
import type { ChatRequest, ChatResult, StreamEvent, ChatMessage, ToolCall } from "./chatTypes.js";
import { iterNDJSON } from "./streamUtils.js";
import { tryEnsureOllamaRunning } from "./ollamaAutoLaunch.js";

interface OllamaTagsResponse {
  models?: { name: string }[];
}

interface OllamaToolCall {
  function: {
    name: string;
    /** Ollama returns arguments as a parsed object, NOT a JSON string. */
    arguments: Record<string, unknown>;
  };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaChatResponse {
  message?: OllamaMessage;
  prompt_eval_count?: number;
  eval_count?: number;
  done_reason?: string;
}

interface OllamaStreamChunk {
  message?: { content?: string; tool_calls?: OllamaToolCall[] };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Convert Tierkit's ChatMessage to Ollama's on-the-wire format. The shapes are close to
 * identical except `toolCalls.arguments` is a JSON STRING in Tierkit/OpenAI's convention
 * but an OBJECT in Ollama's. We unwrap on the way out, re-wrap on the way back.
 */
function toOllamaMessages(messages: ChatMessage[]): OllamaMessage[] {
  return messages.map((m): OllamaMessage => {
    const base: OllamaMessage = { role: m.role, content: m.content };
    if (m.toolCalls && m.toolCalls.length > 0) {
      base.tool_calls = m.toolCalls.map((tc) => ({
        function: {
          name: tc.function.name,
          arguments: safeJsonParse(tc.function.arguments) ?? {},
        },
      }));
    }
    return base;
  });
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function ollamaToolCallsToOpenAI(ollamaToolCalls: OllamaToolCall[]): ToolCall[] {
  return ollamaToolCalls.map((tc, idx) => ({
    // Ollama doesn't generate per-call ids. Synthesize one so tool result messages can
    // reference back to it via tool_call_id.
    id: `call_${Date.now().toString(36)}_${idx}`,
    type: "function" as const,
    function: {
      name: tc.function.name,
      arguments: JSON.stringify(tc.function.arguments ?? {}),
    },
  }));
}

function isConnectionRefused(err: Error): boolean {
  return /ECONNREFUSED|fetch failed|connect ENOENT/i.test(err.message);
}

function friendlyOllamaUnreachable(baseUrl: string, err: Error): string {
  if (isConnectionRefused(err)) {
    return `cannot reach ollama at ${baseUrl} — is the daemon running? Try: ollama serve`;
  }
  return `cannot reach ollama at ${baseUrl}: ${err.message}`;
}

/**
 * Ollama probe: `GET {baseUrl}/api/tags` returns the list of locally-installed models.
 * No auth required for the default Ollama install. We additionally check whether the
 * profile's configured model appears in the returned list and report it via `modelAvailable`.
 */
async function ensureUpThenFetch(baseUrl: string, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (!isConnectionRefused(err as Error)) throw err;
    // Connection-refused on first try → attempt auto-launch + one retry.
    await tryEnsureOllamaRunning(baseUrl);
    return await fetch(url, init);
  }
}

export class OllamaClient implements ProviderClient {
  async probe(profile: ModelProfile): Promise<ProbeResult> {
    if (!profile.baseUrl) {
      return { ok: false, code: "missing-base-url", message: "ollama profile requires baseUrl", latencyMs: 0 };
    }
    const url = joinUrl(profile.baseUrl, "/api/tags");
    const start = performance.now();
    try {
      const res = await ensureUpThenFetch(profile.baseUrl, url, { method: "GET" });
      const latencyMs = Math.round(performance.now() - start);
      if (!res.ok) {
        return {
          ok: false,
          code: "bad-status",
          message: `ollama responded with ${res.status} ${res.statusText}`,
          latencyMs,
          status: res.status,
        };
      }
      const body = (await res.json()) as OllamaTagsResponse;
      const models = body.models ?? [];
      const modelCount = models.length;
      const modelAvailable = models.some((m) => m.name === profile.model || m.name.startsWith(profile.model + ":"));
      return {
        ok: true,
        modelCount,
        modelAvailable,
        latencyMs,
        note: modelAvailable
          ? `model "${profile.model}" is installed (${modelCount} total)`
          : `${modelCount} model(s) installed but "${profile.model}" is NOT one of them — run \`ollama pull ${profile.model}\``,
      };
    } catch (err) {
      return {
        ok: false,
        code: "unreachable",
        message: friendlyOllamaUnreachable(profile.baseUrl, err as Error),
        latencyMs: Math.round(performance.now() - start),
      };
    }
  }

  async chat(profile: ModelProfile, request: ChatRequest): Promise<ChatResult> {
    if (!profile.baseUrl) {
      return {
        ok: false,
        code: "missing-base-url",
        message: "ollama profile requires baseUrl",
        latencyMs: 0,
      };
    }
    const url = joinUrl(profile.baseUrl, "/api/chat");
    const body: Record<string, unknown> = {
      model: profile.model,
      messages: toOllamaMessages(request.messages),
      stream: false,
      ...(request.maxTokens !== undefined || request.temperature !== undefined
        ? {
            options: {
              ...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
              ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            },
          }
        : {}),
    };
    // Forward tools to Ollama 0.4+ (older versions ignore the field). Ollama accepts the
    // OpenAI tool format verbatim, so we just pass `request.tools` through unchanged.
    if (request.tools && request.tools.length > 0) body.tools = request.tools;
    const start = performance.now();
    try {
      const res = await ensureUpThenFetch(profile.baseUrl, url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const latencyMs = Math.round(performance.now() - start);
      if (!res.ok) {
        return {
          ok: false,
          code: "bad-status",
          message: `ollama responded with ${res.status} ${res.statusText}`,
          latencyMs,
          status: res.status,
        };
      }
      const parsed = (await res.json()) as OllamaChatResponse;
      const text = parsed.message?.content ?? "";
      const ollamaToolCalls = parsed.message?.tool_calls;
      const toolCalls = ollamaToolCalls && ollamaToolCalls.length > 0
        ? ollamaToolCallsToOpenAI(ollamaToolCalls)
        : undefined;
      return {
        ok: true,
        text,
        usage: {
          inputTokens: parsed.prompt_eval_count ?? 0,
          outputTokens: parsed.eval_count ?? 0,
        },
        latencyMs,
        model: profile.model,
        ...(toolCalls ? { toolCalls, finishReason: "tool_calls" as const } : {}),
      };
    } catch (err) {
      return {
        ok: false,
        code: "unreachable",
        message: friendlyOllamaUnreachable(profile.baseUrl, err as Error),
        latencyMs: Math.round(performance.now() - start),
      };
    }
  }

  async *stream(profile: ModelProfile, request: ChatRequest): AsyncIterable<StreamEvent> {
    if (!profile.baseUrl) {
      yield {
        type: "error",
        code: "missing-base-url",
        message: "ollama profile requires baseUrl",
        latencyMs: 0,
      };
      return;
    }
    yield { type: "start", model: profile.model, provider: "ollama" };
    const url = joinUrl(profile.baseUrl, "/api/chat");
    const body: Record<string, unknown> = {
      model: profile.model,
      messages: toOllamaMessages(request.messages),
      stream: true,
      ...(request.maxTokens !== undefined || request.temperature !== undefined
        ? {
            options: {
              ...(request.maxTokens !== undefined ? { num_predict: request.maxTokens } : {}),
              ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            },
          }
        : {}),
    };
    if (request.tools && request.tools.length > 0) body.tools = request.tools;
    const start = performance.now();
    let res: Response;
    try {
      res = await ensureUpThenFetch(profile.baseUrl, url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      yield {
        type: "error",
        code: "unreachable",
        message: friendlyOllamaUnreachable(profile.baseUrl, err as Error),
        latencyMs: Math.round(performance.now() - start),
      };
      return;
    }
    if (!res.ok) {
      yield {
        type: "error",
        code: "bad-status",
        message: `ollama responded with ${res.status} ${res.statusText}`,
        latencyMs: Math.round(performance.now() - start),
        status: res.status,
      };
      return;
    }

    let promptTokens: number | undefined;
    let evalTokens: number | undefined;
    try {
      for await (const chunk of iterNDJSON<OllamaStreamChunk>(res.body)) {
        const delta = chunk.message?.content ?? "";
        if (delta.length > 0) yield { type: "delta", text: delta };
        if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
          for (const tc of ollamaToolCallsToOpenAI(chunk.message.tool_calls)) {
            yield { type: "tool_call", toolCall: tc };
          }
        }
        if (chunk.done) {
          promptTokens = chunk.prompt_eval_count;
          evalTokens = chunk.eval_count;
        }
      }
    } catch (err) {
      yield {
        type: "error",
        code: "stream-error",
        message: `ollama stream broke mid-flight: ${(err as Error).message}`,
        latencyMs: Math.round(performance.now() - start),
      };
      return;
    }

    if (promptTokens !== undefined || evalTokens !== undefined) {
      yield {
        type: "usage",
        ...(promptTokens !== undefined ? { inputTokens: promptTokens } : {}),
        ...(evalTokens !== undefined ? { outputTokens: evalTokens } : {}),
      };
    }
    yield { type: "end", latencyMs: Math.round(performance.now() - start) };
  }
}

function joinUrl(base: string, path: string): string {
  if (base.endsWith("/")) return base.slice(0, -1) + path;
  return base + path;
}
