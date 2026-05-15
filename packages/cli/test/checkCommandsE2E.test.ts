import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { buildCli } from "../src/cli.js";
import type { CliContext } from "../src/context/CliContext.js";

class StringSink extends Writable {
  chunks: Buffer[] = [];
  override _write(chunk: Buffer, _enc: unknown, cb: (err?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    cb();
  }
  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function makeContext(cwd: string): { context: CliContext; stdout: StringSink; stderr: StringSink } {
  const stdout = new StringSink();
  const stderr = new StringSink();
  return {
    context: {
      stdin: process.stdin,
      stdout,
      stderr,
      env: process.env as Record<string, string>,
      colorDepth: 1,
      cwd,
    },
    stdout,
    stderr,
  };
}

describe("CLI e2e: v0.6 check commands", () => {
  let root: string;
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("`check redact` reports hits and exits 1 when secrets found", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-check-redact-"));
    const file = path.join(root, "notes.txt");
    await fs.writeFile(file, "OPENAI=sk-abcdefghijklmnopqrst1234");
    const cli = buildCli();
    const ctx = makeContext(root);
    expect(await cli.run(["check", "redact", file], ctx.context)).toBe(1);
    expect(ctx.stdout.text()).toContain("openai-api-key");
  });

  it("`check redact` exits 0 for a clean file", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-check-redact-clean-"));
    const file = path.join(root, "ok.md");
    await fs.writeFile(file, "# Title\nNo secrets here.");
    const cli = buildCli();
    const ctx = makeContext(root);
    expect(await cli.run(["check", "redact", file], ctx.context)).toBe(0);
    expect(ctx.stdout.text()).toContain("file appears clean");
  });

  it("`check command` exits 2 for block-severity command", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-check-cmd-"));
    const cli = buildCli();
    const ctx = makeContext(root);
    expect(await cli.run(["check", "command", "rm -rf /"], ctx.context)).toBe(2);
    expect(ctx.stdout.text()).toContain("BLOCK");
  });

  it("`check command` exits 1 for warn-severity command", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-check-cmd-warn-"));
    const cli = buildCli();
    const ctx = makeContext(root);
    expect(await cli.run(["check", "command", "git reset --hard origin/main"], ctx.context)).toBe(1);
    expect(ctx.stdout.text()).toContain("WARN");
  });

  it("`check command` exits 0 for harmless command", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-check-cmd-ok-"));
    const cli = buildCli();
    const ctx = makeContext(root);
    expect(await cli.run(["check", "command", "ls -la"], ctx.context)).toBe(0);
    expect(ctx.stdout.text()).toContain("OK");
  });

  it("`check path` flags .env and exits 1", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-check-path-"));
    const cli = buildCli();
    const ctx = makeContext(root);
    expect(await cli.run(["check", "path", ".env"], ctx.context)).toBe(1);
    expect(ctx.stdout.text()).toContain("Sensitive: YES");
  });

  it("`check path` clears README.md", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-check-path-ok-"));
    const cli = buildCli();
    const ctx = makeContext(root);
    expect(await cli.run(["check", "path", "README.md"], ctx.context)).toBe(0);
    expect(ctx.stdout.text()).toContain("Sensitive: no");
  });
});
