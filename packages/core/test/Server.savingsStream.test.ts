import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";
import { logMcpActivity, setActivityListener } from "../src/mcp/activityLog.js";

async function writeMinimalConfig(cwd: string): Promise<void> {
  const cfg = {
    version: "0.1",
    modelProfiles: {
      claudeSonnet: { kind: "private-remote", provider: "anthropic", model: "x", apiKeyEnv: "K", cost: { type: "per-token", inputUsdPerMillion: 3, outputUsdPerMillion: 15 }, roles: ["code"] },
    },
    routingBaseline: "claudeSonnet",
  };
  await fs.writeFile(path.join(cwd, "tierkit.config.json"), JSON.stringify(cfg));
}

describe("/v1/tierkit/savings/stream", () => {
  let cwd: string;
  let running: RunningServer;
  let url: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-sse-"));
    await fs.mkdir(path.join(cwd, ".tierkit", "runtime"), { recursive: true });
    await writeMinimalConfig(cwd);
    // TIERKIT_NO_BUNDLED_DEFAULTS=1 mirrors what other tests in this suite do
    // to avoid racing first-boot migrations.
    process.env.TIERKIT_NO_BUNDLED_DEFAULTS = "1";
    running = await startServer({ port: 0, host: "127.0.0.1", cwd, homeDir: cwd });
    url = `http://${running.address}:${running.port}`;
  });

  afterEach(async () => {
    setActivityListener(null);
    await running.close();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("emits an initial snapshot on connect and a new snapshot after logMcpActivity", async () => {
    const ac = new AbortController();
    const res = await fetch(`${url}/v1/tierkit/savings/stream`, { signal: ac.signal });
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    async function readOneEvent(): Promise<any> {
      while (true) {
        const idx = buf.indexOf("\n\n");
        if (idx >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (block.startsWith("data:")) return JSON.parse(block.slice(5).trim());
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream closed before event");
        buf += decoder.decode(value, { stream: true });
      }
    }

    const first = await readOneEvent();
    expect(first.type).toBe("savings-snapshot");
    expect(first.summary.baselineProfileId).toBe("claudeSonnet");

    // Trigger an MCP activity record — must produce a second event.
    await logMcpActivity(cwd, {
      tool: "tierkit.get_file_digest",
      ok: true, code: null, durationMs: 5, redactionHits: 0,
      inputSummary: { path: "f.ts" },
      outputSummary: { beforeTokens: 1000, afterTokens: 100, savedTokens: 900 },
    });

    const second = await Promise.race([
      readOneEvent(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout waiting for second event")), 3000)),
    ]);
    expect(second.type).toBe("savings-snapshot");

    ac.abort();
    try { await reader.cancel(); } catch { /* stream may already be closed */ }
  });
});
