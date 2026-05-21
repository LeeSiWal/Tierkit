import { spawn } from "node:child_process";
import { classifyCommand } from "@tierkit/core";
import { redactOutput } from "../redactOutput.js";

export interface RunCommandInput {
  workspaceRoot: string;
  command: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export type RunCommandResult =
  | {
      ok: true;
      exitCode: number;
      stdout: string;
      stderr: string;
      truncated: boolean;
      durationMs: number;
      redactionHits?: Array<{ ruleId: string; count: number }>;
    }
  | {
      ok: false;
      code: string;            // "command-blocked" | "approval-required" | "command-timeout" | "spawn-failed"
      message: string;
      classification?: string; // severity level for caller's telemetry
      // No `approval` envelope on run_command — v0.15.0 does not execute approval-required commands
      // even after manual approval. A command-ticket flow lands in v0.15.1.
    };

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_STDOUT = 1 * 1024 * 1024;
const DEFAULT_MAX_STDERR = 256 * 1024;

const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "SHELL"];

function sanitizeEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) {
    const v = process.env[k];
    if (typeof v === "string") out[k] = v;
  }
  // Mark the child as Tierkit-spawned for telemetry breadcrumbs (no PII).
  out.TIERKIT_SPAWNED = "mcp-run_command";
  return out;
}

export async function runCommandTool(input: RunCommandInput): Promise<RunCommandResult> {
  // classifyCommand returns { severity: "ok" | "warn" | "block", ... }
  // "ok"   → safe to execute
  // "warn" → approval-required (non-safe, non-blocked)
  // "block" → hard-blocked, never execute
  const c = classifyCommand(input.command);

  if (c.severity === "block") {
    const reason = c.matched.map((m) => m.description).join("; ");
    return {
      ok: false,
      code: "command-blocked",
      message: `command is hard-blocked: ${reason || "blocked by classifier"}`,
      classification: c.severity,
    };
  }

  if (c.severity !== "ok") {
    // v0.15.0: anything not classified as severity="ok" (i.e. "warn") is rejected with
    // approval-required. We do NOT execute these commands. A command-ticket flow lands in v0.15.1.
    const reason = c.matched.map((m) => m.description).join("; ");
    return {
      ok: false,
      code: "approval-required",
      message:
        `command requires approval: ${reason || "non-safe classification"}. ` +
        `v0.15.0 does not execute approval-required commands through MCP yet — ` +
        `run the command yourself in your shell, or wait for v0.15.1.`,
      classification: c.severity,
    };
  }

  const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const maxStdoutBytes = input.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  const maxStderrBytes = input.maxStderrBytes ?? DEFAULT_MAX_STDERR;
  const started = Date.now();

  return new Promise<RunCommandResult>((resolve) => {
    const child = spawn(input.command, {
      shell: true,
      cwd: input.workspaceRoot,
      env: sanitizeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore cleanup errors */ }
      resolve({ ok: false, code: "command-timeout", message: `command exceeded timeoutMs=${timeoutMs}` });
    }, timeoutMs);

    child.stdout!.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= maxStdoutBytes) { truncated = true; return; }
      const remaining = maxStdoutBytes - stdoutBytes;
      const take = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
      stdout += take.toString("utf8");
      stdoutBytes += take.length;
      if (take.length < chunk.length) {
        truncated = true;
        try { child.kill("SIGKILL"); } catch { /* ignore cleanup errors */ }
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderrBytes >= maxStderrBytes) return;
      const remaining = maxStderrBytes - stderrBytes;
      const take = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
      stderr += take.toString("utf8");
      stderrBytes += take.length;
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const redStdout = redactOutput(stdout);
      const redStderr = redactOutput(stderr);
      resolve({
        ok: true,
        exitCode: code ?? 0,
        stdout: redStdout.text,
        stderr: redStderr.text,
        truncated,
        durationMs: Date.now() - started,
        redactionHits: [...redStdout.hits, ...redStderr.hits],
      });
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: "spawn-failed", message: String(err.message ?? err) });
    });
  });
}
