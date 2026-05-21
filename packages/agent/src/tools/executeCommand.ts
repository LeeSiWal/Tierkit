import { spawn } from "node:child_process";
import {
  makeSuccessEnvelope,
  makeFailureEnvelope,
} from "@tierkit/core";
import { envelopeToString } from "./envelopeUtils.js";
import type { Tool, ToolResult, AgentContext } from "../types.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_STDOUT = 64 * 1024;       // 64KB default per spec §B.4 run_command
const DEFAULT_MAX_STDERR = 32 * 1024;       // 32KB default per spec
const HARD_MAX_STDOUT = 1 * 1024 * 1024;    // 1MB ceiling
const HARD_MAX_STDERR = 256 * 1024;         // 256KB ceiling

const TRUNCATION_WARNING =
  "command output was truncated. Re-run with narrower scope or redirect output to a file and use read_file with a cursor.";

interface ExecuteCommandArgs {
  command?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

interface ExecuteCommandData {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export const executeCommandTool: Tool = {
  name: "execute_command",
  description:
    "Run a shell command in the workspace. Returns a tool-result-envelope.v1 envelope. " +
    "stdout/stderr are byte-capped (64KB/32KB defaults). When truncated, the envelope " +
    "carries warnings but no `next.cursor` (re-running a command is not deterministic " +
    "continuation).",
  parameters: [
    { name: "command",        type: "string", description: "Shell command to run.", required: true },
    { name: "timeoutMs",      type: "number", description: "Default 60_000 ms; capped at 600_000.", required: false },
    { name: "maxStdoutBytes", type: "number", description: "Default 65536; capped at 1048576.", required: false },
    { name: "maxStderrBytes", type: "number", description: "Default 32768; capped at 262144.", required: false },
  ],
  example: ["<execute_command>", "<command>pnpm test</command>", "</execute_command>"].join("\n"),
  approval: "destructive-only",

  async execute(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
    const input = args as ExecuteCommandArgs;
    const command = String(input.command ?? "").trim();
    if (!command) {
      return envelopeToString(makeFailureEnvelope("execute_command", "invalid-args", "missing required parameter `command`"));
    }

    const timeoutMs = Math.max(1, Math.min(Number(input.timeoutMs ?? DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS));
    const maxStdoutBytes = Math.max(1, Math.min(Number(input.maxStdoutBytes ?? DEFAULT_MAX_STDOUT), HARD_MAX_STDOUT));
    const maxStderrBytes = Math.max(1, Math.min(Number(input.maxStderrBytes ?? DEFAULT_MAX_STDERR), HARD_MAX_STDERR));

    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;

    return new Promise<ToolResult>((resolve) => {
      const child = spawn(command, {
        shell: true,
        cwd: ctx.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let settled = false;
      const finish = (env: object) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(envelopeToString(env));
      };

      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* */ }
        finish(makeFailureEnvelope("execute_command", "command-timeout", `command exceeded timeoutMs=${timeoutMs}`));
      }, timeoutMs);

      child.stdout!.on("data", (chunk: Buffer) => {
        if (stdoutBytes >= maxStdoutBytes) { stdoutTruncated = true; return; }
        const remaining = maxStdoutBytes - stdoutBytes;
        const take = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
        stdout += take.toString("utf8");
        stdoutBytes += take.length;
        if (take.length < chunk.length) {
          stdoutTruncated = true;
          try { child.kill("SIGKILL"); } catch { /* */ }
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

      child.on("error", (err) => {
        finish(makeFailureEnvelope("execute_command", "spawn-failed", err.message));
      });
      child.on("close", (code) => {
        const durationMs = Date.now() - started;
        const truncated = stdoutTruncated || stderrTruncated;
        const warnings: string[] | undefined = truncated ? [TRUNCATION_WARNING] : undefined;

        const data: ExecuteCommandData = { exitCode: code ?? 0, stdout, stderr, durationMs };
        finish(makeSuccessEnvelope<ExecuteCommandData>("execute_command", data, {
          truncated,
          size: {
            stdoutBytesReturned: stdoutBytes,
            stderrBytesReturned: stderrBytes,
            stdoutTruncated,
            stderrTruncated,
          },
          warnings,
        }));
      });
    });
  },
};
