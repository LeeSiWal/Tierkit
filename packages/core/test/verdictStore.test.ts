import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {
  readVerdict,
  writeVerdict,
  VerdictStoreError,
  VerdictSchema,
  writeArtifact,
  type ContextArtifact,
} from "@tierkit/core";

let tmp = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-verdict-"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

// Seed an artifact with optional compare result.
async function seedArtifact(withCompare: boolean): Promise<string> {
  const artifact: ContextArtifact = {
    id: "ctx_0000000000",
    schemaVersion: 1,
    createdAt: "2026-05-19T00:00:00.000Z",
    workspaceRoot: tmp,
    task: "t",
    keywords: ["t"],
    budget: { maxFiles: 1, maxHotspotsPerFile: 1, hotspotContextLines: 1 },
    ignoreGlobs: [],
    candidates: [],
    excerpts: [],
    promptMdPath: "prompt.md",
    estimatedBaselineInputTokens: 100,
    estimatedCompressedInputTokens: 30,
    savedTokensEstimate: 70,
    compressionRatio: 0.3,
    ...(withCompare
      ? {
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
        }
      : {}),
  };
  const { id } = await writeArtifact(tmp, artifact, "PROMPT BODY");
  return id;
}

describe("readVerdict", () => {
  it("returns null when verdict file is absent (not an error)", async () => {
    const id = await seedArtifact(false);
    expect(await readVerdict(tmp, id)).toBeNull();
  });

  it("returns null on invalid JSON (lenient)", async () => {
    const id = await seedArtifact(true);
    const dir = path.join(tmp, ".tierkit/runtime/context-artifacts", id);
    await fs.writeFile(path.join(dir, "verdict.json"), "{not json");
    expect(await readVerdict(tmp, id)).toBeNull();
  });

  it("returns null on schema mismatch (lenient)", async () => {
    const id = await seedArtifact(true);
    const dir = path.join(tmp, ".tierkit/runtime/context-artifacts", id);
    await fs.writeFile(path.join(dir, "verdict.json"), JSON.stringify({ qualityVerdict: "weird" }));
    expect(await readVerdict(tmp, id)).toBeNull();
  });
});

describe("writeVerdict", () => {
  it("throws artifact-not-found when artifact dir missing", async () => {
    await expect(
      writeVerdict(tmp, "ctx_aaaaaaaaaa", { qualityVerdict: "same" }),
    ).rejects.toMatchObject({ code: "artifact-not-found" });
  });

  it("throws compare-not-run when artifact has no compare field", async () => {
    const id = await seedArtifact(false);
    await expect(
      writeVerdict(tmp, id, { qualityVerdict: "same" }),
    ).rejects.toMatchObject({ code: "compare-not-run" });
  });

  it("writes verdict when compare exists", async () => {
    const id = await seedArtifact(true);
    const v = await writeVerdict(tmp, id, {
      qualityVerdict: "same",
      missingContext: false,
      notes: "hello",
    });
    expect(v.artifactId).toBe(id);
    expect(v.qualityVerdict).toBe("same");
    expect(v.missingContext).toBe(false);
    expect(v.notes).toBe("hello");
    expect(typeof v.reviewedAt).toBe("string");
    expect(Date.parse(v.reviewedAt)).not.toBeNaN();
    // round-trip via disk
    const reread = await readVerdict(tmp, id);
    expect(reread).toEqual(v);
  });

  it("overwrites existing verdict; reviewedAt updates", async () => {
    const id = await seedArtifact(true);
    const v1 = await writeVerdict(tmp, id, { qualityVerdict: "same" });
    await new Promise((r) => setTimeout(r, 10));
    const v2 = await writeVerdict(tmp, id, { qualityVerdict: "better" });
    expect(v2.qualityVerdict).toBe("better");
    expect(v2.reviewedAt).not.toBe(v1.reviewedAt);
    expect(Date.parse(v2.reviewedAt)).toBeGreaterThan(Date.parse(v1.reviewedAt));
  });

  it("ignores caller-supplied reviewedAt (server-stamps)", async () => {
    const id = await seedArtifact(true);
    const v = await writeVerdict(tmp, id, {
      qualityVerdict: "same",
      // @ts-expect-error caller cannot supply this (input shape excludes it)
      reviewedAt: "1999-01-01T00:00:00.000Z",
    });
    expect(v.reviewedAt).not.toBe("1999-01-01T00:00:00.000Z");
  });

  it("rejects notes > 2000 chars via schema", async () => {
    const id = await seedArtifact(true);
    await expect(
      writeVerdict(tmp, id, { qualityVerdict: "same", notes: "x".repeat(2001) }),
    ).rejects.toThrow();
  });

  it("atomic write: tmp file gone after success", async () => {
    const id = await seedArtifact(true);
    await writeVerdict(tmp, id, { qualityVerdict: "same" });
    const dir = path.join(tmp, ".tierkit/runtime/context-artifacts", id);
    const files = await fs.readdir(dir);
    expect(files).not.toContain("verdict.json.tmp");
    expect(files).toContain("verdict.json");
  });
});

describe("VerdictSchema (drift guard)", () => {
  it("validates ISO datetime reviewedAt", () => {
    const ok = VerdictSchema.safeParse({
      artifactId: "ctx_aaaaaaaaaa",
      qualityVerdict: "same",
      reviewedAt: "2026-05-19T00:00:00.000Z",
    });
    expect(ok.success).toBe(true);
    const bad = VerdictSchema.safeParse({
      artifactId: "ctx_aaaaaaaaaa",
      qualityVerdict: "same",
      reviewedAt: "not-an-iso-date",
    });
    expect(bad.success).toBe(false);
  });
});
