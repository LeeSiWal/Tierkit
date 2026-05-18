/**
 * Refusal-phrase regexes. Each is anchored to the start of the response (^) so we don't
 * fire on responses that QUOTE refusal phrases as part of legitimate content
 * (e.g., explaining what a refusal looks like).
 *
 * Matched against the first 200 chars of trimmed response in
 * ResponseQualityEvaluator.evaluateResponse — same convention applies for added patterns.
 */
export const REFUSAL_PATTERNS: readonly RegExp[] = [
  /^I can(?:'t| ?not|not)\b/i,
  /^I'?m sorry,? but/i,
  /^(?:As an?|I'm an?) AI\b/i,
  /^I (?:am|'m) (?:unable|not able)/i,
  /^I (?:cannot|can not) (?:help|assist|provide|generate)/i,
  /^I won'?t (?:be able to|help|provide)/i,
  /^죄송(?:합니다|하지만)/,
  /^저는.*수 ?없습니다/,
  /^(?:할|도와드릴|답변(?:드릴|할)) 수 ?없습니다/,
  /^거부합니다/,
];

/** True if any pattern matches the head of `text`. */
export function matchesRefusal(text: string): boolean {
  const head = text.trimStart().slice(0, 200);
  return REFUSAL_PATTERNS.some((re) => re.test(head));
}
