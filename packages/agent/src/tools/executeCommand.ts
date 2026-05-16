import { spawn } from "node:child_process";
import { gateDangerousCommand } from "./tierkitGates.js";
import type { Tool, ToolResult, AgentContext } from "../types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024; // 64KB per stream — guards context budget

export const executeCommandTool: Tool = {
  name: "execute_command",
  description:
    "Execute a shell command in the workspace. Use for build / test / install / git operations. " +
    "Requires user approval. Tierkit classifies the command via its dangerous-command rules — " +
    "patterns like `rm -rf /`, `chmod 777`, `curl | sh` etc. are blocked outright. " +
    "Default timeout 30s. Output is truncated to 64KB per stream.",
  parameters: [
    {
      name: "command",
      type: "string",
      description: "The full shell command line to run, exactly as you would type it in a terminal.",
      required: true,
    },
    {
      name: "timeoutMs",
      type: "number",
      description: "Optional override for the timeout in ms. Default 30000.",
      required: false,
    },
  ],
  example: ["<execute_command>", "<command>npm test</command>", "</execute_command>"].join("\n"),
  approval: "always",

  async execute(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
    const command = String(args.command ?? "").trim();
    if (!command) return failed("invalid-args", "missing required parameter `command`");

    // Tierkit policy gate — block dangerous commands before they even get a chance to run.
    const cls = await gateDangerousCommand(ctx.tierkitBaseUrl, command);
    if (cls.severity === "block") {
      return failed(
        "dangerous-command-blocked",
        `Command blocked by Tierkit policy: ${cls.matched.map((m) => m.id).join(", ")}`,
      );
    }

    const timeoutMs =
      typeof args.timeoutMs === "number" && args.timeoutMs > 0 && args.timeoutMs <= 300_000
        ? args.timeoutMs
        : DEFAULT_TIMEOUT_MS;

    const start = Date.now();
    return new Promise<ToolResult>((resolve) => {
      const child = spawn(command, [], {
        cwd: ctx.cwd,
        shell: true,
        env: ctx.env as NodeJS.ProcessEnv,
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdoutBytes < MAX_OUTPUT_BYTES) {
          stdoutChunks.push(chunk);
          stdoutBytes += chunk.length;
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrBytes < MAX_OUTPUT_BYTES) {
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        }
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.killed || child.kill("SIGKILL"), 1000);
      }, timeoutMs);

      let userAborted = false;
      const onAbort = (): void => {
        userAborted = true;
        child.kill("SIGTERM");
        setTimeout(() => child.killed || child.kill("SIGKILL"), 1000);
      };
      const sig = ctx.abortSignal;
      if (sig) {
        if (sig.aborted) onAbort();
        else sig.addEventListener("abort", onAbort, { once: true });
      }

      child.on("error", (err) => {
        clearTimeout(timer);
        sig?.removeEventListener("abort", onAbort);
        resolve(failed("spawn-error", err.message));
      });

      child.on("close", (code, signal) => {
        clearTimeout(timer);
        sig?.removeEventListener("abort", onAbort);
        const elapsedMs = Date.now() - start;
        const stdout = Buffer.concat(stdoutChunks).toString("utf8").slice(0, MAX_OUTPUT_BYTES);
        const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, MAX_OUTPUT_BYTES);
        const banner: string[] = [];
        banner.push(`Command: ${command}`);
        banner.push(`Exit: ${code ?? "(signal " + signal + ")"} in ${elapsedMs}ms`);
        if (timedOut) banner.push(`Timed out after ${timeoutMs}ms — killed`);
        if (userAborted) banner.push("Aborted by user — killed");
        if (cls.severity === "warn" && cls.matched.length > 0) {
          banner.push(`Warning rules matched: ${cls.matched.map((m) => m.id).join(", ")}`);
        }
        if (stdout.length === MAX_OUTPUT_BYTES) banner.push("stdout truncated");
        if (stderr.length === MAX_OUTPUT_BYTES) banner.push("stderr truncated");
        const parts: string[] = [banner.join("\n")];
        if (stdout.length > 0) parts.push("--- stdout ---\n" + stdout);
        if (stderr.length > 0) parts.push("--- stderr ---\n" + stderr);
        const ok = !timedOut && !userAborted && code === 0;
        resolve({
          ok,
          content: parts.join("\n\n"),
          ...(ok ? {} : { error: { code: userAborted ? "aborted" : timedOut ? "timeout" : "non-zero-exit", message: userAborted ? "user aborted" : `exit ${code}` } }),
        });
      });
    });
  },
};

function failed(code: string, message: string): ToolResult {
  return { ok: false, content: `[${code}] ${message}`, error: { code, message } };
}
