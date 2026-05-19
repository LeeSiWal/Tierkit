import { z } from "zod";

export const SourceLanguageSchema = z.enum([
  "ts", "tsx", "js", "jsx",
  "py", "go", "rs",
  "md", "json", "yaml", "toml", "sh",
  "other",
]);

export const ContextBudgetSchema = z.object({
  maxFiles: z.number().int().positive(),
  maxHotspotsPerFile: z.number().int().positive(),
  hotspotContextLines: z.number().int().positive(),
  cloudTokenBudget: z.number().int().positive().optional(),
}).strict();

export const RelevantFileSchema = z.object({
  path: z.string(),
  score: z.number().min(0).max(1),
  reason: z.string(),
  matchedTerms: z.array(z.string()),
  termHitCount: z.number().int().nonnegative(),
  pathBonus: z.number(),
  mtimeBonus: z.number(),
  sizeBytes: z.number().int().nonnegative(),
  language: SourceLanguageSchema.optional(),
}).strict();

export const SymbolEntrySchema = z.object({
  kind: z.enum(["import", "export", "function", "class", "interface", "type", "const"]),
  line: z.number().int().positive(),
  text: z.string(),
}).strict();

export const HotspotSchema = z.object({
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  matchedTerms: z.array(z.string()),
  code: z.string(),
}).strict();

export const FileExcerptSchema = z.object({
  path: z.string(),
  language: SourceLanguageSchema.optional(),
  totalLines: z.number().int().nonnegative(),
  skeleton: z.array(SymbolEntrySchema),
  hotspots: z.array(HotspotSchema),
  omittedLineRanges: z.array(z.tuple([z.number().int(), z.number().int()])),
  estimatedTokens: z.number().int().nonnegative(),
}).strict();

export const CompareSideSchema = z.object({
  inputPath: z.string(),
  estimatedInputTokens: z.number().int().nonnegative(),
  actualInputTokens: z.number().int().nonnegative().optional(),
  actualOutputTokens: z.number().int().nonnegative().optional(),
  actualCostUsd: z.number().nonnegative().optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  responsePath: z.string(),
  failureCode: z.string().optional(),
}).strict();

export const CompareResultSchema = z.object({
  ranAt: z.string(),
  profileId: z.string(),
  baseline: CompareSideSchema,
  compressed: CompareSideSchema,
  savedInputTokensEstimate: z.number().int(),
  savedInputTokensActual: z.number().int().optional(),
  savedCostUsdActual: z.number().optional(),
}).strict();

export const ContextArtifactSchema = z.object({
  id: z.string().regex(/^ctx_[a-f0-9]{10}$/),
  schemaVersion: z.literal(1),
  createdAt: z.string(),
  workspaceRoot: z.string(),
  task: z.string(),
  keywords: z.array(z.string()),
  budget: ContextBudgetSchema,
  ignoreGlobs: z.array(z.string()),
  candidates: z.array(RelevantFileSchema),
  excerpts: z.array(FileExcerptSchema),
  promptMdPath: z.string(),
  estimatedBaselineInputTokens: z.number().int().nonnegative(),
  estimatedCompressedInputTokens: z.number().int().nonnegative(),
  savedTokensEstimate: z.number().int(),
  compressionRatio: z.number(),
  baselineMdPath: z.string().optional(),
  baselineEstimatedTokens: z.number().int().nonnegative().optional(),
  compare: CompareResultSchema.optional(),
}).strict();

export const ContextCompressionConfigSchema = z.object({
  defaultMaxFiles: z.number().int().positive().optional(),
  defaultCloudTokenBudget: z.number().int().positive().optional(),
  ignoreGlobs: z.array(z.string()).optional(),
}).strict();
