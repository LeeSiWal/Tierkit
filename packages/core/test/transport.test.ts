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

describe("createVsCodeTransport.request", () => {
  let posted: unknown[];
  let messageListeners: Array<(e: MessageEvent) => void>;

  function reply(id: number, payload: object) {
    const ev = new MessageEvent("message", { data: { ...payload, id } });
    for (const l of messageListeners) l(ev);
  }

  beforeEach(() => {
    posted = [];
    messageListeners = [];
    vi.stubGlobal("acquireVsCodeApi", () => ({ postMessage: (m: unknown) => posted.push(m) }));
    const origAdd = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation((type, listener, opts) => {
      if (type === "message") messageListeners.push(listener as (e: MessageEvent) => void);
      else origAdd(type, listener as EventListener, opts);
    });
  });

  it("posts tk:req and resolves on matching tk:res", async () => {
    const { createVsCodeTransport } = loadFactories();
    const transport = createVsCodeTransport();
    const p = transport.request("/v1/health", { method: "GET" });

    // Give microtask a tick so the post happens.
    await Promise.resolve();

    expect(posted.length).toBe(1);
    const msg = posted[0] as { type: string; id: number; method: string; path: string };
    expect(msg.type).toBe("tk:req");
    expect(msg.method).toBe("GET");
    expect(msg.path).toBe("/v1/health");
    expect(typeof msg.id).toBe("number");

    reply(msg.id, { type: "tk:res", ok: true, status: 200, data: { ok: true } });
    await expect(p).resolves.toEqual({ ok: true, status: 200, data: { ok: true } });
  });

  it("rejects on tk:err", async () => {
    const { createVsCodeTransport } = loadFactories();
    const p = createVsCodeTransport().request("/x");
    await Promise.resolve();
    const msg = posted[0] as { id: number };
    reply(msg.id, { type: "tk:err", message: "daemon down" });
    await expect(p).rejects.toThrow(/daemon down/);
  });

  it("does not cross-resolve different ids", async () => {
    const { createVsCodeTransport } = loadFactories();
    const transport = createVsCodeTransport();
    const p1 = transport.request("/a");
    const p2 = transport.request("/b");
    await Promise.resolve();
    const m1 = posted[0] as { id: number };
    const m2 = posted[1] as { id: number };
    expect(m1.id).not.toBe(m2.id);
    reply(m2.id, { type: "tk:res", ok: true, status: 200, data: { which: "b" } });
    await expect(p2).resolves.toMatchObject({ data: { which: "b" } });
    // p1 still pending — resolve it to clean up
    reply(m1.id, { type: "tk:res", ok: true, status: 200, data: { which: "a" } });
    await expect(p1).resolves.toMatchObject({ data: { which: "a" } });
  });
});
