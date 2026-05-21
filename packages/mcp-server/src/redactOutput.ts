import { redactSecrets, type RedactionRule } from "@tierkit/core";
import { DEFAULT_REDACTION_RULES } from "@tierkit/core";

export interface RedactHit {
  ruleId: string;
  count: number;
}

export interface RedactOutputResult {
  text: string;
  hits: RedactHit[];
}

/**
 * Run Tierkit's redaction engine over arbitrary text output (file contents,
 * stdout/stderr, code search snippets). Returns the redacted text + per-hit
 * metadata for activity logging.
 *
 * Note: redactSecrets returns { ruleId, count } per hit — not { rule, matchedAt }.
 * The `hits` array here reflects the actual shape from @tierkit/core.
 */
export function redactOutput(text: string, customRules?: readonly RedactionRule[]): RedactOutputResult {
  const rules = customRules ?? DEFAULT_REDACTION_RULES;
  const result = redactSecrets(text, rules);
  return {
    text: result.text,
    hits: result.hits,
  };
}

/**
 * Count total redaction hits across all rules (convenience for activity logging).
 */
export function countHits(hits: RedactHit[]): number {
  return hits.reduce((acc, h) => acc + h.count, 0);
}
