/**
 * compressTestOutput — keep what failed, drop what passed.
 *
 * Supports three common test-runner output formats:
 *   - vitest: "× MyComponent > renders when ... 12ms"
 *   - jest:   "● Suite name › nested case"
 *   - pytest: "FAILED tests/test_app.py::test_addition - assert ..."
 *
 * For each failure, extracts:
 *   - suite + caseName (the test that failed)
 *   - expected / received (from "Expected: ..." and "Received: ..." lines)
 *   - 1-2 relevant user-code stack frames (vendor frames dropped)
 *   - a synthesized "likelyCause" if both expected + received are present
 *
 * What gets dropped:
 *   - Passing test output (✓ / PASS / ok N) — counted but not kept
 *   - node:internal frames, node_modules frames
 *   - Empty lines, runner banners
 *
 * Why parse runner-specific patterns instead of using one generic regex?
 * Each runner formats failures differently and the *exact* failure signature
 * line is the most reliable anchor for grouping subsequent lines (expected,
 * received, frames). One generic pattern would collapse them all into noise.
 */
import {
  DEFAULT_DIGEST_BUDGET,
  type DigestBudget,
  type TestDigest,
  type TestFailureItem,
} from "./types.js";
import { computeStats, makeDigestId } from "./stats.js";

export interface CompressTestOutputOptions {
  budget?: Partial<DigestBudget>;
  keepVendorFrames?: boolean;
}

const VENDOR_PATH_RE = /(node_modules|site-packages|\/dist\/|\/build\/|\.next\/|\.vite\/|\.turbo\/|\/internal\/modules\/|node:internal)/;
const VITEST_FAIL_RE = /^\s*(?:×|FAIL|✗)\s+(?<suite>.+?)\s+>\s+(?<name>.+?)(?:\s+\d+ms)?\s*$/;
const VITEST_PASS_RE = /^\s*(?:✓|PASS|✔)\s+/;
const JEST_FAIL_RE = /^\s*●\s+(?<full>.+?)(?:\s+›\s+)?$/;
const JEST_FAIL_LOC_RE = /^\s*●\s+(?<suite>.+?)\s+›\s+(?<name>.+?)$/;
const EXPECTED_RE = /^\s*(?:Expected|expected:)\s*(?<v>.+)$/;
const RECEIVED_RE = /^\s*(?:Received|received:|got:)\s*(?<v>.+)$/;
const NODE_FRAME_RE = /^\s*at\s+(?:(?<symbol>[^()\s][^()]*?)\s+\()?(?<file>[^()]+):(?<line>\d+):(?<col>\d+)\)?\s*$/;
const PYTEST_FAIL_RE = /^(?:FAILED|FAIL)\s+(?<file>[^:]+)::(?<name>\S+)/;

interface ParsedFailure {
  suite?: string;
  caseName?: string;
  expected?: string;
  received?: string;
  frames: string[];
  filePathHints: string[];
}

function isUserFrame(line: string, keepVendor: boolean): boolean {
  if (keepVendor) return true;
  return !VENDOR_PATH_RE.test(line);
}

function uniqPush<T>(arr: T[], value: T): void {
  if (value !== undefined && value !== null && !arr.includes(value)) arr.push(value);
}

export function compressTestOutput(
  output: string,
  options: CompressTestOutputOptions = {},
): TestDigest {
  const budget = { ...DEFAULT_DIGEST_BUDGET, ...options.budget };
  const keepVendor = options.keepVendorFrames === true;
  const lines = output.split(/\r?\n/);

  let passedCount = 0;
  let failedCount = 0;
  const failures: ParsedFailure[] = [];
  let current: ParsedFailure | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (VITEST_PASS_RE.test(line)) {
      passedCount += 1;
      continue;
    }

    // pytest summary at bottom: "FAILED tests/foo.py::test_bar - assert ..."
    const pyt = PYTEST_FAIL_RE.exec(line);
    const pytFile = pyt?.groups?.file;
    const pytName = pyt?.groups?.name;
    if (pytFile && pytName) {
      const next: ParsedFailure = {
        suite: pytFile,
        caseName: pytName,
        frames: [],
        filePathHints: [pytFile],
      };
      current = next;
      failures.push(next);
      failedCount += 1;
      continue;
    }

    // vitest: "× MyComponent > renders when category empty 12ms"
    const vit = VITEST_FAIL_RE.exec(line);
    const vitSuite = vit?.groups?.suite;
    const vitName = vit?.groups?.name;
    if (vitSuite && vitName) {
      const next: ParsedFailure = {
        suite: vitSuite,
        caseName: vitName,
        frames: [],
        filePathHints: [],
      };
      current = next;
      failures.push(next);
      failedCount += 1;
      continue;
    }

    // jest: "● Description › nested case"
    const jest = JEST_FAIL_RE.exec(line);
    const jestFull = jest?.groups?.full;
    if (jestFull && jestFull.length > 0) {
      const loc = JEST_FAIL_LOC_RE.exec(line);
      const next: ParsedFailure = {
        suite: loc?.groups?.suite ?? jestFull,
        caseName: loc?.groups?.name,
        frames: [],
        filePathHints: [],
      };
      current = next;
      failures.push(next);
      failedCount += 1;
      continue;
    }

    if (!current) continue;

    const exp = EXPECTED_RE.exec(line);
    const expV = exp?.groups?.v;
    if (expV) {
      current.expected = expV.trim();
      continue;
    }
    const recv = RECEIVED_RE.exec(line);
    const recvV = recv?.groups?.v;
    if (recvV) {
      current.received = recvV.trim();
      continue;
    }
    const frame = NODE_FRAME_RE.exec(line);
    const frameFile = frame?.groups?.file;
    if (frameFile) {
      if (!isUserFrame(line, keepVendor)) continue;
      current.frames.push(line.trim());
      uniqPush(current.filePathHints, frameFile);
    }
  }

  // Truncate to budget.
  const truncatedFailures = failures.slice(0, budget.maxItems);

  const failedSuites: string[] = [];
  const likelyFiles: string[] = [];
  const failedCases: TestFailureItem[] = truncatedFailures.map((f) => {
    if (f.suite) uniqPush(failedSuites, f.suite);
    for (const h of f.filePathHints) uniqPush(likelyFiles, h);
    return {
      suite: f.suite,
      caseName: f.caseName,
      expected: f.expected,
      received: f.received,
      relevantFrames: f.frames.slice(0, 5),
      likelyCause:
        f.expected && f.received
          ? `Expected ${truncateInline(f.expected, 80)} but received ${truncateInline(f.received, 80)}`
          : undefined,
    };
  });

  const uncertainty: string[] = [];
  if (failedCount === 0 && passedCount === 0) {
    uncertainty.push("No vitest/jest/pytest patterns detected — log may be in an unsupported format.");
  }
  if (failures.length > budget.maxItems) {
    uncertainty.push(`Truncated to first ${budget.maxItems} failed cases of ${failures.length} total.`);
  }
  for (const f of failedCases) {
    if (!f.expected || !f.received) {
      uncertainty.push(`${f.caseName ?? f.suite ?? "<unknown>"}: missing expected/received — likely cause inferred from frames only.`);
      break;
    }
  }

  const summaryMd = renderTestDigestMd(failedCases, passedCount, failedCount, likelyFiles);
  const stats = computeStats(output, summaryMd);

  return {
    id: makeDigestId("test"),
    summaryMd,
    failedSuites,
    failedCases,
    likelyFiles,
    passedCount,
    failedCount,
    uncertainty,
    stats,
    verdict: "not-evaluated",
  };
}

function truncateInline(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function renderTestDigestMd(
  cases: TestFailureItem[],
  passed: number,
  failed: number,
  likelyFiles: string[],
): string {
  const lines: string[] = [];
  lines.push("# Test Digest");
  lines.push("");
  lines.push(`Passed: ${passed} · Failed: ${failed}`);
  lines.push("");
  if (cases.length === 0) {
    lines.push("_No failed cases parsed._");
    return lines.join("\n");
  }
  lines.push(`Failed cases (${cases.length}):`);
  for (const c of cases) {
    const header = [c.suite, c.caseName].filter(Boolean).join(" › ");
    lines.push(`- **${header || "(unnamed)"}**`);
    if (c.expected) lines.push(`  - expected: \`${truncateInline(c.expected, 200)}\``);
    if (c.received) lines.push(`  - received: \`${truncateInline(c.received, 200)}\``);
    if (c.relevantFrames.length > 0) {
      lines.push(`  - at: ${c.relevantFrames[0]}`);
    }
    if (c.likelyCause) {
      lines.push(`  - likely: ${c.likelyCause}`);
    }
  }
  if (likelyFiles.length > 0) {
    lines.push("");
    lines.push("Likely files:");
    for (const f of likelyFiles) lines.push(`- ${f}`);
  }
  return lines.join("\n");
}
