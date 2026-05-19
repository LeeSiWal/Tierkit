import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { Cli } from "clipanion";
import { ContextBuildCommand } from "../src/commands/context/ContextBuildCommand.js";
import type { CliContext } from "../src/context/CliContext.js";
import { PassThrough } from "node:stream";

let tmp = "";
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-ctx-build-test-"));
  await fs.mkdir(path.join(tmp, "src"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, "src/api.ts"),
    "import { Foo } from './foo';\nexport function payment() { return 'paid' }\n",
  );
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function runCli(argv: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  const cli = new Cli<CliContext>({ binaryName: "tierkit" });
  cli.register(ContextBuildCommand);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let outBuf = "";
  let errBuf = "";
  stdout.on("data", (b) => (outBuf += b.toString()));
  stderr.on("data", (b) => (errBuf += b.toString()));
  return cli
    .run(argv, { cwd, stdout, stderr, stdin: process.stdin })
    .then((code) => ({ code, out: outBuf, err: errBuf }));
}

describe("ContextBuildCommand", () => {
  it("creates artifact and writes prompt.md + artifact.json", async () => {
    const { code, out } = await runCli(["context", "build", "payment foo function"], tmp);
    expect(code).toBe(0);
    expect(out).toMatch(/Context artifact: ctx_[a-f0-9]{10}/);
    expect(out).toMatch(/Prompt: \.tierkit\/runtime\/context-artifacts\/ctx_/);
    const dirs = await fs.readdir(path.join(tmp, ".tierkit/runtime/context-artifacts"));
    expect(dirs).toHaveLength(1);
    const artifact = JSON.parse(
      await fs.readFile(
        path.join(tmp, ".tierkit/runtime/context-artifacts", dirs[0], "artifact.json"),
        "utf8",
      ),
    );
    expect(artifact.schemaVersion).toBe(1);
  });

  it("returns exit 1 on no-keywords", async () => {
    const { code, err } = await runCli(["context", "build", "the and is of"], tmp);
    expect(code).toBe(1);
    expect(err).toContain("no-keywords");
  });
});
