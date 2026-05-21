import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { resolveUnderWorkspace } from "../workspaceBoundary.js";
import { loadIgnoreSources, isIgnored } from "../ignoreSources.js";
import { isDenied } from "../pathDenylist.js";
import { redactOutput } from "../redactOutput.js";

export interface CodebaseSearchInput {
  workspaceRoot: string;
  query: string;
  maxMatches?: number;    // default 100
  contextLines?: number;  // default 2
}

export interface SearchMatch {
  path: string;
  line: number;
  snippet: string;
}

export type CodebaseSearchResult =
  | { ok: true; matches: SearchMatch[]; truncated: boolean }
  | { ok: false; code: string; message: string };

const DEFAULT_MAX_MATCHES = 100;

export async function codebaseSearchTool(input: CodebaseSearchInput): Promise<CodebaseSearchResult> {
  let root: string;
  try {
    root = resolveUnderWorkspace(input.workspaceRoot, ".");
  } catch (err) {
    return { ok: false, code: "outside-workspace", message: String((err as Error).message) };
  }

  if (!input.query || input.query.length === 0) {
    return { ok: false, code: "invalid-query", message: "query is empty" };
  }

  // Resolve the workspace root through symlinks (macOS /var→/private/var) so
  // path.relative() produces clean relative paths.
  let resolvedRoot: string;
  try {
    resolvedRoot = fsSync.realpathSync(input.workspaceRoot);
  } catch {
    resolvedRoot = path.resolve(input.workspaceRoot);
  }

  const sources = await loadIgnoreSources(input.workspaceRoot);
  const maxMatches = input.maxMatches ?? DEFAULT_MAX_MATCHES;
  const contextLines = input.contextLines ?? 2;
  const matches: SearchMatch[] = [];
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (matches.length >= maxMatches) { truncated = true; return; }
      const childAbs = path.join(dir, item.name);
      const relToWs = path.relative(resolvedRoot, childAbs).split(path.sep).join("/");
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
        if (lines[i]!.includes(input.query)) {
          const from = Math.max(0, i - contextLines);
          const to = Math.min(lines.length, i + contextLines + 1);
          const snippet = lines.slice(from, to).join("\n");
          const redacted = redactOutput(snippet);
          matches.push({ path: relToWs, line: i + 1, snippet: redacted.text });
          if (matches.length >= maxMatches) { truncated = true; return; }
        }
      }
    }
  }

  await walk(root);
  return { ok: true, matches, truncated };
}
