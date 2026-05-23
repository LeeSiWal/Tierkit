/**
 * summarizeGitDiff — turn `git diff` into "what changed, in what files, with
 * what risks" — without sending the full diff to Claude.
 *
 * Output:
 *   - changedFiles   : list of paths touched
 *   - addedFiles     : new files
 *   - modifiedFiles  : existing files edited
 *   - deletedFiles   : files removed
 *   - renamedFiles   : [{ from, to }] rename pairs
 *   - affectedSymbols: function/class/type names extracted from hunk content
 *   - possibleBreakages: heuristic warnings (deletes, renames, big net removals)
 *
 * Why this exists instead of just `git diff`:
 *   A typical refactor diff is hundreds of lines. The *Claude-useful* signal
 *   is "you renamed Foo to Bar across 4 files; verify imports". This function
 *   extracts that signal in ~30 lines instead of 1500.
 *
 * Implementation:
 *   - Spawns `git diff` (working tree by default, --staged if requested).
 *   - Parses the unified diff line-by-line — file headers (diff --git a/...
 *     b/...), hunk headers (@@ -A,B +C,D @@), +/- lines.
 *   - Extracts identifier-shaped names from +/- lines and hunk context.
 *
 * Test injection:
 *   `options.diffRunner` lets tests bypass the git subprocess. Default
 *   `defaultDiffRunner` runs the real `git` binary in the project root.
 *
 * Error handling:
 *   If `git` isn't on PATH, or the directory isn't a repo, you get an empty
 *   summary with the error message in `uncertainty`. Never throws.
 *
 * Known limitation:
 *   The symbol extraction is regex-based, not AST-based. It catches the
 *   common cases (function foo, class Bar, const baz =) but won't catch
 *   exotic patterns (decorators, dynamic exports, JSX components). See
 *   docs/REVIEW-v0.19.md §7 for the upgrade path.
 */
import { spawn } from "node:child_process";
import {
  DEFAULT_DIGEST_BUDGET,
  type DiffSummary,
  type DigestBudget,
} from "./types.js";
import { computeStats, makeDigestId } from "./stats.js";

export interface SummarizeGitDiffOptions {
  budget?: Partial<DigestBudget>;
  /** When true, diff `--staged`; otherwise unstaged (working tree). Default false. */
  staged?: boolean;
  /** Injectable diff runner for tests. */
  diffRunner?: (rootPath: string, staged: boolean) => Promise<{ ok: true; diff: string } | { ok: false; message: string }>;
}

export const defaultDiffRunner = (rootPath: string, staged: boolean): Promise<{ ok: true; diff: string } | { ok: false; message: string }> =>
  new Promise((resolve) => {
    const args = ["diff", staged ? "--staged" : "--", "--no-color"];
    if (staged) args.pop(); // remove "--" because --staged form
    const finalArgs = staged ? ["diff", "--staged", "--no-color"] : ["diff", "--no-color"];
    const child = spawn("git", finalArgs, { cwd: rootPath });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      resolve({
        ok: false,
        message: code === "ENOENT" ? "git command not found in PATH" : err.message,
      });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ ok: false, message: stderr.trim() || `git diff exited with code ${code}` });
        return;
      }
      resolve({ ok: true, diff: stdout });
    });
  });

const FILE_HEADER_RE = /^diff --git a\/(.+?) b\/(.+?)\s*$/;
const RENAME_FROM_RE = /^rename from (.+?)\s*$/;
const RENAME_TO_RE = /^rename to (.+?)\s*$/;
const NEW_FILE_MODE_RE = /^new file mode /;
const DELETED_FILE_MODE_RE = /^deleted file mode /;
const HUNK_HEADER_RE = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@(?:\s+(?<context>.*))?$/;
// Heuristic: function/symbol pattern in hunk context line or added/changed lines.
const SYMBOL_RE = /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|def|fn|func)\s+([A-Za-z_][A-Za-z0-9_]*)\b/g;

interface PerFileState {
  oldPath: string;
  newPath: string;
  status: "added" | "deleted" | "modified" | "renamed";
  insertions: number;
  deletions: number;
  hunkSymbols: Set<string>;
}

function newFileState(oldPath: string, newPath: string): PerFileState {
  return {
    oldPath,
    newPath,
    status: oldPath === newPath ? "modified" : "renamed",
    insertions: 0,
    deletions: 0,
    hunkSymbols: new Set<string>(),
  };
}

function extractSymbols(line: string, out: Set<string>): void {
  let m: RegExpExecArray | null;
  SYMBOL_RE.lastIndex = 0;
  while ((m = SYMBOL_RE.exec(line)) !== null) {
    if (m[1]) out.add(m[1]);
  }
}

export async function summarizeGitDiff(
  rootPath: string,
  options: SummarizeGitDiffOptions = {},
): Promise<DiffSummary> {
  const budget = { ...DEFAULT_DIGEST_BUDGET, ...options.budget };
  const staged = options.staged === true;
  const runner = options.diffRunner ?? defaultDiffRunner;

  const result = await runner(rootPath, staged);
  if (!result.ok) {
    const empty: DiffSummary = {
      id: makeDigestId("diff"),
      summaryMd: `# Diff Summary\n\n_Could not run git diff: ${result.message}_`,
      changedFiles: [],
      addedFiles: [],
      modifiedFiles: [],
      deletedFiles: [],
      renamedFiles: [],
      affectedSymbols: [],
      possibleBreakages: [],
      uncertainty: [result.message],
      totalInsertions: 0,
      totalDeletions: 0,
      stats: computeStats("", ""),
    };
    return empty;
  }

  const diff = result.diff;
  const files: PerFileState[] = [];
  let current: PerFileState | null = null;
  const lines = diff.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const header = FILE_HEADER_RE.exec(line);
    if (header && header[1] && header[2]) {
      current = newFileState(header[1], header[2]);
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (NEW_FILE_MODE_RE.test(line)) {
      current.status = "added";
      continue;
    }
    if (DELETED_FILE_MODE_RE.test(line)) {
      current.status = "deleted";
      continue;
    }
    const renameFrom = RENAME_FROM_RE.exec(line);
    if (renameFrom && renameFrom[1]) {
      current.oldPath = renameFrom[1];
      current.status = "renamed";
      continue;
    }
    const renameTo = RENAME_TO_RE.exec(line);
    if (renameTo && renameTo[1]) {
      current.newPath = renameTo[1];
      current.status = "renamed";
      continue;
    }
    const hunk = HUNK_HEADER_RE.exec(line);
    if (hunk) {
      const ctx = hunk.groups?.context ?? "";
      if (ctx) extractSymbols(ctx, current.hunkSymbols);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.insertions += 1;
      extractSymbols(line.slice(1), current.hunkSymbols);
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions += 1;
      extractSymbols(line.slice(1), current.hunkSymbols);
    }
  }

  // Truncate to budget.
  const truncatedFiles = files.slice(0, budget.maxItems);

  const changedFiles: string[] = [];
  const addedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const deletedFiles: string[] = [];
  const renamedFiles: Array<{ from: string; to: string }> = [];
  const affectedSymbols = new Set<string>();
  let totalInsertions = 0;
  let totalDeletions = 0;

  for (const f of truncatedFiles) {
    const path = f.newPath || f.oldPath;
    changedFiles.push(path);
    if (f.status === "added") addedFiles.push(path);
    else if (f.status === "deleted") deletedFiles.push(f.oldPath || f.newPath);
    else if (f.status === "renamed") renamedFiles.push({ from: f.oldPath, to: f.newPath });
    else modifiedFiles.push(path);
    for (const s of f.hunkSymbols) affectedSymbols.add(s);
    totalInsertions += f.insertions;
    totalDeletions += f.deletions;
  }

  const possibleBreakages: string[] = [];
  if (deletedFiles.length > 0) {
    possibleBreakages.push(`${deletedFiles.length} file(s) deleted — verify no imports remain.`);
  }
  if (renamedFiles.length > 0) {
    possibleBreakages.push(`${renamedFiles.length} file(s) renamed — verify all import paths updated.`);
  }
  for (const f of truncatedFiles) {
    if (f.status === "modified" && f.deletions > f.insertions * 3 && f.deletions > 30) {
      possibleBreakages.push(`${f.newPath}: large net removal (-${f.deletions} +${f.insertions}) — verify behavior preserved.`);
    }
  }

  const uncertainty: string[] = [];
  if (files.length > budget.maxItems) {
    uncertainty.push(`Truncated to first ${budget.maxItems} of ${files.length} files.`);
  }
  if (files.length === 0) {
    uncertainty.push("Diff was empty — working tree may be clean (or --staged was wrong).");
  }

  const summaryMd = renderDiffSummaryMd(
    changedFiles,
    addedFiles,
    modifiedFiles,
    deletedFiles,
    renamedFiles,
    [...affectedSymbols],
    possibleBreakages,
    totalInsertions,
    totalDeletions,
  );
  const stats = computeStats(diff, summaryMd);

  return {
    id: makeDigestId("diff"),
    summaryMd,
    changedFiles,
    addedFiles,
    modifiedFiles,
    deletedFiles,
    renamedFiles,
    affectedSymbols: [...affectedSymbols],
    possibleBreakages,
    uncertainty,
    totalInsertions,
    totalDeletions,
    stats,
  };
}

function renderDiffSummaryMd(
  changed: string[],
  added: string[],
  modified: string[],
  deleted: string[],
  renamed: Array<{ from: string; to: string }>,
  symbols: string[],
  breakages: string[],
  ins: number,
  del: number,
): string {
  const lines: string[] = [];
  lines.push("# Diff Summary");
  lines.push("");
  lines.push(`Changed files: ${changed.length} (+${ins} / -${del})`);
  lines.push("");
  if (added.length > 0) {
    lines.push("## Added");
    for (const p of added) lines.push(`- ${p}`);
  }
  if (modified.length > 0) {
    lines.push("");
    lines.push("## Modified");
    for (const p of modified) lines.push(`- ${p}`);
  }
  if (deleted.length > 0) {
    lines.push("");
    lines.push("## Deleted");
    for (const p of deleted) lines.push(`- ${p}`);
  }
  if (renamed.length > 0) {
    lines.push("");
    lines.push("## Renamed");
    for (const r of renamed) lines.push(`- ${r.from} → ${r.to}`);
  }
  if (symbols.length > 0) {
    lines.push("");
    lines.push("## Affected symbols");
    for (const s of symbols.slice(0, 30)) lines.push(`- ${s}`);
    if (symbols.length > 30) lines.push(`- … (+${symbols.length - 30} more)`);
  }
  if (breakages.length > 0) {
    lines.push("");
    lines.push("## Possible breakages");
    for (const b of breakages) lines.push(`- ${b}`);
  }
  return lines.join("\n");
}
