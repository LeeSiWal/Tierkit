import fs from "node:fs/promises";
import path from "node:path";
import { resolveUnderCwd } from "./safePath.js";
import type { Tool, ToolResult, AgentContext } from "../types.js";

const MAX_FILE_BYTES = 512 * 1024;
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".turbo", ".cache", "dist", "build", ".next", "coverage", ".tierkit",
]);
const MAX_RESULTS = 20;
const MAX_VISITED = 8_000;

/**
 * Lightweight code search: BM25-ish term frequency ranking over file contents, scoped to
 * the workspace. Designed to be a usable substitute for semantic search when the workspace
 * has no embedding store. Returns the top-K most-relevant file:line snippets.
 *
 * This is intentionally NOT semantic — it does not understand synonyms. But it is fast, has
 * zero external dependencies, and is good enough for "find me where the user clicks login"-
 * style queries when keywords overlap with the codebase.
 *
 * A real embedding-based implementation can swap in later behind the same tool name.
 */
export const codebaseSearchTool: Tool = {
  name: "codebase_search",
  description:
    "Find code relevant to a natural-language query using keyword + locality ranking. Use " +
    "this when you don't know exact symbol names — e.g. \"where does login happen\" or " +
    "\"the function that emits SSE events\". For exact substring/regex matches, prefer " +
    "search_files. Returns up to 20 ranked file:line snippets with surrounding context.",
  parameters: [
    {
      name: "query",
      type: "string",
      description: "Natural-language description of what you're looking for. Treated as a bag of keywords.",
      required: true,
    },
    {
      name: "path",
      type: "string",
      description: "Optional workspace-relative root to scope the search. Default: '.'",
      required: false,
    },
  ],
  example: [
    "<codebase_search>",
    "<query>where the agent loop yields tool_call events</query>",
    "<path>packages/agent</path>",
    "</codebase_search>",
  ].join("\n"),
  approval: "never",

  async execute(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
    const query = String(args.query ?? "").trim();
    const relPath = String(args.path ?? ".").trim() || ".";
    if (!query) return failed("invalid-args", "missing required parameter `query`");

    // Tokenize: lowercase, split on non-alnum, drop short words.
    const terms = [...new Set(
      query.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 3),
    )];
    if (terms.length === 0) return failed("invalid-query", "query has no usable tokens (need words ≥3 chars)");

    let rootAbs: string;
    try {
      rootAbs = resolveUnderCwd(ctx.cwd, relPath);
    } catch (err) {
      return failed("path-escape", (err as Error).message);
    }

    // Score: each line gets +1 per matching term; whole-file score is the max line score
    // weighted by total file matches. We keep the top per-file line for the result list.
    interface Hit {
      file: string;
      lineNo: number;
      line: string;
      score: number;
    }
    const hits: Hit[] = [];
    let visited = 0;

    async function walk(dir: string): Promise<void> {
      if (visited >= MAX_VISITED) return;
      let dirents;
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch { return; }
      for (const d of dirents) {
        if (visited >= MAX_VISITED) return;
        visited++;
        if (SKIP_DIRS.has(d.name) || d.name.startsWith(".")) continue;
        const full = path.join(dir, d.name);
        if (d.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!d.isFile()) continue;
        // Skip binaries and large files.
        if (!/\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|java|cs|rb|php|sh|yaml|yml|toml|css|html|scss)$/i.test(d.name)) continue;
        let body: string;
        try {
          const stat = await fs.stat(full);
          if (stat.size > MAX_FILE_BYTES) continue;
          body = await fs.readFile(full, "utf8");
        } catch { continue; }

        const lower = body.toLowerCase();
        // Cheap pre-filter: at least one term must appear in the file.
        if (!terms.some((t) => lower.includes(t))) continue;

        const lines = body.split(/\r?\n/);
        let bestLine = -1;
        let bestScore = 0;
        for (let i = 0; i < lines.length; i++) {
          const ln = lines[i]!.toLowerCase();
          let s = 0;
          for (const t of terms) if (ln.includes(t)) s++;
          if (s > bestScore) {
            bestScore = s;
            bestLine = i;
          }
        }
        if (bestLine >= 0 && bestScore > 0) {
          hits.push({
            file: path.relative(ctx.cwd, full),
            lineNo: bestLine + 1,
            line: lines[bestLine]!.slice(0, 240),
            score: bestScore,
          });
        }
      }
    }

    try {
      await walk(rootAbs);
    } catch (err) {
      return failed("search-error", (err as Error).message);
    }

    hits.sort((a, b) => b.score - a.score || a.file.length - b.file.length);
    const top = hits.slice(0, MAX_RESULTS);

    if (top.length === 0) {
      return { ok: true, content: `No relevant matches for query "${query}" in ${relPath}.\nTerms used: ${terms.join(", ")}` };
    }

    const banner = [
      `Query: ${query}`,
      `Terms: ${terms.join(", ")}`,
      `${hits.length} candidate files (showing top ${top.length}); scope: ${relPath}`,
      "Note: keyword+locality ranking — exact matches are most reliable. Use search_files for regex.",
    ].join("\n");
    const body = top.map((h) => `[${h.score}/${terms.length}] ${h.file}:${h.lineNo}: ${h.line}`).join("\n");
    return { ok: true, content: banner + "\n---\n" + body };
  },
};

function failed(code: string, message: string): ToolResult {
  return { ok: false, content: `[${code}] ${message}`, error: { code, message } };
}
