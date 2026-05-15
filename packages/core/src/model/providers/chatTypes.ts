/**
 * Tool / ToolCall types follow OpenAI's Chat Completions API shape — that's the most
 * widely-adopted format and what coding agents (Roo, Cline, Continue, aider, etc.) send.
 * Provider-specific adapters (Anthropic, Ollama) convert between these and the upstream's
 * native format.
 */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    /** JSON Schema for the function's parameters. Provider clients forward this verbatim. */
    parameters?: Record<string, unknown>;
  };
}

export type ToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; function: { name: string } };

/** A single model-requested tool invocation, in the response. */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** Arguments object serialized as a JSON string (OpenAI's contract). */
    arguments: string;
  };
}

/**
 * Messages exchanged with a chat model. Extends the basic system/user/assistant trio with
 * the "tool" role and the assistant's optional `tool_calls` field, mirroring OpenAI's
 * multi-turn tool-use conversation format:
 *
 *   1. user:      "list files in src"
 *   2. assistant: { tool_calls: [{ id: "abc", function: { name: "list_files", arguments: "..." } }] }
 *   3. tool:      { tool_call_id: "abc", content: "['foo.ts', 'bar.ts']" }
 *   4. assistant: "I found 2 files: foo.ts and bar.ts."
 *
 * The provider-specific adapters convert this shape to the native one for each backend.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** May be empty when the assistant turn carries `toolCalls` instead of text. */
  content: string;
  /** Assistant-role only: tool invocations the model is requesting. */
  toolCalls?: ToolCall[];
  /** Tool-role only: identifies which assistant tool_call this message responds to. */
  toolCallId?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Optional max tokens to generate. */
  maxTokens?: number;
  /** Optional sampling temperature in [0, 2]. */
  temperature?: number;
  /** Tools the model may call. Forwarded to the provider when the provider supports it. */
  tools?: ToolDefinition[];
  /** Constraint on which tool (if any) the model must call. Default: "auto" when tools are provided. */
  toolChoice?: ToolChoice;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatOk {
  ok: true;
  text: string;
  usage: ChatUsage;
  latencyMs: number;
  model: string;
  /** Present when the model asked to invoke one or more tools (instead of/along with text). */
  toolCalls?: ToolCall[];
  /** Reason the model stopped: "stop" | "length" | "tool_calls" | "content_filter". */
  finishReason?: "stop" | "length" | "tool_calls" | "content_filter";
}

export interface ChatFail {
  ok: false;
  code: string;
  message: string;
  latencyMs: number;
  status?: number;
}

export type ChatResult = ChatOk | ChatFail;

/**
 * Discriminated-union event emitted by `ProviderClient.stream()`.
 *
 * Consumers iterate over the AsyncIterable and switch on `type`. Every successful stream
 * MUST emit exactly one `start`, zero or more `delta`s, optionally one `usage`, and exactly
 * one terminator (`end` for success, `error` for failure). After a terminator no more events
 * are emitted.
 */
export type StreamEvent =
  | { type: "start"; model: string; provider: string }
  | { type: "delta"; text: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "end"; latencyMs: number }
  | { type: "error"; code: string; message: string; latencyMs: number; status?: number };
