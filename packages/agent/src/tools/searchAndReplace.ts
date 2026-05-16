import fs from "node:fs/promises";
import { resolveUnderCwd } from "./safePath.js";
import { gateSensitivePath } from "./tierkitGates.js";
import type { Tool, ToolResult, AgentContext } from "../types.js";

const MAX_FILE_BYTES = 1024 * 1024;

export const searchAndReplaceTool: Tool = {
  name: "search_and_replace",
  description:
    "Replace ALL occurrences of a regex pattern in a single file. Use this when apply_diff would " +
    "need multiple identical edits, or when you want to rename a symbol throughout a file. " +
    "Unlike apply_diff (which requires a unique anchor), this tool intentionally rewrites every " +
    "match — be precise with the pattern. Requires user approval.",
  parameters: [
    { name: "path", type: "string", description: "Workspace-relative file path.", required: true },
    { name: "pattern", type: "string", description: "JavaScript regex source. Backslashes must be escaped.", required: true },
    { name: "replacement", type: "string", description: "Replacement string (supports $1, $2 backrefs).", required: true },
    {
      name: "flags",
      type: "string",
      description: "Optional regex flags. Default 'g' (always added). Pass 'gi' for case-insensitive.",
      required: false,
    },
  ],
  example: [
    "<search_and_replace>",
    "<path>src/old-name.ts</path>",
    "<pattern>oldName</pattern>",
    "<replacement>newName</replacement>",
    "</search_and_replace>",
  ].join("\n"),
  approval: "always",

  async execute(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
    const relPath = String(args.path ?? "").trim();
    const patternStr = String(args.pattern ?? "");
    const replacement = String(args.replacement ?? "");
    const flagsRaw = String(args.flags ?? "g");
    if (!relPath) return failed("invalid-args", "missing required parameter `path`");
    if (!patternStr) return failed("invalid-args", "missing required parameter `pattern`");
    // Always enforce `g` so we replace ALL — that's the contract this tool advertises.
    const flags = flagsRaw.includes("g") ? flagsRaw : flagsRaw + "g";

    let absPath: string;
    try {
      absPath = resolveUnderCwd(ctx.cwd, relPath);
    } catch (err) {
      return failed("path-escape", (err as Error).message);
    }

    const gate = await gateSensitivePath(ctx.tierkitBaseUrl, relPath);
    if (gate.blocked) {
      return failed("sensitive-file-blocked", `${relPath} is on the sensitive-file blocklist (${gate.reason ?? "policy"}). Refusing to edit.`);
    }

    let regex: RegExp;
    try {
      regex = new RegExp(patternStr, flags);
    } catch (err) {
      return failed("invalid-regex", (err as Error).message);
    }

    let body: string;
    try {
      const stat = await fs.stat(absPath);
      if (stat.size > MAX_FILE_BYTES) return failed("too-large", `file is ${stat.size} bytes (max ${MAX_FILE_BYTES})`);
      body = await fs.readFile(absPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return failed("not-found", `file does not exist: ${relPath}`);
      return failed("read-error", (err as Error).message);
    }

    // Use the string-replacement form so $1, $2 backreferences in `replacement` work the
    // way the model expects. We separately count by running the regex once with matchAll.
    const matchIter = body.matchAll(new RegExp(patternStr, flags));
    let count = 0;
    for (const _ of matchIter) {
      void _;
      count++;
    }
    const next = body.replace(regex, replacement);

    if (count === 0) {
      return failed("no-match", `pattern not found in ${relPath}.`);
    }

    try {
      const tmp = absPath + ".tmp";
      await fs.writeFile(tmp, next, "utf8");
      await fs.rename(tmp, absPath);
    } catch (err) {
      return failed("write-error", (err as Error).message);
    }

    return {
      ok: true,
      content: `Replaced ${count} occurrence${count === 1 ? "" : "s"} of /${patternStr}/${flags} in ${relPath}\n` +
        `Removed ${body.length} bytes, wrote ${next.length} bytes (net ${next.length - body.length >= 0 ? "+" : ""}${next.length - body.length})`,
    };
  },
};

function failed(code: string, message: string): ToolResult {
  return { ok: false, content: `[${code}] ${message}`, error: { code, message } };
}
