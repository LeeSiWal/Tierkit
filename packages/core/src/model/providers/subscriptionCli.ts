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
    yield { type: "start", provider: profile.provider, model: profile.model };
    const r = await this.chat(profile, request, env);
    if (!r.ok) {
      yield { type: "error", code: r.code, message: r.message, latencyMs: r.latencyMs };
      return;
    }
    yield { type: "delta", text: r.text };
    yield { type: "usage", inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens };
    yield { type: "end", latencyMs: r.latencyMs };
  }
}
