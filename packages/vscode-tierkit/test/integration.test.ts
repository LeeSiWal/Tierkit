/**
 * End-to-end integration: real @tierkit/core daemon + real messageRouter +
 * the exact fetchProxy/streamProxy implementations from extension.ts.
 *
 * This exercises the full path that runs in production when the webview
 * sends a tk:req or tk:stream — minus only the actual webview iframe →
 * extension host postMessage hop (which is a thin VS Code API wrapper).
 *
 * If this passes, the protocol works end-to-end against a live daemon.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "@tierkit/core";
import { createAgentRouteExtension } from "@tierkit/agent";
import { createMessageRouter, type MessageRouter } from "../src/messageRouter.js";

// Copies of the exact proxy implementations from extension.ts. Kept here
// (rather than imported) because extension.ts also imports `vscode`, which
// isn't available in a node test environment. The shape must stay in sync;
// any drift breaks the protocol contract.
async function fetchProxy(
  url: string,
  init: { method: string; body?: string; signal: AbortSignal },
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, {
    method: init.method,
    headers: init.body !== undefined ? { "content-type": "application/json" } : {},
    body: init.body,
    signal: init.signal,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function* streamProxy(
  url: string,
  init: { method: string; body?: string; signal: AbortSignal },
): AsyncIterable<{ data: string }> {
  const res = await fetch(url, {
    method: init.method,
    headers: init.body !== undefined ? { "content-type": "application/json" } : {},
    body: init.body,
    signal: init.signal,
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const r = await reader.read();
      if (r.done) break;
      buf += decoder.decode(r.value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (!block.startsWith("data:")) continue;
        yield { data: block.slice(5).trim() };
      }
    }
  } finally {
    try { reader.cancel(); } catch { /* ignore */ }
  }
}

let server: RunningServer;
let router: MessageRouter;

beforeAll(async () => {
  server = await startServer({
    cwd: process.cwd(),
    host: "127.0.0.1",
    port: 0,
    routeExtensions: [createAgentRouteExtension()],
  });
  router = createMessageRouter({
    getBaseUrl: () => `http://127.0.0.1:${server.port}`,
    fetchProxy,
    streamProxy,
    log: () => {},
  });
});

afterAll(async () => {
  router.disposeAll();
  await server.close();
});

describe("integration: messageRouter + real daemon", () => {
  it("tk:req for /v1/health round-trips with ok:true", async () => {
    const posted: Array<Record<string, unknown>> = [];
    await router.handle(
      { type: "tk:req", id: 1, method: "GET", path: "/v1/health" },
      (m) => posted.push(m as Record<string, unknown>),
    );
    expect(posted.length).toBe(1);
    const res = posted[0];
    expect(res.type).toBe("tk:res");
    expect(res.id).toBe(1);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    const data = res.data as { ok: boolean; version: string };
    expect(data.ok).toBe(true);
    expect(typeof data.version).toBe("string");
  });

  it("tk:req for non-existent path returns ok:false (not throw)", async () => {
    const posted: Array<Record<string, unknown>> = [];
    await router.handle(
      { type: "tk:req", id: 2, method: "GET", path: "/v1/does-not-exist" },
      (m) => posted.push(m as Record<string, unknown>),
    );
    expect(posted.length).toBe(1);
    expect(posted[0].type).toBe("tk:res");
    expect(posted[0].ok).toBe(false);
    expect(posted[0].status).toBe(404);
  });

  it("tk:stream for /v1/agent/run emits tk:chunk(s) and tk:done", async () => {
    const posted: Array<Record<string, unknown>> = [];
    await router.handle(
      {
        type: "tk:stream",
        id: 3,
        method: "POST",
        path: "/v1/agent/run",
        body: { task: "echo hi", mode: "plan", maxTurns: 1 },
      },
      (m) => posted.push(m as Record<string, unknown>),
    );

    // Expect at least one tk:chunk and a final tk:done
    const chunks = posted.filter((m) => m.type === "tk:chunk");
    const dones = posted.filter((m) => m.type === "tk:done");
    expect(chunks.length).toBeGreaterThan(0);
    expect(dones.length).toBe(1);
    expect(dones[0].id).toBe(3);
    // reason should be eof or error (the agent loop may fail without a real model, that's fine —
    // what matters is the protocol delivered the events).
    expect(["eof", "error", "aborted"]).toContain(dones[0].reason);

    // Every non-sentinel chunk must be valid JSON. The agent SSE stream
    // emits a literal [DONE] sentinel as its terminator (mirroring OpenAI's
    // SSE convention); production GUI code filters it before JSON.parse.
    for (const c of chunks) {
      if (c.data === "[DONE]") continue;
      expect(() => JSON.parse(c.data as string)).not.toThrow();
    }
  }, 30_000);

  // Abort during stream is unit-tested at the messageRouter layer
  // (messageRouter.test.ts "posts tk:done reason=aborted after tk:abort").
  // We don't repeat it here because Node 20's fetch generates a transient
  // unhandled rejection from its internal request-body AbortController when
  // an in-flight stream is aborted, which vitest reports as a test failure
  // even though the protocol behaves correctly.
});
