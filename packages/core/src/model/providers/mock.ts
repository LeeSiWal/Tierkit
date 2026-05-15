import type { ModelProfile } from "../ModelProfile.js";
import type { ProbeResult, ProviderClient } from "./types.js";
import type { ChatRequest, ChatResult, StreamEvent } from "./chatTypes.js";

/**
 * Test-only provider client. Returns canned responses for `probe()`, `chat()`, and `stream()`
 * so usecases can be tested without hitting any real network. Call sites configure the
 * canned output via the constructor.
 *
 * For streaming, the `chunks` are emitted as `delta` events in order, followed by an `end`
 * event. Pass `failWith` to short-circuit any call with a `ProbeFail` / `ChatFail` / error
 * `StreamEvent`.
 */
export interface MockModelClientOptions {
  text?: string;
  chunks?: string[];
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  failWith?: { code: string; message: string; status?: number };
}

export class MockModelClient implements ProviderClient {
  private opts: MockModelClientOptions;
  /** Tracks all calls for assertions in tests. */
  public readonly calls: { kind: "probe" | "chat" | "stream"; profile: string; request?: ChatRequest }[] = [];

  constructor(opts: MockModelClientOptions = {}) {
    this.opts = opts;
  }

  async probe(profile: ModelProfile): Promise<ProbeResult> {
    this.calls.push({ kind: "probe", profile: profile.model });
    if (this.opts.failWith) {
      return {
        ok: false,
        code: this.opts.failWith.code,
        message: this.opts.failWith.message,
        latencyMs: this.opts.latencyMs ?? 0,
        ...(this.opts.failWith.status !== undefined ? { status: this.opts.failWith.status } : {}),
      };
    }
    return {
      ok: true,
      modelCount: 1,
      modelAvailable: true,
      latencyMs: this.opts.latencyMs ?? 0,
      note: `(mock) model "${profile.model}" available`,
    };
  }

  async chat(profile: ModelProfile, request: ChatRequest): Promise<ChatResult> {
    this.calls.push({ kind: "chat", profile: profile.model, request });
    if (this.opts.failWith) {
      return {
        ok: false,
        code: this.opts.failWith.code,
        message: this.opts.failWith.message,
        latencyMs: this.opts.latencyMs ?? 0,
        ...(this.opts.failWith.status !== undefined ? { status: this.opts.failWith.status } : {}),
      };
    }
    const text = this.opts.text ?? (this.opts.chunks?.join("") ?? "");
    return {
      ok: true,
      text,
      usage: {
        inputTokens: this.opts.inputTokens ?? 0,
        outputTokens: this.opts.outputTokens ?? text.length,
      },
      latencyMs: this.opts.latencyMs ?? 0,
      model: profile.model,
    };
  }

  async *stream(profile: ModelProfile, request: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls.push({ kind: "stream", profile: profile.model, request });
    yield { type: "start", model: profile.model, provider: profile.provider };
    if (this.opts.failWith) {
      yield {
        type: "error",
        code: this.opts.failWith.code,
        message: this.opts.failWith.message,
        latencyMs: this.opts.latencyMs ?? 0,
        ...(this.opts.failWith.status !== undefined ? { status: this.opts.failWith.status } : {}),
      };
      return;
    }
    const chunks = this.opts.chunks ?? (this.opts.text ? [this.opts.text] : []);
    for (const c of chunks) yield { type: "delta", text: c };
    if (this.opts.inputTokens !== undefined || this.opts.outputTokens !== undefined) {
      yield {
        type: "usage",
        ...(this.opts.inputTokens !== undefined ? { inputTokens: this.opts.inputTokens } : {}),
        ...(this.opts.outputTokens !== undefined ? { outputTokens: this.opts.outputTokens } : {}),
      };
    }
    yield { type: "end", latencyMs: this.opts.latencyMs ?? 0 };
  }
}
