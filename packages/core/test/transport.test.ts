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
});
