// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { TRANSPORT_INLINE_JS } from "../src/runtime/ui/transport.js";

interface TransportFactories {
  createHttpTransport: (base: string) => {
    request: (path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }) =>
      Promise<{ ok: boolean; status: number; data: unknown }>;
    stream: (path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }) =>
      AsyncIterable<{ data: string }>;
  };
  createVsCodeTransport: () => {
    request: (path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }) =>
      Promise<{ ok: boolean; status: number; data: unknown }>;
    stream: (path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }) =>
      AsyncIterable<{ data: string }>;
  };
}

function loadFactories(): TransportFactories {
  const fn = new Function(
    TRANSPORT_INLINE_JS + "; return { createHttpTransport, createVsCodeTransport };",
  );
  return fn() as TransportFactories;
}

describe("createHttpTransport.request", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("GETs the base+path and returns {ok,status,data}", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ hello: "world" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { createHttpTransport } = loadFactories();
    const transport = createHttpTransport("http://127.0.0.1:4101");
    const res = await transport.request("/v1/health");

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:4101/v1/health", expect.objectContaining({
      method: "GET",
    }));
    expect(res).toEqual({ ok: true, status: 200, data: { hello: "world" } });
  });

  it("POSTs JSON body with content-type header", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { createHttpTransport } = loadFactories();
    const transport = createHttpTransport("http://127.0.0.1:4101");
    await transport.request("/v1/agent/run", { method: "POST", body: { task: "hi" } });

    const callInit = fetchMock.mock.calls[0][1];
    expect(callInit.method).toBe("POST");
    expect(callInit.headers["content-type"]).toBe("application/json");
    expect(callInit.body).toBe(JSON.stringify({ task: "hi" }));
  });

  it("returns ok=false for HTTP 4xx without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "bad" }), { status: 400, headers: { "content-type": "application/json" } }),
    ));
    const { createHttpTransport } = loadFactories();
    const res = await createHttpTransport("").request("/x", { method: "POST", body: {} });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.data).toEqual({ error: "bad" });
  });

  it("propagates AbortSignal to fetch", async () => {
    const ctrl = new AbortController();
    const fetchMock = vi.fn(async (_url: string, init: { signal?: AbortSignal }) => {
      // Simulate fetch respecting signal by waiting and rejecting on abort.
      return await new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { createHttpTransport } = loadFactories();
    const p = createHttpTransport("").request("/slow", { signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toThrow(/abort/i);
  });
});

describe("createHttpTransport.stream", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("yields each SSE data: payload as a chunk", async () => {
    const sseBody =
      "data: {\"type\":\"task_start\"}\n\n" +
      "data: {\"type\":\"delta\",\"text\":\"hi\"}\n\n" +
      "data: [DONE]\n\n";
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Push in two chunks to exercise the buffering path.
        controller.enqueue(encoder.encode(sseBody.slice(0, 30)));
        controller.enqueue(encoder.encode(sseBody.slice(30)));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ));

    const { createHttpTransport } = loadFactories();
    const collected: string[] = [];
    for await (const ev of createHttpTransport("").stream("/v1/agent/run", { method: "POST", body: {} })) {
      collected.push(ev.data);
      if (ev.data === "[DONE]") break;
    }
    expect(collected).toEqual([
      '{"type":"task_start"}',
      '{"type":"delta","text":"hi"}',
      "[DONE]",
    ]);
  });

  it("throws on non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const { createHttpTransport } = loadFactories();
    const iter = createHttpTransport("").stream("/x", { method: "POST", body: {} });
    await expect((async () => { for await (const _ of iter) {} })()).rejects.toThrow(/500/);
  });
});
