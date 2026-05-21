import fs from "node:fs/promises";
import path from "node:path";
import {
  encodeCursor,
  decodeCursor,
  makeSuccessEnvelope,
  makeFailureEnvelope,
  cursorInvalidEnvelope,
  CursorDecodeError,
  type SearchFilesCursor,
} from "@tierkit/core";
import { resolveUnderCwd } from "./safePath.js";
import { envelopeToString } from "./envelopeUtils.js";
import type { Tool, ToolResult, AgentContext } from "../types.js";

const DEFAULT_MAX_MATCHES = 50;
const HARD_MAX_MATCHES = 200;
const DEFAULT_CONTEXT_LINES = 2;

interface SearchFilesArgs {
  pattern?: string;
  path?: string;
  maxMatches?: number;
  contextLines?: number;
  cursor?: string;
}

interface SearchMatch {
  path: string;
  line: number;
  snippet: string;
  before?: string[];
  after?: string[];
}

interface SearchFilesData {
  pattern: string;
  path: string;
  matches: SearchMatch[];
}

const BROAD_PATTERNS = new Set([".*", ".+", "[^\\n]*", ".*?", ".+?"]);

async function* walkFiles(rootAbs: string): AsyncIterable<string> {
  let dirents;
  try { dirents = await fs.readdir(rootAbs, { withFileTypes: true }); }
  catch { return; }
  for (const d of dirents) {
    const full = path.join(rootAbs, d.name);
    if (d.isDirectory()) {
      // Skip common large/uninteresting dirs
      if (["node_modules", ".git", "dist", ".tierkit", ".turbo"].includes(d.name)) continue;
      yield* walkFiles(full);
    } else if (d.isFile()) {
      yield full;
    }
  }
}

async function collectMatches(
  searchRootAbs: string,
  workspaceAbs: string,
  re: RegExp,
  contextLines: number,
): Promise<SearchMatch[]> {
  const out: SearchMatch[] = [];
  for await (const fileAbs of walkFiles(searchRootAbs)) {
    let body: string;
    try { body = await fs.readFile(fileAbs, "utf8"); }
    catch { continue; }
    const lines = body.split(/\r?\n/);
    const relPath = path.relative(workspaceAbs, fileAbs).split(path.sep).join("/");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        const before = contextLines > 0 ? lines.slice(Math.max(0, i - contextLines), i) : undefined;
        const after = contextLines > 0 ? lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines)) : undefined;
        out.push({ path: relPath, line: i + 1, snippet: lines[i]!, before, after });
      }
    }
  }
  return out;
}

export const searchFilesTool: Tool = {
  name: "search_files",
  description:
    "Search for a regex pattern across the workspace. Returns a tool-result-envelope.v1 " +
    "envelope. Default returns up to 50 matches; for very broad patterns prefer narrowing " +
    "the query rather than paginating with cursor.",
  parameters: [
    { name: "pattern",      type: "string",  description: "JavaScript regex pattern. Required (or pass cursor).", required: false },
    { name: "path",         type: "string",  description: "Workspace-relative root. Default '.'.", required: false },
    { name: "maxMatches",   type: "number",  description: "Max matches to return. Default 50; clamped to 200.", required: false },
    { name: "contextLines", type: "number",  description: "Lines of before/after context per match. Default 2.", required: false },
    { name: "cursor",       type: "string",  description: "Opaque cursor for pagination. Best-effort: workspace changes between calls may shift results.", required: false },
  ],
  example: ["<search_files>", "<pattern>TODO</pattern>", "</search_files>"].join("\n"),
  approval: "never",

  async execute(args: Record<string, unknown>, ctx: AgentContext): Promise<ToolResult> {
    const input = args as SearchFilesArgs;
    let pattern: string;
    let targetPath: string;
    let maxMatches: number;
    let contextLines: number;
    let nextMatchIndex: number;
    const warnings: string[] = [];

    if (typeof input.cursor === "string" && input.cursor.length > 0) {
      let cur: SearchFilesCursor;
      try { cur = decodeCursor<SearchFilesCursor>(input.cursor); }
      catch (err) {
        if (err instanceof CursorDecodeError) {
          return envelopeToString(cursorInvalidEnvelope("search_files", err.message));
        }
        throw err;
      }
      if (cur.tool !== "search_files") {
        return envelopeToString(cursorInvalidEnvelope("search_files", `cursor.tool was ${cur.tool}`));
      }
      pattern = cur.pattern;
      targetPath = cur.path;
      maxMatches = cur.maxMatches;
      contextLines = DEFAULT_CONTEXT_LINES;
      nextMatchIndex = cur.nextMatchIndex;
    } else {
      pattern = String(input.pattern ?? "").trim();
      if (!pattern) {
        return envelopeToString(makeFailureEnvelope("search_files", "invalid-query", "missing required parameter `pattern`"));
      }
      targetPath = String(input.path ?? ".").trim() || ".";
      const rawMax = Number(input.maxMatches ?? DEFAULT_MAX_MATCHES);
      if (Number.isFinite(rawMax) && rawMax > HARD_MAX_MATCHES) {
        maxMatches = HARD_MAX_MATCHES;
        warnings.push(`maxMatches clamped to ${HARD_MAX_MATCHES}`);
      } else if (Number.isFinite(rawMax) && rawMax >= 1) {
        maxMatches = Math.floor(rawMax);
      } else {
        maxMatches = DEFAULT_MAX_MATCHES;
      }
      contextLines = Math.max(0, Math.min(10, Math.floor(Number(input.contextLines ?? DEFAULT_CONTEXT_LINES))));
      nextMatchIndex = 0;
    }

    if (BROAD_PATTERNS.has(pattern)) {
      warnings.push("pattern matches every line; prefer read_file with startLine cursor for sequential file reads");
    }

    let re: RegExp;
    try { re = new RegExp(pattern); }
    catch (err) {
      return envelopeToString(makeFailureEnvelope("search_files", "invalid-query", `regex compile error: ${(err as Error).message}`));
    }

    let searchRootAbs: string;
    try { searchRootAbs = resolveUnderCwd(ctx.cwd, targetPath); }
    catch (err) {
      return envelopeToString(makeFailureEnvelope("search_files", "path-escape", (err as Error).message));
    }

    const allMatches = await collectMatches(searchRootAbs, ctx.cwd, re, contextLines);
    const slice = allMatches.slice(nextMatchIndex, nextMatchIndex + maxMatches);
    const truncated = nextMatchIndex + slice.length < allMatches.length;

    if (!truncated) {
      return envelopeToString(makeSuccessEnvelope<SearchFilesData>(
        "search_files",
        { pattern, path: targetPath, matches: slice },
        {
          truncated: false,
          size: { linesReturned: slice.length, totalLines: allMatches.length, remainingLines: 0 },
          warnings: warnings.length > 0 ? warnings : undefined,
        },
      ));
    }

    const cur: SearchFilesCursor = {
      tool: "search_files",
      pattern,
      path: targetPath,
      nextMatchIndex: nextMatchIndex + slice.length,
      maxMatches,
      createdAt: new Date().toISOString(),
    };
    const encoded = encodeCursor(cur);

    return envelopeToString(makeSuccessEnvelope<SearchFilesData>(
      "search_files",
      { pattern, path: targetPath, matches: slice },
      {
        truncated: true,
        size: { linesReturned: slice.length, totalLines: allMatches.length, remainingLines: allMatches.length - nextMatchIndex - slice.length },
        next: { cursor: encoded, suggestedCall: { tool: "search_files", args: { cursor: encoded } } },
        warnings: warnings.length > 0 ? warnings : undefined,
      },
    ));
  },
};
