import fs from "node:fs/promises";
import { resolveUnderCwd } from "./safePath.js";
import { gateSensitivePath } from "./tierkitGates.js";
import type { Tool, ToolResult, AgentContext } from "../types.js";

const MAX_FILE_BYTES = 1024 * 1024;

export const applyDiffTool: Tool = {
  name: "apply_diff",
  description:
    "Apply a targeted edit to an existing file by replacing a unique substring with new content. " +
    "Prefer this over write_file when the change is local — saves tokens and avoids accidentally " +
    "overwriting unrelated parts. The `search` block must appear EXACTLY ONCE in the file " +
    "(byte-for-byte, including whitespace). If it appears zero or multiple times, the tool refuses. " +
    "Requires user approval.",
  parameters: [
    {
      name: "path",
      type: "string",
      description: "Workspace-relative path of the file to edit.",
      required: true,
    },
    {
      name: "search",
      type: "string",
      description: "The exact text block to find. Must be unique in the file.",
      required: true,
    },
    {
      name: "replace",
      type: "string",
      description: "The new text that replaces the matched block.",
      required: true,
    },
  ],
  example: [
    "<apply_diff>",
    "<path>src/auth.ts</path>",
    "<search>const x = 1;</search>",
    "<replace>const x = 2;</replace>",
    "</apply_diff>",
  ].join("\n"),
  approval: "always",

  async execute(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
    const relPath = String(args.path ?? "").trim();
    const search = typeof args.search === "string" ? args.search : "";
    const replace = typeof args.replace === "string" ? args.replace : "";
    if (!relPath) return failed("invalid-args", "missing required parameter `path`");
    if (!search) return failed("invalid-args", "missing required parameter `search`");
    // `replace` may legitimately be empty (deleting a block), so don't reject that.

    let absPath: string;
    try {
      absPath = resolveUnderCwd(ctx.cwd, relPath);
    } catch (err) {
      return failed("path-escape", (err as Error).message);
    }

    const gate = await gateSensitivePath(ctx.tierkitBaseUrl, relPath);
    if (gate.blocked) {
      return failed(
        "sensitive-file-blocked",
        `${relPath} is on the sensitive-file blocklist (${gate.reason ?? "policy"}). Refusing to edit.`,
      );
    }

    let body: string;
    try {
      const stat = await fs.stat(absPath);
      if (stat.size > MAX_FILE_BYTES) return failed("too-large", `file is ${stat.size} bytes (max ${MAX_FILE_BYTES})`);
      body = await fs.readFile(absPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return failed("not-found", `file does not exist: ${relPath}`);
      }
      return failed("read-error", (err as Error).message);
    }

    // Count occurrences. We require exactly one — zero or multiple matches mean the model's
    // anchor is wrong and a silent fix would be dangerous.
    let idx = body.indexOf(search);
    if (idx === -1) {
      return failed("no-match", `search block not found in ${relPath}. Read the file again and provide a verbatim block.`);
    }
    const second = body.indexOf(search, idx + search.length);
    if (second !== -1) {
      return failed(
        "ambiguous-match",
        `search block appears multiple times in ${relPath}. Add more surrounding context until the block is unique.`,
      );
    }

    const next = body.slice(0, idx) + replace + body.slice(idx + search.length);
    try {
      const tmp = absPath + ".tmp";
      await fs.writeFile(tmp, next, "utf8");
      await fs.rename(tmp, absPath);
    } catch (err) {
      return failed("write-error", (err as Error).message);
    }

    const removed = search.length;
    const added = replace.length;
    const lineNumber = body.slice(0, idx).split("\n").length;
    return {
      ok: true,
      content:
        `Applied diff in ${relPath} at line ${lineNumber}\n` +
        `Removed ${removed} bytes, added ${added} bytes (net ${added - removed >= 0 ? "+" : ""}${added - removed})`,
    };
  },
};

function failed(code: string, message: string): ToolResult {
  return { ok: false, content: `[${code}] ${message}`, error: { code, message } };
}
