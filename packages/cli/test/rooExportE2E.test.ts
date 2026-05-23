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

// v0.19: `tierkit export roo` command disabled.
describe.skip("CLI e2e: export roo (superpowers-free)", () => {
  let projectRoot: string;
  afterEach(async () => {
    if (projectRoot) await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("produces .roomodes plus .roo/{commands,rules,TIERKIT.md}", async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-e2e-roo-"));
    const cli = buildCli();

    expect(await cli.run(["init"], makeContext(projectRoot).context)).toBe(0);
    expect(
      await cli.run(
        ["plugin", "install", SUPERPOWERS_FREE_DIR],
        makeContext(projectRoot).context,
      ),
    ).toBe(0);

    const exportCtx = makeContext(projectRoot);
    expect(await cli.run(["export", "roo"], exportCtx.context)).toBe(0);
    expect(exportCtx.stdout.text()).toContain('target "roo"');

    const roomodesText = await fs.readFile(path.join(projectRoot, ".roomodes"), "utf8");
    const roomodes = JSON.parse(roomodesText);
    expect(Array.isArray(roomodes.customModes)).toBe(true);
    const slugs: string[] = roomodes.customModes.map((m: { slug: string }) => m.slug);
    expect(slugs.sort()).toEqual([
      "superpowers-free-brainstormer",
      "superpowers-free-free-coder",
      "superpowers-free-reviewer",
    ]);

    const brainstorm = await fs.readFile(
      path.join(projectRoot, ".roo/commands/superpowers-free-brainstorm.md"),
      "utf8",
    );
    expect(brainstorm).toMatch(/^---\nname: brainstorm/);
    expect(brainstorm).toContain("/brainstorm");

    const localFirst = await fs.readFile(
      path.join(projectRoot, ".roo/rules/superpowers-free/local-first.md"),
      "utf8",
    );
    expect(localFirst).toContain("local-device");
    expect(localFirst).toContain("Tierkit defaults to local-device");

    const readme = await fs.readFile(
      path.join(projectRoot, ".roo/TIERKIT.md"),
      "utf8",
    );
    expect(readme).toContain("Tierkit → Roo / Zoo Code export");
  });

  it("`export zoo` aliases to the same adapter", async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-e2e-zoo-"));
    const cli = buildCli();

    expect(await cli.run(["init"], makeContext(projectRoot).context)).toBe(0);
    expect(
      await cli.run(
        ["plugin", "install", SUPERPOWERS_FREE_DIR],
        makeContext(projectRoot).context,
      ),
    ).toBe(0);
    expect(
      await cli.run(["export", "zoo", "--out", "."], makeContext(projectRoot).context),
    ).toBe(0);

    await expect(fs.access(path.join(projectRoot, ".roomodes"))).resolves.toBeUndefined();
  });
});
