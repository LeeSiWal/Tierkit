import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Writable } from "node:stream";
import { buildCli } from "../src/cli.js";
import type { CliContext } from "../src/context/CliContext.js";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

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

const SUPERPOWERS_FREE_DIR = path.resolve(
  TEST_DIR,
  "../../plugin-superpowers/plugins/superpowers-free",
);

// v0.19: plugin install/list/validate/export commands disabled.
describe.skip("CLI end-to-end: superpowers-free", () => {
  let projectRoot: string;
  afterEach(async () => {
    if (projectRoot) await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("init → plugin install → plugin list → export generic", async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-e2e-"));
    const cli = buildCli();

    const initCtx = makeContext(projectRoot);
    expect(await cli.run(["init"], initCtx.context)).toBe(0);
    expect(initCtx.stdout.text()).toContain("Tierkit project initialized");

    const installCtx = makeContext(projectRoot);
    expect(
      await cli.run(["plugin", "install", SUPERPOWERS_FREE_DIR], installCtx.context),
    ).toBe(0);
    expect(installCtx.stdout.text()).toContain("superpowers-free@0.1.0");

    const listCtx = makeContext(projectRoot);
    expect(await cli.run(["plugin", "list"], listCtx.context)).toBe(0);
    expect(listCtx.stdout.text()).toContain("superpowers-free");
    expect(listCtx.stdout.text()).toContain("free");

    const exportCtx = makeContext(projectRoot);
    expect(
      await cli.run(["export", "generic", "--out", "out"], exportCtx.context),
    ).toBe(0);

    const readme = await fs.readFile(
      path.join(projectRoot, "out/superpowers-free/README.md"),
      "utf8",
    );
    expect(readme).toContain("# Superpowers Free");

    const brainstorm = await fs.readFile(
      path.join(projectRoot, "out/superpowers-free/commands/brainstorm.md"),
      "utf8",
    );
    expect(brainstorm).toContain("/brainstorm");

    const localFirst = await fs.readFile(
      path.join(projectRoot, "out/superpowers-free/rules/local-first.md"),
      "utf8",
    );
    expect(localFirst).toContain("local-first");
  });

  it("plugin validate exits 0 for the sample plugin", async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-e2e-validate-"));
    const cli = buildCli();
    const ctx = makeContext(projectRoot);
    expect(await cli.run(["plugin", "validate", SUPERPOWERS_FREE_DIR], ctx.context)).toBe(0);
    expect(ctx.stdout.text()).toContain("valid: superpowers-free@0.1.0");
  });

  it("plugin validate --strict exits non-zero when there are warnings", async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-e2e-strict-"));
    const sample = path.join(projectRoot, "warning-plugin");
    await fs.mkdir(path.join(sample, "commands"), { recursive: true });
    await fs.writeFile(path.join(sample, "commands/x.md"), "x");
    await fs.writeFile(
      path.join(sample, "tierkit.plugin.json"),
      JSON.stringify({
        schemaVersion: "0.1",
        id: "warns",
        name: "warns",
        version: "0.1.0",
        description: "warns",
        author: "tierkit",
        compatibility: { tierkit: ">=0.1.0", targets: ["generic"] },
        components: {
          commands: [{ name: "x", file: "commands/x.md", description: "x", category: "misc" }],
        },
        permissions: { readFiles: true, runCommands: true },
        freedom: { level: "free" },
      }),
    );
    const cli = buildCli();
    const ctx = makeContext(projectRoot);
    expect(await cli.run(["plugin", "validate", sample, "--strict"], ctx.context)).toBe(1);
  });
});
