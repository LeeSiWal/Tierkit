import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { Cli } from "clipanion";
import { ContextShowCommand } from "../src/commands/context/ContextShowCommand.js";
import { writeArtifact, type ContextArtifact } from "@tierkit/core";
import type { CliContext } from "../src/context/CliContext.js";
import { PassThrough } from "node:stream";

const sample: Omit<ContextArtifact, "id"> = {
  schemaVersion: 1,
  createdAt: "2026-05-19T00:00:00.000Z",
  workspaceRoot: "",
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

let tmp = "";
let savedId = "";
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-ctx-show-test-"));
  const artifact: ContextArtifact = { ...sample, workspaceRoot: tmp, id: "ctx_0000000000" };
  const { id } = await writeArtifact(tmp, artifact, "PROMPT");
  savedId = id;
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function runCli(argv: string[], cwd: string) {
  const cli = new Cli<CliContext>({ binaryName: "tierkit" });
  cli.register(ContextShowCommand);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (b) => (out += b.toString()));
  stderr.on("data", (b) => (err += b.toString()));
  return cli.run(argv, { cwd, stdout, stderr, stdin: process.stdin }).then((code) => ({ code, out, err }));
}

describe("ContextShowCommand", () => {
  it("prints human-readable summary by default", async () => {
    const { code, out } = await runCli(["context", "show", savedId], tmp);
    expect(code).toBe(0);
    expect(out).toContain(savedId);
    expect(out).toContain("fix the bug");
    expect(out).toContain("70 tokens");
  });

  it("--json prints the artifact as JSON", async () => {
    const { code, out } = await runCli(["context", "show", savedId, "--json"], tmp);
    expect(code).toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.id).toBe(savedId);
    expect(parsed.task).toBe("fix the bug");
  });

  it("exits 1 with not-found message on unknown id", async () => {
    const { code, err } = await runCli(["context", "show", "ctx_ffffffffff"], tmp);
    expect(code).toBe(1);
    expect(err).toContain("not-found");
  });
});
