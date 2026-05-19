import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextArtifactStoreError,
  readArtifact,
  writeArtifact,
  type WriteArtifactOptions,
} from "../src/runtime/contextArtifactStore.js";
import type { ContextArtifact } from "@tierkit/core";

const makeArtifact = (over: Partial<ContextArtifact> = {}): ContextArtifact => ({
  id: "ctx_a1b2c3d4e5",
  schemaVersion: 1,
  createdAt: "2026-05-19T00:00:00.000Z",
  workspaceRoot: "/tmp/x",
  task: "t",
  keywords: ["t"],
  budget: { maxFiles: 1, maxHotspotsPerFile: 1, hotspotContextLines: 1 },
  ignoreGlobs: [],
  candidates: [],
  excerpts: [],
  promptMdPath: "prompt.md",
  estimatedBaselineInputTokens: 10,
  estimatedCompressedInputTokens: 3,
  savedTokensEstimate: 7,
  compressionRatio: 0.3,
  ...over,
});

let tmpWorkspace = "";

beforeEach(async () => {
  tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-artifact-test-"));
});
afterEach(async () => {
  await fs.rm(tmpWorkspace, { recursive: true, force: true });
});

describe("contextArtifactStore", () => {
  it("write + read roundtrip preserves shape", async () => {
    const artifact = makeArtifact({ workspaceRoot: tmpWorkspace });
    const { id } = await writeArtifact(tmpWorkspace, artifact, "PROMPT BODY");
    const read = await readArtifact(tmpWorkspace, id);
    expect(read.artifact).toEqual({ ...artifact, id });
    expect(read.promptMd).toBe("PROMPT BODY");
  });

  it("throws ContextArtifactStoreError with code 'not-found' on missing id", async () => {
    await expect(readArtifact(tmpWorkspace, "ctx_0000000000")).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("retries on id collision and eventually succeeds", async () => {
    // Pre-create 2 colliding ids using mock generator.
    const ids = ["ctx_aaaaaaaaaa", "ctx_bbbbbbbbbb", "ctx_cccccccccc"];
    for (const id of ids.slice(0, 2)) {
      const dir = path.join(tmpWorkspace, ".tierkit/runtime/context-artifacts", id);
      await fs.mkdir(dir, { recursive: true });
    }
    const generator = vi.fn(() => ids.shift()!);
    const opts: WriteArtifactOptions = { idGenerator: generator };
    const { id } = await writeArtifact(tmpWorkspace, makeArtifact(), "x", opts);
    expect(id).toBe("ctx_cccccccccc");
    expect(generator).toHaveBeenCalledTimes(3);
  });

  it("throws after 5 collisions", async () => {
    const generator = vi.fn(() => "ctx_zzzzzzzzzz");
    await fs.mkdir(path.join(tmpWorkspace, ".tierkit/runtime/context-artifacts/ctx_zzzzzzzzzz"), {
      recursive: true,
    });
    await expect(
      writeArtifact(tmpWorkspace, makeArtifact(), "x", { idGenerator: generator }),
    ).rejects.toMatchObject({ code: "id-collision" });
    expect(generator).toHaveBeenCalledTimes(5);
  });

  it("creates .tierkit/.gitignore with '*' if missing", async () => {
    await writeArtifact(tmpWorkspace, makeArtifact(), "x");
    const gi = await fs.readFile(path.join(tmpWorkspace, ".tierkit/.gitignore"), "utf8");
    expect(gi.trim()).toBe("*");
  });

  it("does NOT overwrite an existing .tierkit/.gitignore", async () => {
    await fs.mkdir(path.join(tmpWorkspace, ".tierkit"), { recursive: true });
    await fs.writeFile(path.join(tmpWorkspace, ".tierkit/.gitignore"), "# custom\n!keep.me\n");
    await writeArtifact(tmpWorkspace, makeArtifact(), "x");
    const gi = await fs.readFile(path.join(tmpWorkspace, ".tierkit/.gitignore"), "utf8");
    expect(gi).toContain("# custom");
    expect(gi).toContain("!keep.me");
  });

  it("mutateArtifact updates artifact.json in place", async () => {
    const { id, dir } = await writeArtifact(tmpWorkspace, makeArtifact(), "x");
    const { artifact } = await readArtifact(tmpWorkspace, id);
    const updated: ContextArtifact = { ...artifact, baselineMdPath: "baseline.md", baselineEstimatedTokens: 999 };
    const { mutateArtifact } = await import("../src/runtime/contextArtifactStore.js");
    await mutateArtifact(tmpWorkspace, updated);
    const reread = await readArtifact(tmpWorkspace, id);
    expect(reread.artifact.baselineEstimatedTokens).toBe(999);
    expect(reread.artifact.baselineMdPath).toBe("baseline.md");
    // unrelated files still present
    expect(await fs.readFile(path.join(dir, "prompt.md"), "utf8")).toBe("x");
  });

  it("rejects artifact with bad schemaVersion on read", async () => {
    const dir = path.join(tmpWorkspace, ".tierkit/runtime/context-artifacts/ctx_dddddddddd");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "artifact.json"), JSON.stringify({ schemaVersion: 999 }));
    await fs.writeFile(path.join(dir, "prompt.md"), "");
    await expect(readArtifact(tmpWorkspace, "ctx_dddddddddd")).rejects.toMatchObject({
      code: "schema-mismatch",
    });
  });
});
