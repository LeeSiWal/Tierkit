import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { Cli } from "clipanion";
import { PassThrough, Readable } from "node:stream";
import { ContextPackCommand } from "../src/commands/context/ContextPackCommand.js";
import { DigestCommandCommand } from "../src/commands/digest/DigestCommandCommand.js";
import { DigestErrorCommand } from "../src/commands/digest/DigestErrorCommand.js";
import { DigestTestCommand } from "../src/commands/digest/DigestTestCommand.js";
import { DigestJsonCommand } from "../src/commands/digest/DigestJsonCommand.js";
import { DigestFileCommand } from "../src/commands/digest/DigestFileCommand.js";
import { DigestDiffCommand } from "../src/commands/digest/DigestDiffCommand.js";
import type { CliContext } from "../src/context/CliContext.js";

let tmp = "";
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-cli-digest-"));
  await fs.mkdir(path.join(tmp, "src"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, "src/foo.ts"),
    "export function helper() { return 1 }\nexport class Widget {}\n",
  );
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  out: string;
  err: string;
}

function runCli(argv: string[], cwd: string, stdinText?: string): Promise<RunResult> {
  const cli = new Cli<CliContext>({ binaryName: "tierkit" });
  cli.register(ContextPackCommand);
  cli.register(DigestCommandCommand);
  cli.register(DigestErrorCommand);
  cli.register(DigestTestCommand);
  cli.register(DigestJsonCommand);
  cli.register(DigestFileCommand);
  cli.register(DigestDiffCommand);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let outBuf = "";
  let errBuf = "";
  stdout.on("data", (b) => (outBuf += b.toString()));
  stderr.on("data", (b) => (errBuf += b.toString()));
  // For stdin: always use a Readable so the test never hangs on a TTY-less
  // process.stdin. An empty stream simulates "no piped input" — readTextInput
  // sees zero chunks and returns undefined.
  const stdin = stdinText !== undefined
    ? Readable.from([Buffer.from(stdinText)])
    : Readable.from([]);
  return cli
    .run(argv, { cwd, stdout, stderr, stdin })
    .then((code) => ({ code, out: outBuf, err: errBuf }));
}

describe("tierkit digest command", () => {
  it("accepts a positional argument", async () => {
    const r = await runCli(["digest", "command", "Add CRUD for AdminMenuForm"], tmp);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Compressed Task");
    expect(r.out).toContain("Add CRUD");
  });

  it("--json emits a parseable JSON object", async () => {
    const r = await runCli(["digest", "command", "Add x to y", "--json"], tmp);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out);
    expect(parsed.id).toMatch(/^cmd_/);
    expect(parsed.compressed).toContain("Task:");
  });

  it("fails when no input provided", async () => {
    const r = await runCli(["digest", "command"], tmp);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("no command");
  });

  it("--out writes compressed brief to a file", async () => {
    const target = path.join(tmp, "out.txt");
    const r = await runCli(["digest", "command", "Add a button", "--out", target], tmp);
    expect(r.code).toBe(0);
    const written = await fs.readFile(target, "utf8");
    expect(written).toContain("Task:");
  });
});

describe("tierkit digest error", () => {
  it("reads from stdin (piped)", async () => {
    const log = "src/foo.ts:1:1 - error TS2345: bad arg";
    const r = await runCli(["digest", "error"], tmp, log);
    expect(r.code).toBe(0);
    expect(r.out).toContain("TS2345");
    expect(r.out).toContain("src/foo.ts");
  });

  it("reads from --file", async () => {
    const logPath = path.join(tmp, "error.log");
    await fs.writeFile(logPath, "src/bar.ts:5:5 - error TS2304: x not found");
    const r = await runCli(["digest", "error", "--file", logPath], tmp);
    expect(r.code).toBe(0);
    expect(r.out).toContain("TS2304");
  });
});

describe("tierkit digest test", () => {
  it("parses passing/failing counts", async () => {
    const output = "✓ pass 1\n× suite > case\n    Expected: 1\n    Received: 2";
    const r = await runCli(["digest", "test"], tmp, output);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Passed: 1");
    expect(r.out).toContain("Failed: 1");
  });
});

describe("tierkit digest json", () => {
  it("emits shape + field paths from stdin", async () => {
    const r = await runCli(["digest", "json"], tmp, JSON.stringify({ a: { b: 1, c: "x" } }));
    expect(r.code).toBe(0);
    expect(r.out).toContain("a.b");
    expect(r.out).toContain("a.c");
  });
});

describe("tierkit digest file", () => {
  it("digests a workspace file with --cwd", async () => {
    const r = await runCli(["digest", "file", "src/foo.ts", "--cwd", tmp], tmp);
    expect(r.code).toBe(0);
    expect(r.out).toContain("helper");
    expect(r.out).toContain("Widget");
  });

  it("second call reports cache hit", async () => {
    await runCli(["digest", "file", "src/foo.ts", "--cwd", tmp], tmp);
    const r = await runCli(["digest", "file", "src/foo.ts", "--cwd", tmp], tmp);
    expect(r.code).toBe(0);
    expect(r.out).toContain("(cache hit)");
  });
});

describe("tierkit digest diff", () => {
  it("works on a non-git directory and reports uncertainty", async () => {
    const r = await runCli(["digest", "diff", "--cwd", tmp], tmp);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Diff Summary");
  });
});

describe("tierkit context pack", () => {
  it("builds a pack from command + files", async () => {
    const r = await runCli(
      ["context", "pack", "--command", "Add CRUD", "--files", "src/foo.ts", "--cwd", tmp],
      tmp,
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("Context Pack");
    expect(r.out).toContain("Task Brief");
    expect(r.out).toContain("src/foo.ts");
    expect(r.out).toContain("Output Policy for Claude Code");
  });

  it("--out writes pack Markdown to file", async () => {
    const outPath = path.join(tmp, "pack.md");
    const r = await runCli(
      ["context", "pack", "--command", "Add CRUD", "--out", outPath, "--cwd", tmp],
      tmp,
    );
    expect(r.code).toBe(0);
    const written = await fs.readFile(outPath, "utf8");
    expect(written).toContain("Tierkit Context Pack");
    expect(written).toContain("Output Policy");
  });
});
