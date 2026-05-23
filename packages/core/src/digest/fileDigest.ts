/**
 * getFileDigest / getFileDigestCached — explain a file without sending its
 * full contents.
 *
 * Use case: Claude Code needs to understand `src/components/Foo.tsx` exists,
 * what it exports, and what its general shape is — before it decides whether
 * to actually read the full file. Sending 800 lines of source for every
 * reference is wasteful; sending a 20-line digest is enough most of the time.
 *
 * The digest contains:
 *   - purpose       : one-line description inferred from primary export kind
 *   - importantSymbols: top-level exports (function/class/interface/type/const)
 *   - dependencies  : import sources extracted from `import ... from "..."`
 *   - risks         : large file (>500 lines), TODO/FIXME markers, `any` usage
 *   - summaryMd     : a Markdown rendering of all of the above + a skeleton
 *
 * What gets dropped:
 *   - Function bodies (only signatures from skeleton)
 *   - Comments inside functions
 *   - Test fixtures, mock data
 *
 * Caching layer (getFileDigestCached):
 *   Digests are cached on disk at `.tierkit/runtime/file-digests/{hash}.json`
 *   where `hash = sha256(schemaVersion + path + content).slice(0, 32)`.
 *
 *   - Same content → same hash → cache hit (`cacheHit: true`).
 *   - File edited → new content → new hash → fresh digest.
 *   - Schema bump → hash differs → regenerated.
 *   - forceRefresh:true bypasses the cache lookup.
 *
 * Why hash-based instead of mtime-based?
 *   mtime can lie (touch, git checkout, FAT filesystems). Content hash is
 *   the source of truth and works across machines (if we ever share cache).
 *
 * Cache maintenance:
 *   - invalidateFileDigest(path) — remove one entry
 *   - clearFileDigestCache(root) — wipe everything
 *   - getFileDigestCacheStats(root) — count + bytes for the Settings card
 *
 * Pure rule-based. Uses extractSkeleton() from v0.11 context-compression for
 * the language-aware import/export/symbol parsing.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { extractSkeleton } from "../context-compression/extractSkeleton.js";
import type { SourceLanguage, SymbolEntry } from "../context-compression/types.js";
import {
  DEFAULT_DIGEST_BUDGET,
  type DigestBudget,
  type FileDigest,
} from "./types.js";
import { computeStats, makeDigestId } from "./stats.js";

const SCHEMA_VERSION = 1 as const;
const CACHE_SUBDIR = ".tierkit/runtime/file-digests";

export interface GetFileDigestOptions {
  workspaceRoot: string;
  budget?: Partial<DigestBudget>;
  /** When true, ignore the on-disk cache and regenerate. Default false. */
  forceRefresh?: boolean;
}

function languageFromPath(filePath: string): SourceLanguage {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
  switch (ext) {
    case "ts": return "ts";
    case "tsx": return "tsx";
    case "js": case "mjs": case "cjs": return "js";
    case "jsx": return "jsx";
    case "py": return "py";
    case "go": return "go";
    case "rs": return "rs";
    case "md": case "mdx": return "md";
    case "json": return "json";
    case "yaml": case "yml": return "yaml";
    case "toml": return "toml";
    case "sh": case "bash": case "zsh": return "sh";
    default: return "other";
  }
}

function hashContent(filePath: string, content: string): string {
  const h = crypto.createHash("sha256");
  h.update(`v${SCHEMA_VERSION}|`);
  h.update(filePath);
  h.update("\n");
  h.update(content);
  return h.digest("hex").slice(0, 32);
}

function cachePath(workspaceRoot: string, hash: string): string {
  return path.join(workspaceRoot, CACHE_SUBDIR, `${hash}.json`);
}

async function readCache(workspaceRoot: string, hash: string): Promise<FileDigest | null> {
  try {
    const raw = await fs.readFile(cachePath(workspaceRoot, hash), "utf8");
    const parsed = JSON.parse(raw) as FileDigest;
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(workspaceRoot: string, digest: FileDigest): Promise<void> {
  const target = cachePath(workspaceRoot, digest.hash);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(digest, null, 2));
}

function summarizeSymbols(skeleton: SymbolEntry[]): {
  importantSymbols: string[];
  dependencies: string[];
  purpose: string;
} {
  const importantSymbols: string[] = [];
  const dependencies: string[] = [];
  let primaryKind: string | null = null;

  for (const s of skeleton) {
    if (s.kind === "import") {
      const m = /from\s+["']([^"']+)["']/.exec(s.text) ?? /(?:require|import)\s*\(\s*["']([^"']+)["']/.exec(s.text);
      const dep = m?.[1];
      if (dep && !dependencies.includes(dep)) {
        dependencies.push(dep);
      }
      continue;
    }
    const nameMatch = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|def|fn|func)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(s.text);
    const symName = nameMatch?.[1];
    if (symName) {
      importantSymbols.push(symName);
      if (!primaryKind) primaryKind = s.kind;
    }
  }

  const purpose =
    primaryKind === "class" ? "Defines class(es) — likely an entity, controller, or service."
    : primaryKind === "interface" || primaryKind === "type" ? "Defines type contracts — consumed by other modules."
    : primaryKind === "function" ? "Exports function(s) — utility or workflow."
    : importantSymbols.length > 0 ? "Exports constants / values."
    : "No top-level exports detected.";

  return { importantSymbols, dependencies, purpose };
}

function detectRisks(filePath: string, content: string, totalLines: number): string[] {
  const risks: string[] = [];
  if (totalLines > 500) risks.push(`Large file (${totalLines} lines) — read in sections.`);
  const todoCount = (content.match(/\bTODO\b/g) || []).length;
  if (todoCount > 0) risks.push(`${todoCount} TODO marker(s) — incomplete work flagged.`);
  const fixmeCount = (content.match(/\bFIXME\b/g) || []).length;
  if (fixmeCount > 0) risks.push(`${fixmeCount} FIXME marker(s) — known issues flagged.`);
  if (/\bany\s*[;,)\]>]|: any\b/.test(content) && filePath.endsWith(".ts")) {
    risks.push("Uses `any` type — type safety gaps possible.");
  }
  return risks;
}

function renderFileDigestMd(
  filePath: string,
  purpose: string,
  importantSymbols: string[],
  dependencies: string[],
  risks: string[],
  totalLines: number,
  skeleton: SymbolEntry[],
): string {
  const lines: string[] = [];
  lines.push(`# File Digest: ${filePath}`);
  lines.push("");
  lines.push(`**Total lines:** ${totalLines}`);
  lines.push("");
  lines.push(`## Purpose`);
  lines.push(purpose);
  if (importantSymbols.length > 0) {
    lines.push("");
    lines.push(`## Important symbols`);
    for (const s of importantSymbols.slice(0, 30)) lines.push(`- ${s}`);
    if (importantSymbols.length > 30) lines.push(`- … (+${importantSymbols.length - 30} more)`);
  }
  if (dependencies.length > 0) {
    lines.push("");
    lines.push(`## Dependencies`);
    for (const d of dependencies.slice(0, 20)) lines.push(`- ${d}`);
  }
  if (risks.length > 0) {
    lines.push("");
    lines.push(`## Risks`);
    for (const r of risks) lines.push(`- ${r}`);
  }
  if (skeleton.length > 0) {
    lines.push("");
    lines.push("## Skeleton");
    lines.push("```");
    for (const s of skeleton.slice(0, 40)) {
      lines.push(`${s.line}: ${s.text.trim()}`);
    }
    if (skeleton.length > 40) {
      lines.push(`… (+${skeleton.length - 40} more)`);
    }
    lines.push("```");
  }
  return lines.join("\n");
}

export async function getFileDigest(
  filePath: string,
  options: GetFileDigestOptions,
): Promise<FileDigest> {
  // Resolve under workspace root.
  const absPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(options.workspaceRoot, filePath);
  const relPath = path.relative(options.workspaceRoot, absPath).split(path.sep).join("/");
  let content: string;
  try {
    content = await fs.readFile(absPath, "utf8");
  } catch (err) {
    const msg = (err as NodeJS.ErrnoException).code === "ENOENT"
      ? `file does not exist: ${relPath}`
      : (err as Error).message;
    const summaryMd = `# File Digest: ${relPath}\n\n_${msg}_`;
    return {
      id: makeDigestId("file"),
      path: relPath,
      hash: "",
      schemaVersion: SCHEMA_VERSION,
      purpose: "File could not be read.",
      importantSymbols: [],
      dependencies: [],
      risks: [],
      uncertainty: [msg],
      summaryMd,
      totalLines: 0,
      generatedAt: new Date().toISOString(),
      cacheHit: false,
      stats: computeStats("", summaryMd),
    };
  }

  const hash = hashContent(relPath, content);
  const lang = languageFromPath(relPath);
  const totalLines = content.split(/\r?\n/).length;
  const skeleton = extractSkeleton(content, lang);
  const { importantSymbols, dependencies, purpose } = summarizeSymbols(skeleton);
  const risks = detectRisks(relPath, content, totalLines);
  const summaryMd = renderFileDigestMd(relPath, purpose, importantSymbols, dependencies, risks, totalLines, skeleton);

  return {
    id: makeDigestId("file"),
    path: relPath,
    hash,
    schemaVersion: SCHEMA_VERSION,
    language: lang,
    purpose,
    importantSymbols,
    dependencies,
    risks,
    uncertainty: [],
    summaryMd,
    totalLines,
    generatedAt: new Date().toISOString(),
    cacheHit: false,
    stats: computeStats(content, summaryMd),
  };
}

export async function getFileDigestCached(
  filePath: string,
  options: GetFileDigestOptions,
): Promise<FileDigest> {
  // To compute the hash we need content first — we read once and reuse.
  const absPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(options.workspaceRoot, filePath);
  const relPath = path.relative(options.workspaceRoot, absPath).split(path.sep).join("/");

  let content: string;
  try {
    content = await fs.readFile(absPath, "utf8");
  } catch {
    // Delegate to getFileDigest which builds an empty digest with uncertainty.
    return getFileDigest(filePath, options);
  }

  const hash = hashContent(relPath, content);

  if (!options.forceRefresh) {
    const cached = await readCache(options.workspaceRoot, hash);
    if (cached) {
      return { ...cached, cacheHit: true };
    }
  }

  const fresh = await getFileDigest(filePath, options);
  if (fresh.hash) {
    await writeCache(options.workspaceRoot, fresh);
  }
  return fresh;
}

export async function invalidateFileDigest(
  filePath: string,
  options: { workspaceRoot: string },
): Promise<void> {
  const absPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(options.workspaceRoot, filePath);
  const relPath = path.relative(options.workspaceRoot, absPath).split(path.sep).join("/");
  let content: string;
  try {
    content = await fs.readFile(absPath, "utf8");
  } catch {
    return; // file gone; nothing to invalidate
  }
  const hash = hashContent(relPath, content);
  await fs.rm(cachePath(options.workspaceRoot, hash), { force: true });
}

export interface FileDigestCacheStats {
  /** Workspace-relative cache dir (always `.tierkit/runtime/file-digests`). */
  relativePath: string;
  /** Number of cached digest files. */
  count: number;
  /** Sum of all cache file sizes in bytes. */
  totalBytes: number;
  /** True when the cache directory does not exist yet. */
  empty: boolean;
}

export async function getFileDigestCacheStats(workspaceRoot: string): Promise<FileDigestCacheStats> {
  const dir = path.join(workspaceRoot, CACHE_SUBDIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { relativePath: CACHE_SUBDIR, count: 0, totalBytes: 0, empty: true };
  }
  let count = 0;
  let totalBytes = 0;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const st = await fs.stat(path.join(dir, name));
      if (st.isFile()) {
        count += 1;
        totalBytes += st.size;
      }
    } catch {
      // entry vanished between readdir and stat; skip
    }
  }
  return { relativePath: CACHE_SUBDIR, count, totalBytes, empty: count === 0 };
}

export async function clearFileDigestCache(workspaceRoot: string): Promise<{ removedCount: number }> {
  const dir = path.join(workspaceRoot, CACHE_SUBDIR);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return { removedCount: 0 };
  }
  let removedCount = 0;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      await fs.rm(path.join(dir, name), { force: true });
      removedCount += 1;
    } catch {
      // ignore individual failures; report the rest
    }
  }
  return { removedCount };
}
