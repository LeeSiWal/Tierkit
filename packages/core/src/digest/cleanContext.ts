/**
 * cleanContext — a *generic* noise filter for any text blob.
 *
 * Use this when you want to strip the obvious garbage from a mixed-content
 * input before handing it to a model — without committing to a specific
 * format like "this is an error log" (compressErrorLog) or "this is test
 * output" (compressTestOutput).
 *
 * Rules applied (in order, each one configurable via options):
 *   - passing-test  : drop "✓ test name" / "ok N - ..." lines
 *   - vendor-frame  : drop stack frames inside node_modules / site-packages / node:internal
 *   - coverage-detail: drop coverage table rows (% Stmts |  | ...)
 *   - build-chatter : drop [vite]/[webpack]/[esbuild] noise and "built in Xms"
 *   - blank-padding : drop lines with only whitespace
 *   - repeated-line : keep the first two occurrences of identical lines, mark the 3rd as "[repeated]", drop the rest
 *
 * Preserves anything matching /warning|WARN|deprecated|insecure/i and surfaces
 * the first N matches in `preservedWarnings` so a downstream digest can spot
 * security issues.
 *
 * Pure rule-based, deterministic, no LLM.
 */
import {
  DEFAULT_DIGEST_BUDGET,
  type CleanedContext,
  type DigestBudget,
} from "./types.js";
import { computeStats, makeDigestId } from "./stats.js";

export interface CleanContextOptions {
  budget?: Partial<DigestBudget>;
  /** Keep passing test lines (default false). */
  keepPassingTests?: boolean;
  /** Keep node_modules stack frames (default false). */
  keepVendorFrames?: boolean;
  /** Keep build/coverage chatter (default false). */
  keepBuildChatter?: boolean;
}

interface Rule {
  name: string;
  predicate: (line: string, opts: CleanContextOptions) => boolean;
}

const RULES: Rule[] = [
  {
    name: "passing-test",
    predicate: (line, opts) => {
      if (opts.keepPassingTests) return false;
      return /^\s*(?:✓|✔|PASS|ok\s+\d+\s+-)/.test(line);
    },
  },
  {
    name: "vendor-frame",
    predicate: (line, opts) => {
      if (opts.keepVendorFrames) return false;
      return /^\s*at\s.*(?:node_modules|site-packages|node:internal)/.test(line);
    },
  },
  {
    name: "coverage-detail",
    predicate: (line, opts) => {
      if (opts.keepBuildChatter) return false;
      return /^(File|All files)\s+\|\s+%\s+Stmts/.test(line)
        || /^[-]+\s*$/.test(line)
        || /^\s*\d+\s+\|\s+\d+(\.\d+)?\s+\|\s+\d+(\.\d+)?\s+\|\s+\d+(\.\d+)?\s+\|/.test(line);
    },
  },
  {
    name: "build-chatter",
    predicate: (line, opts) => {
      if (opts.keepBuildChatter) return false;
      return /^\s*\[(esbuild|vite|webpack|tsc)\]/i.test(line)
        || /^(?:.*\d+\s+modules?\s+transformed\.?)/.test(line)
        || /^\s*built in \d+/.test(line)
        || /^\s*ready in \d+/.test(line)
        || /^\s*✨\s+Done/.test(line);
    },
  },
  {
    name: "blank-padding",
    predicate: (line) => /^\s{20,}$/.test(line),
  },
];

const WARNING_HINT_RE = /\b(warning|WARN|deprecated|insecure)\b/i;

export function cleanContext(
  input: string,
  options: CleanContextOptions = {},
): CleanedContext {
  const budget = { ...DEFAULT_DIGEST_BUDGET, ...options.budget };
  const lines = input.split(/\r?\n/);

  const kept: string[] = [];
  const removedCounts = new Map<string, number>();
  const preservedWarnings: string[] = [];
  const seenLine = new Map<string, number>();

  for (const line of lines) {
    let removed: string | null = null;
    for (const rule of RULES) {
      if (rule.predicate(line, options)) {
        removed = rule.name;
        break;
      }
    }
    if (removed) {
      removedCounts.set(removed, (removedCounts.get(removed) ?? 0) + 1);
      continue;
    }

    // Dedup consecutive identical lines.
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      const seen = seenLine.get(trimmed) ?? 0;
      seenLine.set(trimmed, seen + 1);
      if (seen >= 2) {
        // Collapse: at the third occurrence, keep but tag as "repeated"; after that, drop.
        if (seen === 2) {
          kept.push(`${line}  // [repeated]`);
        } else {
          removedCounts.set("repeated-line", (removedCounts.get("repeated-line") ?? 0) + 1);
        }
        continue;
      }
    }

    kept.push(line);
    if (WARNING_HINT_RE.test(line) && preservedWarnings.length < budget.maxItems) {
      preservedWarnings.push(line.trim());
    }
  }

  const cleaned = kept.join("\n");
  const removedHints: string[] = [];
  for (const [name, count] of removedCounts.entries()) {
    removedHints.push(`removed ${count} × ${name}`);
  }

  const stats = computeStats(input, cleaned);

  return {
    id: makeDigestId("clean"),
    originalLength: input.length,
    cleaned,
    removedHints,
    preservedWarnings,
    stats,
  };
}
