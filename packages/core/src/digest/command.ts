/**
 * compressCommand — turn a verbose natural-language task into a compact brief.
 *
 * Input:  "Add CRUD for AdminMenuForm. Keep existing structure intact.
 *          Don't break the type system. Maybe also support sorting?"
 *
 * Output (rule-based, no LLM):
 *   ## Task: Add CRUD for AdminMenuForm
 *   ### Requirements
 *   - Add CRUD for AdminMenuForm.
 *   - Maybe also support sorting?
 *   ### Constraints
 *   - Keep existing structure intact
 *   - Don't break the type system
 *   ### Likely focus
 *   - AdminMenuForm
 *
 * How it works (purely rules — no LLM by default):
 *   1. Split input into sentences.
 *   2. Sentences containing action verbs (add/implement/keep/avoid/유지/구현/...)
 *      are categorized as Requirements or Constraints.
 *   3. Identifier-shaped tokens (CamelCase, snake_case, kebab-case) are
 *      pulled out as "likely focus" — files/symbols the user probably meant.
 *   4. Hedging words ("maybe", "I think", "?")  → uncertainty markers.
 *
 * Optional LLM refine:
 *   Pass `options.refine = makeRefineCallback(profile)` to run the rule-based
 *   brief through a local model (typically Ollama) for further compression.
 *   If the LLM fails, throws, or returns nonsense, the rule output is used.
 *
 * Why default to rule-only? Compression must work offline, in CI, and on
 * machines without Ollama installed. The LLM pass is a *bonus*, never a
 * blocker.
 */
import {
  DEFAULT_DIGEST_BUDGET,
  type CompressedCommand,
  type DigestBudget,
} from "./types.js";
import { computeStats, makeDigestId } from "./stats.js";

export interface CompressCommandOptions {
  budget?: Partial<DigestBudget>;
  /**
   * Optional LLM-backed refinement. When provided, the rule-based brief is
   * passed through this function which may rewrite/expand it. Must return
   * a string; throwing/returning empty falls back to the rule-only brief.
   * The orchestrator (not this module) is responsible for wiring this to
   * an Ollama/local-model client.
   */
  refine?: (prompt: string) => Promise<string>;
  /** Tag set on the result so callers know which path was taken. */
  provider?: "rule" | "ollama" | "mock";
  model?: string;
}

const REQUIREMENT_VERBS = [
  "add", "create", "implement", "build", "make", "support", "enable", "render",
  "show", "hide", "fix", "update", "remove", "delete", "refactor", "rename",
  "migrate", "wire", "expose", "return", "store", "validate", "save", "load",
  "추가", "구현", "만들", "지원", "표시", "수정", "삭제", "리팩터", "이동", "검증",
];

const CONSTRAINT_PATTERNS = [
  // English
  { re: /\b(?:must|should|do not|don't|cannot|can't|without|keep|preserve|maintain)\b[^.!?\n]+[.!?\n]?/gi },
  { re: /\bavoid[^.!?\n]+[.!?\n]?/gi },
  // Korean
  { re: /(?:유지하|보존하|그대로|그대로 두|건드리지|건들지|발생하지|않게|않도록|않아야)[^.!?\n]*[.!?\n]?/g },
];

const UNCERTAIN_HINTS = [
  /\b(?:maybe|perhaps|i think|i guess|not sure|아마|것 같)\b/gi,
  /\?{2,}/g,
];

function splitSentences(text: string): string[] {
  // Split on Latin .!? plus Korean fullstops (period works as well).
  return text
    .split(/(?<=[.!?。])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function dedup(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    const key = v.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(v.trim());
  }
  return out;
}

function extractRequirements(sentences: string[]): string[] {
  const out: string[] = [];
  for (const s of sentences) {
    const lower = s.toLowerCase();
    if (REQUIREMENT_VERBS.some((v) => lower.includes(v) || s.includes(v))) {
      out.push(s);
    }
  }
  return dedup(out);
}

function extractConstraints(text: string): string[] {
  const out: string[] = [];
  for (const pat of CONSTRAINT_PATTERNS) {
    pat.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.re.exec(text)) !== null) {
      out.push(m[0].trim().replace(/[.!?]$/, ""));
    }
  }
  return dedup(out);
}

function extractFocus(text: string): string[] {
  const tokens = text.match(/\b[A-Za-z_][A-Za-z0-9_]*[A-Za-z0-9_]\b/g) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t.length < 4) continue;
    // identifier-ish: contains separator or internal capital
    if (!/[_-]/.test(t) && !/[A-Za-z][A-Z]/.test(t)) continue;
    const key = t;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

function extractUncertainty(text: string): string[] {
  const out: string[] = [];
  for (const pat of UNCERTAIN_HINTS) {
    pat.lastIndex = 0;
    if (pat.test(text)) {
      pat.lastIndex = 0;
      const m = pat.exec(text);
      if (m) out.push(`Phrasing suggests uncertainty: "${m[0]}"`);
    }
  }
  return dedup(out);
}

function makeTitle(text: string): string {
  // Take first sentence or first 80 chars.
  const first = text.split(/[\n.!?。]/)[0] ?? text;
  return first.trim().slice(0, 80);
}

function renderCompressedBrief(
  title: string,
  requirements: string[],
  constraints: string[],
  focus: string[],
): string {
  const lines: string[] = [];
  lines.push(`## Task: ${title}`);
  lines.push("");
  if (requirements.length > 0) {
    lines.push("### Requirements");
    for (const r of requirements) lines.push(`- ${r}`);
    lines.push("");
  }
  if (constraints.length > 0) {
    lines.push("### Constraints");
    for (const c of constraints) lines.push(`- ${c}`);
    lines.push("");
  }
  if (focus.length > 0) {
    lines.push("### Likely focus");
    for (const f of focus) lines.push(`- ${f}`);
  }
  return lines.join("\n").trim();
}

export async function compressCommand(
  input: string,
  options: CompressCommandOptions = {},
): Promise<CompressedCommand> {
  const budget = { ...DEFAULT_DIGEST_BUDGET, ...options.budget };
  const trimmed = input.trim();
  const title = makeTitle(trimmed);
  const sentences = splitSentences(trimmed);
  const requirements = extractRequirements(sentences).slice(0, budget.maxItems);
  const constraints = extractConstraints(trimmed).slice(0, budget.maxItems);
  const focus = extractFocus(trimmed);
  const uncertainty = extractUncertainty(trimmed);

  let compressed = renderCompressedBrief(title, requirements, constraints, focus);

  let provider: CompressedCommand["provider"] = options.provider ?? "rule";
  if (options.refine) {
    try {
      const refined = (await options.refine(compressed)).trim();
      if (refined.length > 0 && refined.length < compressed.length * 3) {
        compressed = refined;
        provider = options.provider ?? "ollama";
      }
    } catch (err) {
      uncertainty.push(`LLM refinement failed; using rule-based brief. (${(err as Error).message})`);
    }
  }

  // Enforce hard cap on output length.
  if (compressed.length > budget.maxChars) {
    compressed = compressed.slice(0, budget.maxChars - 20) + "\n…[truncated]";
    uncertainty.push(`Brief truncated to ${budget.maxChars} chars.`);
  }

  const stats = computeStats(trimmed, compressed);

  return {
    id: makeDigestId("cmd"),
    original: trimmed,
    taskTitle: title,
    compressed,
    requirements,
    constraints,
    likelyFocus: focus,
    uncertainty,
    stats,
    provider,
    model: options.model,
    verdict: "not-evaluated",
  };
}
