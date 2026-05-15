import type { ModelProfile } from "../ModelProfile.js";
import type { ChatRequest, ChatResult, StreamEvent } from "./chatTypes.js";

export interface ProbeOk {
  ok: true;
  /** Whether the provider reported the configured model is available. Undefined when the provider cannot confirm. */
  modelAvailable?: boolean;
  /** Number of models the provider listed (when available). */
  modelCount?: number;
  /** Round-trip latency in milliseconds. */
  latencyMs: number;
  /** Short human-readable note about the response. */
  note?: string;
}

export interface ProbeFail {
  ok: false;
  /** Stable code for tests / scripting (`unreachable`, `unauthorized`, `bad-status`, `not-implemented`, ...). */
  code: string;
  message: string;
  latencyMs: number;
  status?: number;
}

export type ProbeResult = ProbeOk | ProbeFail;

export interface ProviderClient {
  /**
   * Probe the provider to confirm reachability. Implementations should:
   * - Issue the **lightest possible** request (model-list endpoint where available).
   * - Time the call and return `latencyMs`.
   * - Surface auth/network errors as `ProbeFail` rather than throwing.
   */
  probe(profile: ModelProfile, env: Record<string, string | undefined>): Promise<ProbeResult>;

  /**
   * Send a chat request to the provider and return the assistant text + token usage.
   * Implementations should:
   * - Send the smallest possible request body (don't add streaming).
   * - Surface auth/network errors as `ChatFail` rather than throwing.
   * - Report `latencyMs` and a stable `code` on failure.
   */
  chat(
    profile: ModelProfile,
    request: ChatRequest,
    env: Record<string, string | undefined>,
  ): Promise<ChatResult>;

  /**
   * Streaming chat. Emits events in order: one `start`, zero or more `delta`s, optionally
   * one `usage`, exactly one terminator (`end` on success, `error` on failure).
   *
   * Implementations should:
   * - Always yield a `start` event first, including provider/model so the caller can
   *   render attribution before any text arrives.
   * - Convert transport/auth errors into a single `error` event rather than throwing.
   * - Stop reading once a terminator is yielded.
   */
  stream(
    profile: ModelProfile,
    request: ChatRequest,
    env: Record<string, string | undefined>,
  ): AsyncIterable<StreamEvent>;
}

export class ProviderError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}
