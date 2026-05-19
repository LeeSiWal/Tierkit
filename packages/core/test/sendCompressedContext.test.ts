import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {
  writeArtifact,
  type ContextArtifact,
  type RouteRunner,
} from "@tierkit/core";
import { sendCompressedContext } from "../src/usecases/sendCompressedContext.js";

let tmp = "";
let savedId = "";
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-send-test-"));
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
    estimatedBaselineInputTokens: 10,
    estimatedCompressedInputTokens: 3,
    savedTokensEstimate: 7,
    compressionRatio: 0.3,
  };
  const { id } = await writeArtifact(tmp, artifact, "# Task\n\nt\n\n(prompt body)");
  savedId = id;
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const fakeRunner: RouteRunner = async (input) => {
  return {
    ok: true,
    context: {} as any,
    stream: (async function* () {
      yield { type: "start" } as any;
      yield { type: "delta", text: `received task length=${input.task.length}` } as any;
      yield { type: "end", latencyMs: 1 } as any;
    })(),
    done: Promise.resolve({
      text: `received task length=${input.task.length}`,
      inputTokens: 100,
      outputTokens: 5,
      costUsd: 0.001,
      latencyMs: 1,
    }),
  };
};

describe("sendCompressedContext", () => {
  it("passes prompt.md content as task to routeRunner", async () => {
    let capturedTask = "";
    const capturingRunner: RouteRunner = async (input) => {
      capturedTask = input.task;
      return fakeRunner(input);
    };
    const result = await sendCompressedContext(
      { workspaceRoot: tmp, id: savedId, profileId: "claudeSonnet", mode: "execute" },
      { routeRunner: capturingRunner },
    );
    expect(result.ok).toBe(true);
    expect(capturedTask).toContain("# Task");
    expect(capturedTask).toContain("(prompt body)");
  });

  it("writes response to response-compressed.md", async () => {
    await sendCompressedContext(
      { workspaceRoot: tmp, id: savedId, profileId: "claudeSonnet", mode: "execute" },
      { routeRunner: fakeRunner },
    );
    const resp = await fs.readFile(
      path.join(tmp, ".tierkit/runtime/context-artifacts", savedId, "response-compressed.md"),
      "utf8",
    );
    expect(resp).toContain("received task length=");
  });

  it("does NOT mutate artifact.json", async () => {
    const before = await fs.readFile(
      path.join(tmp, ".tierkit/runtime/context-artifacts", savedId, "artifact.json"),
      "utf8",
    );
    await sendCompressedContext(
      { workspaceRoot: tmp, id: savedId, profileId: "claudeSonnet", mode: "execute" },
      { routeRunner: fakeRunner },
    );
    const after = await fs.readFile(
      path.join(tmp, ".tierkit/runtime/context-artifacts", savedId, "artifact.json"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("returns ok:false when routeRunner returns structural failure", async () => {
    const failingRunner: RouteRunner = async () => ({
      ok: false,
      code: "unknown-profile",
      message: "no such profile",
    });
    const result = await sendCompressedContext(
      { workspaceRoot: tmp, id: savedId, profileId: "xxx", mode: "execute" },
      { routeRunner: failingRunner },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("unknown-profile");
  });
});
