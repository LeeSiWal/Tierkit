import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";

describe("POST /v1/route/explain", () => {
  let root: string;
  let server: RunningServer | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function start(config: object): Promise<number> {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-rexp-"));
    await fs.mkdir(path.join(root, ".tierkit"), { recursive: true });
    await fs.writeFile(path.join(root, ".tierkit", "plugins.json"),
      JSON.stringify({ version: "0.1", plugins: [] }));
    await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify(config));
    server = await startServer({ cwd: root, host: "127.0.0.1", port: 0, env: {} });
    return server.port;
  }

  it("returns taskType, score, reasons, tier, ceiling, candidates[]", async () => {
    const port = await start({
      version: "0.1",
      migrations: { defaultDisabledSeededProfileIds: ["claudeCode"] },
      modelProfiles: {
        localCoder: {
          kind: "local-device", provider: "ollama", model: "qwen2.5-coder:7b",
          baseUrl: "http://127.0.0.1:11434", notGoodAt: ["code-review"], roles: ["code"],
        },
      },
    });
    const r = await fetch(`http://127.0.0.1:${port}/v1/route/explain`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "리뷰해줘" }),
    });
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.taskType).toBe("code-review");
    expect(json.score).toBeGreaterThanOrEqual(30);  // 10 base + 20 taskType
    expect(json.tier).toBeDefined();
    expect(Array.isArray(json.candidates)).toBe(true);
  });

  it("400 on missing task", async () => {
    const port = await start({ version: "0.1", modelProfiles: {} });
    const r = await fetch(`http://127.0.0.1:${port}/v1/route/explain`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  it("400 on empty task string", async () => {
    const port = await start({ version: "0.1", modelProfiles: {} });
    const r = await fetch(`http://127.0.0.1:${port}/v1/route/explain`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "" }),
    });
    expect(r.status).toBe(400);
  });
});
