/**
 * Internal token estimator for subprocess providers whose CLI does not report
 * usage. Dependency-free and approximate. CJK characters (Hangul / CJK Unified
 * Ideographs / Hiragana / Katakana) count ~2 chars/token; everything else
 * ~4 chars/token. Tierkit surfaces `usageSource: "estimated"` so consumers know
 * the count is a guess.
 *
 * This is a SEPARATE function from `context-compression/estimateTokens.ts`, which
 * is a simpler chars/4 estimator used by the deterministic context compressor.
 */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (
      (cp >= 0x3040 && cp <= 0x30FF) ||  // Hiragana + Katakana
      (cp >= 0x3400 && cp <= 0x9FFF) ||  // CJK Unified (incl. Ext-A)
      (cp >= 0xAC00 && cp <= 0xD7A3)     // Hangul Syllables
    ) cjk++;
  }
  const nonCjk = text.length - cjk;
  return Math.max(1, Math.ceil(cjk / 2 + nonCjk / 4));
}
