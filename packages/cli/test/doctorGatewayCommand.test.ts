import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

describe("tierkit doctor gateway", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("exits 0 with check lines when gatewayMode is off", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tk-cli-doctor-gw-"));
    await writeFile(path.join(dir, "tierkit.config.json"), JSON.stringify({ version: "0.1" }));
    const cli = buildCli();
    const ctx = makeContext(dir);
    const code = await cli.run(["doctor", "gateway"], ctx.context);
    const out = ctx.stdout.text();
    expect(code).toBe(0);
    expect(out).toContain("runtime.gatewayMode");
    expect(out).toContain("safe gateway log");
  });

  it("exits 1 when a hard failure occurs", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tk-cli-doctor-gw-fail-"));
    await writeFile(
      path.join(dir, "tierkit.config.json"),
      JSON.stringify({ version: "0.1", runtime: { gatewayMode: "on", port: 1 } }),
    );
    const cli = buildCli();
    const ctx = makeContext(dir);
    const code = await cli.run(["doctor", "gateway"], ctx.context);
    expect(code).toBe(1);
  });
});
