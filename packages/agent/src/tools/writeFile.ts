import fs from "node:fs/promises";
import path from "node:path";
import { resolveUnderCwd } from "./safePath.js";
import { gateSensitivePath } from "./tierkitGates.js";
import type { Tool, ToolResult, AgentContext } from "../types.js";

const MAX_WRITE_BYTES = 1024 * 1024; // 1MB per write

export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Write or overwrite a file with the given content. Creates intermediate directories as needed. " +
    "Requires user approval before execution. Path is workspace-relative. " +
    "Refuses to write to sensitive files (.env, *.pem, etc.) per Tierkit's blocklist.",
  parameters: [
    {
      name: "path",
      type: "string",
      description: "Workspace-relative path of the file to write.",
      required: true,
    },
    {
      name: "content",
      type: "string",
      description: "Full file content. The previous content is replaced entirely.",
      required: true,
    },
  ],
  example: [
    "<write_file>",
    "<path>src/main.ts</path>",
    "<content>console.log('hi');\n</content>",
    "</write_file>",
  ].join("\n"),
  approval: "always",

  async execute(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
    const relPath = String(args.path ?? "").trim();
    const content = typeof args.content === "string" ? args.content : "";
    if (!relPath) return failed("invalid-args", "missing required parameter `path`");

    let absPath: string;
    try {
      absPath = resolveUnderCwd(ctx.cwd, relPath);
    } catch (err) {
      return failed("path-escape", (err as Error).message);
    }

    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength > MAX_WRITE_BYTES) {
      return failed("too-large", `content is ${byteLength} bytes (max ${MAX_WRITE_BYTES})`);
    }

    // Tierkit policy gate — sensitive-file blocklist (.env, *.pem, id_rsa, ...).
    const gate = await gateSensitivePath(ctx.tierkitBaseUrl, relPath);
    if (gate.blocked) {
      return failed(
        "sensitive-file-blocked",
        `${relPath} is on the sensitive-file blocklist (${gate.reason ?? "policy"}). Refusing to write.`,
      );
    }

    // Existing file size, for the result banner.
    let existedBefore = false;
    let prevSize = 0;
    try {
      const stat = await fs.stat(absPath);
      existedBefore = true;
      prevSize = stat.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        return failed("write-error", (err as Error).message);
      }
    }

    try {
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      const tmp = absPath + ".tmp";
      await fs.writeFile(tmp, content, "utf8");
      await fs.rename(tmp, absPath);
    } catch (err) {
      return failed("write-error", (err as Error).message);
    }

    return {
      ok: true,
      content:
        `${existedBefore ? "Overwrote" : "Created"} ${relPath}\n` +
        `Previous size: ${prevSize} bytes, new size: ${byteLength} bytes`,
    };
  },
};

function failed(code: string, message: string): ToolResult {
  return { ok: false, content: `[${code}] ${message}`, error: { code, message } };
}
