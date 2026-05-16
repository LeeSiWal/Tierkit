import fs from "node:fs/promises";
import path from "node:path";
import { resolveUnderCwd } from "./safePath.js";
import type { Tool, ToolResult, AgentContext } from "../types.js";

const MAX_MATCHES = 200;
const MAX_BYTES_PER_FILE = 1024 * 1024;
const SKIP_DIRS = new Set(["node_modules", ".git", ".turbo", ".cache", "dist", "build", ".next", "coverage", ".tierkit"]);

export const searchFilesTool: Tool = {
  name: "search_files",
  description:
    "Search file contents with a JavaScript regular expression. Use to find a symbol, error message, " +
    "TODO marker, or any string-matched pattern across the project. " +
    "Returns up to 200 matching lines with `file:line: matched-line`. " +
    "Path is workspace-relative; use '.' for the whole workspace.",
  parameters: [
    {
      name: "path",
      type: "string",
      description: "Workspace-relative root for the search. Use '.' for the whole workspace.",
      required: true,
    },
    {
      name: "pattern",
      type: "string",
      description: "JavaScript regex pattern. NOT a raw-string — escape backslashes if needed.",
      required: true,
    },
    {
      name: "filePattern",
      type: "string",
      description: "Optional filename glob, e.g. '*.ts' or '*.md'. Default: any file.",
      required: false,
    },
  ],
  example: [
    "<search_files>",
    "<path>src</path>",
    "<pattern>TODO|FIXME</pattern>",
    "<filePattern>*.ts</filePattern>",
    "</search_files>",
  ].join("\n"),
  approval: "never",

  async execute(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
    const relPath = String(args.path ?? ".").trim() || ".";
    const patternStr = String(args.pattern ?? "").trim();
    const filePatternStr = String(args.filePattern ?? "").trim();
    if (!patternStr) return failed("invalid-args", "missing required parameter `pattern`");

    let regex: RegExp;
    try {
      regex = new RegExp(patternStr);
    } catch (err) {
      return failed("invalid-regex", (err as Error).message);
    }
    const fileMatcher = filePatternStr ? globToRegExp(filePatternStr) : null;

    let rootAbs: string;
    try {
      rootAbs = resolveUnderCwd(ctx.cwd, relPath);
    } catch (err) {
      return failed("path-escape", (err as Error).message);
    }

    const matches: string[] = [];
    let filesScanned = 0;
    let truncated = false;

    async function walk(dir: string): Promise<void> {
      if (matches.length >= MAX_MATCHES) {
        truncated = true;
        return;
      }
      let dirents;
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of dirents) {
        if (SKIP_DIRS.has(d.name)) continue;
        if (matches.length >= MAX_MATCHES) {
          truncated = true;
          return;
        }
        const full = path.join(dir, d.name);
        if (d.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!d.isFile()) continue;
        if (fileMatcher && !fileMatcher.test(d.name)) continue;
        const rel = path.relative(ctx.cwd, full);
        let body: string;
        try {
          const stat = await fs.stat(full);
          if (stat.size > MAX_BYTES_PER_FILE) continue;
          body = await fs.readFile(full, "utf8");
        } catch {
          continue;
        }
        filesScanned++;
        const lines = body.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i]!)) {
            matches.push(`${rel}:${i + 1}: ${lines[i]!.slice(0, 240)}`);
            if (matches.length >= MAX_MATCHES) {
              truncated = true;
              return;
            }
          }
        }
      }
    }

    try {
      await walk(rootAbs);
    } catch (err) {
      return failed("search-error", (err as Error).message);
    }

    const banner = [
      `Search: ${patternStr}`,
      `Path: ${relPath}${filePatternStr ? `, files: ${filePatternStr}` : ""}`,
      `${matches.length} matches in ${filesScanned} files${truncated ? " (truncated)" : ""}`,
    ].join("\n");
    return { ok: true, content: banner + "\n---\n" + matches.join("\n") };
  },
};

/** Convert a glob like `*.ts` or `foo-*.md` to a RegExp matching base filenames. */
function globToRegExp(glob: string): RegExp {
  // Very minimal — just supports * and ?
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function failed(code: string, message: string): ToolResult {
  return { ok: false, content: `[${code}] ${message}`, error: { code, message } };
}
