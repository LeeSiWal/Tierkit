import { describe, expect, it } from "vitest";
import { ContextArtifactSchema, type ContextArtifact } from "@tierkit/core";

describe("ContextArtifactSchema", () => {
  it("parses a minimal valid artifact", () => {
    const artifact: ContextArtifact = {
      id: "ctx_a3b2c1d4e5",
      schemaVersion: 1,
      createdAt: "2026-05-19T00:00:00.000Z",
      workspaceRoot: "/tmp/repo",
      task: "fix the bug",
      keywords: ["fix", "bug"],
      budget: { maxFiles: 8, maxHotspotsPerFile: 3, hotspotContextLines: 12 },
      ignoreGlobs: ["node_modules/**"],
      candidates: [],
      excerpts: [],
      promptMdPath: "prompt.md",
      estimatedBaselineInputTokens: 100,
      estimatedCompressedInputTokens: 30,
      savedTokensEstimate: 70,
      compressionRatio: 0.3,
    };
    expect(ContextArtifactSchema.parse(artifact)).toEqual(artifact);
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
    expect(() => ContextArtifactSchema.parse({ schemaVersion: 999 })).toThrow();
  });
});
