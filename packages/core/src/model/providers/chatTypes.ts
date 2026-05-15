export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Optional max tokens to generate. */
  maxTokens?: number;
  /** Optional sampling temperature in [0, 2]. */
  temperature?: number;
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
  | { type: "usage"; inputTokens?: number; outputTokens?: number }
  | { type: "end"; latencyMs: number }
  | { type: "error"; code: string; message: string; latencyMs: number; status?: number };
