import type { ModelProfile } from "../ModelProfile.js";
import type { ProbeResult, ProviderClient } from "./types.js";
import type { ChatRequest, ChatResult, ChatMessage, StreamEvent, ToolDefinition, ToolCall } from "./chatTypes.js";
import { iterSSE } from "./streamUtils.js";

/**
 * Read the body of a non-2xx response and try to extract a human-readable reason. Anthropic
 * returns `{"type":"error","error":{"type":"...","message":"..."}}`. Fall back to raw text.
 * Same shape as the helper in openaiCompatible.ts — kept local to avoid coupling.
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
      // not JSON
    }
    return text.length > 240 ? text.slice(0, 240) + "…" : text;
  } catch {
    return "";
  }
}

function bad(status: number, statusText: string, body: string): string {
  const head = `anthropic responded with ${status} ${statusText}`;
  return body ? `${head} — ${body}` : head;
}

interface AnthropicSSEEvent {
  type?: string;
  index?: number;
  delta?: { type?: string; text?: string; partial_json?: string };
  content_block?: { type?: string; id?: string; name?: string; input?: Record<string, unknown> };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface AnthropicContentBlock {
  type: "text" | "tool_use" | "tool_result" | "image";
  /** type=text */
  text?: string;
  /** type=tool_use */
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  /** type=tool_result */
  tool_use_id?: string;
  content?: string;
  /** type=image */
  source?: { type: "base64"; media_type: string; data: string };
}

interface AnthropicMessagesResponse {
  content?: AnthropicContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
}

/**
 * Convert Tierkit/OpenAI tool format to Anthropic's. Mostly identical except:
 *   - Anthropic: `input_schema` (not `parameters`)
 *   - Anthropic: no `type: "function"` wrapper
 */
function toAnthropicTools(tools: ToolDefinition[]): Array<{ name: string; description?: string; input_schema: Record<string, unknown> }> {
  return tools.map((t) => ({
    name: t.function.name,
    ...(t.function.description !== undefined ? { description: t.function.description } : {}),
    input_schema: t.function.parameters ?? { type: "object", properties: {} },
  }));
}

/**
 * Convert a Tierkit message into Anthropic's wire shape. Anthropic doesn't have a separate
 * "tool" role — tool results are sent as a user message whose content is an array
 * containing one tool_result block per response. Assistant turns with tool_calls become
 * assistant messages with content arrays of tool_use blocks.
 */
function toAnthropicMessages(messages: ChatMessage[]): Array<{ role: "user" | "assistant"; content: string | AnthropicContentBlock[] }> {
  const out: Array<{ role: "user" | "assistant"; content: string | AnthropicContentBlock[] }> = [];
  for (const m of messages) {
    if (m.role === "system") continue; // pulled out separately by caller
    if (m.role === "tool") {
      // OpenAI's tool message → Anthropic's user message containing a tool_result block.
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId ?? "unknown", content: m.content }],
      });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content && m.content.length > 0) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        let input: Record<string, unknown> = {};
        try { input = JSON.parse(tc.function.arguments); } catch { /* leave empty */ }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    // User turn with vision attachments → content becomes an array of image blocks
    // followed by a text block (Anthropic vision wants images first per their docs).
    if (m.role === "user" && m.images && m.images.length > 0) {
      const blocks: AnthropicContentBlock[] = m.images.map((img) => ({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.base64 },
      }));
      if (m.content && m.content.length > 0) blocks.push({ type: "text", text: m.content });
      out.push({ role: "user", content: blocks });
      continue;
    }
    out.push({ role: m.role as "user" | "assistant", content: m.content });
  }
  return out;
}

/** Extract OpenAI-shape tool_calls from Anthropic's response content blocks. */
function anthropicContentToToolCalls(blocks: AnthropicContentBlock[]): ToolCall[] {
  return blocks
    .filter((b) => b.type === "tool_use" && b.name)
    .map((b) => ({
      id: b.id ?? `call_${Date.now().toString(36)}`,
      type: "function" as const,
      function: {
        name: b.name!,
        arguments: JSON.stringify(b.input ?? {}),
      },
    }));
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
          message: bad(res.status, res.statusText, await readErrorBody(res)),
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
    const nonSystem: ChatMessage[] = [];
    for (const m of request.messages) {
      if (m.role === "system") systemParts.push(m.content);
      else nonSystem.push(m);
    }
    const messages = toAnthropicMessages(nonSystem);

    const base = profile.baseUrl ?? "https://api.anthropic.com";
    const url = `${base.endsWith("/") ? base.slice(0, -1) : base}/v1/messages`;
    const body: Record<string, unknown> = {
      model: profile.model,
      max_tokens: request.maxTokens ?? 1024,
      messages,
      ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = toAnthropicTools(request.tools);
      // Anthropic supports tool_choice with the same auto/any/tool shapes.
      if (request.toolChoice === "required") body.tool_choice = { type: "any" };
      else if (request.toolChoice === "none") body.tool_choice = { type: "none" };
      else if (typeof request.toolChoice === "object" && request.toolChoice?.type === "function") {
        body.tool_choice = { type: "tool", name: request.toolChoice.function.name };
      }
      // "auto" or undefined → leave unset (Anthropic's default)
    }
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
          message: bad(res.status, res.statusText, await readErrorBody(res)),
          latencyMs,
          status: res.status,
        };
      }
      const parsed = (await res.json()) as AnthropicMessagesResponse;
      const blocks = parsed.content ?? [];
      const text = blocks.filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      const toolCalls = anthropicContentToToolCalls(blocks);
      const finishReason = parsed.stop_reason === "tool_use"
        ? "tool_calls"
        : parsed.stop_reason === "max_tokens"
          ? "length"
          : parsed.stop_reason === "end_turn"
            ? "stop"
            : undefined;
      return {
        ok: true,
        text,
        usage: {
          inputTokens: parsed.usage?.input_tokens ?? 0,
          outputTokens: parsed.usage?.output_tokens ?? 0,
        },
        latencyMs,
        model: profile.model,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        ...(finishReason ? { finishReason: finishReason as "stop" | "length" | "tool_calls" } : {}),
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
    const nonSystem: ChatMessage[] = [];
    for (const m of request.messages) {
      if (m.role === "system") systemParts.push(m.content);
      else nonSystem.push(m);
    }
    const messages = toAnthropicMessages(nonSystem);
    const base = profile.baseUrl ?? "https://api.anthropic.com";
    const url = `${base.endsWith("/") ? base.slice(0, -1) : base}/v1/messages`;
    const body: Record<string, unknown> = {
      model: profile.model,
      max_tokens: request.maxTokens ?? 1024,
      messages,
      stream: true,
      ...(systemParts.length > 0 ? { system: systemParts.join("\n\n") } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = toAnthropicTools(request.tools);
      if (request.toolChoice === "required") body.tool_choice = { type: "any" };
      else if (request.toolChoice === "none") body.tool_choice = { type: "none" };
      else if (typeof request.toolChoice === "object" && request.toolChoice?.type === "function") {
        body.tool_choice = { type: "tool", name: request.toolChoice.function.name };
      }
    }

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
        message: bad(res.status, res.statusText, await readErrorBody(res)),
        latencyMs: Math.round(performance.now() - start),
        status: res.status,
      };
      return;
    }

    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    // Anthropic streams tool_use as: content_block_start (with name/id) → multiple
    // input_json_delta partial_json strings → content_block_stop. We accumulate.
    const toolBlocks: Record<number, { id: string; name: string; args: string }> = {};
    try {
      for await (const evt of iterSSE<AnthropicSSEEvent>(res.body)) {
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
          yield { type: "delta", text: evt.delta.text };
        } else if (evt.type === "content_block_start" && evt.content_block?.type === "tool_use" && evt.index !== undefined) {
          toolBlocks[evt.index] = {
            id: evt.content_block.id ?? `call_${Date.now().toString(36)}_${evt.index}`,
            name: evt.content_block.name ?? "",
            args: "",
          };
        } else if (evt.type === "content_block_delta" && evt.delta?.type === "input_json_delta" && evt.index !== undefined) {
          const buf = toolBlocks[evt.index];
          if (buf && evt.delta.partial_json) buf.args += evt.delta.partial_json;
        } else if (evt.type === "content_block_stop" && evt.index !== undefined) {
          const buf = toolBlocks[evt.index];
          if (buf && buf.name) {
            yield {
              type: "tool_call",
              toolCall: {
                id: buf.id,
                type: "function",
                function: { name: buf.name, arguments: buf.args || "{}" },
              },
            };
            delete toolBlocks[evt.index];
          }
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
