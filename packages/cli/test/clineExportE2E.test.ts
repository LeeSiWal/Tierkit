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

// v0.19: `tierkit export cline` command disabled (Plugin adapter export pivot).
describe.skip("CLI e2e: export cline (superpowers-free)", () => {
  let projectRoot: string;
  afterEach(async () => {
    if (projectRoot) await fs.rm(projectRoot, { recursive: true, force: true });
  });

  it("produces .clinerules/ files at the four prefix tiers and an TIERKIT.md", async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-e2e-cline-"));
    const cli = buildCli();

    expect(await cli.run(["init"], makeContext(projectRoot).context)).toBe(0);
    expect(
      await cli.run(
        ["plugin", "install", SUPERPOWERS_FREE_DIR],
        makeContext(projectRoot).context,
      ),
    ).toBe(0);

    const ctx = makeContext(projectRoot);
    expect(await cli.run(["export", "cline"], ctx.context)).toBe(0);
    expect(ctx.stdout.text()).toContain('target "cline"');

    const dir = path.join(projectRoot, ".clinerules");
    const entries = (await fs.readdir(dir)).sort();
    expect(entries).toContain("TIERKIT.md");
    expect(entries).toContain("00-superpowers-free-permission.md");
    expect(entries).toContain("10-superpowers-free-rule-local-first.md");
    expect(entries).toContain("20-superpowers-free-mode-free-coder.md");
    expect(entries).toContain("20-superpowers-free-mode-brainstormer.md");
    expect(entries).toContain("20-superpowers-free-mode-reviewer.md");
    expect(entries).toContain("30-superpowers-free-command-brainstorm.md");
    expect(entries).toContain("30-superpowers-free-command-debug.md");
    expect(entries).toContain("30-superpowers-free-command-review.md");
    expect(entries).toContain("30-superpowers-free-command-escalate.md");

    const permission = await fs.readFile(
      path.join(dir, "00-superpowers-free-permission.md"),
      "utf8",
    );
    expect(permission).toContain("# Permission contract — Superpowers Free");
    // superpowers-free grants runCommands → MAY line, with approval pause
    expect(permission).toContain("Run shell commands — always surface what will run");
    // superpowers-free grants usePublicCloudModel → MAY line, review-only stance
    expect(permission).toContain("Use a public-cloud model — only in review-only mode");
    // superpowers-free does NOT grant registerMcp → MUST NOT
    expect(permission).toContain("Register MCP servers.");
    // superpowers-free does NOT grant accessSecrets → MUST NOT
    expect(permission).toContain("Access secrets");

    const readme = await fs.readFile(path.join(dir, "TIERKIT.md"), "utf8");
    expect(readme).toContain("Tierkit → Cline export");
    expect(readme).toContain("superpowers-free");
  });
});
