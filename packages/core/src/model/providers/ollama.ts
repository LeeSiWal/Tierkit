import type { ModelProfile } from "../ModelProfile.js";
import type { ProbeResult, ProviderClient } from "./types.js";
import type { ChatRequest, ChatResult, StreamEvent, ChatMessage, ToolCall, ToolDefinition, ToolChoice } from "./chatTypes.js";
import { iterNDJSON } from "./streamUtils.js";
import { tryEnsureOllamaRunning } from "./ollamaAutoLaunch.js";

/**
 * When the caller wants `tool_choice: "required"` (or a specific function) but the model
 * is local Ollama, we can't use OpenAI's tool_choice keyword — Ollama doesn't honor it.
 * Instead we use Ollama's `format` parameter (v0.5+ accepts a JSON schema) to constrain
 * the model's text output to a JSON object naming a tool + its arguments. The text body
 * of the response becomes that JSON, which we parse here and convert into Tierkit's
 * `toolCalls` shape — invisible to the AgentLoop, which sees a normal tool_calls result.
 *
 * Tradeoff: stricter Ollama JSON-schema constraint (anyOf with per-tool argument schemas)
 * is brittle on smaller models — they sometimes 0-token or repeat. We stick to a coarse
 * schema (enum of tool_name, free-form arguments object) so the model still has room to
 * "think" while being forced into the right shape. The model has already seen each tool's
 * parameters via the `tools` array sent alongside.
 */
function buildToolChoiceFormat(
  tools: ToolDefinition[] | undefined,
  choice: ToolChoice | undefined,
): Record<string, unknown> | undefined {
  if (!tools || tools.length === 0 || !choice) return undefined;
  let names: string[] = [];
  if (choice === "required") {
    names = tools.map((t) => t.function.name);
  } else if (typeof choice === "object" && choice.type === "function") {
    names = tools.filter((t) => t.function.name === choice.function.name).map((t) => t.function.name);
  } else {
    return undefined; // "auto" / "none" don't force anything
  }
  if (names.length === 0) return undefined;
  return {
    type: "object",
    properties: {
      tool_name: { type: "string", enum: names },
      arguments: { type: "object" },
    },
    required: ["tool_name", "arguments"],
  };
}

/**
 * When `format` constraint was applied, Ollama returns the JSON document as `message.content`
 * (not `tool_calls`). Parse and adapt to OpenAI-shape toolCalls so downstream code (AgentLoop,
 * openaiCompat walker) can treat it identically.
 */
function adoptFormatJsonAsToolCalls(rawContent: string | undefined): ToolCall[] | undefined {
  if (!rawContent) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as { tool_name?: unknown; arguments?: unknown };
  if (typeof obj.tool_name !== "string" || !obj.tool_name) return undefined;
  const args = obj.arguments && typeof obj.arguments === "object" && !Array.isArray(obj.arguments)
    ? (obj.arguments as Record<string, unknown>)
    : {};
  return [
    {
      id: `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      type: "function",
      function: { name: obj.tool_name, arguments: JSON.stringify(args) },
    },
  ];
}

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
    // tool_choice: "required" → use Ollama's JSON-schema `format` to force the model to
    // emit a tool-call envelope. See buildToolChoiceFormat for the schema shape.
    const forcedFormat = buildToolChoiceFormat(request.tools, request.toolChoice);
    if (forcedFormat) body.format = forcedFormat;
    const start = performance.now();
    try {
      const res = await ensureUpThenFetch(profile.baseUrl, url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const latencyMs = Math.round(performance.now() - start);
      if (!res.ok) {
        const friendly = res.status === 404 ? await describeOllama404(profile.baseUrl, profile.model) : null;
        return {
          ok: false,
          code: "bad-status",
          message: friendly ?? `ollama responded with ${res.status} ${res.statusText}`,
          latencyMs,
          status: res.status,
        };
      }
      const parsed = (await res.json()) as OllamaChatResponse;
      const text = parsed.message?.content ?? "";
      const ollamaToolCalls = parsed.message?.tool_calls;
      // Prefer native tool_calls (Ollama 0.4+ structured output). Fall back to parsing the
      // forced-JSON envelope ONLY when our forced-format path is active and no native
      // tool_calls came back — that's the local-tool_choice path.
      let toolCalls = ollamaToolCalls && ollamaToolCalls.length > 0
        ? ollamaToolCallsToOpenAI(ollamaToolCalls)
        : undefined;
      if (!toolCalls && forcedFormat) {
        toolCalls = adoptFormatJsonAsToolCalls(text);
      }
      return {
        ok: true,
        // When we adopted forced-format JSON as tool_calls, the raw JSON content is no
        // longer meant for the user — clear it so the UI doesn't show the envelope blob.
        text: toolCalls && forcedFormat ? "" : text,
        usage: {
          inputTokens: parsed.prompt_eval_count ?? 0,
          outputTokens: parsed.eval_count ?? 0,
        },
        usageSource: "provider-reported",
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
      const friendly = res.status === 404 ? await describeOllama404(profile.baseUrl, profile.model) : null;
      yield {
        type: "error",
        code: "bad-status",
        message: friendly ?? `ollama responded with ${res.status} ${res.statusText}`,
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

/**
 * Ollama returns 404 on /api/chat when the model isn't installed locally.
 * The raw "ollama responded with 404 Not Found" message is useless — the user
 * can't tell if they need to start Ollama, pull a model, or fix the config.
 * Do a quick /api/tags lookup to produce an actionable message.
 *
 * Returns null on any failure (network, parse, etc.) — caller falls back to
 * the raw status text in that case.
 */
async function describeOllama404(baseUrl: string, modelName: string): Promise<string | null> {
  try {
    const res = await fetch(joinUrl(baseUrl, "/api/tags"));
    if (!res.ok) return null;
    const body = (await res.json()) as OllamaTagsResponse;
    const models = body.models ?? [];
    const has = models.some((m) => m.name === modelName || m.name.startsWith(modelName + ":"));
    if (has) return null; // model IS installed — 404 is from something else
    if (models.length === 0) {
      return `model "${modelName}" not found on ollama at ${baseUrl} — ollama is running but has no models installed. Run: ollama pull ${modelName}`;
    }
    return `model "${modelName}" not installed on ollama at ${baseUrl} (${models.length} other model(s) available). Run: ollama pull ${modelName}`;
  } catch {
    return null;
  }
}
