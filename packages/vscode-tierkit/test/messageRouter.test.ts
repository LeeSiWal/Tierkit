import { describe, it, expect, vi } from "vitest";
import { createMessageRouter } from "../src/messageRouter.js";

describe("messageRouter.handle tk:req", () => {
  it("calls injected fetchProxy with built URL+init, posts tk:res with response", async () => {
    const fetchProxy = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:4101/v1/health");
      expect(init.method).toBe("GET");
      return { ok: true, status: 200, data: { ok: true, version: "test" } };
    });
    const posted: unknown[] = [];
    const router = createMessageRouter({ getBaseUrl: () => "http://127.0.0.1:4101", fetchProxy, streamProxy: async function*(){}, log: () => {} });

    await router.handle({ type: "tk:req", id: 7, method: "GET", path: "/v1/health" }, (m) => posted.push(m));
    expect(posted).toEqual([{ type: "tk:res", id: 7, ok: true, status: 200, data: { ok: true, version: "test" } }]);
  });

  it("posts tk:err when fetchProxy throws", async () => {
    const fetchProxy = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const posted: unknown[] = [];
    const router = createMessageRouter({ getBaseUrl: () => "x", fetchProxy, streamProxy: async function*(){}, log: () => {} });
    await router.handle({ type: "tk:req", id: 1, method: "GET", path: "/x" }, (m) => posted.push(m));
    expect(posted).toEqual([{ type: "tk:err", id: 1, message: "ECONNREFUSED" }]);
  });

  it("does not post tk:err when the request was aborted (disposed webview)", async () => {
    let resolveFetch: ((res: { ok: boolean; status: number; data: unknown }) => void) | null = null;
    const fetchProxy = vi.fn(async (_url: string, init: { signal: AbortSignal }) =>
      new Promise<{ ok: boolean; status: number; data: unknown }>((resolve, reject) => {
        resolveFetch = resolve;
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    );
    const posted: unknown[] = [];
    const router = createMessageRouter({ getBaseUrl: () => "x", fetchProxy, streamProxy: async function*(){}, log: () => {} });

    const handlePromise = router.handle({ type: "tk:req", id: 99, method: "GET", path: "/slow" }, (m) => posted.push(m));
    await Promise.resolve(); // let handleReq enter await
    router.disposeAll();
    await handlePromise;
    void resolveFetch;
    expect(posted).toEqual([]); // no tk:err posted
  });
});
