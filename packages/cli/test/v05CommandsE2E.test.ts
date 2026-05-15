import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
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

async function makeProjectWithConfig(config: object): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-v05-e2e-"));
  await fs.mkdir(path.join(root, ".tierkit"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".tierkit", "plugins.json"),
    JSON.stringify({ version: "0.1", plugins: [] }),
  );
  await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify(config));
  return root;
}

describe("CLI e2e: v0.5 commands", () => {
  let root: string;
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(async () => {
    vi.unstubAllGlobals();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it("`models list` prints configured profiles", async () => {
    root = await makeProjectWithConfig({
      version: "0.1",
      modelProfiles: {
        localFast: { kind: "local-device", provider: "ollama", model: "qwen2.5-coder:7b" },
        cloud: {
          kind: "public-cloud",
          provider: "anthropic",
          model: "claude-sonnet",
          apiKeyEnv: "AK",
          requiresApproval: true,
          defaultMode: "review-only",
        },
      },
    });
    const cli = buildCli();
    const ctx = makeContext(root);
    expect(await cli.run(["models", "list"], ctx.context)).toBe(0);
    const out = ctx.stdout.text();
    expect(out).toContain("localFast");
    expect(out).toContain("ollama");
    expect(out).toContain("anthropic");
    expect(out).toContain("APPROVAL");
  });

  it("`models test <profileId>` succeeds against mocked ollama", async () => {
    root = await makeProjectWithConfig({
      version: "0.1",
      modelProfiles: {
        localFast: {
          kind: "local-device",
          provider: "ollama",
          baseUrl: "http://localhost:11434",
          model: "qwen2.5-coder:7b",
        },
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:7b" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const cli = buildCli();
    const ctx = makeContext(root);
    expect(await cli.run(["models", "test", "localFast"], ctx.context)).toBe(0);
    const out = ctx.stdout.text();
    expect(out).toContain("status     OK");
    expect(out).toContain("qwen2.5-coder:7b");
  });

  it("`models test` exits 1 with a clear error for unknown profile", async () => {
    root = await makeProjectWithConfig({
      version: "0.1",
      modelProfiles: {
        localFast: { kind: "local-device", provider: "ollama", model: "x" },
      },
    });
    const cli = buildCli();
    const ctx = makeContext(root);
    expect(await cli.run(["models", "test", "ghost"], ctx.context)).toBe(1);
    expect(ctx.stderr.text()).toContain("unknown-profile");
  });

  it("`route explain` reports a low-risk task as local-device", async () => {
    root = await makeProjectWithConfig({
      version: "0.1",
      modelProfiles: {
        localFast: { kind: "local-device", provider: "ollama", model: "x" },
      },
    });
    const cli = buildCli();
    const ctx = makeContext(root);
    expect(await cli.run(["route", "explain", "rename a helper function"], ctx.context)).toBe(0);
    const out = ctx.stdout.text();
    expect(out).toContain("Chosen tier:   local-device");
    expect(out).toContain("Chosen profile: localFast");
  });

  it("`route explain --secrets --prod` escalates to public-cloud with approval", async () => {
    root = await makeProjectWithConfig({
      version: "0.1",
      modelProfiles: {
        localFast: { kind: "local-device", provider: "ollama", model: "x" },
        cloud: {
          kind: "public-cloud",
          provider: "anthropic",
          model: "claude-sonnet",
          apiKeyEnv: "AK",
          requiresApproval: true,
          defaultMode: "review-only",
        },
      },
    });
    const cli = buildCli();
    const ctx = makeContext(root);
    expect(
      await cli.run(
        ["route", "explain", "audit production auth secrets", "--secrets", "--prod", "--files", "12"],
        ctx.context,
      ),
    ).toBe(0);
    const out = ctx.stdout.text();
    expect(out).toContain("Chosen tier:   public-cloud");
    expect(out).toContain("Approval:      REQUIRED");
    expect(out).toContain("review-only");
  });

  it("`config show` masks API key env values by default", async () => {
    root = await makeProjectWithConfig({
      version: "0.1",
      modelProfiles: {
        priv: {
          kind: "private-remote",
          provider: "openai-compatible",
          baseUrl: "https://example.com/v1",
          model: "x",
          apiKeyEnv: "TIERKIT_V05_E2E_KEY",
        },
      },
    });
    process.env.TIERKIT_V05_E2E_KEY = "supersecret";
    try {
      const cli = buildCli();
      const ctx = makeContext(root);
      expect(await cli.run(["config", "show"], ctx.context)).toBe(0);
      const out = ctx.stdout.text();
      expect(out).toContain("TIERKIT_V05_E2E_KEY = ***");
      expect(out).not.toContain("supersecret");
    } finally {
      delete process.env.TIERKIT_V05_E2E_KEY;
    }
  });

  it("`config show --reveal-env` reveals the value", async () => {
    root = await makeProjectWithConfig({
      version: "0.1",
      modelProfiles: {
        priv: {
          kind: "private-remote",
          provider: "openai-compatible",
          baseUrl: "https://example.com/v1",
          model: "x",
          apiKeyEnv: "TIERKIT_V05_E2E_KEY",
        },
      },
    });
    process.env.TIERKIT_V05_E2E_KEY = "supersecret";
    try {
      const cli = buildCli();
      const ctx = makeContext(root);
      expect(await cli.run(["config", "show", "--reveal-env"], ctx.context)).toBe(0);
      expect(ctx.stdout.text()).toContain('supersecret');
    } finally {
      delete process.env.TIERKIT_V05_E2E_KEY;
    }
  });
});
