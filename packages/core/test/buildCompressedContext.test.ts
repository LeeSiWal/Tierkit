import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCompressedContext } from "../src/usecases/buildCompressedContext.js";

const FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/sample-repo",
);

describe("buildCompressedContext", () => {
  it("returns no-keywords when task has no extractable terms", async () => {
    const result = await buildCompressedContext({
      task: "the and is of",
      workspaceRoot: FIXTURE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("no-keywords");
  });

  it("returns rg-missing when rg runner throws ENOENT", async () => {
    const result = await buildCompressedContext({
      task: "payment toss",
      workspaceRoot: FIXTURE,
      rg: async () => {
        const e: NodeJS.ErrnoException = new Error("not found");
        e.code = "ENOENT";
        throw e;
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rg-missing");
  });

  it("returns workspace-not-found when workspaceRoot does not exist", async () => {
    const result = await buildCompressedContext({
      task: "payment",
      workspaceRoot: "/definitely/does/not/exist/9c8d7e6f",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("workspace-not-found");
  });

  it("returns no-candidates when nothing matches", async () => {
    const result = await buildCompressedContext({
      task: "xyzqwerty_no_such_term",
      workspaceRoot: FIXTURE,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("no-candidates");
  });

  it("builds an artifact with sensible structure for a Toss payment task", async () => {
    const result = await buildCompressedContext({
      task: "fix toss payment confirm not updating order status",
      workspaceRoot: FIXTURE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const a = result.artifact;
    expect(a.id).toMatch(/^ctx_[a-f0-9]{10}$/);
    expect(a.schemaVersion).toBe(1);
    expect(a.workspaceRoot).toBe(FIXTURE);
    expect(a.task).toBe("fix toss payment confirm not updating order status");
    expect(a.candidates.length).toBeGreaterThan(0);
    expect(a.candidates.length).toBe(a.excerpts.length);
    // The toss route file should rank well.
    const top = a.candidates[0];
    expect(top.path).toMatch(/toss/);
    // Compression should beat baseline (skeleton + hotspots < full files).
    expect(a.estimatedCompressedInputTokens).toBeLessThan(a.estimatedBaselineInputTokens);
    expect(a.savedTokensEstimate).toBe(
      a.estimatedBaselineInputTokens - a.estimatedCompressedInputTokens,
    );
  });

  it("excludes node_modules via DEFAULT_IGNORE_GLOBS", async () => {
    const result = await buildCompressedContext({
      task: "payment toss",
      workspaceRoot: FIXTURE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifact.candidates.every((c) => !c.path.startsWith("node_modules"))).toBe(true);
  });

  it("does NOT write anything to disk", async () => {
    const artifactDir = path.join(FIXTURE, ".tierkit");
    const before = await fs.readdir(FIXTURE);
    const result = await buildCompressedContext({
      task: "payment toss",
      workspaceRoot: FIXTURE,
    });
    expect(result.ok).toBe(true);
    const after = await fs.readdir(FIXTURE);
    expect(after.sort()).toEqual(before.sort());
    // .tierkit should not exist
    await expect(fs.access(artifactDir)).rejects.toThrow();
  });
});
