/**
 * Shared types for the v0.18 context-gateway digest functions.
 *
 * These are deliberately separate from `context-compression/types.ts` —
 * that file handles ripgrep-driven file excerpts; this file handles
 * the rule-based digests for commands, error logs, test output, JSON,
 * git diffs, and full Context Packs.
 *
 * Every digest result has the same skeleton:
 *   - id          : unique "{prefix}_{hex10}" identifier
 *   - summaryMd   : human-readable Markdown for display
 *   - stats       : CompressionStats (before/after tokens, saved ratio)
 *   - uncertainty : list of caveats — surface these in the UI!
 *   - verdict     : "safe" | "risky" | "failed" | "not-evaluated"
 *                   ("not-evaluated" means no compare step ran yet)
 *
 * The big interesting type at the bottom is `ContextPack` — that's what
 * Claude Code consumes via `buildContextPack`.
 */

export type CompressionVerdict = "safe" | "risky" | "failed" | "not-evaluated";

export interface CompressionStats {
  beforeChars: number;
  afterChars: number;
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
  savedRatio: number;
  estimationMethod: "chars/4";
}

export interface CompressedCommand {
  id: string;
  original: string;
  taskTitle: string;
  compressed: string;
  requirements: string[];
  constraints: string[];
  likelyFocus: string[];
  uncertainty: string[];
  stats: CompressionStats;
  provider: "rule" | "ollama" | "mock";
  model?: string;
  verdict: CompressionVerdict;
}

export interface DigestErrorItem {
  message: string;
  filePath?: string;
  line?: number;
  column?: number;
  symbol?: string;
  repeatedCount: number;
}

export interface ErrorDigest {
  id: string;
  summaryMd: string;
  mainErrors: DigestErrorItem[];
  likelyFiles: string[];
  likelySymbols: string[];
  uncertainty: string[];
  stats: CompressionStats;
  verdict: CompressionVerdict;
}

export interface TestFailureItem {
  suite?: string;
  caseName?: string;
  expected?: string;
  received?: string;
  relevantFrames: string[];
  likelyCause?: string;
}

export interface TestDigest {
  id: string;
  summaryMd: string;
  failedSuites: string[];
  failedCases: TestFailureItem[];
  likelyFiles: string[];
  passedCount: number;
  failedCount: number;
  uncertainty: string[];
  stats: CompressionStats;
  verdict: CompressionVerdict;
}

export interface JsonDigest {
  id: string;
  summaryMd: string;
  shape: unknown;
  fieldPaths: string[];
  possibleMismatches: string[];
  uncertainty: string[];
  stats: CompressionStats;
  verdict: CompressionVerdict;
}

export interface FileDigest {
  id: string;
  path: string;
  hash: string;
  schemaVersion: 1;
  language?: string;
  purpose: string;
  importantSymbols: string[];
  dependencies: string[];
  risks: string[];
  uncertainty: string[];
  summaryMd: string;
  totalLines: number;
  generatedAt: string;
  cacheHit: boolean;
  stats: CompressionStats;
}

export interface DiffSummary {
  id: string;
  summaryMd: string;
  changedFiles: string[];
  addedFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
  renamedFiles: Array<{ from: string; to: string }>;
  affectedSymbols: string[];
  possibleBreakages: string[];
  uncertainty: string[];
  totalInsertions: number;
  totalDeletions: number;
  stats: CompressionStats;
}

export interface CleanedContext {
  id: string;
  originalLength: number;
  cleaned: string;
  removedHints: string[];
  preservedWarnings: string[];
  stats: CompressionStats;
}

export interface ContextPack {
  id: string;
  title: string;
  taskBrief: string;
  requirements: string[];
  constraints: string[];
  relevantFileDigests: FileDigest[];
  diffSummary?: DiffSummary;
  errorDigest?: ErrorDigest;
  testDigest?: TestDigest;
  jsonDigest?: JsonDigest;
  cleanedContext?: CleanedContext;
  uncertainty: string[];
  outputPolicy: string[];
  contentMd: string;
  stats: CompressionStats;
  provider: string;
  model?: string;
  verdict: CompressionVerdict;
  createdAt: string;
}

export interface DigestBudget {
  /** Hard cap on character output of an individual digest. Default 8000. */
  maxChars: number;
  /** Cap on the number of items kept per category (errors, failed cases, etc.). Default 20. */
  maxItems: number;
}

export const DEFAULT_DIGEST_BUDGET: DigestBudget = {
  maxChars: 8000,
  maxItems: 20,
};

export const CONTEXT_PACK_OUTPUT_POLICY: string[] = [
  "Use this Context Pack as the primary task context.",
  "Prefer minimal patches over rewrites.",
  "Do not rewrite unrelated files.",
  "Do not repeat unchanged code in your response.",
  "Before reading large source files in full, prefer the Tierkit MCP digest tools.",
  "Read original source only where exact implementation details are required.",
  "Preserve the current architecture unless explicitly instructed otherwise.",
  "Run typecheck and relevant tests after changes.",
  "Report changed files, verification commands, and remaining risks.",
];
