import { describe, it, expect } from "vitest";
import http from "node:http";
import { AddressInfo } from "node:net";
import { pickForwardHeaders, forwardMessages, streamMessages, forwardCountTokens } from "../src/runtime/anthropicGateway.js";

async function startFakeUpstream(
  handler: (req: http.IncomingMessage, body: Buffer) => { status: number; body: object; headers?: Record<string, string> },
): Promise<{ url: string; close: () => Promise<void>; received: () => { headers: http.IncomingHttpHeaders; body: string; url?: string; method?: string } }> {
  let receivedHeaders: http.IncomingHttpHeaders = {};
  let receivedBody = "";
  let receivedUrl: string | undefined;
  let receivedMethod: string | undefined;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      receivedHeaders = req.headers;
      receivedBody = body.toString("utf8");
      receivedUrl = req.url;
      receivedMethod = req.method;
      const r = handler(req, body);
      const headers = { "content-type": "application/json", ...(r.headers ?? {}) };
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
      res.statusCode = r.status;
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    received: () => ({ headers: receivedHeaders, body: receivedBody, url: receivedUrl, method: receivedMethod }),
  };
}

describe("pickForwardHeaders", () => {
  it("forwards Anthropic-required headers and drops hop-by-hop ones", () => {
    const out = pickForwardHeaders({
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31",
      "x-api-key": "sk-test",
      "x-claude-code-session-id": "sess-1",
      "x-claude-code-agent-id": "agent-9",
      "host": "127.0.0.1:4101",
      "content-length": "42",
      "connection": "keep-alive",
      "transfer-encoding": "chunked",
    });
    expect(out["anthropic-version"]).toBe("2023-06-01");
    expect(out["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    expect(out["x-api-key"]).toBe("sk-test");
    expect(out["x-claude-code-session-id"]).toBe("sess-1");
    expect(out["x-claude-code-agent-id"]).toBe("agent-9");
    expect(out["host"]).toBeUndefined();
    expect(out["content-length"]).toBeUndefined();
    expect(out["connection"]).toBeUndefined();
    expect(out["transfer-encoding"]).toBeUndefined();
  });

  it("forwards Authorization Bearer when x-api-key absent", () => {
    const out = pickForwardHeaders({
      "authorization": "Bearer some-oauth-token",
      "anthropic-version": "2023-06-01",
    });
    expect(out["authorization"]).toBe("Bearer some-oauth-token");
  });

  it("collapses array-valued headers to a comma-separated string", () => {
    const out = pickForwardHeaders({
      "anthropic-beta": ["prompt-caching-2024-07-31", "tools-2024-04-04"],
    });
    expect(out["anthropic-beta"]).toBe("prompt-caching-2024-07-31,tools-2024-04-04");
  });
});

describe("forwardMessages (non-streaming)", () => {
  it("forwards POST body verbatim and returns upstream status+body+headers", async () => {
    const upstream = await startFakeUpstream(() => ({
      status: 200,
      body: { id: "msg_test", content: [{ type: "text", text: "ok" }] },
    }));
    try {
      const req = { headers: { "x-api-key": "sk-x", "anthropic-version": "2023-06-01", "content-type": "application/json" } } as unknown as http.IncomingMessage;
      const body = Buffer.from(JSON.stringify({ model: "m", max_tokens: 4, messages: [{ role: "user", content: "hi" }] }));
      const r = await forwardMessages(req, body, { upstreamBaseUrl: upstream.url });
      expect(r.status).toBe(200);
      const parsed = JSON.parse(r.body.toString("utf8"));
      expect(parsed.id).toBe("msg_test");
      const rec = upstream.received();
      expect(rec.headers["x-api-key"]).toBe("sk-x");
      expect(rec.headers["anthropic-version"]).toBe("2023-06-01");
      expect(JSON.parse(rec.body).model).toBe("m");
    } finally {
      await upstream.close();
    }
  });

  it("propagates non-2xx status codes (e.g. 401 from upstream)", async () => {
    const upstream = await startFakeUpstream(() => ({
      status: 401,
      body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
    }));
    try {
      const req = { headers: { "x-api-key": "sk-bad", "anthropic-version": "2023-06-01" } } as unknown as http.IncomingMessage;
      const body = Buffer.from("{}");
      const r = await forwardMessages(req, body, { upstreamBaseUrl: upstream.url });
      expect(r.status).toBe(401);
      const parsed = JSON.parse(r.body.toString("utf8"));
      expect(parsed.error.type).toBe("authentication_error");
    } finally {
      await upstream.close();
    }
  });
});

async function startStreamingUpstream(
  events: string[],
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      res.setHeader("content-type", "text/event-stream");
      res.statusCode = 200;
      for (const ev of events) {
        res.write(ev);
        await new Promise((r) => setImmediate(r));
      }
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

describe("streamMessages (SSE passthrough)", () => {
  it("pipes upstream SSE events in order and without modification", async () => {
    const events = [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"m1"}}\n\n`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n`,
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
    ];
    const upstream = await startStreamingUpstream(events);
    try {
      const written: Buffer[] = [];
      const { EventEmitter } = await import("node:events");
      const res = Object.assign(new EventEmitter(), {
        setHeader: () => {},
        write: (chunk: Buffer | string) => {
          written.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          return true;
        },
        end: () => {},
        statusCode: 0,
        headersSent: false,
        off: function (this: any, ev: string, fn: any) { return this.removeListener(ev, fn); },
      }) as unknown as http.ServerResponse;
      const req = Object.assign(new EventEmitter(), {
        headers: { "x-api-key": "sk-x", "anthropic-version": "2023-06-01" },
        off: function (this: any, ev: string, fn: any) { return this.removeListener(ev, fn); },
      }) as unknown as http.IncomingMessage;
      const body = Buffer.from(JSON.stringify({ model: "m", max_tokens: 4, messages: [{ role: "user", content: "hi" }], stream: true }));
      await streamMessages(req, body, res, { upstreamBaseUrl: upstream.url });
      const piped = Buffer.concat(written).toString("utf8");
      expect(piped).toBe(events.join(""));
    } finally {
      await upstream.close();
    }
  });
});

describe("forwardCountTokens", () => {
  it("forwards to /v1/messages/count_tokens and returns the upstream JSON", async () => {
    const upstream = await startFakeUpstream((req) => {
      expect(req.url).toBe("/v1/messages/count_tokens");
      return { status: 200, body: { input_tokens: 12 } };
    });
    try {
      const req = { headers: { "x-api-key": "sk-x", "anthropic-version": "2023-06-01" } } as unknown as http.IncomingMessage;
      const body = Buffer.from(JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }));
      const r = await forwardCountTokens(req, body, { upstreamBaseUrl: upstream.url });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body.toString("utf8")).input_tokens).toBe(12);
    } finally {
      await upstream.close();
    }
  });
});
