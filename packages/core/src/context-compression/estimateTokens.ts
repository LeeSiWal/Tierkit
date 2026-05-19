/**
 * Rough token estimator: chars / 4, ceiling.
 *
 * This is the standard ~3.5-4 chars-per-token heuristic. It is wrong by
 * up to ~30% on code, but the compare summary always shows the actual
 * provider usage alongside the estimate so users can see the gap.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
