import fs from "node:fs/promises";
import path from "node:path";
import { resolveUnderCwd } from "./safePath.js";
import type { Tool, ToolResult, AgentContext } from "../types.js";

const MAX_ENTRIES = 500;

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".turbo",
  ".cache",
  "dist",
  "build",
  ".next",
  "coverage",
  ".tierkit",
]);

export const listFilesTool: Tool = {
  name: "list_files",
  description:
    "List files and directories in a path. Use to understand project layout. " +
    "Path is workspace-relative. Set `recursive` to true to descend into subdirectories. " +
    "Skips noisy directories (node_modules, .git, dist, etc.). Caps at 500 entries.",
  parameters: [
    {
      name: "path",
      type: "string",
      description: "Workspace-relative directory path. Use '.' or empty for the workspace root.",
      required: false,
    },
    {
      name: "recursive",
      type: "boolean",
      description: "If true, list files in all subdirectories. Default false.",
      required: false,
    },
  ],
  example: ["<list_files>", "<path>src</path>", "<recursive>true</recursive>", "</list_files>"].join("\n"),
  approval: "never",

  async execute(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
    const relPath = String(args.path ?? ".").trim() || ".";
    const recursive = args.recursive === true || args.recursive === "true";

    let rootAbs: string;
    try {
      rootAbs = resolveUnderCwd(ctx.cwd, relPath);
    } catch (err) {
      return failed("path-escape", (err as Error).message);
    }

    let stat;
    try {
      stat = await fs.stat(rootAbs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return failed("not-found", `directory does not exist: ${relPath}`);
      }
      return failed("list-error", (err as Error).message);
    }
    if (!stat.isDirectory()) {
      return failed("not-a-directory", `${relPath} is not a directory`);
    }

    const entries: string[] = [];
    const truncated = await walk(rootAbs, rootAbs, recursive, entries);
    entries.sort();

    const banner = [
      `Directory: ${relPath}`,
      `${entries.length} entries${truncated ? " (truncated)" : ""}`,
    ].join("\n");
    return {
      ok: true,
      content: banner + "\n---\n" + entries.join("\n"),
    };
  },
};

async function walk(rootAbs: string, currentAbs: string, recursive: boolean, out: string[]): Promise<boolean> {
  if (out.length >= MAX_ENTRIES) return true;
  let dirents;
  try {
    dirents = await fs.readdir(currentAbs, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const d of dirents) {
    if (out.length >= MAX_ENTRIES) return true;
    if (SKIP_DIRS.has(d.name)) continue;
    // Skip all dotfiles/dotdirs by default. Show .env* (relevant for code config);
    // .env reads still go through sensitive-file checks elsewhere.
    if (d.name.startsWith(".") && d.name !== "." && d.name !== ".." && !d.name.startsWith(".env")) {
      continue;
    }
    const full = path.join(currentAbs, d.name);
    const rel = path.relative(rootAbs, full);
    if (d.isDirectory()) {
      out.push(rel + "/");
      if (recursive) {
        if (await walk(rootAbs, full, recursive, out)) return true;
      }
    } else {
      out.push(rel);
    }
  }
  return false;
}

function failed(code: string, message: string): ToolResult {
  return { ok: false, content: `[${code}] ${message}`, error: { code, message } };
}
