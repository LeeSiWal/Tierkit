import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  ContextArtifactSchema,
  ContextBudgetSchema,
  RelevantFileSchema,
  FileExcerptSchema,
  CompareResultSchema,
  CompareSideSchema,
  type ContextArtifact,
  type ContextBudget,
  type RelevantFile,
  type FileExcerpt,
  type CompareResult,
  type CompareSide,
} from "@tierkit/core";

// A populated valid artifact that exercises every nested sub-schema
// (RelevantFile, FileExcerpt, SymbolEntry, Hotspot, omittedLineRanges tuple).
// Defined at suite scope so multiple tests can share / mutate copies.
const validArtifact: ContextArtifact = {
  id: "ctx_a3b2c1d4e5",
  schemaVersion: 1,
  createdAt: "2026-05-19T00:00:00.000Z",
  workspaceRoot: "/tmp/repo",
  task: "fix the bug",
  keywords: ["fix", "bug"],
  budget: { maxFiles: 8, maxHotspotsPerFile: 3, hotspotContextLines: 12 },
  ignoreGlobs: ["node_modules/**"],
  candidates: [
    {
      path: "src/foo.ts",
      score: 0.85,
      reason: "filename match + 2 term hits",
      matchedTerms: ["foo"],
      termHitCount: 2,
      pathBonus: 0.2,
      mtimeBonus: 0.05,
      sizeBytes: 1024,
      language: "ts",
    },
  ],
  excerpts: [
    {
      path: "src/foo.ts",
      language: "ts",
      totalLines: 120,
      skeleton: [
        { kind: "import", line: 1, text: 'import { bar } from "./bar.js";' },
        { kind: "function", line: 10, text: "export function foo(input: string) {" },
      ],
      hotspots: [
        {
          startLine: 10,
          endLine: 22,
          matchedTerms: ["foo"],
          code: "export function foo(input: string) {\n  // ...\n}",
        },
      ],
      omittedLineRanges: [[23, 119]],
      estimatedTokens: 64,
    },
  ],
  promptMdPath: "prompt.md",
  estimatedBaselineInputTokens: 100,
  estimatedCompressedInputTokens: 30,
  savedTokensEstimate: 70,
  compressionRatio: 0.3,
};

describe("ContextArtifactSchema", () => {
  it("parses a minimal valid artifact", () => {
    expect(ContextArtifactSchema.parse(validArtifact)).toEqual(validArtifact);
  });

  it("accepts optional compare fields after compare runs", () => {
    const base = {
      id: "ctx_a3b2c1d4e5",
      schemaVersion: 1 as const,
      createdAt: "2026-05-19T00:00:00.000Z",
      workspaceRoot: "/tmp/repo",
      task: "x",
      keywords: ["x"],
      budget: { maxFiles: 1, maxHotspotsPerFile: 1, hotspotContextLines: 1 },
      ignoreGlobs: [],
      candidates: [],
      excerpts: [],
      promptMdPath: "prompt.md",
      estimatedBaselineInputTokens: 1,
      estimatedCompressedInputTokens: 1,
      savedTokensEstimate: 0,
      compressionRatio: 1,
    };
    const withCompare = {
      ...base,
      baselineMdPath: "baseline.md",
      baselineEstimatedTokens: 100,
      compare: {
        ranAt: "2026-05-19T00:01:00.000Z",
        profileId: "claudeSonnet",
        baseline: {
          inputPath: "baseline.md",
          estimatedInputTokens: 100,
          responsePath: "response-baseline.md",
        },
        compressed: {
          inputPath: "prompt.md",
          estimatedInputTokens: 30,
          responsePath: "response-compressed.md",
        },
        savedInputTokensEstimate: 70,
      },
    };
    expect(ContextArtifactSchema.parse(withCompare)).toEqual(withCompare);
  });

  it("rejects unknown schemaVersion", () => {
    // Clone the otherwise-valid artifact and override only schemaVersion,
    // so the failure isolates the z.literal(1) check rather than missing
    // required fields elsewhere.
    const bad = { ...validArtifact, schemaVersion: 999 };
    expect(() => ContextArtifactSchema.parse(bad)).toThrow();
  });
});

// Type/schema drift guards: if a future change adds a field to one side
// (interface or zod schema) but forgets the other, these compile-time
// assertions fail. `expectTypeOf` is a vitest builtin — no extra dep.
describe("type/schema parity", () => {
  it("ContextArtifact matches ContextArtifactSchema", () => {
    expectTypeOf<ContextArtifact>().toEqualTypeOf<z.infer<typeof ContextArtifactSchema>>();
  });
  it("ContextBudget matches ContextBudgetSchema", () => {
    expectTypeOf<ContextBudget>().toEqualTypeOf<z.infer<typeof ContextBudgetSchema>>();
  });
  it("RelevantFile matches RelevantFileSchema", () => {
    expectTypeOf<RelevantFile>().toEqualTypeOf<z.infer<typeof RelevantFileSchema>>();
  });
  it("FileExcerpt matches FileExcerptSchema", () => {
    expectTypeOf<FileExcerpt>().toEqualTypeOf<z.infer<typeof FileExcerptSchema>>();
  });
  it("CompareResult matches CompareResultSchema", () => {
    expectTypeOf<CompareResult>().toEqualTypeOf<z.infer<typeof CompareResultSchema>>();
  });
  it("CompareSide matches CompareSideSchema", () => {
    expectTypeOf<CompareSide>().toEqualTypeOf<z.infer<typeof CompareSideSchema>>();
  });
});
