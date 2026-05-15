import { DEFAULT_REDACTION_RULES, type RedactionRule } from "./redactionRules.js";

export type { RedactionRule } from "./redactionRules.js";

export interface RedactionResult {
  text: string;
  hits: { ruleId: string; count: number }[];
}

/**
 * Apply redaction rules to `input`. Rules are applied in declaration order; later rules see
 * already-redacted text, so place the *most specific* rules first if patterns could overlap.
 *
 * Pure function. Safe to call on arbitrary user input (no side effects, no logging).
 */
export function redactSecrets(
  input: string,
  rules: readonly RedactionRule[] = DEFAULT_REDACTION_RULES,
): RedactionResult {
  let text = input;
  const hits: { ruleId: string; count: number }[] = [];
  for (const rule of rules) {
    const matches = text.match(rule.pattern);
    if (matches && matches.length > 0) {
      text = text.replace(rule.pattern, rule.replacement);
      hits.push({ ruleId: rule.id, count: matches.length });
    }
  }
  return { text, hits };
}

export function getDefaultRedactionRules(): readonly RedactionRule[] {
  return DEFAULT_REDACTION_RULES;
}
