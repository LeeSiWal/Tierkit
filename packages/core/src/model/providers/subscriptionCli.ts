import { spawn } from "node:child_process";
import type { ModelProfile } from "../ModelProfile.js";
import type { ProviderClient, ProbeResult } from "./types.js";
import type { ChatRequest, ChatResult, ChatMessage, StreamEvent } from "./chatTypes.js";
import { estimateTokensFromText } from "./estimateTokens.js";

export interface SubscriptionCliParsedResult {
  content: string;
  inputTokens?: number;
  outputTokens?: number;
  raw: unknown;
}

interface SpawnOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  spawnError?: NodeJS.ErrnoException;
}

interface SpawnOptions {
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  stdin?: string;
}

function runSubprocess(command: string, args: string[], opts: SpawnOptions): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }, opts.timeoutMs);

    function finish(outcome: SpawnOutcome): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    }

    child.stdout!.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= opts.maxStdoutBytes) { stdoutTruncated = true; return; }
      const remaining = opts.maxStdoutBytes - stdoutBytes;
      if (chunk.length > remaining) {
        stdout += chunk.toString("utf8", 0, remaining);
        stdoutBytes += remaining;
        stdoutTruncated = true;
        try { child.kill("SIGKILL"); } catch { /* */ }
      } else {
        stdout += chunk.toString("utf8");
        stdoutBytes += chunk.length;
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderrBytes >= opts.maxStderrBytes) { stderrTruncated = true; return; }
      const remaining = opts.maxStderrBytes - stderrBytes;
      if (chunk.length > remaining) {
        stderr += chunk.toString("utf8", 0, remaining);
        stderrBytes += remaining;
        stderrTruncated = true;
      } else {
        stderr += chunk.toString("utf8");
        stderrBytes += chunk.length;
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      finish({ stdout, stderr, code: null, timedOut, stdoutTruncated, stderrTruncated, spawnError: err });
    });
    child.on("close", (code) => {
      finish({ stdout, stderr, code, timedOut, stdoutTruncated, stderrTruncated });
    });

    if (opts.stdin !== undefined) {
      child.stdin!.end(opts.stdin, "utf8");
    } else {
      child.stdin!.end();
    }
  });
}

function serializeMessages(messages: ChatMessage[]): string {
  const labelFor = (role: string): string => {
    if (role === "system" || role === "developer") return "System";
    if (role === "assistant") return "Assistant";
    if (role === "tool") return "Tool result";
    return "User";
  };
  return messages
    .map((m) => `${labelFor(m.role)}:\n${typeof m.content === "string" ? m.content : ""}`)
    .join("\n\n");
}

function isNonNegativeFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

export abstract class SubscriptionCliProvider implements ProviderClient {
  abstract buildArgs(profile: ModelProfile): string[];
  abstract parseStdout(stdout: string): SubscriptionCliParsedResult;

  /**
   * Returns CLI args for streaming mode. Subclasses that support native
   * stream-json output (e.g. ClaudeCodeProvider) override this to supply the
   * appropriate flags. The default falls back to non-streaming args so that the
   * stream() implementation can gracefully degrade when not overridden.
   */
  streamArgs(profile: ModelProfile): string[] {
    return this.buildArgs(profile);
  }

  /**
   * Parse one newline-delimited JSON line from a stream-json stdout and return
   * the text delta it contains, or undefined if the line carries no text.
   *
   * The default impl returns undefined (not stream-aware). Subclasses that
   * override streamArgs() should also override this method.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  parseStreamLine(_line: string): string | undefined {
    return undefined;
  }

  async probe(profile: ModelProfile, _env: Record<string, string | undefined>): Promise<ProbeResult> {
    const t = profile.transport;
    if (!t || t.type !== "subprocess") {
      return { ok: false, code: "not-implemented", message: "profile has no subprocess transport", latencyMs: 0 };
    }
    const started = Date.now();
    const out = await runSubprocess(t.command, t.healthCheckArgs, {
      timeoutMs: Math.min(1_500, t.timeoutMs),
      maxStdoutBytes: 10_000,
      maxStderrBytes: 10_000,
    });
    const latencyMs = Date.now() - started;
    if (out.spawnError && (out.spawnError.code === "ENOENT" || out.spawnError.code === "EACCES")) {
      return { ok: false, code: "cli-not-found", message: out.spawnError.message, latencyMs };
    }
    if (out.timedOut) {
      return { ok: false, code: "cli-healthcheck-failed", message: "healthcheck timed out", latencyMs };
    }
    if (out.code !== 0) {
      return { ok: false, code: "cli-healthcheck-failed", message: out.stderr.trim() || `exit ${out.code}`, latencyMs };
    }
    return { ok: true, latencyMs };
  }

  async chat(
    profile: ModelProfile,
    request: ChatRequest,
    _env: Record<string, string | undefined>,
  ): Promise<ChatResult> {
    const t = profile.transport;
    if (!t || t.type !== "subprocess") {
      return { ok: false, code: "not-implemented", message: "profile has no subprocess transport", latencyMs: 0 };
    }
    const prompt = serializeMessages(request.messages);
    const started = Date.now();
    const out = await runSubprocess(t.command, this.buildArgs(profile), {
      timeoutMs: t.timeoutMs,
      maxStdoutBytes: t.maxStdoutBytes,
      maxStderrBytes: t.maxStderrBytes,
      stdin: prompt,
    });
    const latencyMs = Date.now() - started;

    if (out.spawnError && (out.spawnError.code === "ENOENT" || out.spawnError.code === "EACCES")) {
      return { ok: false, code: "cli-not-found", message: out.spawnError.message, latencyMs };
    }
    if (out.timedOut) {
      return { ok: false, code: "cli-timeout", message: out.stderr.trim() || "subprocess exceeded timeoutMs", latencyMs };
    }
    if (out.stdoutTruncated) {
      return { ok: false, code: "cli-output-too-large", message: "stdout exceeded maxStdoutBytes", latencyMs };
    }
    if (out.code !== 0) {
      return { ok: false, code: "cli-exit-nonzero", message: out.stderr.trim() || `exit ${out.code}`, latencyMs };
    }

    let parsed: SubscriptionCliParsedResult;
    try {
      parsed = this.parseStdout(out.stdout);
    } catch {
      const trimmed = out.stdout.trim();
      if (!trimmed) {
        return { ok: false, code: "cli-empty-output", message: out.stderr.trim() || "empty stdout", latencyMs };
      }
      parsed = { content: trimmed, raw: out.stdout };
    }
    if (!parsed.content) {
      return { ok: false, code: "cli-empty-output", message: out.stderr.trim() || "parser returned empty content", latencyMs };
    }

    const inputTokensRaw = parsed.inputTokens;
    const outputTokensRaw = parsed.outputTokens;
    const hasFullUsage = isNonNegativeFiniteNumber(inputTokensRaw) && isNonNegativeFiniteNumber(outputTokensRaw);
    const inputTokens = hasFullUsage ? inputTokensRaw : estimateTokensFromText(prompt);
    const outputTokens = hasFullUsage ? outputTokensRaw : estimateTokensFromText(parsed.content);

    return {
      ok: true,
      text: parsed.content,
      usage: { inputTokens, outputTokens },
      latencyMs,
      model: profile.model,
      usageSource: hasFullUsage ? "provider-reported" : "estimated",
    };
  }

  async *stream(
    profile: ModelProfile,
    request: ChatRequest,
    env: Record<string, string | undefined>,
  ): AsyncIterable<StreamEvent> {
    const t = profile.transport;
    if (!t || t.type !== "subprocess") {
      yield { type: "start", provider: profile.provider, model: profile.model };
      yield { type: "error", code: "not-implemented", message: "profile has no subprocess transport", latencyMs: 0 };
      return;
    }

    yield { type: "start", provider: profile.provider, model: profile.model };

    const argsResolved = this.streamArgs(profile);
    const prompt = serializeMessages(request.messages);
    const started = Date.now();

    // Collect resolved events from subprocess into a queue that we drain via the
    // async generator. Node event handlers cannot yield directly, so we bridge
    // them through a simple push/pull queue with a Promise-based wakeup.
    const queue: StreamEvent[] = [];
    let wakeup: (() => void) | undefined;
    let closed = false;

    const push = (ev: StreamEvent): void => {
      queue.push(ev);
      wakeup?.();
    };

    const child = spawn(t.command, argsResolved, { stdio: ["pipe", "pipe", "pipe"] });

    // fullStdout accumulates every byte for the final parseStdout call (usage extraction).
    // lineBuffer holds the current incomplete line as we stream.
    let fullStdout = "";
    let lineBuffer = "";
    let fullStdoutBytes = 0;
    let stdoutTruncated = false;
    let stderrBuf = "";
    let stderrBytes = 0;
    let timedOut = false;
    let deltaCount = 0;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }, t.timeoutMs);

    child.stdout!.on("data", (chunk: Buffer) => {
      if (fullStdoutBytes >= t.maxStdoutBytes) {
        stdoutTruncated = true;
        try { child.kill("SIGKILL"); } catch { /* */ }
        return;
      }
      const maxRemaining = t.maxStdoutBytes - fullStdoutBytes;
      const sliceLen = Math.min(chunk.length, maxRemaining);
      const slice = chunk.toString("utf8", 0, sliceLen);
      if (chunk.length > maxRemaining) stdoutTruncated = true;

      fullStdout += slice;
      fullStdoutBytes += slice.length;
      lineBuffer += slice;

      // Parse complete newline-delimited lines and emit delta events immediately.
      let nl: number;
      while ((nl = lineBuffer.indexOf("\n")) !== -1) {
        const line = lineBuffer.slice(0, nl);
        lineBuffer = lineBuffer.slice(nl + 1);
        const text = this.parseStreamLine(line);
        if (text !== undefined && text.length > 0) {
          deltaCount++;
          push({ type: "delta", text });
        }
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderrBytes >= t.maxStderrBytes) return;
      const remaining = t.maxStderrBytes - stderrBytes;
      const slice = chunk.length > remaining
        ? chunk.toString("utf8", 0, remaining)
        : chunk.toString("utf8");
      stderrBuf += slice;
      stderrBytes += slice.length;
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      if (err.code === "ENOENT" || err.code === "EACCES") {
        push({ type: "error", code: "cli-not-found", message: err.message, latencyMs });
      } else {
        push({ type: "error", code: "cli-spawn-error", message: err.message, latencyMs });
      }
      closed = true;
      wakeup?.();
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const latencyMs = Date.now() - started;

      // Flush any remaining incomplete line in lineBuffer
      const tail = lineBuffer.trim();
      if (tail.length > 0) {
        const text = this.parseStreamLine(tail);
        if (text !== undefined && text.length > 0) {
          deltaCount++;
          push({ type: "delta", text });
        }
      }

      if (timedOut) {
        push({ type: "error", code: "cli-timeout", message: stderrBuf.trim() || "subprocess exceeded timeoutMs", latencyMs });
        closed = true;
        wakeup?.();
        return;
      }
      if (stdoutTruncated) {
        push({ type: "error", code: "cli-output-too-large", message: "stdout exceeded maxStdoutBytes", latencyMs });
        closed = true;
        wakeup?.();
        return;
      }
      if (code !== 0) {
        push({ type: "error", code: "cli-exit-nonzero", message: stderrBuf.trim() || `exit ${code}`, latencyMs });
        closed = true;
        wakeup?.();
        return;
      }

      // Parse the full accumulated stdout for usage info.
      let parsed: SubscriptionCliParsedResult | undefined;
      try {
        parsed = this.parseStdout(fullStdout);
      } catch {
        const raw = fullStdout.trim();
        if (raw) parsed = { content: raw, raw: fullStdout };
      }

      // Graceful fallback: if no streaming deltas were emitted (provider doesn't support
      // stream-json), fall back to emitting the full parsed content as a single delta.
      if (deltaCount === 0) {
        if (parsed && parsed.content) {
          push({ type: "delta", text: parsed.content });
        } else {
          push({ type: "error", code: "cli-empty-output", message: stderrBuf.trim() || "empty stdout", latencyMs });
          closed = true;
          wakeup?.();
          return;
        }
      }

      const inputTokensRaw = parsed?.inputTokens;
      const outputTokensRaw = parsed?.outputTokens;
      const hasFullUsage = isNonNegativeFiniteNumber(inputTokensRaw) && isNonNegativeFiniteNumber(outputTokensRaw);
      const inputTokens = hasFullUsage ? inputTokensRaw : estimateTokensFromText(prompt);
      const outputTokens = hasFullUsage ? outputTokensRaw : estimateTokensFromText(parsed?.content ?? "");

      push({ type: "usage", inputTokens, outputTokens });
      push({ type: "end", latencyMs });
      closed = true;
      wakeup?.();
    });

    child.stdin!.end(prompt, "utf8");

    // Drain the event queue until the subprocess closes.
    while (!closed || queue.length > 0) {
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      if (!closed) {
        await new Promise<void>((r) => { wakeup = r; });
        wakeup = undefined;
      }
    }
  }
}
