import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server as HttpServer, type IncomingMessage } from "node:http";
import { startServer } from "../src/runtime/Server.js";
import { gatewayLogPath } from "../src/runtime/gatewayLog.js";
import { resolveRuntimeDataDir } from "../src/runtime/runtimePaths.js";

let upstream: HttpServer;
let upstreamUrl: string;
let upstreamRequests: Array<{ method: string; path: string }>;

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) raw += chunk.toString();
  return raw;
}

beforeAll(async () => {
  upstreamRequests = [];
  upstream = createServer(async (req, res) => {
    upstreamRequests.push({ method: req.method ?? "?", path: req.url ?? "?" });
    const raw = await readBody(req);
    let body: { stream?: boolean } = {};
    try { body = JSON.parse(raw); } catch { /* leave empty */ }

    if (req.url === "/v1/messages" && body.stream === true) {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true,"mock":true}');
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const addr = upstream.address();
  if (!addr || typeof addr !== "object") throw new Error("no mock addr");
  upstreamUrl = `http://127.0.0.1:${addr.port}`;
  process.env.TIERKIT_ANTHROPIC_UPSTREAM = upstreamUrl;
});

afterAll(async () => {
  delete process.env.TIERKIT_ANTHROPIC_UPSTREAM;
  await new Promise<void>((resolve, reject) => upstream.close((e) => (e ? reject(e) : resolve())));
});

async function startWith(gatewayMode: "off" | "on") {
  const dir = await mkdtemp(path.join(tmpdir(), "tk-gw-mode-"));
  await writeFile(path.join(dir, "tierkit.config.json"), JSON.stringify({ version: "0.1", runtime: { gatewayMode } }));
  const srv = await startServer({ port: 0, cwd: dir });
  return { srv, dir, url: `http://127.0.0.1:${srv.port}` };
}

function logPathFor(dir: string): string {
  return gatewayLogPath(resolveRuntimeDataDir(".tierkit/runtime", dir));
}

describe("Server — gatewayMode gate", () => {
  it("returns 404 for /v1/messages when off", async () => {
    const { srv, dir, url } = await startWith("off");
    try {
      const r = await fetch(`${url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }) });
      expect(r.status).toBe(404);
    } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("returns 404 for /v1/messages/count_tokens when off", async () => {
    const { srv, dir, url } = await startWith("off");
    try {
      const r = await fetch(`${url}/v1/messages/count_tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }) });
      expect(r.status).toBe(404);
    } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("forwards /v1/messages to MOCK upstream when on", async () => {
    const before = upstreamRequests.length;
    const { srv, dir, url } = await startWith("on");
    try {
      const r = await fetch(`${url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }) });
      expect(r.status).toBe(200);
      expect(upstreamRequests.length).toBe(before + 1);
      expect(upstreamRequests.at(-1)!.path).toBe("/v1/messages");
    } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("forwards /v1/messages/count_tokens to MOCK upstream when on", async () => {
    const before = upstreamRequests.length;
    const { srv, dir, url } = await startWith("on");
    try {
      const r = await fetch(`${url}/v1/messages/count_tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }) });
      expect(r.status).toBe(200);
      expect(upstreamRequests.length).toBe(before + 1);
      expect(upstreamRequests.at(-1)!.path).toBe("/v1/messages/count_tokens");
    } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
  });
});

describe("Server — safe log (deterministic, every route)", () => {
  it("non-stream /v1/messages: log present IMMEDIATELY when fetch resolves", async () => {
    const { srv, dir, url } = await startWith("on");
    try {
      await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "sk-test-NEVER-PERSISTED" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }),
      });
      const raw = await readFile(logPathFor(dir), "utf8");
      expect(raw.trim().split("\n")).toHaveLength(1);
      expect(raw).not.toContain("sk-test-NEVER-PERSISTED");
      const parsed = JSON.parse(raw.trim());
      expect(parsed.path).toBe("/v1/messages");
      expect(parsed.stream).toBe(false);
      expect(parsed.status).toBe(200);
      expect(parsed.auth.apiKeyPresent).toBe(true);
      expect(parsed.auth.apiKeyFingerprint).toMatch(/^[0-9a-f]{12}$/);
    } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("/v1/messages/count_tokens: writes path + stream:false to safe log", async () => {
    const { srv, dir, url } = await startWith("on");
    try {
      await fetch(`${url}/v1/messages/count_tokens`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", messages: [] }) });
      const parsed = JSON.parse((await readFile(logPathFor(dir), "utf8")).trim());
      expect(parsed.path).toBe("/v1/messages/count_tokens");
      expect(parsed.stream).toBe(false);
    } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("streaming /v1/messages: writes stream:true AFTER the stream completes (mock decides on body)", async () => {
    const { srv, dir, url } = await startWith("on");
    try {
      const res = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, stream: true, messages: [] }),
      });
      await res.text(); // drain
      const parsed = JSON.parse((await readFile(logPathFor(dir), "utf8")).trim());
      expect(parsed.path).toBe("/v1/messages");
      expect(parsed.stream).toBe(true);
    } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("pre-headers transport error → HTTP 502 AND log records status: 502", async () => {
    process.env.TIERKIT_ANTHROPIC_UPSTREAM = "http://127.0.0.1:1";
    const { srv, dir, url } = await startWith("on");
    try {
      const r = await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }),
      });
      expect(r.status).toBe(502);
      const parsed = JSON.parse((await readFile(logPathFor(dir), "utf8")).trim());
      expect(parsed.status).toBe(502);
    } finally {
      process.env.TIERKIT_ANTHROPIC_UPSTREAM = upstreamUrl;
      await srv.close(); await rm(dir, { recursive: true, force: true });
    }
  });

  it("non-Bearer Authorization scheme is recorded as 'Other'", async () => {
    const { srv, dir, url } = await startWith("on");
    try {
      await fetch(`${url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": "Basic abc123" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1, messages: [] }),
      });
      const parsed = JSON.parse((await readFile(logPathFor(dir), "utf8")).trim());
      expect(parsed.auth.authorizationScheme).toBe("Other");
    } finally { await srv.close(); await rm(dir, { recursive: true, force: true }); }
  });

  // Post-headers stream abort coverage is in Task 10 Test 11 (manual). The automated
  // version requires a mid-stream upstream socket close, which is timing-sensitive
  // in vitest. The implementation in Server.ts catch block logs res.statusCode
  // (not 502) when res.headersSent is true.
});
