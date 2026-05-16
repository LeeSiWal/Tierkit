import fs from "node:fs/promises";
import path from "node:path";
import { resolveUnderCwd } from "./safePath.js";
import { gateSensitivePath } from "./tierkitGates.js";
import type { Tool, ToolResult, AgentContext } from "../types.js";

const MAX_BYTES = 256 * 1024; // 256KB hard cap — protects context budget from huge files
const MAX_LINES = 4000; // soft cap by line count

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read the contents of a file. Returns the file body with line numbers prepended (1: ..., 2: ...). " +
    "Use this BEFORE making any assumptions about what a file contains. " +
    "Path is relative to the workspace root. Files larger than 256KB or 4000 lines are truncated.",
  parameters: [
    {
      name: "path",
      type: "string",
      description: "Workspace-relative path of the file to read (e.g., 'src/main.ts').",
      required: true,
    },
  ],
  example: ["<read_file>", "<path>src/main.ts</path>", "</read_file>"].join("\n"),
  approval: "never",

  async execute(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
    const relPath = String(args.path ?? "").trim();
    if (!relPath) {
      return failed("invalid-args", "missing required parameter `path`");
    }

    // Path traversal guard — never escape cwd.
    let absPath: string;
    try {
      absPath = resolveUnderCwd(ctx.cwd, relPath);
    } catch (err) {
      return failed("path-escape", (err as Error).message);
    }

    // Tierkit policy gate: refuses .env, *.pem, id_rsa, etc.
    const gate = await gateSensitivePath(ctx.tierkitBaseUrl, relPath);
    if (gate.blocked) {
      return failed(
        "sensitive-file-blocked",
        `${relPath} is on the sensitive-file blocklist (${gate.reason ?? "policy"}). ` +
          "Refusing to read.",
      );
    }

    let stat;
    try {
      stat = await fs.stat(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return failed("not-found", `file does not exist: ${relPath}`);
      }
      return failed("read-error", (err as Error).message);
    }
    if (!stat.isFile()) {
      return failed("not-a-file", `${relPath} exists but is not a regular file`);
    }

    const truncated = stat.size > MAX_BYTES;
    let body: string;
    try {
      const fd = await fs.open(absPath, "r");
      try {
        const buf = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
        await fd.read(buf, 0, buf.length, 0);
        body = buf.toString("utf8");
      } finally {
        await fd.close();
      }
    } catch (err) {
      return failed("read-error", (err as Error).message);
    }

    const lines = body.split(/\r?\n/);
    const truncatedByLines = lines.length > MAX_LINES;
    const shown = truncatedByLines ? lines.slice(0, MAX_LINES) : lines;
    const numbered = shown.map((ln, i) => `${i + 1}: ${ln}`).join("\n");

    const banner: string[] = [];
    banner.push(`File: ${relPath}`);
    banner.push(`Size: ${stat.size} bytes, ${lines.length} lines`);
    if (truncated) banner.push(`Note: truncated to first ${MAX_BYTES} bytes`);
    if (truncatedByLines) banner.push(`Note: showing first ${MAX_LINES} lines`);
    return {
      ok: true,
      content: banner.join("\n") + "\n---\n" + numbered,
    };
  },
};

function failed(code: string, message: string): ToolResult {
  return { ok: false, content: `[${code}] ${message}`, error: { code, message } };
}
