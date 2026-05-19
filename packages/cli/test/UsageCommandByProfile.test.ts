import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { buildCli } from "../src/cli.js";
import type { CliContext } from "../src/context/CliContext.js";

// The CLI `usage` command reads usage.jsonl + tierkit.config.json from disk
// (no HTTP daemon). We seed both, then invoke the CLI directly.

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

async function writeConfig(root: string, modelProfiles: Record<string, unknown>, perProfile?: Record<string, unknown>): Promise<void> {
  const cfg: Record<string, unknown> = {
    version: "0.1",
    activePlugins: [],
    defaultTarget: "generic",
    modelProfiles,
    disabledProfileIds: [],
  };
  if (perProfile) {
    cfg.budget = { perProfile, warnAtPercent: 70, blockAtPercent: 100 };
  }
  await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify(cfg, null, 2), "utf8");
}

async function writeUsageRecords(root: string, records: Array<Record<string, unknown>>): Promise<void> {
  const dir = path.join(root, ".tierkit/runtime");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "usage.jsonl");
  const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await fs.writeFile(file, text, "utf8");
}

describe("tierkit usage --by-profile", () => {
  let root: string;
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("prints per-profile breakdown when --by-profile is passed", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-usage-byprofile-"));
    await writeConfig(
      root,
      {
        claudeSonnet: {
          kind: "public-cloud",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          requiresApproval: true,
          cost: { type: "per-token", inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
        },
        localCoder: {
          kind: "local-device",
          provider: "ollama",
          model: "qwen2.5-coder:7b",
        },
      },
    );
    // Use today's UTC date so records land in the current month bucket.
    const now = new Date();
    const ts = now.toISOString();
    await writeUsageRecords(root, [
      {
        timestamp: ts,
        profileId: "claudeSonnet",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        tier: "public-cloud",
        inputTokens: 1200,
        outputTokens: 300,
        costUsd: 0.12,
        latencyMs: 100,
        ok: true,
      },
      {
        timestamp: ts,
        profileId: "localCoder",
        provider: "ollama",
        model: "qwen2.5-coder:7b",
        tier: "local-device",
        inputTokens: 386700,
        outputTokens: 5200,
        costUsd: 0,
        latencyMs: 100,
        ok: true,
      },
    ]);

    const cli = buildCli();
    const ctx = makeContext(root);
    const code = await cli.run(["usage", "--by-profile"], ctx.context);
    const out = ctx.stdout.text();
    expect(code).toBe(0);
    expect(out).toContain("claudeSonnet");
    expect(out).toContain("per-token");
    expect(out).toContain("localCoder");
    expect(out).toContain("free");
    // Header present
    expect(out).toMatch(/Per-profile/);
    // Status column rendered (no per-profile budget set, so "—")
    expect(out).toMatch(/Status|—/);
  });

  it("without --by-profile, output matches v0.11.x shape (no per-profile section)", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-usage-noflag-"));
    await writeConfig(root, {});
    const cli = buildCli();
    const ctx = makeContext(root);
    const code = await cli.run(["usage"], ctx.context);
    expect(code).toBe(0);
    expect(ctx.stdout.text()).not.toContain("Per-profile");
  });
});
