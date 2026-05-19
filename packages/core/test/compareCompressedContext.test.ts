import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {
  writeArtifact,
  readArtifact,
  type ContextArtifact,
  type RouteRunner,
  type RelevantFile,
  type FileExcerpt,
} from "@tierkit/core";
import { compareCompressedContext } from "../src/usecases/compareCompressedContext.js";

let tmp = "";
let savedId = "";

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-compare-test-"));
  // Create a couple of source files to be the "baseline" content.
  await fs.mkdir(path.join(tmp, "src"), { recursive: true });
  await fs.writeFile(path.join(tmp, "src/a.ts"), "console.log('a')\n");
  await fs.writeFile(path.join(tmp, "src/b.ts"), "console.log('b')\n");

  const candidates: RelevantFile[] = [
    { path: "src/a.ts", score: 0.9, reason: "x", matchedTerms: ["a"], termHitCount: 1, pathBonus: 0, mtimeBonus: 0, sizeBytes: 18, language: "ts" },
    { path: "src/b.ts", score: 0.8, reason: "x", matchedTerms: ["b"], termHitCount: 1, pathBonus: 0, mtimeBonus: 0, sizeBytes: 18, language: "ts" },
  ];
  const excerpts: FileExcerpt[] = candidates.map((c) => ({
    path: c.path, language: "ts", totalLines: 1, skeleton: [], hotspots: [], omittedLineRanges: [], estimatedTokens: 0,
  }));
  const artifact: ContextArtifact = {
    id: "ctx_0000000000",
    schemaVersion: 1,
    createdAt: "2026-05-19T00:00:00.000Z",
    workspaceRoot: tmp,
    task: "t",
    keywords: ["t"],
    budget: { maxFiles: 2, maxHotspotsPerFile: 1, hotspotContextLines: 1 },
    ignoreGlobs: [],
    candidates,
    excerpts,
    promptMdPath: "prompt.md",
    estimatedBaselineInputTokens: 50,
    estimatedCompressedInputTokens: 10,
    savedTokensEstimate: 40,
    compressionRatio: 0.2,
  };
  const { id } = await writeArtifact(tmp, artifact, "# Task\n\nt\n\n(compressed)");
  savedId = id;
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function makeRunner(captured: string[], opts: { failStream?: number; structuralFailOn?: number } = {}): RouteRunner {
  let call = 0;
  return async (input) => {
    call += 1;
    if (opts.structuralFailOn === call) {
      return { ok: false, code: "budget-exceeded", message: "no budget" };
    }
    captured.push(input.task);
    return {
      ok: true,
      context: {} as any,
      stream: (async function* () {
        if (opts.failStream === call) {
          yield { type: "error", code: "stream-error", message: "boom", latencyMs: 1 } as any;
        }
        yield { type: "delta", text: `response-${call}` } as any;
        yield { type: "end", latencyMs: 1 } as any;
      })(),
      done: Promise.resolve({
        text: `response-${call}`,
        inputTokens: call === 1 ? 100 : 30,
        outputTokens: 5,
        costUsd: call === 1 ? 0.1 : 0.01,
        latencyMs: 1,
      }),
    };
  };
}

describe("compareCompressedContext", () => {
  it("calls runner twice, baseline first, with full and compressed inputs", async () => {
    const captured: string[] = [];
    const runner = makeRunner(captured);
    const result = await compareCompressedContext(
      { workspaceRoot: tmp, id: savedId, profileId: "claudeSonnet", mode: "execute" },
      { routeRunner: runner },
    );
    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(2);
    expect(captured[0]).toContain("src/a.ts");  // baseline = full files
    expect(captured[0]).toContain("console.log('a')");
    expect(captured[1]).toContain("(compressed)");
    expect(captured[1]).not.toContain("console.log('b')");
  });

  it("writes baseline.md, response-baseline.md, response-compressed.md", async () => {
    const runner = makeRunner([]);
    await compareCompressedContext(
      { workspaceRoot: tmp, id: savedId, profileId: "x", mode: "execute" },
      { routeRunner: runner },
    );
    const dir = path.join(tmp, ".tierkit/runtime/context-artifacts", savedId);
    await expect(fs.access(path.join(dir, "baseline.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "response-baseline.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(dir, "response-compressed.md"))).resolves.toBeUndefined();
  });

  it("mutates artifact.json with baselineMdPath / baselineEstimatedTokens / compare", async () => {
    const runner = makeRunner([]);
    await compareCompressedContext(
      { workspaceRoot: tmp, id: savedId, profileId: "x", mode: "execute" },
      { routeRunner: runner },
    );
    const { artifact } = await readArtifact(tmp, savedId);
    expect(artifact.baselineMdPath).toBe("baseline.md");
    expect(artifact.baselineEstimatedTokens).toBeGreaterThan(0);
    expect(artifact.compare).toBeDefined();
    expect(artifact.compare?.profileId).toBe("x");
    expect(artifact.compare?.baseline.actualInputTokens).toBe(100);
    expect(artifact.compare?.compressed.actualInputTokens).toBe(30);
    expect(artifact.compare?.savedInputTokensActual).toBe(70);
  });

  it("on baseline structural failure: skips compressed and returns ok:false", async () => {
    const runner = makeRunner([], { structuralFailOn: 1 });
    const result = await compareCompressedContext(
      { workspaceRoot: tmp, id: savedId, profileId: "x", mode: "execute" },
      { routeRunner: runner },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("budget-exceeded");
  });

  it("on baseline stream error: continues to compressed and records failureCode", async () => {
    const runner = makeRunner([], { failStream: 1 });
    const result = await compareCompressedContext(
      { workspaceRoot: tmp, id: savedId, profileId: "x", mode: "execute" },
      { routeRunner: runner },
    );
    expect(result.ok).toBe(true);
    const { artifact } = await readArtifact(tmp, savedId);
    expect(artifact.compare?.baseline.failureCode).toBe("stream-error");
    expect(artifact.compare?.compressed.failureCode).toBeUndefined();
  });

  it("overwrite: second run replaces only compare/baselineMdPath/baselineEstimatedTokens", async () => {
    const runner = makeRunner([]);
    await compareCompressedContext(
      { workspaceRoot: tmp, id: savedId, profileId: "x", mode: "execute" },
      { routeRunner: runner },
    );
    const { artifact: first } = await readArtifact(tmp, savedId);
    await compareCompressedContext(
      { workspaceRoot: tmp, id: savedId, profileId: "y", mode: "execute" },
      { routeRunner: makeRunner([]) },
    );
    const { artifact: second } = await readArtifact(tmp, savedId);
    expect(second.compare?.profileId).toBe("y");
    expect(second.task).toBe(first.task);
    expect(second.candidates).toEqual(first.candidates);
  });
});
