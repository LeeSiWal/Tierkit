export type SourceLanguage =
  | "ts" | "tsx" | "js" | "jsx"
  | "py" | "go" | "rs"
  | "md" | "json" | "yaml" | "toml" | "sh"
  | "other";

export interface ContextBudget {
  maxFiles: number;
  maxHotspotsPerFile: number;
  hotspotContextLines: number;
  /** Soft target for information only — not used to truncate prompt.md. */
  cloudTokenBudget?: number;
}

export interface RelevantFile {
  path: string;                     // workspace-relative
  score: number;                    // 0..1
  reason: string;                   // short human-readable
  matchedTerms: string[];
  termHitCount: number;
  pathBonus: number;                // breakdown for debugging
  mtimeBonus: number;
  sizeBytes: number;
  language?: SourceLanguage;
}

export type SymbolKind = "import" | "export" | "function" | "class" | "interface" | "type" | "const";

export interface SymbolEntry {
  kind: SymbolKind;
  line: number;                     // 1-based
  text: string;                     // verbatim source line
}

export interface Hotspot {
  startLine: number;                // 1-based, inclusive
  endLine: number;                  // 1-based, inclusive
  matchedTerms: string[];
  code: string;                     // verbatim source for [startLine..endLine]
}

export interface FileExcerpt {
  path: string;
  language?: SourceLanguage;
  totalLines: number;
  skeleton: SymbolEntry[];
  hotspots: Hotspot[];              // adjacent/overlapping windows pre-merged
  omittedLineRanges: Array<[number, number]>;
  /** chars/4 ceil of rendered skeleton + hotspots only. */
  estimatedTokens: number;
}

export interface CompareSide {
  /** artifact-dir-relative path: "baseline.md" or "prompt.md". */
  inputPath: string;
  estimatedInputTokens: number;
  /** Provider usage if available (Anthropic / OpenAI / Ollama all report). */
  actualInputTokens?: number;
  actualOutputTokens?: number;
  actualCostUsd?: number;
  latencyMs?: number;
  /** artifact-dir-relative path: "response-baseline.md" or "response-compressed.md". */
  responsePath: string;
  /** Set when the stream emitted an error event mid-call. Phase continues regardless. */
  failureCode?: string;
}

export interface CompareResult {
  ranAt: string;                    // ISO timestamp
  profileId: string;
  baseline: CompareSide;
  compressed: CompareSide;
  savedInputTokensEstimate: number;
  /** Set only when both sides have actualInputTokens. */
  savedInputTokensActual?: number;
  /** Set only when both sides have actualCostUsd. */
  savedCostUsdActual?: number;
}

export interface ContextArtifact {
  id: string;                       // "ctx_" + 10 hex chars (from crypto.randomUUID)
  schemaVersion: 1;
  createdAt: string;                // ISO
  /** Absolute path. Document warning: artifacts contain local paths; do not share. */
  workspaceRoot: string;
  task: string;                     // verbatim user input
  keywords: string[];               // extracted (post-stopword, post-cap)
  budget: ContextBudget;            // resolved (CLI > config > default)
  ignoreGlobs: string[];            // resolved (default ∪ config ∪ CLI)
  candidates: RelevantFile[];       // top-N selected
  excerpts: FileExcerpt[];          // same order/length as candidates
  promptMdPath: string;             // "prompt.md" (artifact-dir-relative)
  /** NOT full repository — task + full text of selected candidate files only. */
  estimatedBaselineInputTokens: number;
  estimatedCompressedInputTokens: number;
  savedTokensEstimate: number;      // baseline - compressed
  compressionRatio: number;         // compressed / baseline (0..1)
  // Populated only after `tierkit context compare` runs:
  baselineMdPath?: string;          // "baseline.md"
  baselineEstimatedTokens?: number;
  compare?: CompareResult;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxFiles: 8,
  maxHotspotsPerFile: 3,
  hotspotContextLines: 12,
};

export const DEFAULT_IGNORE_GLOBS = [
  "node_modules/**",
  ".git/**",
  "dist/**",
  "build/**",
  ".next/**",
  "coverage/**",
  ".tierkit/**",
  "*.lock",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
];
