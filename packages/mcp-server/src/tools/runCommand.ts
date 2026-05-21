import { spawn } from "node:child_process";
import { classifyCommand, makeSuccessEnvelope, makeFailureEnvelope } from "@tierkit/core";
import { redactOutput } from "../redactOutput.js";

const TOOL_NAME = "tierkit.run_command";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_STDOUT = 1 * 1024 * 1024;
const DEFAULT_MAX_STDERR = 256 * 1024;

const TRUNCATION_WARNING =
  "command output was truncated. Re-run with narrower scope or redirect output to a file and use read_file with a cursor.";

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

export interface RunCommandInput {
  workspaceRoot: string;
  command: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export async function runCommandTool(input: RunCommandInput) {
  // classifyCommand returns { severity: "ok" | "warn" | "block", ... }
  // "ok"   → safe to execute
  // "warn" → approval-required (non-safe, non-blocked)
  // "block" → hard-blocked, never execute
  const c = classifyCommand(input.command);

  if (c.severity === "block") {
    const reason = c.matched.map((m) => m.description).join("; ");
    return makeFailureEnvelope(
      TOOL_NAME,
      "command-blocked",
      `command is hard-blocked: ${reason || "blocked by classifier"}`,
      [`classification: ${c.severity}`],
    );
  }

  if (c.severity !== "ok") {
    // v0.15.0: anything not classified as severity="ok" (i.e. "warn") is rejected with
    // approval-required. We do NOT execute these commands. A command-ticket flow lands in v0.15.1.
    const reason = c.matched.map((m) => m.description).join("; ");
    return makeFailureEnvelope(
      TOOL_NAME,
      "approval-required",
      `command requires approval: ${reason || "non-safe classification"}. ` +
        `v0.15.0 does not execute approval-required commands through MCP yet — ` +
        `run the command yourself in your shell, or wait for v0.15.1.`,
      [`classification: ${c.severity}`],
    );
  }

  const timeoutMs = Math.max(1, Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const maxStdoutBytes = input.maxStdoutBytes ?? DEFAULT_MAX_STDOUT;
  const maxStderrBytes = input.maxStderrBytes ?? DEFAULT_MAX_STDERR;
  const started = Date.now();

  return new Promise<ReturnType<typeof makeSuccessEnvelope> | ReturnType<typeof makeFailureEnvelope>>((resolve) => {
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
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore cleanup errors */ }
      resolve(makeFailureEnvelope(TOOL_NAME, "command-timeout", `command exceeded timeoutMs=${timeoutMs}`));
    }, timeoutMs);

    child.stdout!.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= maxStdoutBytes) { stdoutTruncated = true; return; }
      const remaining = maxStdoutBytes - stdoutBytes;
      const take = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
      stdout += take.toString("utf8");
      stdoutBytes += take.length;
      if (take.length < chunk.length) {
        stdoutTruncated = true;
        try { child.kill("SIGKILL"); } catch { /* ignore cleanup errors */ }
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderrBytes >= maxStderrBytes) { stderrTruncated = true; return; }
      const remaining = maxStderrBytes - stderrBytes;
      const take = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
      stderr += take.toString("utf8");
      stderrBytes += take.length;
      if (take.length < chunk.length) stderrTruncated = true;
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const redStdout = redactOutput(stdout);
      const redStderr = redactOutput(stderr);
      const truncated = stdoutTruncated || stderrTruncated;
      const warnings: string[] | undefined = truncated ? [TRUNCATION_WARNING] : undefined;

      resolve(makeSuccessEnvelope(TOOL_NAME, {
        exitCode: code ?? 0,
        stdout: redStdout.text,
        stderr: redStderr.text,
        durationMs: Date.now() - started,
      }, {
        truncated,
        size: {
          stdoutBytesReturned: stdoutBytes,
          stderrBytesReturned: stderrBytes,
          stdoutTruncated,
          stderrTruncated,
        },
        // No `next` field — run_command output is not deterministically continuable (spec §B.4)
        warnings,
      }));
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(makeFailureEnvelope(TOOL_NAME, "spawn-failed", String(err.message ?? err)));
    });
  });
}
