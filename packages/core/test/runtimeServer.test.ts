import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startServer, type RunningServer } from "../src/runtime/Server.js";

interface MockOllama {
  url: string;
  close(): Promise<void>;
}

function startMockOllama(handler: (body: unknown) => unknown): Promise<MockOllama> {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      const response = handler(body);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(response));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r, j) => server.close((err) => (err ? j(err) : r()))),
      });
    });
  });
}

async function makeProject(config: object): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-runtime-server-"));
  await fs.mkdir(path.join(root, ".tierkit"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".tierkit", "plugins.json"),
    JSON.stringify({ version: "0.1", plugins: [] }),
  );
  await fs.writeFile(path.join(root, "tierkit.config.json"), JSON.stringify(config));
  return root;
}

describe("runtime Server", () => {
  let root: string;
  let server: RunningServer | undefined;
  let mockOllama: MockOllama | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
    if (mockOllama) await mockOllama.close();
    mockOllama = undefined;
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function boot(config: object): Promise<RunningServer> {
    root = await makeProject(config);
    return startServer({ cwd: root, host: "127.0.0.1", port: 0 });
  }

  it("GET /v1/health returns ok+version", async () => {
    server = await boot({
      version: "0.1",
      modelProfiles: { localFast: { kind: "local-device", provider: "ollama", model: "x" } },
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/health`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
  });

  it("POST /v1/route returns a routing decision", async () => {
    server = await boot({
      version: "0.1",
      modelProfiles: { localFast: { kind: "local-device", provider: "ollama", model: "x" } },
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "rename a helper" }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.decision.tier).toBe("local-device");
  });

  it("POST /v1/check/command classifies command", async () => {
    server = await boot({ version: "0.1", modelProfiles: {} });
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/check/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "rm -rf /" }),
    });
    const body = await res.json();
    expect(body.severity).toBe("block");
  });

  it("POST /v1/redact applies redaction rules", async () => {
    server = await boot({ version: "0.1", modelProfiles: {} });
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/redact`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "key=sk-abcdefghijklmnopqrstuvw0" }),
    });
    const body = await res.json();
    expect(body.text).toContain("[REDACTED:openai-api-key]");
    expect(body.hits.length).toBeGreaterThan(0);
  });

  it("POST /v1/llm-call routes through a real mock ollama and logs usage", async () => {
    mockOllama = await startMockOllama(() => ({
      message: { content: "Hello from mock ollama" },
      prompt_eval_count: 10,
      eval_count: 5,
    }));
    server = await boot({
      version: "0.1",
      modelProfiles: {
        localFast: {
          kind: "local-device",
          provider: "ollama",
          baseUrl: mockOllama.url,
          model: "qwen2.5-coder:7b",
        },
      },
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/v1/llm-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profileId: "localFast",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.text).toBe("Hello from mock ollama");
    expect(body.inputTokens).toBe(10);
    expect(body.outputTokens).toBe(5);

    // Verify usage log was written
    const logPath = path.join(root, ".tierkit/runtime/usage.jsonl");
    const logged = await fs.readFile(logPath, "utf8");
    expect(logged).toContain("localFast");
  });

  it("POST /v1/llm-call rejects an unknown profile", async () => {
    server = await boot({ version: "0.1", modelProfiles: {} });
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/llm-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profileId: "ghost", messages: [{ role: "user", content: "x" }] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("unknown-profile");
  });

  it("POST /v1/llm-call blocks when toolCommands contain a `block`-severity command", async () => {
    server = await boot({
      version: "0.1",
      modelProfiles: {
        localFast: { kind: "local-device", provider: "ollama", model: "x" },
      },
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/llm-call`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        profileId: "localFast",
        messages: [{ role: "user", content: "x" }],
        toolCommands: ["rm -rf /"],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("dangerous-command-blocked");
  });

  it("returns 404 for unknown routes", async () => {
    server = await boot({ version: "0.1", modelProfiles: {} });
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/nothing`);
    expect(res.status).toBe(404);
  });
});
