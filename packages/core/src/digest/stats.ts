/**
 * Helpers shared by every digest function:
 *
 *   makeDigestId("err") → "err_a3f2b91c84"
 *   computeStats(before, after) → { savedTokens, savedRatio, ... }
 *
 * Token estimation uses the chars/4 heuristic from v0.11
 * (`estimateTokens`). It is approximate (±30% on code) but consistent across
 * before and after — so `savedRatio` is meaningful even if individual numbers
 * aren't exact. See docs/REVIEW-v0.19.md §7 for the tiktoken upgrade path.
 */
import crypto from "node:crypto";
import { estimateTokens } from "../context-compression/estimateTokens.js";
import type { CompressionStats } from "./types.js";

export function makeDigestId(prefix: string): string {
  const hex = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  return `${prefix}_${hex}`;
}

export function computeStats(before: string, after: string): CompressionStats {
  const beforeChars = before.length;
  const afterChars = after.length;
  const beforeTokens = estimateTokens(before);
  const afterTokens = estimateTokens(after);
  const savedTokens = beforeTokens - afterTokens;
  const savedRatio = beforeTokens > 0 ? savedTokens / beforeTokens : 0;
  return {
    beforeChars,
    afterChars,
    beforeTokens,
    afterTokens,
    savedTokens,
    savedRatio,
    estimationMethod: "chars/4",
  };
}
