# code-server 호환 채팅 UI 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tierkit-vscode`의 사이드바 채팅 UI가 code-server(브라우저 VS Code)에서도 동작하도록, webview ↔ 확장 호스트 메시지 채널 기반 transport 어댑터로 전환한다. Desktop 회귀 0, 데몬은 loopback only 유지.

**Architecture:** GUI 안에 환경 감지 transport (HTTP 또는 postMessage 기반)를 두고, vscode 호스트에서는 fetch 대신 `tk:req`/`tk:stream`/`tk:abort` 메시지를 확장 호스트에 보낸다. 확장 호스트는 메시지를 받아 데몬 loopback에 raw fetch로 프록시한다. `portMapping`과 CSP `connect-src http://127.0.0.1:*`는 제거된다.

**Tech Stack:** TypeScript, tsup (CJS for vscode extension, ESM for core), vitest 2.x, Node 20 (built-in fetch), VS Code API (postMessage / acquireVsCodeApi), pnpm workspace.

**Spec:** [docs/superpowers/specs/2026-05-16-codeserver-chat-ui-design.md](../specs/2026-05-16-codeserver-chat-ui-design.md)

---

## File Map

**Create:**
- `packages/core/src/runtime/ui/transport.ts` — `TRANSPORT_INLINE_JS` 상수 (template string) export
- `packages/core/test/transport.test.ts` — transport 단위 테스트 (HTTP + VsCode 둘 다)
- `packages/vscode-tierkit/src/messageRouter.ts` — 의존성 주입형 pure 모듈; `tk:*` 메시지 처리 로직
- `packages/vscode-tierkit/test/messageRouter.test.ts` — 라우터 단위 테스트
- `packages/vscode-tierkit/vitest.config.ts` — vitest 설정 (현재 없음)

**Modify:**
- `packages/core/src/runtime/ui/gui.ts` — `TRANSPORT_INLINE_JS` 인라인, `jget`/`jpost`/직접 fetch 호출 교체 (4곳)
- `packages/vscode-tierkit/src/extension.ts` — `messageRouter` 와이어업, `portMapping` 제거, CSP 단순화, `__TIERKIT_HOST__` 주입
- `packages/vscode-tierkit/package.json` — 버전 0.7.0 → 0.8.0
- `packages/vscode-tierkit/CHANGELOG.md` — 0.8.0 항목
- `docs/INTEGRATIONS.md` — code-server 섹션

---

## Task 1: transport.ts 스켈레톤 + HTTP transport request

**Files:**
- Create: `packages/core/src/runtime/ui/transport.ts`
- Test: `packages/core/test/transport.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/transport.test.ts`:

```typescript
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
  // The inline JS defines createHttpTransport and createVsCodeTransport on globalThis-style;
  // we evaluate it inside a Function and return the symbols.
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
```

- [ ] **Step 2: Create core/test/setup-jsdom.ts and update vitest config to support jsdom env**

Check existing setup. Add jsdom as devDep if needed:

Run: `cd packages/core && pnpm list jsdom 2>/dev/null`

If not installed:
```bash
cd packages/core && pnpm add -D jsdom @types/jsdom
```

The `@vitest-environment jsdom` pragma in the test file selects per-file environment; no global config change needed for vitest 2.x as long as jsdom is installed.

- [ ] **Step 3: Run test to verify it fails (module missing)**

Run: `cd packages/core && pnpm test -- transport.test.ts`
Expected: FAIL — `Cannot find module '../src/runtime/ui/transport.js'`

- [ ] **Step 4: Create transport.ts with TRANSPORT_INLINE_JS skeleton + HTTP request**

Create `packages/core/src/runtime/ui/transport.ts`:

```typescript
/**
 * Transport adapter source, embedded as JS inside GUI_HTML. Two modes:
 *
 *   - HTTP (default): direct fetch / ReadableStream — used when the GUI is loaded
 *     in a regular browser pointed at the daemon (e.g. http://127.0.0.1:4101/).
 *   - VsCode: postMessage RPC over `acquireVsCodeApi()` — used when GUI_HTML is
 *     embedded in a VS Code webview (Desktop OR code-server). The extension host
 *     proxies the actual daemon calls. Avoids browser sandbox issues with loopback
 *     fetches from a remote webview.
 *
 * We ship this as a string (single source of truth) and inline it into GUI_HTML.
 * Unit tests evaluate the string with `new Function(...)` and exercise the factories.
 */
export const TRANSPORT_INLINE_JS = `
function createHttpTransport(base) {
  function buildUrl(path) { return (base || '') + path; }
  function makeInit(init) {
    var i = init || {};
    var headers = {};
    var body = undefined;
    if (i.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(i.body);
    }
    return {
      method: (i.method || 'GET').toUpperCase(),
      headers: headers,
      body: body,
      signal: i.signal,
    };
  }
  return {
    request: async function (path, init) {
      var res = await fetch(buildUrl(path), makeInit(init));
      var data = await res.json().catch(function () { return {}; });
      return { ok: res.ok, status: res.status, data: data };
    },
    stream: async function* (path, init) {
      // Placeholder until Task 3.
      throw new Error('stream not implemented');
    },
  };
}

function createVsCodeTransport() {
  // Placeholder until Task 5.
  return {
    request: async function () { throw new Error('vscode transport not implemented'); },
    stream: async function* () { throw new Error('vscode transport not implemented'); },
  };
}
`;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/core && pnpm test -- transport.test.ts`
Expected: PASS — 1 test

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime/ui/transport.ts packages/core/test/transport.test.ts packages/core/package.json packages/core/pnpm-lock.yaml 2>/dev/null
git commit -m "feat(core): transport adapter scaffold + http request

Establishes TRANSPORT_INLINE_JS as the single source of truth for the
GUI's network adapter. HTTP request path implemented; SSE stream and
VsCode transport stubs throw until follow-up tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: HTTP transport POST + abort

**Files:**
- Modify: `packages/core/src/runtime/ui/transport.ts`
- Modify: `packages/core/test/transport.test.ts`

- [ ] **Step 1: Add failing tests for POST and abort**

Append to `packages/core/test/transport.test.ts` inside the `describe("createHttpTransport.request", ...)` block:

```typescript
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
```

- [ ] **Step 2: Run tests to verify abort test fails / others may already pass**

Run: `cd packages/core && pnpm test -- transport.test.ts`
Expected: POST test PASS (already supported), abort test PASS (signal already passed through), 4xx test PASS

If all already pass thanks to the Task 1 implementation, that's fine — the tests pin down behavior. Document this in step 3 if needed.

- [ ] **Step 3: Commit (regression coverage)**

```bash
git add packages/core/test/transport.test.ts
git commit -m "test(core): http transport POST, 4xx, abort coverage

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: HTTP transport SSE stream

**Files:**
- Modify: `packages/core/src/runtime/ui/transport.ts`
- Modify: `packages/core/test/transport.test.ts`

- [ ] **Step 1: Write failing test for stream()**

Append to `packages/core/test/transport.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm test -- transport.test.ts`
Expected: FAIL — "stream not implemented"

- [ ] **Step 3: Implement stream() in transport.ts**

In `packages/core/src/runtime/ui/transport.ts`, replace the stream stub inside `createHttpTransport`:

```javascript
    stream: async function* (path, init) {
      var i = init || {};
      var fetchInit = {
        method: (i.method || 'GET').toUpperCase(),
        headers: i.body !== undefined ? { 'content-type': 'application/json' } : {},
        body: i.body !== undefined ? JSON.stringify(i.body) : undefined,
        signal: i.signal,
      };
      var res = await fetch(buildUrl(path), fetchInit);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      try {
        while (true) {
          var r = await reader.read();
          if (r.done) break;
          buf += decoder.decode(r.value, { stream: true });
          var idx;
          while ((idx = buf.indexOf('\\n\\n')) >= 0) {
            var block = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 2);
            if (block.indexOf('data:') !== 0) continue;
            yield { data: block.slice(5).trim() };
          }
        }
      } finally {
        try { reader.cancel(); } catch (e) {}
      }
    },
```

Note the `'\\n\\n'` — inside the template literal containing JS source, `\n` literal characters would terminate strings; we want the JS `'\n\n'` after evaluation. So in the TS template string write `\\n\\n` to produce JS source `'\n\n'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/core && pnpm test -- transport.test.ts`
Expected: PASS — all stream tests + all request tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/ui/transport.ts packages/core/test/transport.test.ts
git commit -m "feat(core): http transport SSE stream

Mirrors the existing GUI manual SSE decoder so behavior is identical
when running outside a VS Code webview.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: VsCode transport request

**Files:**
- Modify: `packages/core/src/runtime/ui/transport.ts`
- Modify: `packages/core/test/transport.test.ts`

- [ ] **Step 1: Write failing test for VsCode request**

Append to `packages/core/test/transport.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd packages/core && pnpm test -- transport.test.ts`
Expected: FAIL — "vscode transport not implemented"

- [ ] **Step 3: Implement createVsCodeTransport in transport.ts**

Replace the `createVsCodeTransport` stub in `packages/core/src/runtime/ui/transport.ts`:

```javascript
function createVsCodeTransport() {
  var vscode = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
  if (!vscode) {
    return {
      request: async function () { throw new Error('acquireVsCodeApi unavailable'); },
      stream: async function* () { throw new Error('acquireVsCodeApi unavailable'); },
    };
  }
  var nextId = 1;
  var pending = new Map(); // id -> { resolve, reject } | { stream handlers }

  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg || typeof msg !== 'object') return;
    var entry = pending.get(msg.id);
    if (!entry) return;
    if (msg.type === 'tk:res') {
      pending.delete(msg.id);
      entry.resolve({ ok: msg.ok, status: msg.status, data: msg.data });
    } else if (msg.type === 'tk:err') {
      pending.delete(msg.id);
      entry.reject(new Error(msg.message || 'tk:err'));
    } else if (msg.type === 'tk:chunk') {
      if (entry.onChunk) entry.onChunk(msg.data);
    } else if (msg.type === 'tk:done') {
      pending.delete(msg.id);
      if (entry.onDone) entry.onDone(msg.reason || 'eof', msg.error);
    }
  });

  function allocId() { return nextId++; }

  return {
    request: function (path, init) {
      var id = allocId();
      var i = init || {};
      return new Promise(function (resolve, reject) {
        pending.set(id, { resolve: resolve, reject: reject });
        if (i.signal) {
          i.signal.addEventListener('abort', function () {
            if (pending.has(id)) {
              pending.delete(id);
              try { vscode.postMessage({ type: 'tk:abort', id: id }); } catch (e) {}
              reject(new Error('aborted'));
            }
          });
        }
        try {
          vscode.postMessage({
            type: 'tk:req', id: id,
            method: (i.method || 'GET').toUpperCase(),
            path: path,
            body: i.body,
          });
        } catch (e) {
          pending.delete(id);
          reject(e);
        }
      });
    },
    stream: async function* (path, init) {
      // Implemented in Task 5.
      throw new Error('vscode stream not implemented');
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && pnpm test -- transport.test.ts`
Expected: PASS — all 3 vscode request tests + earlier tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/ui/transport.ts packages/core/test/transport.test.ts
git commit -m "feat(core): vscode transport request via postMessage RPC

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: VsCode transport stream

**Files:**
- Modify: `packages/core/src/runtime/ui/transport.ts`
- Modify: `packages/core/test/transport.test.ts`

- [ ] **Step 1: Write failing test for stream + abort**

Append to `packages/core/test/transport.test.ts`:

```typescript
describe("createVsCodeTransport.stream", () => {
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
    vi.spyOn(window, "addEventListener").mockImplementation((type, listener) => {
      if (type === "message") messageListeners.push(listener as (e: MessageEvent) => void);
    });
  });

  it("posts tk:stream, yields tk:chunk in order, ends on tk:done", async () => {
    const { createVsCodeTransport } = loadFactories();
    const iter = createVsCodeTransport().stream("/v1/agent/run", { method: "POST", body: { task: "hi" } });

    // Start consumption asynchronously
    const collected: string[] = [];
    const consumer = (async () => {
      for await (const ev of iter) collected.push(ev.data);
    })();

    await Promise.resolve();
    const msg = posted[0] as { id: number; type: string };
    expect(msg.type).toBe("tk:stream");

    reply(msg.id, { type: "tk:chunk", data: '{"type":"task_start"}' });
    reply(msg.id, { type: "tk:chunk", data: '{"type":"delta","text":"x"}' });
    reply(msg.id, { type: "tk:done", reason: "eof" });

    await consumer;
    expect(collected).toEqual(['{"type":"task_start"}', '{"type":"delta","text":"x"}']);
  });

  it("posts tk:abort and ends iteration when signal aborts", async () => {
    const ctrl = new AbortController();
    const { createVsCodeTransport } = loadFactories();
    const iter = createVsCodeTransport().stream("/v1/agent/run", {
      method: "POST", body: {}, signal: ctrl.signal,
    });

    const consumer = (async () => {
      const out: string[] = [];
      try { for await (const ev of iter) out.push(ev.data); } catch { /* ignore */ }
      return out;
    })();

    await Promise.resolve();
    const startMsg = posted[0] as { id: number };
    reply(startMsg.id, { type: "tk:chunk", data: "one" });
    ctrl.abort();
    // Allow microtasks
    await Promise.resolve();

    const abortMsg = posted.find((m) => (m as { type: string }).type === "tk:abort") as { id: number };
    expect(abortMsg).toBeTruthy();
    expect(abortMsg.id).toBe(startMsg.id);

    // After abort, the consumer should resolve (we use done to unblock).
    reply(startMsg.id, { type: "tk:done", reason: "aborted" });
    await consumer;
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd packages/core && pnpm test -- transport.test.ts`
Expected: FAIL — "vscode stream not implemented"

- [ ] **Step 3: Implement stream() in createVsCodeTransport**

Replace the stream stub in `createVsCodeTransport`:

```javascript
    stream: async function* (path, init) {
      var id = allocId();
      var i = init || {};
      var queue = [];
      var waiter = null;
      var ended = false;
      var error = null;

      pending.set(id, {
        onChunk: function (data) {
          if (waiter) { var w = waiter; waiter = null; w({ value: { data: data }, done: false }); }
          else queue.push({ value: { data: data }, done: false });
        },
        onDone: function (reason, errMsg) {
          ended = true;
          if (errMsg && reason !== 'eof') error = new Error(errMsg);
          if (waiter) {
            var w = waiter; waiter = null;
            if (error) w(Promise.reject(error));
            else w({ value: undefined, done: true });
          }
        },
        resolve: function () {}, reject: function (e) { error = e; ended = true; if (waiter) { var w = waiter; waiter = null; w(Promise.reject(e)); } },
      });

      if (i.signal) {
        i.signal.addEventListener('abort', function () {
          try { vscode.postMessage({ type: 'tk:abort', id: id }); } catch (e) {}
        });
      }

      try {
        vscode.postMessage({
          type: 'tk:stream', id: id,
          method: (i.method || 'POST').toUpperCase(),
          path: path,
          body: i.body,
        });
      } catch (e) {
        pending.delete(id);
        throw e;
      }

      try {
        while (true) {
          if (queue.length > 0) {
            var item = queue.shift();
            if (item.done) return;
            yield item.value;
            continue;
          }
          if (ended) {
            if (error) throw error;
            return;
          }
          var next = await new Promise(function (resolve) { waiter = resolve; });
          if (next && next.done) return;
          if (next && next.value) yield next.value;
        }
      } finally {
        pending.delete(id);
      }
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && pnpm test -- transport.test.ts`
Expected: PASS — all transport tests

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/ui/transport.ts packages/core/test/transport.test.ts
git commit -m "feat(core): vscode transport SSE-equivalent stream

Async iterable backed by a chunk queue/waiter. Supports abort via
tk:abort + signal listener. Mirrors HTTP transport stream() shape so
gui.ts call sites are identical.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Wire transport into gui.ts (replace fetch sites)

**Files:**
- Modify: `packages/core/src/runtime/ui/gui.ts`

- [ ] **Step 1: Read gui.ts head to find existing imports and JS interpolation point**

Run: `head -30 packages/core/src/runtime/ui/gui.ts`

Locate the `export const GUI_HTML = \`...\`` template literal start (around line 20). The inline `<script>` block is inside that template literal.

- [ ] **Step 2: Import TRANSPORT_INLINE_JS at the top of gui.ts**

In `packages/core/src/runtime/ui/gui.ts`, after the file header comment, add the import. Find the existing line that starts the `GUI_HTML` template:

```typescript
import { TRANSPORT_INLINE_JS } from "./transport.js";

export const GUI_HTML = `<!doctype html>
```

(If gui.ts has no other imports, this is the first import line.)

- [ ] **Step 3: Inject TRANSPORT_INLINE_JS into the inline script section**

Find the line `const BASE = (typeof window !== 'undefined' && window.__TIERKIT_BASE_URL__) || '';` (currently `gui.ts:538`). Replace the area immediately before the existing `const BASE = ...` line:

Find:
```javascript
  // ── State + helpers ────────────────────────────────────────────────────────
  const BASE = (typeof window !== 'undefined' && window.__TIERKIT_BASE_URL__) || '';
```

Replace with:
```javascript
  // ── State + helpers ────────────────────────────────────────────────────────
  const BASE = (typeof window !== 'undefined' && window.__TIERKIT_BASE_URL__) || '';
  ${TRANSPORT_INLINE_JS}
  const transport = (typeof window !== 'undefined' && window.__TIERKIT_HOST__ === 'vscode')
    ? createVsCodeTransport()
    : createHttpTransport(BASE);
```

The `${TRANSPORT_INLINE_JS}` is interpolated by the outer TypeScript template literal — it becomes part of the GUI HTML's inline script. `BASE` stays for backwards-compat / debug display.

- [ ] **Step 4: Replace jget/jpost implementations**

Find:
```javascript
  async function jget(p) { const r = await fetch(BASE + p); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
  async function jpost(p, b) {
    const r = await fetch(BASE + p, { method: 'POST', headers: {'content-type':'application/json'}, body: b !== undefined ? JSON.stringify(b) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 400) throw new Error(d?.error || d?.message || ('HTTP ' + r.status));
    return { ok: r.ok, status: r.status, data: d };
  }
```

Replace with:
```javascript
  async function jget(p) {
    const r = await transport.request(p, { method: 'GET' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.data;
  }
  async function jpost(p, b) {
    const r = await transport.request(p, { method: 'POST', body: b });
    if (!r.ok && r.status !== 400) throw new Error(r.data?.error || r.data?.message || ('HTTP ' + r.status));
    return { ok: r.ok, status: r.status, data: r.data };
  }
```

- [ ] **Step 5: Replace direct fetch at line 1364 (workspace files autocomplete)**

Find:
```javascript
      const r = await fetch(BASE + '/v1/workspace/files?prefix=' + encodeURIComponent(prefix) + '&limit=8', { signal: atSuggestAbort.signal });
```

Replace with:
```javascript
      const r = await transport.request('/v1/workspace/files?prefix=' + encodeURIComponent(prefix) + '&limit=8', { method: 'GET', signal: atSuggestAbort.signal });
```

Also update the subsequent lines that consume `r` — they currently do `await r.json()`. Inspect the surrounding 10 lines and adjust:

Before:
```javascript
      const r = await fetch(...);
      if (!r.ok) return;
      const d = await r.json();
      // use d.files etc.
```

After:
```javascript
      const r = await transport.request(...);
      if (!r.ok) return;
      const d = r.data;
      // use d.files etc.
```

- [ ] **Step 6: Replace agent SSE stream at line 1541**

Find the block starting with `const res = await fetch(BASE + '/v1/agent/run', {`. Replace the entire fetch + reader manual decode loop:

Before:
```javascript
      const res = await fetch(BASE + '/v1/agent/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ task: finalTask, mode: selectedMode, approvalMode, ...(attachmentsForSubmit ? { attachments: attachmentsForSubmit } : {}) }),
        signal: agentController.signal,
      });
      pendingAttachments.length = 0;
      renderAttachments();
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        renderAgentEvent({ type: 'error', code: errBody?.error?.code || ('http-' + res.status), message: errBody?.error?.message || ('HTTP ' + res.status) });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const r = await reader.read();
        if (r.done) break;
        buf += decoder.decode(r.value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 2);
          if (!block.startsWith('data:')) continue;
          const payload = block.slice('data:'.length).trim();
          if (payload === '[DONE]') return;
          try { renderAgentEvent(JSON.parse(payload)); } catch (e) { /* skip malformed */ }
        }
      }
```

After:
```javascript
      pendingAttachments.length = 0;
      renderAttachments();
      const body = { task: finalTask, mode: selectedMode, approvalMode, ...(attachmentsForSubmit ? { attachments: attachmentsForSubmit } : {}) };
      try {
        for await (const ev of transport.stream('/v1/agent/run', { method: 'POST', body, signal: agentController.signal })) {
          if (ev.data === '[DONE]') return;
          try { renderAgentEvent(JSON.parse(ev.data)); } catch (e) { /* skip malformed */ }
        }
      } catch (streamErr) {
        if (streamErr.name === 'AbortError' || /aborted/i.test(streamErr.message)) throw streamErr;
        // HTTP error or transport-level failure
        renderAgentEvent({ type: 'error', code: 'stream-error', message: streamErr.message });
        return;
      }
```

Keep the outer `try {} catch (e) { if (e.name === 'AbortError') ... } finally { ... }` block as-is — the new `throw streamErr` re-raises abort so the outer catch still classifies it.

- [ ] **Step 7: Typecheck and build core**

Run: `cd packages/core && pnpm typecheck && pnpm build`
Expected: clean. If typecheck fails on the `streamErr.name` access, cast or check: `((streamErr as any).name === 'AbortError')` — but it's inline JS string, not TS, so this should be fine.

- [ ] **Step 8: Smoke test HTTP mode**

Run:
```bash
cd packages/core && pnpm build
cd ../..
node -e "
const { startServer } = require('./packages/core/dist/index.js');
startServer({ cwd: process.cwd(), host: '127.0.0.1', port: 4101 }).then(s => {
  console.log('daemon at', s.port);
  setTimeout(() => s.close().then(() => process.exit(0)), 30000);
});
" &
SERVER_PID=$!
sleep 2
curl -s http://127.0.0.1:4101/v1/health | head -c 200
echo
# Open http://127.0.0.1:4101/ in browser manually if desired
sleep 30 || true
wait $SERVER_PID 2>/dev/null
```

Expected: `/v1/health` returns `{"ok":true,...}` and (manually) the GUI loads at `http://127.0.0.1:4101/` and the tools list populates — proves HTTP transport still works.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/runtime/ui/gui.ts
git commit -m "feat(core): route gui.ts network calls through transport

jget/jpost and the two direct fetch sites (workspace autocomplete,
agent SSE) now go through transport.request/stream. Default is
HTTP transport — behavior unchanged for browser users. VsCode transport
activates when window.__TIERKIT_HOST__ === 'vscode'.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Extract pure messageRouter module (vscode-tierkit)

**Files:**
- Create: `packages/vscode-tierkit/src/messageRouter.ts`
- Create: `packages/vscode-tierkit/vitest.config.ts`
- Create: `packages/vscode-tierkit/test/messageRouter.test.ts`
- Modify: `packages/vscode-tierkit/tsconfig.json` (test exclusion already in place — confirm)

- [ ] **Step 1: Create vitest.config.ts**

Create `packages/vscode-tierkit/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 2: Write failing test for handleTkReq (request proxy)**

Create `packages/vscode-tierkit/test/messageRouter.test.ts`:

```typescript
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
    const router = createMessageRouter({ baseUrl: "http://127.0.0.1:4101", fetchProxy, streamProxy: async function*(){}, log: () => {} });

    await router.handle({ type: "tk:req", id: 7, method: "GET", path: "/v1/health" }, (m) => posted.push(m));
    expect(posted).toEqual([{ type: "tk:res", id: 7, ok: true, status: 200, data: { ok: true, version: "test" } }]);
  });

  it("posts tk:err when fetchProxy throws", async () => {
    const fetchProxy = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const posted: unknown[] = [];
    const router = createMessageRouter({ baseUrl: "x", fetchProxy, streamProxy: async function*(){}, log: () => {} });
    await router.handle({ type: "tk:req", id: 1, method: "GET", path: "/x" }, (m) => posted.push(m));
    expect(posted).toEqual([{ type: "tk:err", id: 1, message: "ECONNREFUSED" }]);
  });
});
```

- [ ] **Step 3: Run test to verify failure**

Run: `cd packages/vscode-tierkit && pnpm test`
Expected: FAIL — module not found

- [ ] **Step 4: Create messageRouter.ts with handle for tk:req**

Create `packages/vscode-tierkit/src/messageRouter.ts`:

```typescript
/**
 * Pure message router for the Tierkit sidebar webview. Translates
 * `tk:req` / `tk:stream` / `tk:abort` messages from the webview into
 * daemon HTTP calls via injected fetch/stream helpers, and posts
 * `tk:res` / `tk:chunk` / `tk:done` / `tk:err` back.
 *
 * Pure module — does not import the `vscode` API. Wired up by extension.ts
 * which supplies the actual fetch/streaming logic and the webview's
 * postMessage callback.
 */

export interface FetchProxyResponse {
  ok: boolean;
  status: number;
  data: unknown;
}

export interface MessageRouterOptions {
  baseUrl: string;
  fetchProxy: (url: string, init: { method: string; body?: string; signal: AbortSignal }) => Promise<FetchProxyResponse>;
  streamProxy: (
    url: string,
    init: { method: string; body?: string; signal: AbortSignal },
  ) => AsyncIterable<{ data: string }>;
  log: (line: string) => void;
}

export interface IncomingMessage {
  type: string;
  id?: number;
  method?: string;
  path?: string;
  body?: unknown;
}

export interface MessageRouter {
  handle: (msg: IncomingMessage, postMessage: (m: unknown) => void) => Promise<void>;
  disposeAll: () => void;
}

export function createMessageRouter(opts: MessageRouterOptions): MessageRouter {
  const inflight = new Map<number, AbortController>();

  async function handleReq(msg: IncomingMessage, post: (m: unknown) => void): Promise<void> {
    if (typeof msg.id !== "number" || typeof msg.path !== "string") return;
    const ctrl = new AbortController();
    inflight.set(msg.id, ctrl);
    try {
      const init = {
        method: (msg.method || "GET").toUpperCase(),
        body: msg.body !== undefined ? JSON.stringify(msg.body) : undefined,
        signal: ctrl.signal,
      };
      const res = await opts.fetchProxy(opts.baseUrl + msg.path, init);
      post({ type: "tk:res", id: msg.id, ok: res.ok, status: res.status, data: res.data });
    } catch (err) {
      post({ type: "tk:err", id: msg.id, message: (err as Error).message });
    } finally {
      inflight.delete(msg.id);
    }
  }

  return {
    async handle(msg, post) {
      if (msg.type === "tk:req") return handleReq(msg, post);
      if (msg.type === "tk:abort" && typeof msg.id === "number") {
        const c = inflight.get(msg.id);
        if (c) c.abort();
        return;
      }
      // tk:stream — implemented in Task 8.
    },
    disposeAll() {
      for (const c of inflight.values()) c.abort();
      inflight.clear();
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/vscode-tierkit && pnpm test`
Expected: PASS — 2 tests

- [ ] **Step 6: Commit**

```bash
git add packages/vscode-tierkit/src/messageRouter.ts packages/vscode-tierkit/test/messageRouter.test.ts packages/vscode-tierkit/vitest.config.ts
git commit -m "feat(vscode): pure messageRouter for tk:req proxying

Dependency-injected router so we can unit-test without mocking the
vscode module. Handles tk:req only in this commit; stream + abort
follow in subsequent tasks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: messageRouter tk:stream + tk:abort

**Files:**
- Modify: `packages/vscode-tierkit/src/messageRouter.ts`
- Modify: `packages/vscode-tierkit/test/messageRouter.test.ts`

- [ ] **Step 1: Write failing tests for stream + abort**

Append to `packages/vscode-tierkit/test/messageRouter.test.ts`:

```typescript
describe("messageRouter.handle tk:stream", () => {
  it("yields chunks as tk:chunk and finishes with tk:done", async () => {
    async function* fakeStream() {
      yield { data: '{"type":"task_start"}' };
      yield { data: '{"type":"delta","text":"x"}' };
    }
    const posted: any[] = [];
    const router = createMessageRouter({
      baseUrl: "http://127.0.0.1:4101",
      fetchProxy: async () => { throw new Error("not called"); },
      streamProxy: (_url, _init) => fakeStream(),
      log: () => {},
    });
    await router.handle({ type: "tk:stream", id: 42, method: "POST", path: "/v1/agent/run", body: { task: "hi" } }, (m) => posted.push(m));
    expect(posted).toEqual([
      { type: "tk:chunk", id: 42, data: '{"type":"task_start"}' },
      { type: "tk:chunk", id: 42, data: '{"type":"delta","text":"x"}' },
      { type: "tk:done", id: 42, reason: "eof" },
    ]);
  });

  it("posts tk:done reason=aborted after tk:abort", async () => {
    let abortSeen = false;
    async function* slowStream(_url: string, init: { signal: AbortSignal }) {
      yield { data: "a" };
      // Wait until aborted
      await new Promise<void>((resolve) => {
        init.signal.addEventListener("abort", () => { abortSeen = true; resolve(); });
      });
    }
    const posted: any[] = [];
    const router = createMessageRouter({
      baseUrl: "x",
      fetchProxy: async () => ({ ok: true, status: 200, data: {} }),
      streamProxy: (u, i) => slowStream(u, i),
      log: () => {},
    });

    // Kick off the stream
    const p = router.handle({ type: "tk:stream", id: 9, method: "POST", path: "/x", body: {} }, (m) => posted.push(m));
    // Wait for first chunk to land
    await new Promise((r) => setTimeout(r, 10));
    await router.handle({ type: "tk:abort", id: 9 }, () => {});
    await p;
    expect(abortSeen).toBe(true);
    expect(posted[0]).toEqual({ type: "tk:chunk", id: 9, data: "a" });
    expect(posted[posted.length - 1]).toEqual({ type: "tk:done", id: 9, reason: "aborted" });
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd packages/vscode-tierkit && pnpm test`
Expected: FAIL — first stream test runs but posts nothing (stream not implemented).

- [ ] **Step 3: Implement stream handling**

In `packages/vscode-tierkit/src/messageRouter.ts`, add `handleStream` and dispatch:

Replace the existing `return { async handle(...) {...} }` block with:

```typescript
  async function handleStream(msg: IncomingMessage, post: (m: unknown) => void): Promise<void> {
    if (typeof msg.id !== "number" || typeof msg.path !== "string") return;
    const ctrl = new AbortController();
    inflight.set(msg.id, ctrl);
    const init = {
      method: (msg.method || "POST").toUpperCase(),
      body: msg.body !== undefined ? JSON.stringify(msg.body) : undefined,
      signal: ctrl.signal,
    };
    let reason: "eof" | "aborted" | "error" = "eof";
    let errMsg: string | undefined;
    try {
      for await (const chunk of opts.streamProxy(opts.baseUrl + msg.path, init)) {
        if (ctrl.signal.aborted) break;
        post({ type: "tk:chunk", id: msg.id, data: chunk.data });
      }
      if (ctrl.signal.aborted) reason = "aborted";
    } catch (err) {
      if (ctrl.signal.aborted) {
        reason = "aborted";
      } else {
        reason = "error";
        errMsg = (err as Error).message;
      }
    } finally {
      inflight.delete(msg.id);
      const payload: { type: string; id: number; reason: string; error?: string } = {
        type: "tk:done",
        id: msg.id,
        reason,
      };
      if (errMsg) payload.error = errMsg;
      post(payload);
    }
  }

  return {
    async handle(msg, post) {
      if (msg.type === "tk:req") return handleReq(msg, post);
      if (msg.type === "tk:stream") return handleStream(msg, post);
      if (msg.type === "tk:abort" && typeof msg.id === "number") {
        const c = inflight.get(msg.id);
        if (c) c.abort();
        return;
      }
    },
    disposeAll() {
      for (const c of inflight.values()) c.abort();
      inflight.clear();
    },
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/vscode-tierkit && pnpm test`
Expected: PASS — 4 tests

- [ ] **Step 5: Commit**

```bash
git add packages/vscode-tierkit/src/messageRouter.ts packages/vscode-tierkit/test/messageRouter.test.ts
git commit -m "feat(vscode): messageRouter stream + abort handling

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Wire messageRouter into extension.ts + remove portMapping/CSP

**Files:**
- Modify: `packages/vscode-tierkit/src/extension.ts`

- [ ] **Step 1: Add fetchProxy/streamProxy implementations + router instance**

In `packages/vscode-tierkit/src/extension.ts`, after the existing `function makeClient()` function, add:

```typescript
import { createMessageRouter, type MessageRouter } from "./messageRouter.js";

async function fetchProxy(url: string, init: { method: string; body?: string; signal: AbortSignal }): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(url, {
    method: init.method,
    headers: init.body !== undefined ? { "content-type": "application/json" } : {},
    body: init.body,
    signal: init.signal,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function* streamProxy(url: string, init: { method: string; body?: string; signal: AbortSignal }): AsyncIterable<{ data: string }> {
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
```

- [ ] **Step 2: Update TierkitSidebarProvider.resolveWebviewView to route tk:* messages**

Find the `webviewView.webview.onDidReceiveMessage((msg) => { ... })` block in `TierkitSidebarProvider.resolveWebviewView`. Replace with:

```typescript
    const router = createMessageRouter({
      baseUrl: baseUrl(),
      fetchProxy,
      streamProxy,
      log: (line) => log(`router: ${line}`),
    });
    webviewView.onDidDispose(() => router.disposeAll());

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (typeof msg?.type !== "string") return;
      if (msg.type.startsWith("tk:")) {
        void router.handle(msg, (out) => webviewView.webview.postMessage(out));
        return;
      }
      // Pre-existing message types
      if (msg.type === "showOutput") outputChannel?.show(true);
      else if (msg.type === "restartDaemon") void restartDaemon();
      else if (msg.type === "previewDiff" && typeof msg.path === "string" && typeof msg.proposed === "string") {
        void previewDiff(msg.path, msg.proposed);
      }
      else if (msg.type === "openFile" && typeof msg.path === "string") {
        void openFile(msg.path);
      }
    });
```

Note: router captures `baseUrl()` at create time. If base URL changes (daemon restart on different port), the router uses stale URL. Mitigate: rebuild router in `render()`, or pass a thunk. Use a thunk — change `baseUrl: baseUrl()` to a property that re-reads. Simpler: pass `baseUrl: ""` and have `fetchProxy`/`streamProxy` accept a `getBaseUrl()` closure. To avoid restructuring, recreate the router inside `resolveWebviewView` whenever `render()` runs:

Actually a cleaner fix — pass a thunk into the router options. Change `MessageRouterOptions.baseUrl: string` to `getBaseUrl: () => string`:

In `packages/vscode-tierkit/src/messageRouter.ts`:
- Change interface: `baseUrl: string` → `getBaseUrl: () => string`
- Inside `handleReq`/`handleStream`: replace `opts.baseUrl + msg.path` with `opts.getBaseUrl() + msg.path`

Update the existing tests in `messageRouter.test.ts` accordingly: every `baseUrl: "..."` becomes `getBaseUrl: () => "..."`.

In `extension.ts` router creation: `getBaseUrl: () => baseUrl()`.

- [ ] **Step 3: Update render() to inject __TIERKIT_HOST__ + simplify CSP + remove portMapping**

Find the `render()` method in `TierkitSidebarProvider` (~line 223–241). Replace the entire `render()` method with:

```typescript
  render(): void {
    if (!this.current) return;
    log(`render: baseUrl=${baseUrl()} daemonError=${lastDaemonError ?? "none"}`);
    this.current.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    this.current.webview.html = wrapHtmlForWebview(GUI_HTML, baseUrl(), lastDaemonError);
  }
```

And replace `wrapHtmlForWebview`:

```typescript
function wrapHtmlForWebview(html: string, base: string, errorMessage?: string): string {
  // CSP: webview no longer fetches the daemon directly; all data flows through
  // postMessage to the extension host. So connect-src is not needed.
  const csp =
    `<meta http-equiv="Content-Security-Policy" content="` +
    `default-src 'none'; ` +
    `style-src 'unsafe-inline'; ` +
    `script-src 'unsafe-inline'; ` +
    `img-src data: https:; ` +
    `font-src data:;` +
    `">`;
  const errLiteral = errorMessage ? JSON.stringify(errorMessage) : "null";
  const bootstrap =
    `<script>` +
    `window.__TIERKIT_BASE_URL__ = ${JSON.stringify(base)};` +
    `window.__TIERKIT_DAEMON_ERROR__ = ${errLiteral};` +
    `window.__TIERKIT_HOST__ = "vscode";` +
    `</script>`;
  return html.replace(/<head>/i, `<head>\n${csp}\n${bootstrap}`);
}
```

Remove the `portFromBaseUrl` function — it's no longer referenced.

- [ ] **Step 4: Typecheck**

Run: `cd packages/vscode-tierkit && pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Build**

Run: `cd packages/vscode-tierkit && pnpm build`
Expected: clean, `dist/extension.js` produced.

- [ ] **Step 6: Run router unit tests (already passing, regression check)**

Run: `cd packages/vscode-tierkit && pnpm test`
Expected: PASS — all router tests still pass after `getBaseUrl` refactor.

- [ ] **Step 7: Commit**

```bash
git add packages/vscode-tierkit/src/extension.ts packages/vscode-tierkit/src/messageRouter.ts packages/vscode-tierkit/test/messageRouter.test.ts
git commit -m "feat(vscode): route webview tk:* through messageRouter; drop portMapping

Webview no longer fetches the daemon directly. portMapping option
removed; CSP simplified (no connect-src needed). __TIERKIT_HOST__ flag
injected so the GUI's transport picks the vscode adapter.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Bump version, build VSIX, Desktop regression

**Files:**
- Modify: `packages/vscode-tierkit/package.json`
- Modify: `packages/vscode-tierkit/CHANGELOG.md`

- [ ] **Step 1: Bump version**

Edit `packages/vscode-tierkit/package.json`: change `"version": "0.7.0"` to `"version": "0.8.0"`.

- [ ] **Step 2: Add CHANGELOG entry**

Prepend to `packages/vscode-tierkit/CHANGELOG.md` (or create if missing):

```markdown
## 0.8.0 — 2026-05-XX

- code-server compatible chat UI. The sidebar webview now talks to the
  extension host via postMessage instead of direct fetch through
  portMapping; the host proxies all daemon calls. Works in VS Code
  Desktop and code-server (and any future host that supports the
  standard webview API).
- Removed `portMapping` and `connect-src` CSP entries (no longer needed).
```

(Replace `2026-05-XX` with today's date when running.)

- [ ] **Step 3: Build VSIX**

Run: `cd packages/vscode-tierkit && pnpm clean && pnpm build && pnpm package:sideload`
Expected: produces `tierkit-vscode-0.8.0.vsix`.

- [ ] **Step 4: Install in Desktop VS Code (manual)**

Run: `cd packages/vscode-tierkit && code --install-extension tierkit-vscode-0.8.0.vsix --force`

If `code` CLI not on PATH, install via VS Code UI: Extensions → ... menu → "Install from VSIX...".

- [ ] **Step 5: Smoke test in Desktop**

Restart VS Code window (or reload). Open the Tierkit activity bar icon. Verify:
1. Sidebar loads with the dashboard (tools / models / agent panels visible).
2. Open the agent chat panel, send a simple prompt ("hello").
3. Observe streaming response and successful completion.
4. Attach an image (if you have one), submit, verify it round-trips.
5. Click "Restart daemon" — should restart cleanly.
6. Check Output → "Tierkit" channel: no obvious errors.

If anything fails, **do not proceed**. Capture the error from the Output channel and the webview devtools (Help → Toggle Developer Tools while sidebar is focused) and report back.

- [ ] **Step 6: Commit version bump**

```bash
git add packages/vscode-tierkit/package.json packages/vscode-tierkit/CHANGELOG.md
git commit -m "chore(vscode): bump to 0.8.0 — code-server compatible

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: code-server verification (docker)

**Files:**
- None to create. This is a manual verification task.

- [ ] **Step 1: Start code-server with the repo mounted**

Run:
```bash
docker run --rm -d --name tk-codeserver \
  -p 8443:8080 \
  -v "$(pwd):/home/coder/project" \
  -v "$(pwd)/packages/vscode-tierkit:/tmp/tk" \
  -e PASSWORD=tk \
  codercom/code-server:latest \
  --bind-addr 0.0.0.0:8080 --auth password /home/coder/project
```

Wait ~5 seconds for startup. Confirm: `docker logs tk-codeserver | tail`

- [ ] **Step 2: Install the VSIX into the code-server**

Run:
```bash
docker exec tk-codeserver code-server --install-extension /tmp/tk/tierkit-vscode-0.8.0.vsix
```

Expected output: "Extension 'tierkit-vscode' v0.8.0 was successfully installed."

- [ ] **Step 3: Open the browser**

Open `http://localhost:8443/` in a browser. Login with password `tk`.

In the file explorer, the workspace should be `/home/coder/project`. Open the Tierkit activity bar icon (left side).

- [ ] **Step 4: Verify sidebar and chat work end-to-end**

Same checklist as Desktop smoke test in Task 10 step 5:
1. Sidebar dashboard renders.
2. Send a test agent prompt — verify SSE chunks stream in.
3. (Optional) Image attachment.

If chat does **not** work, open the browser devtools (F12) → Console / Network tabs. Check the code-server iframe webview for any errors. The most likely failure modes:
- `acquireVsCodeApi` undefined → transport falls back to HTTP and fails (because relative URL doesn't match the daemon). Verify `window.__TIERKIT_HOST__` is set to `"vscode"`.
- Messages not delivered → check that `webviewView.webview.postMessage` from code-server reaches the webview iframe (test by adding a `console.log` in router's `post`).

- [ ] **Step 5: Tear down**

Run: `docker stop tk-codeserver`

- [ ] **Step 6: Document outcome (no commit unless changes required)**

If everything passes, proceed to docs. If not, file follow-up tasks for any issues uncovered.

---

## Task 12: Documentation

**Files:**
- Modify: `docs/INTEGRATIONS.md`

- [ ] **Step 1: Add code-server section**

Append to `docs/INTEGRATIONS.md` (or insert under an appropriate "VS Code" section):

```markdown
## Running in code-server (browser VS Code)

Tierkit's VS Code extension works in [code-server](https://github.com/coder/code-server)
(VS Code in a browser) starting with v0.8.0. The setup is identical to Desktop:

1. Build the VSIX: `cd packages/vscode-tierkit && pnpm package:sideload`
2. Copy the VSIX into your code-server container or host.
3. Install: `code-server --install-extension tierkit-vscode-X.Y.Z.vsix`
4. Open the Tierkit icon in the activity bar.

Under the hood, the sidebar webview communicates with the extension host
via postMessage; the extension host proxies all calls to the daemon
running on `127.0.0.1:4101`. No port forwarding or external daemon URL is
needed — the daemon stays loopback-only on the server.

**Limitation:** `vscode.dev` and other web-only extension hosts are not
supported, because they cannot spawn the Node-based daemon process.
```

- [ ] **Step 2: Commit**

```bash
git add docs/INTEGRATIONS.md
git commit -m "docs(integrations): code-server usage notes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (post-write)

Spec coverage scan:
- §3.1 transport adapter → Tasks 1–5 ✓
- §3.2 message protocol → Tasks 7–9 ✓
- §3.3 fetch site replacements (4 sites) → Task 6 ✓
- §3.4 portMapping/CSP removal → Task 9 ✓
- §3.5 no daemon changes → confirmed, no task touches `Server.ts` or `serverExtension.ts` ✓
- §5 error handling (timeout, abort, message size) → router handles abort/error; timeout intentionally infinite for streams (matches spec)
- §6 test strategy → Tasks 1–5 (transport tests), Tasks 7–8 (router tests), Tasks 10–11 (manual)
- §7 rollout order → Tasks ordered to match: HTTP transport first (no regression), then vscode transport, then host wiring, then portMapping removal
- §9 artifacts → all listed files appear in the plan

Type consistency: `createHttpTransport`/`createVsCodeTransport` factory names, `transport.request`/`transport.stream` method names, `tk:req`/`tk:res`/`tk:chunk`/`tk:done`/`tk:err`/`tk:abort` message types, `getBaseUrl` thunk — used consistently across tasks.

Placeholder scan: no TODOs/TBDs remain.

Scope: one focused unit of work (single PR). No decomposition needed.
