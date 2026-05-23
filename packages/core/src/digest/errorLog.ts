/**
 * compressErrorLog — keep error LOCATIONS, drop everything else.
 *
 * Input: a multi-line build / test / runtime error log (potentially thousands
 * of lines, mostly noise).
 *
 * Output: a digest with:
 *   - mainErrors: the actual errors with file:line:col
 *   - likelyFiles: paths from the user's own source (not node_modules)
 *   - likelySymbols: function/class names parsed from stack frames
 *
 * What gets dropped (saves ~70-90% tokens on noisy logs):
 *   - Stack frames inside node_modules / site-packages / node:internal
 *   - Duplicate identical error messages (collapsed to repeatedCount)
 *   - Empty lines, build banners
 *
 * What gets kept (safety-critical):
 *   - TypeScript errors (TS\d+) with the source location
 *   - esbuild/vite/swc errors with location
 *   - Generic Error/TypeError messages
 *   - User-code stack frames (file paths NOT matching VENDOR_PATH_RE)
 *   - Python tracebacks (File "x", line N, in func)
 *
 * Pure rule-based. No LLM. Deterministic — same input always produces same
 * digest (modulo the random `id` field). Synchronous.
 *
 * Common gotchas:
 *   - If your error format isn't recognized (e.g., a Rust panic), you'll get
 *     `mainErrors: []` and an uncertainty flag. Add a new regex to handle it.
 *   - keepVendorFrames: true keeps node_modules frames — useful when
 *     debugging a library, not for normal app errors.
 */
import {
  DEFAULT_DIGEST_BUDGET,
  type DigestBudget,
  type DigestErrorItem,
  type ErrorDigest,
} from "./types.js";
import { computeStats, makeDigestId } from "./stats.js";

export interface CompressErrorLogOptions {
  budget?: Partial<DigestBudget>;
  /** When true, keep node_modules/site-packages stack frames (default false). */
  keepVendorFrames?: boolean;
}

interface ParsedError {
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  symbol?: string;
  category: "ts" | "node" | "python" | "bundler" | "generic";
  raw: string;
}

const VENDOR_PATH_RE = /(node_modules|site-packages|\/dist\/|\/build\/|\.next\/|\.vite\/|\.turbo\/|node:internal)/;
const TS_ERROR_RE = /^(?<file>[^():]+?)(?::(?<line>\d+))?(?::(?<col>\d+))?\s*-?\s*error\s+TS(?<code>\d+):\s*(?<msg>.+)$/i;
const NODE_FRAME_RE = /^\s*at\s+(?:(?<symbol>[^()\s][^()]*?)\s+\()?(?<file>[^()]+):(?<line>\d+):(?<col>\d+)\)?\s*$/;
const PY_TRACE_FILE_RE = /^\s*File\s+"(?<file>[^"]+)",\s+line\s+(?<line>\d+)(?:,\s+in\s+(?<symbol>\S+))?\s*$/;
const BUNDLER_ERROR_RE = /^(?<file>[^():]+?):(?<line>\d+):(?<col>\d+):\s*(?:error|ERROR):\s*(?<msg>.+)$/;
const GENERIC_ERROR_RE = /^([A-Z][A-Za-z]*Error|Error):\s*(.+)$/;

function classifyLine(line: string): ParsedError | null {
  // TypeScript: src/foo.ts:42:13 - error TS2345: ...
  const ts = TS_ERROR_RE.exec(line);
  if (ts?.groups) {
    return {
      message: `TS${ts.groups.code}: ${ts.groups.msg}`.trim(),
      filePath: ts.groups.file,
      line: ts.groups.line ? Number(ts.groups.line) : undefined,
      column: ts.groups.col ? Number(ts.groups.col) : undefined,
      category: "ts",
      raw: line,
    };
  }
  // esbuild / vite / swc: src/foo.ts:42:13: ERROR: ...
  const bundler = BUNDLER_ERROR_RE.exec(line);
  const bundlerMsg = bundler?.groups?.msg;
  if (bundlerMsg) {
    return {
      message: bundlerMsg.trim(),
      filePath: bundler!.groups!.file,
      line: Number(bundler!.groups!.line),
      column: Number(bundler!.groups!.col),
      category: "bundler",
      raw: line,
    };
  }
  // Generic Error message: TypeError: foo is not a function
  const gen = GENERIC_ERROR_RE.exec(line);
  if (gen) {
    return {
      message: line.trim(),
      category: "generic",
      raw: line,
    };
  }
  return null;
}

function classifyFrame(line: string): ParsedError | null {
  const node = NODE_FRAME_RE.exec(line);
  if (node?.groups) {
    return {
      message: `at ${node.groups.symbol ?? "<anon>"} (${node.groups.file}:${node.groups.line})`,
      filePath: node.groups.file,
      line: Number(node.groups.line),
      column: Number(node.groups.col),
      symbol: node.groups.symbol,
      category: "node",
      raw: line,
    };
  }
  const py = PY_TRACE_FILE_RE.exec(line);
  if (py?.groups) {
    return {
      message: `at ${py.groups.symbol ?? "<anon>"} (${py.groups.file}:${py.groups.line})`,
      filePath: py.groups.file,
      line: Number(py.groups.line),
      symbol: py.groups.symbol,
      category: "python",
      raw: line,
    };
  }
  return null;
}

function isUserPath(filePath: string | undefined, keepVendor: boolean): boolean {
  if (!filePath) return true;
  if (keepVendor) return true;
  return !VENDOR_PATH_RE.test(filePath);
}

function makeKey(p: ParsedError): string {
  return `${p.category}|${p.filePath ?? ""}|${p.line ?? ""}|${p.message}`;
}

function uniqPush(out: string[], value: string): void {
  if (value && !out.includes(value)) out.push(value);
}

export function compressErrorLog(
  log: string,
  options: CompressErrorLogOptions = {},
): ErrorDigest {
  const budget = { ...DEFAULT_DIGEST_BUDGET, ...options.budget };
  const keepVendor = options.keepVendorFrames === true;
  const lines = log.split(/\r?\n/);

  const errors: ParsedError[] = [];
  const frames: ParsedError[] = [];
  const counts = new Map<string, number>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const err = classifyLine(line);
    if (err) {
      if (!isUserPath(err.filePath, keepVendor)) continue;
      const key = makeKey(err);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!errors.find((e) => makeKey(e) === key)) errors.push(err);
      continue;
    }
    const frame = classifyFrame(line);
    if (frame) {
      if (!isUserPath(frame.filePath, keepVendor)) continue;
      const key = makeKey(frame);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!frames.find((f) => makeKey(f) === key)) frames.push(frame);
    }
  }

  // Prioritize real errors over plain stack frames.
  const ranked = [...errors, ...frames].slice(0, budget.maxItems);

  const mainErrors: DigestErrorItem[] = ranked.map((p) => ({
    message: p.message,
    filePath: p.filePath,
    line: p.line,
    column: p.column,
    symbol: p.symbol,
    repeatedCount: counts.get(makeKey(p)) ?? 1,
  }));

  const likelyFiles: string[] = [];
  const likelySymbols: string[] = [];
  for (const e of mainErrors) {
    if (e.filePath) uniqPush(likelyFiles, e.filePath);
    if (e.symbol) uniqPush(likelySymbols, e.symbol);
  }

  const uncertainty: string[] = [];
  if (errors.length === 0 && frames.length === 0) {
    uncertainty.push("No recognizable error patterns found. The log may be in an unsupported format.");
  } else if (errors.length === 0) {
    uncertainty.push("Found stack frames but no explicit error message — root cause is inferred from frames only.");
  }
  if (mainErrors.length === budget.maxItems) {
    uncertainty.push(`Truncated to top ${budget.maxItems} items — re-run with a larger maxItems to see more.`);
  }

  const summaryMd = renderErrorDigestMd(mainErrors, likelyFiles, likelySymbols);
  const stats = computeStats(log, summaryMd);

  return {
    id: makeDigestId("err"),
    summaryMd,
    mainErrors,
    likelyFiles,
    likelySymbols,
    uncertainty,
    stats,
    verdict: "not-evaluated",
  };
}

function renderErrorDigestMd(
  errors: DigestErrorItem[],
  likelyFiles: string[],
  likelySymbols: string[],
): string {
  const lines: string[] = [];
  lines.push("# Error Digest");
  lines.push("");
  if (errors.length === 0) {
    lines.push("_No recognizable errors found in the log._");
    return lines.join("\n");
  }
  lines.push(`Main errors (${errors.length}):`);
  for (const e of errors) {
    const loc = e.filePath
      ? `${e.filePath}${e.line ? `:${e.line}${e.column ? `:${e.column}` : ""}` : ""}`
      : null;
    const repeat = e.repeatedCount > 1 ? ` (x${e.repeatedCount})` : "";
    lines.push(`- ${e.message}${loc ? ` — ${loc}` : ""}${repeat}`);
  }
  if (likelyFiles.length > 0) {
    lines.push("");
    lines.push("Likely files:");
    for (const f of likelyFiles) lines.push(`- ${f}`);
  }
  if (likelySymbols.length > 0) {
    lines.push("");
    lines.push("Likely symbols:");
    for (const s of likelySymbols) lines.push(`- ${s}`);
  }
  return lines.join("\n");
}
