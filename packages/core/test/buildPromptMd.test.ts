import { describe, expect, it } from "vitest";
import { buildPromptMd } from "../src/context-compression/buildPromptMd.js";
import type { FileExcerpt, RelevantFile } from "@tierkit/core";

const file = (over: Partial<RelevantFile>): RelevantFile => ({
  path: "src/a.ts",
  score: 0.9,
  reason: "matched [foo]",
  matchedTerms: ["foo"],
  termHitCount: 3,
  pathBonus: 0.15,
  mtimeBonus: 0.1,
  sizeBytes: 500,
  language: "ts",
  ...over,
});

const excerpt = (over: Partial<FileExcerpt>): FileExcerpt => ({
  path: "src/a.ts",
  language: "ts",
  totalLines: 50,
  skeleton: [
    { kind: "import", line: 1, text: "import { foo } from './foo'" },
    { kind: "function", line: 10, text: "export function bar()" },
  ],
  hotspots: [
    {
      startLine: 12,
      endLine: 14,
      matchedTerms: ["foo"],
      code: "  const x = foo()\n  return x\n}",
    },
  ],
  omittedLineRanges: [[2, 9], [15, 50]],
  estimatedTokens: 60,
  ...over,
});

describe("buildPromptMd", () => {
  it("includes task verbatim", () => {
    const md = buildPromptMd({
      task: "Fix the bug in foo",
      relevantFiles: [file({})],
      excerpts: [excerpt({})],
    });
    expect(md).toMatch(/^# Task\n\nFix the bug in foo\n/m);
  });

  it("lists selected files with score and matched terms", () => {
    const md = buildPromptMd({
      task: "x",
      relevantFiles: [file({ path: "src/a.ts", score: 0.96, matchedTerms: ["foo", "bar"] })],
      excerpts: [excerpt({ path: "src/a.ts" })],
    });
    expect(md).toContain("# Files in scope");
    expect(md).toContain("`src/a.ts`");
    expect(md).toContain("score 0.96");
    expect(md).toMatch(/matched: foo, bar/);
  });

  it("renders skeleton and hotspots per file", () => {
    const md = buildPromptMd({
      task: "x",
      relevantFiles: [file({})],
      excerpts: [excerpt({})],
    });
    expect(md).toContain("### Skeleton");
    expect(md).toContain("```ts");
    expect(md).toContain("import { foo } from './foo'");
    expect(md).toContain("### Hotspot @ L12-L14");
    expect(md).toContain("(matched: foo)");
    expect(md).toContain("  const x = foo()");
  });

  it("renders omittedLineRanges section", () => {
    const md = buildPromptMd({
      task: "x",
      relevantFiles: [file({})],
      excerpts: [excerpt({ omittedLineRanges: [[2, 9], [15, 50]] })],
    });
    expect(md).toContain("### Omitted");
    expect(md).toMatch(/L2-L9/);
    expect(md).toMatch(/L15-L50/);
  });

  it("is deterministic given the same input (snapshot stable)", () => {
    const input = {
      task: "fix payment",
      relevantFiles: [file({ path: "x.ts" }), file({ path: "y.ts", score: 0.8 })],
      excerpts: [excerpt({ path: "x.ts" }), excerpt({ path: "y.ts", totalLines: 30 })],
    };
    const md1 = buildPromptMd(input);
    const md2 = buildPromptMd(input);
    expect(md1).toBe(md2);
  });
});
