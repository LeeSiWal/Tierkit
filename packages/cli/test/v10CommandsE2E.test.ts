import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { buildCli } from "../src/cli.js";
import type { CliContext } from "../src/context/CliContext.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const SUPERPOWERS_FREE_DIR = path.resolve(
  TEST_DIR,
  "../../plugin-superpowers/plugins/superpowers-free",
);

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

describe("CLI e2e: v1.0 commands", () => {
  let root: string;
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  // v0.19: plugin commands disabled.
  it.skip("`plugin enable` / `plugin disable` modify activePlugins", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-v10-plugin-"));
    const cli = buildCli();
    expect(await cli.run(["init"], makeContext(root).context)).toBe(0);
    expect(
      await cli.run(
        ["plugin", "install", SUPERPOWERS_FREE_DIR],
        makeContext(root).context,
      ),
    ).toBe(0);

    const enableCtx = makeContext(root);
    expect(await cli.run(["plugin", "enable", "superpowers-free"], enableCtx.context)).toBe(0);
    expect(enableCtx.stdout.text()).toContain("enabled superpowers-free");

    const cfgAfterEnable = JSON.parse(
      await fs.readFile(path.join(root, "tierkit.config.json"), "utf8"),
    );
    expect(cfgAfterEnable.activePlugins).toContain("superpowers-free");

    expect(
      await cli.run(["plugin", "disable", "superpowers-free"], makeContext(root).context),
    ).toBe(0);
    const cfgAfterDisable = JSON.parse(
      await fs.readFile(path.join(root, "tierkit.config.json"), "utf8"),
    );
    expect(cfgAfterDisable.activePlugins).not.toContain("superpowers-free");
  });

  // v0.19: plugin commands disabled.
  it.skip("`plugin remove` deletes installed dir and registry entry", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-v10-remove-"));
    const cli = buildCli();
    expect(await cli.run(["init"], makeContext(root).context)).toBe(0);
    expect(
      await cli.run(
        ["plugin", "install", SUPERPOWERS_FREE_DIR],
        makeContext(root).context,
      ),
    ).toBe(0);
    const installed = path.join(root, ".tierkit/plugins/superpowers-free");
    await expect(fs.access(installed)).resolves.toBeUndefined();
    expect(
      await cli.run(["plugin", "remove", "superpowers-free"], makeContext(root).context),
    ).toBe(0);
    await expect(fs.access(installed)).rejects.toBeDefined();
  });

  it("`usage` prints empty report when no usage logged yet", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-v10-usage-empty-"));
    const cli = buildCli();
    expect(await cli.run(["init"], makeContext(root).context)).toBe(0);
    const ctx = makeContext(root);
    expect(await cli.run(["usage"], ctx.context)).toBe(0);
    expect(ctx.stdout.text()).toContain("Total calls: 0");
  });

  it("`runtime status` reports not running when no daemon is up", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-v10-status-"));
    const cli = buildCli();
    expect(await cli.run(["init"], makeContext(root).context)).toBe(0);
    const ctx = makeContext(root);
    expect(await cli.run(["runtime", "status"], ctx.context)).toBe(1);
    expect(ctx.stdout.text()).toContain("NOT RUNNING");
  });

  it("`runtime stop` is a no-op when daemon is not running", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-v10-stop-noop-"));
    const cli = buildCli();
    expect(await cli.run(["init"], makeContext(root).context)).toBe(0);
    const ctx = makeContext(root);
    expect(await cli.run(["runtime", "stop"], ctx.context)).toBe(1);
    expect(ctx.stdout.text()).toContain("Not running");
  });
});
