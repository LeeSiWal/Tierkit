// v0.18 context-gateway digest functions.
// Re-exported via packages/core/src/index.ts.

export {
  type CompressionVerdict,
  type CompressionStats,
  type CompressedCommand,
  type DigestErrorItem,
  type ErrorDigest,
  type TestFailureItem,
  type TestDigest,
  type JsonDigest,
  type FileDigest,
  type DiffSummary,
  type CleanedContext,
  type ContextPack,
  type DigestBudget,
  DEFAULT_DIGEST_BUDGET,
  CONTEXT_PACK_OUTPUT_POLICY,
} from "./types.js";

export { computeStats, makeDigestId } from "./stats.js";

export { compressCommand, type CompressCommandOptions } from "./command.js";
export { compressErrorLog, type CompressErrorLogOptions } from "./errorLog.js";
export { compressTestOutput, type CompressTestOutputOptions } from "./testOutput.js";
export { compressJson, type CompressJsonOptions } from "./jsonCompress.js";
export { cleanContext, type CleanContextOptions } from "./cleanContext.js";
export {
  summarizeGitDiff,
  defaultDiffRunner,
  type SummarizeGitDiffOptions,
} from "./gitDiff.js";
export {
  getFileDigest,
  getFileDigestCached,
  invalidateFileDigest,
  getFileDigestCacheStats,
  clearFileDigestCache,
  type GetFileDigestOptions,
  type FileDigestCacheStats,
} from "./fileDigest.js";
export {
  buildContextPack,
  type BuildContextPackInput,
  type BuildContextPackOptions,
} from "./contextPack.js";
export {
  makeRefineCallback,
  type MakeRefineCallbackOptions,
} from "./refineCallback.js";
