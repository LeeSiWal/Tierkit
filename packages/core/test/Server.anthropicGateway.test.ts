import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startServer, type RunningServer } from "../src/runtime/Server.js";

describe("/v1/messages — Anthropic passthrough (integration)", () => {
  let cwd: string;
  let running: RunningServer;
  let url: string;
  let upstream: http.Server;
  let upstreamUrl: string;
  let lastUpstream: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string };

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-anth-"));
    upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        lastUpstream = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        res.setHeader("content-type", "application/json");
        res.statusCode = 200;
        if (req.url === "/v1/messages/count_tokens") {
          res.end(JSON.stringify({ input_tokens: 12 }));
          return;
        }
        res.end(JSON.stringify({ id: "msg_int", content: [{ type: "text", text: "ok" }] }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    process.env.TIERKIT_ANTHROPIC_UPSTREAM = upstreamUrl;
    running = await startServer({ port: 0, host: "127.0.0.1", cwd });
    url = `http://${running.address}:${running.port}`;
  });

  afterEach(async () => {
    delete process.env.TIERKIT_ANTHROPIC_UPSTREAM;
    await running.close();
    await new Promise<void>((resolve, reject) => upstream.close((e) => (e ? reject(e) : resolve())));
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("non-streaming: forwards body + headers to upstream and returns the response", async () => {
    const r = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-int-test",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
      body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 4, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.id).toBe("msg_int");
    expect(lastUpstream.url).toBe("/v1/messages");
    expect(lastUpstream.headers["x-api-key"]).toBe("sk-int-test");
    expect(lastUpstream.headers["anthropic-version"]).toBe("2023-06-01");
    expect(lastUpstream.headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    // Host header MUST NOT echo Tierkit's address — that would 400 on real api.anthropic.com.
    expect(lastUpstream.headers["host"]).not.toContain("4101");
  });

  it("count_tokens: forwards to /v1/messages/count_tokens on upstream", async () => {
    const r = await fetch(`${url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-x", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    expect(lastUpstream.url).toBe("/v1/messages/count_tokens");
    expect(lastUpstream.method).toBe("POST");
    const json = await r.json();
    expect(json.input_tokens).toBe(12);
  });

  it("body containing the string \"stream\":true does NOT trigger streaming mode", async () => {
    // Critical correctness check: a user message that literally contains the
    // text `"stream": true` must not flip the route into streaming. The route
    // parses JSON top-level, so only the actual top-level "stream" field
    // matters.
    const r = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-x", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "m",
        max_tokens: 4,
        messages: [{ role: "user", content: "consider this JSON: {\"stream\": true}" }],
      }),
    });
    expect(r.status).toBe(200);
    // If the route had wrongly flipped to streaming, response would be
    // text/event-stream and JSON parse would fail. The non-streaming JSON
    // shape proves we took the right branch.
    const json = await r.json();
    expect(json.id).toBe("msg_int");
  });
});
