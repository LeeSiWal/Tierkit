import path from "node:path";
import fs from "node:fs/promises";
import {
  encodeCursor,
  decodeCursor,
  makeSuccessEnvelope,
  makeFailureEnvelope,
  cursorInvalidEnvelope,
  CursorDecodeError,
  type SearchFilesCursor,
} from "@tierkit/core";
import { resolveUnderWorkspace } from "../workspaceBoundary.js";
import { loadIgnoreSources, isIgnored } from "../ignoreSources.js";
import { isDenied } from "../pathDenylist.js";
import { redactOutput } from "../redactOutput.js";

const TOOL_NAME = "tierkit.codebase_search";
const DEFAULT_MAX_MATCHES = 50;
const HARD_MAX_MATCHES = 200;
const DEFAULT_CONTEXT_LINES = 2;
const BROAD = new Set([".*", ".+", "[^\\n]*", ".*?", ".+?"]);

interface SearchInput {
  workspaceRoot: string;
  query?: string;
  path?: string;
  maxMatches?: number;
  contextLines?: number;
  cursor?: string;
}
interface SearchMatch { path: string; line: number; snippet: string; before?: string[]; after?: string[]; }
interface SearchData { pattern: string; path: string; matches: SearchMatch[]; }

export async function codebaseSearchTool(input: SearchInput) {
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
      if (err instanceof CursorDecodeError) return cursorInvalidEnvelope(TOOL_NAME, err.message);
      throw err;
    }
    if (cur.tool !== "search_files") return cursorInvalidEnvelope(TOOL_NAME, `cursor.tool was ${cur.tool}`);
    pattern = cur.pattern; targetPath = cur.path; maxMatches = cur.maxMatches;
    contextLines = DEFAULT_CONTEXT_LINES; nextMatchIndex = cur.nextMatchIndex;
  } else {
    pattern = String(input.query ?? "").trim();
    if (!pattern) return makeFailureEnvelope(TOOL_NAME, "invalid-query", "missing required parameter `query`");
    targetPath = String(input.path ?? ".").trim() || ".";
    const raw = Number(input.maxMatches ?? DEFAULT_MAX_MATCHES);
    if (Number.isFinite(raw) && raw > HARD_MAX_MATCHES) { maxMatches = HARD_MAX_MATCHES; warnings.push(`maxMatches clamped to ${HARD_MAX_MATCHES}`); }
    else if (Number.isFinite(raw) && raw >= 1) maxMatches = Math.floor(raw);
    else maxMatches = DEFAULT_MAX_MATCHES;
    contextLines = Math.max(0, Math.min(10, Math.floor(Number(input.contextLines ?? DEFAULT_CONTEXT_LINES))));
    nextMatchIndex = 0;
  }

  if (BROAD.has(pattern)) {
    warnings.push("pattern matches every line; prefer tierkit.read_file with startLine cursor for sequential file reads");
  }

  let re: RegExp;
  try { re = new RegExp(pattern); }
  catch (err) { return makeFailureEnvelope(TOOL_NAME, "invalid-query", `regex compile error: ${(err as Error).message}`); }

  let rootAbs: string;
  try { rootAbs = resolveUnderWorkspace(input.workspaceRoot, targetPath); }
  catch (err) { return makeFailureEnvelope(TOOL_NAME, "outside-workspace", (err as Error).message); }
  const resolvedWorkspaceRoot = resolveUnderWorkspace(input.workspaceRoot, ".");
  const sources = await loadIgnoreSources(input.workspaceRoot);

  const all: SearchMatch[] = [];

  async function walk(dir: string): Promise<void> {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const childAbs = path.join(dir, item.name);
      const relToWs = path.relative(resolvedWorkspaceRoot, childAbs).split(path.sep).join("/");
      if (isIgnored(sources, relToWs)) continue;
      if (isDenied(relToWs)) continue;  // hard skip — search results never include these
      if (item.isDirectory()) { await walk(childAbs); continue; }
      // Read text files only; skip large files and binary files (null-byte heuristic).
      const stat = await fs.stat(childAbs);
      if (stat.size > 2 * 1024 * 1024) continue;
      const buf = await fs.readFile(childAbs);
      if (buf.includes(0)) continue;
      const text = buf.toString("utf8");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          const snippet = redactOutput(lines[i]!).text;
          const before = contextLines > 0 ? lines.slice(Math.max(0, i - contextLines), i).map(l => redactOutput(l).text) : undefined;
          const after = contextLines > 0 ? lines.slice(i + 1, Math.min(lines.length, i + 1 + contextLines)).map(l => redactOutput(l).text) : undefined;
          all.push({ path: relToWs, line: i + 1, snippet, before, after });
        }
      }
    }
  }

  await walk(rootAbs);

  const slice = all.slice(nextMatchIndex, nextMatchIndex + maxMatches);
  const truncated = nextMatchIndex + slice.length < all.length;

  if (!truncated) {
    return makeSuccessEnvelope<SearchData>(TOOL_NAME, { pattern, path: targetPath, matches: slice }, {
      truncated: false,
      size: { linesReturned: slice.length, totalLines: all.length, remainingLines: 0 },
      warnings: warnings.length > 0 ? warnings : undefined,
    });
  }

  const cur: SearchFilesCursor = {
    tool: "search_files", pattern, path: targetPath,
    nextMatchIndex: nextMatchIndex + slice.length, maxMatches,
    createdAt: new Date().toISOString(),
  };
  const encoded = encodeCursor(cur);
  return makeSuccessEnvelope<SearchData>(TOOL_NAME, { pattern, path: targetPath, matches: slice }, {
    truncated: true,
    size: { linesReturned: slice.length, totalLines: all.length, remainingLines: all.length - nextMatchIndex - slice.length },
    next: { cursor: encoded, suggestedCall: { tool: "tierkit.codebase_search", args: { cursor: encoded } } },
    warnings: warnings.length > 0 ? warnings : undefined,
  });
}
