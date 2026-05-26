# Anthropic Gateway Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate that Tierkit can act as a transparent HTTP proxy between Claude Code and the Anthropic Messages API via `ANTHROPIC_BASE_URL`, then answer the three open questions before committing to a production gateway: **(A)** does subscription OAuth survive a redirected base URL, **(B)** what does Claude Code's MCP Tool Search do when the gateway is active (it defaults to off on non-first-party hosts and falls back to preload — we need to verify both modes), **(C)** does the proxy preserve protocol-semantic fidelity for streaming SSE and multi-turn `tool_use` (Claude Code completes its loop without functional failure).

**Architecture:** Add a new module `anthropicGateway.ts` exposing three handlers (non-streaming forward, streaming forward, count-tokens forward). Wire two routes — `POST /v1/messages` and `POST /v1/messages/count_tokens` — into the existing `Server.ts`. Use native `fetch()` to call `https://api.anthropic.com` upstream; preserve the **semantic values** of `anthropic-version`, `anthropic-beta-*`, `x-api-key`, `Authorization`, and `X-Claude-Code-*` headers. (We do not promise wire-level identity: Node lowercases header names, array values get comma-joined, and `fetch()` regenerates transport headers — Phase 0 verifies that none of those transformations break Claude Code.) SSE responses are piped chunk-by-chunk without parsing — the spike's job is "does the protocol work end-to-end", not "is our policy layer good". No compression, no redaction, no UI toggle, no auto-wire — those are Phase 1+.

**Tech Stack:** Node.js `http` (existing), native `fetch()` for upstream (no SDK dependency), vitest for tests. No new npm dependencies. Upstream URL configurable via env `TIERKIT_ANTHROPIC_UPSTREAM` so the integration test can point at a fake server.

**Phase boundary:** This plan covers **Phase 0 (Spike) only**. Phases 1 (UI toggle + auto-wire), 2 (tool_result compression / dedupe / secret redaction), and 3 (provider routing to local LLM) are explicitly out of scope. The spike's last task (Task 13) writes a one-page RFC with go/no-go and the three validation answers; that document gates Phase 1.

**Three validation questions (the spike's actual deliverable):**
- **A. Subscription OAuth.** A user signed in via `claude login` (Pro/Max/Team) — can Tierkit still forward their requests to Anthropic? Or does the upstream call fail without an API key? If A is "no", Phase 1 must support BYOK-only and document the constraint. **Security note:** validation records the *authentication scheme* and a *fingerprint* of any token observed at the proxy — never the verbatim value.
- **B. MCP behavior under gateway.** Two sub-questions, because gateway mode is documented to change Tool Search semantics:
  - **B-1.** With `ANTHROPIC_BASE_URL` set and `ENABLE_TOOL_SEARCH` unset, MCP should fall back to preload mode. Does the tierkit MCP server still connect, and can preloaded tools still be invoked?
  - **B-2.** With `ANTHROPIC_BASE_URL` set and `ENABLE_TOOL_SEARCH=true`, Claude Code attempts `tool_reference`-based search through the proxy. Does the passthrough preserve that flow?
- **C. Protocol-semantic streaming fidelity.** Not byte-equality — the proxy will inevitably re-chunk at the TCP layer because `fetch()` re-emits the stream. What matters: does the proxied stream preserve the Anthropic SSE event sequence (in order, with no duplication or loss), and does Claude Code complete multi-turn `tool_use` workflows without functional failure (file actually fixed, command actually run, no hang, expected request count observed)?

---

## File Structure

**Files to create:**
- `packages/core/src/runtime/anthropicGateway.ts` — three pure functions + header picker
- `packages/core/test/anthropicGateway.test.ts` — unit tests with a `http.Server` fake upstream
- `packages/core/test/Server.anthropicGateway.test.ts` — integration tests against the real `startServer`
- `docs/RFC-anthropic-gateway.md` — one-page RFC capturing validation results (filled by Tasks 10-13)
- `scripts/spike-anthropic-gateway.sh` — manual smoke-test runner (used by Tasks 10-12)

**Files to modify:**
- `packages/core/src/runtime/Server.ts` — register `/v1/messages` and `/v1/messages/count_tokens` routes
- `packages/core/src/index.ts` — re-export anthropicGateway helpers if Server.ts can't import directly (probably unnecessary, but check)

**Files NOT modified in Phase 0:**
- `packages/vscode-tierkit/src/extension.ts` — no auto-wire in spike
- `packages/core/src/runtime/ui/gui.ts` — no UI toggle in spike
- `packages/core/src/usecases/connectClaudeCode.ts` — no env var manipulation in spike
- `packages/vscode-tierkit/CHANGELOG.md` — bump comes in Phase 1, not the spike

---

## Pre-flight checks (run before code tasks + each validation)

Split into three independent gates so a subscription-only user isn't blocked by the BYOK check, and a BYOK-only user isn't asked to set up OAuth flows they don't use.

### Pre-flight A: infrastructure — required for every task

```bash
# Daemon up
curl -sf http://127.0.0.1:4101/v1/health | jq .ok
# Expected: true

# Claude Code CLI present
which claude
claude --version
# Expected: path + version string

# Stray env vars that would confuse later validations
unset CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY   # /v1/models is intentionally out of scope for Phase 0
```

### Pre-flight B: BYOK direct baseline — required only for Task 9 (BYOK validation)

```bash
test -n "${ANTHROPIC_API_KEY:-}" || {
  echo "ANTHROPIC_API_KEY required for BYOK validation only"; exit 1
}
curl -sS https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":16,"messages":[{"role":"user","content":"hi"}]}' \
  | jq .content
# Expected: content array (proves baseline before involving the proxy)
```

### Pre-flight C: subscription direct baseline — required only for Task 10 (OAuth validation)

```bash
unset ANTHROPIC_BASE_URL
unset ANTHROPIC_API_KEY
claude --version          # ensure same CLI as Task 9
claude                    # opens REPL — confirm a direct subscription-authenticated
                          # prompt succeeds BEFORE enabling the gateway, so a Task 10
                          # failure isn't a pre-existing login problem misattributed
                          # to the gateway.
```

Each pre-flight is independent. If A fails, stop. If only B or C fails, skip the corresponding task — not the whole spike.

---

### Task 1: Header picker — forward Anthropic + Claude Code headers, drop hop-by-hop

**Files:**
- Create: `packages/core/src/runtime/anthropicGateway.ts`
- Create: `packages/core/test/anthropicGateway.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/test/anthropicGateway.test.ts
import { describe, it, expect } from "vitest";
import { pickForwardHeaders } from "../src/runtime/anthropicGateway.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @tierkit/core vitest run test/anthropicGateway.test.ts`
Expected: FAIL — `Cannot find module '../src/runtime/anthropicGateway.js'`

- [ ] **Step 3: Implement minimal pickForwardHeaders**

```typescript
// packages/core/src/runtime/anthropicGateway.ts
import type { IncomingHttpHeaders } from "node:http";

/**
 * Header allowlist for the Anthropic-passthrough proxy. Everything else
 * (host, content-length, connection, transfer-encoding, accept-encoding,
 * user-agent of the inbound request, etc.) is dropped — `fetch()` will
 * regenerate the hop-by-hop ones for the upstream call.
 */
const FORWARD_HEADER_NAMES = new Set([
  "content-type",
  "x-api-key",
  "authorization",
  "x-claude-code-session-id",
  "x-claude-code-agent-id",
  "x-claude-code-parent-agent-id",
]);
const FORWARD_HEADER_PREFIXES = ["anthropic-"];

export function pickForwardHeaders(
  reqHeaders: IncomingHttpHeaders,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (v === undefined) continue;
    const lower = k.toLowerCase();
    const value = Array.isArray(v) ? v.join(",") : v;
    if (FORWARD_HEADER_NAMES.has(lower)) out[lower] = value;
    else if (FORWARD_HEADER_PREFIXES.some((p) => lower.startsWith(p))) out[lower] = value;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @tierkit/core vitest run test/anthropicGateway.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/anthropicGateway.ts packages/core/test/anthropicGateway.test.ts
git commit -m "feat(core): anthropicGateway header picker for Anthropic proxy spike"
```

---

### Task 2: Non-streaming forwardMessages

**Files:**
- Modify: `packages/core/src/runtime/anthropicGateway.ts`
- Modify: `packages/core/test/anthropicGateway.test.ts`

- [ ] **Step 1: Write the failing test — fake upstream HTTP server**

Append to `packages/core/test/anthropicGateway.test.ts`:

```typescript
import http from "node:http";
import { AddressInfo } from "node:net";
import { forwardMessages } from "../src/runtime/anthropicGateway.js";

async function startFakeUpstream(handler: (req: http.IncomingMessage, body: Buffer) => { status: number; body: object; headers?: Record<string, string> }): Promise<{ url: string; close: () => Promise<void>; received: () => { headers: http.IncomingHttpHeaders; body: string } }> {
  let receivedHeaders: http.IncomingHttpHeaders = {};
  let receivedBody = "";
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      receivedHeaders = req.headers;
      receivedBody = body.toString("utf8");
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
    close: () => new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())),
    received: () => ({ headers: receivedHeaders, body: receivedBody }),
  };
}

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @tierkit/core vitest run test/anthropicGateway.test.ts`
Expected: FAIL — `forwardMessages is not exported`

- [ ] **Step 3: Implement forwardMessages**

Append to `packages/core/src/runtime/anthropicGateway.ts`:

```typescript
import type { IncomingMessage } from "node:http";

export interface ForwardOptions {
  /** Upstream Anthropic base URL. Defaults to https://api.anthropic.com. */
  upstreamBaseUrl?: string;
  /** Abort signal forwarded into fetch(). */
  signal?: AbortSignal;
}

export interface ForwardResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const DEFAULT_UPSTREAM = "https://api.anthropic.com";

function upstreamUrl(opts: ForwardOptions, path: string): string {
  const base = opts.upstreamBaseUrl ?? process.env.TIERKIT_ANTHROPIC_UPSTREAM ?? DEFAULT_UPSTREAM;
  return base.replace(/\/$/, "") + path;
}

/** Headers we drop from the upstream response before writing to the client.
 *  `content-encoding` and `transfer-encoding` get rebuilt by Node; passing them
 *  through can break decoding on the Claude Code side. */
const RESPONSE_HEADER_BLOCKLIST = new Set(["content-encoding", "transfer-encoding"]);

function pickResponseHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    if (!RESPONSE_HEADER_BLOCKLIST.has(k.toLowerCase())) out[k] = v;
  });
  return out;
}

export async function forwardMessages(
  req: IncomingMessage,
  body: Buffer,
  opts: ForwardOptions = {},
): Promise<ForwardResult> {
  const res = await fetch(upstreamUrl(opts, "/v1/messages"), {
    method: "POST",
    headers: pickForwardHeaders(req.headers),
    body,
    signal: opts.signal,
  });
  return {
    status: res.status,
    headers: pickResponseHeaders(res.headers),
    body: Buffer.from(await res.arrayBuffer()),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @tierkit/core vitest run test/anthropicGateway.test.ts`
Expected: PASS (5 tests total)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/anthropicGateway.ts packages/core/test/anthropicGateway.test.ts
git commit -m "feat(core): forwardMessages — non-streaming Anthropic passthrough"
```

---

### Task 3: Streaming forwardMessages (SSE pipe-through)

**Files:**
- Modify: `packages/core/src/runtime/anthropicGateway.ts`
- Modify: `packages/core/test/anthropicGateway.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/anthropicGateway.test.ts`:

```typescript
import { streamMessages } from "../src/runtime/anthropicGateway.js";

async function startStreamingUpstream(events: string[]): Promise<{ url: string; close: () => Promise<void>; received: () => { headers: http.IncomingHttpHeaders; body: string } }> {
  let receivedHeaders: http.IncomingHttpHeaders = {};
  let receivedBody = "";
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      receivedHeaders = req.headers;
      receivedBody = Buffer.concat(chunks).toString("utf8");
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
    close: () => new Promise((resolve, reject) => server.close((e) => e ? reject(e) : resolve())),
    received: () => ({ headers: receivedHeaders, body: receivedBody }),
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
      // Capture writes to a fake ServerResponse. EventEmitter-shaped so the
      // gateway's `res.once('close', abort)` wiring doesn't blow up.
      const written: Buffer[] = [];
      const { EventEmitter } = await import("node:events");
      const res = Object.assign(new EventEmitter(), {
        setHeader: () => {},
        write: (chunk: Buffer | string) => { written.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk); return true; },
        end: () => {},
        statusCode: 0,
        headersSent: false,
      }) as unknown as http.ServerResponse;
      const req = Object.assign(new EventEmitter(), { headers: { "x-api-key": "sk-x", "anthropic-version": "2023-06-01" } }) as unknown as http.IncomingMessage;
      const body = Buffer.from(JSON.stringify({ model: "m", max_tokens: 4, messages: [{ role: "user", content: "hi" }], stream: true }));
      await streamMessages(req, body, res, { upstreamBaseUrl: upstream.url });
      const piped = Buffer.concat(written).toString("utf8");
      // Exact equality — guarantees order preservation AND no duplication or
      // loss. `toContain` would let an out-of-order or repeated event slip by.
      expect(piped).toBe(events.join(""));
    } finally {
      await upstream.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @tierkit/core vitest run test/anthropicGateway.test.ts`
Expected: FAIL — `streamMessages is not exported`

- [ ] **Step 3: Implement streamMessages**

Append to `packages/core/src/runtime/anthropicGateway.ts`:

```typescript
import type { ServerResponse } from "node:http";

/**
 * Stream an Anthropic Messages request and pipe each SSE chunk to the client.
 * We do NOT parse events here — the spike's job is protocol-semantic
 * fidelity (event sequence + multi-turn tool_use completion), not byte-level
 * identity of TCP framing. Compression / dedupe hook into this function in
 * Phase 2 after Phase 0 confirms the protocol works.
 *
 * Two stability concerns the spike still must address (because they affect
 * whether Claude Code's session stays healthy under load):
 *   1. If the downstream client (Claude Code) disconnects, we must abort the
 *      upstream fetch — otherwise the daemon keeps streaming Anthropic tokens
 *      into the void, leaking memory and burning the user's API credit.
 *   2. If res.write() returns false (downstream buffer full), we must await
 *      'drain' before pushing more — otherwise we silently drop chunks under
 *      slow consumers.
 */
import { once } from "node:events";

export async function streamMessages(
  req: IncomingMessage,
  body: Buffer,
  res: ServerResponse,
  opts: ForwardOptions = {},
): Promise<void> {
  // Wire client-side disconnects (req aborted or res closed early) to abort
  // the upstream fetch. Use a fresh controller unless the caller supplied
  // their own signal.
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  const signal = opts.signal ?? controller.signal;

  try {
    const upstreamRes = await fetch(upstreamUrl(opts, "/v1/messages"), {
      method: "POST",
      headers: pickForwardHeaders(req.headers),
      body,
      signal,
    });

    // Mirror upstream status + headers (minus the blocked hop-by-hop ones).
    for (const [k, v] of Object.entries(pickResponseHeaders(upstreamRes.headers))) {
      res.setHeader(k, v);
    }
    res.statusCode = upstreamRes.status;

    if (!upstreamRes.body) {
      res.end();
      return;
    }
    const reader = upstreamRes.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const writable = res.write(Buffer.from(value));
        if (!writable) {
          // Wait for the consumer to drain before reading the next chunk.
          // Without this, fast upstream + slow downstream silently truncates.
          await once(res, "drain");
        }
      }
    } finally {
      res.end();
    }
  } finally {
    req.off("aborted", abort);
    res.off("close", abort);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @tierkit/core vitest run test/anthropicGateway.test.ts`
Expected: PASS (6 tests total)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/anthropicGateway.ts packages/core/test/anthropicGateway.test.ts
git commit -m "feat(core): streamMessages — SSE passthrough preserves event bytes"
```

---

### Task 4: forwardCountTokens

**Files:**
- Modify: `packages/core/src/runtime/anthropicGateway.ts`
- Modify: `packages/core/test/anthropicGateway.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/anthropicGateway.test.ts`:

```typescript
import { forwardCountTokens } from "../src/runtime/anthropicGateway.js";

describe("forwardCountTokens", () => {
  it("forwards to /v1/messages/count_tokens and returns the upstream JSON", async () => {
    const upstream = await startFakeUpstream((req) => {
      // Verify the upstream URL path was the count-tokens variant.
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -F @tierkit/core vitest run test/anthropicGateway.test.ts`
Expected: FAIL — `forwardCountTokens is not exported`

- [ ] **Step 3: Implement forwardCountTokens**

Append to `packages/core/src/runtime/anthropicGateway.ts`:

```typescript
export async function forwardCountTokens(
  req: IncomingMessage,
  body: Buffer,
  opts: ForwardOptions = {},
): Promise<ForwardResult> {
  const res = await fetch(upstreamUrl(opts, "/v1/messages/count_tokens"), {
    method: "POST",
    headers: pickForwardHeaders(req.headers),
    body,
    signal: opts.signal,
  });
  return {
    status: res.status,
    headers: pickResponseHeaders(res.headers),
    body: Buffer.from(await res.arrayBuffer()),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -F @tierkit/core vitest run test/anthropicGateway.test.ts`
Expected: PASS (7 tests total)

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/anthropicGateway.ts packages/core/test/anthropicGateway.test.ts
git commit -m "feat(core): forwardCountTokens — count-tokens passthrough"
```

---

### Task 5: Wire `POST /v1/messages` route in Server.ts (branch on `stream`)

**Files:**
- Modify: `packages/core/src/runtime/Server.ts`

- [ ] **Step 1: Locate the right insertion point**

Open `packages/core/src/runtime/Server.ts`. Find the existing OpenAI-compatible route (`POST /v1/openai/chat/completions`). Insert the new Anthropic route directly after it — the two are conceptually paired (both are "client compatibility shims" for different agent ecosystems).

Run: `grep -n "POST /v1/openai/chat/completions" packages/core/src/runtime/Server.ts`
Expected: One line number — call it `L`. The new route insertion goes at the next blank line below the closing of that handler.

- [ ] **Step 2: Add the route handler**

In `packages/core/src/runtime/Server.ts`, after the existing OpenAI handler:

```typescript
// Anthropic Gateway Phase 0 spike (branch only — not shipped to users yet):
// Transparent passthrough so Claude Code can be pointed at Tierkit via
// ANTHROPIC_BASE_URL=http://127.0.0.1:4101. No compression, no redaction,
// no UI, no auto-wire — those land in Phase 1+ after the spike's RFC
// answers the three open validation questions. See docs/RFC-anthropic-gateway.md.
if (route === "POST /v1/messages") {
  const body = await readRawBody(req);
  const wantsStream = isStreamingMessagesBody(body);
  try {
    if (wantsStream) {
      await streamMessages(req, body, res);
      return;
    }
    const r = await forwardMessages(req, body);
    for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    res.statusCode = r.status;
    res.end(r.body);
    return;
  } catch (err) {
    // If we already started streaming (headers or chunks sent), we cannot
    // pivot to a JSON 502 — the client would see a mixed-protocol response.
    // Destroy the socket instead; Claude Code surfaces this as a network
    // error, which is the honest signal.
    if (res.headersSent) {
      res.destroy(err as Error);
      return;
    }
    return sendJson(res, 502, { type: "error", error: { type: "upstream_error", message: (err as Error).message } });
  }
}
```

Also add the import at the top of the file (find the existing core-module import block):

```typescript
import { forwardMessages, streamMessages, forwardCountTokens } from "./anthropicGateway.js";
```

- [ ] **Step 3: Add the two helpers if they don't already exist**

Search for `readRawBody` and `isStreamingMessagesBody`:

```bash
grep -n "function readRawBody\|isStreamingMessagesBody" packages/core/src/runtime/Server.ts
```

`readRawBody` likely doesn't exist (existing code uses `readJsonBody`). Add it near other body helpers:

```typescript
async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

function isStreamingMessagesBody(body: Buffer): boolean {
  // MUST be a real JSON parse, not a regex. A user message that contains the
  // text `"stream": true` would false-positive a regex check — and the
  // proxy would switch to streaming mode against a non-streaming request,
  // hanging Claude Code. Parse once for the decision; the upstream call
  // still gets the ORIGINAL Buffer (never our re-serialized form).
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { stream?: unknown };
    return parsed.stream === true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Sanity-check the file still parses**

Run: `pnpm -F @tierkit/core typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/Server.ts
git commit -m "feat(core): POST /v1/messages — Anthropic passthrough route"
```

---

### Task 6: Wire `POST /v1/messages/count_tokens` route

**Files:**
- Modify: `packages/core/src/runtime/Server.ts`

- [ ] **Step 1: Add the route immediately after `POST /v1/messages`**

```typescript
if (route === "POST /v1/messages/count_tokens") {
  const body = await readRawBody(req);
  try {
    const r = await forwardCountTokens(req, body);
    for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
    res.statusCode = r.status;
    res.end(r.body);
  } catch (err) {
    return sendJson(res, 502, { type: "error", error: { type: "upstream_error", message: (err as Error).message } });
  }
  return;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm -F @tierkit/core typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/runtime/Server.ts
git commit -m "feat(core): POST /v1/messages/count_tokens — passthrough"
```

---

### Task 7: Server integration test (real Server + fake upstream)

**Files:**
- Create: `packages/core/test/Server.anthropicGateway.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/test/Server.anthropicGateway.test.ts
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
        // Branch on path so the count_tokens test can assert the route wiring.
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
    await new Promise<void>((resolve, reject) => upstream.close((e) => e ? reject(e) : resolve()));
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
    expect(lastUpstream.headers["x-api-key"]).toBe("sk-int-test");
    expect(lastUpstream.headers["anthropic-version"]).toBe("2023-06-01");
    expect(lastUpstream.headers["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
    // Host header must NOT be the downstream's (api.anthropic.com would error on this in real use)
    expect(lastUpstream.headers["host"]).not.toBe("127.0.0.1:4101");
  });

  it("count_tokens: forwards to /v1/messages/count_tokens on upstream", async () => {
    const r = await fetch(`${url}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-x", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(200);
    // The upstream branches on URL; assert it actually saw the count-tokens path.
    // Without this the route could silently forward to /v1/messages and the test
    // would still appear green.
    expect(lastUpstream.url).toBe("/v1/messages/count_tokens");
    expect(lastUpstream.method).toBe("POST");
    const json = await r.json();
    expect(json.input_tokens).toBe(12);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (the routes don't exist yet only if Tasks 5+6 weren't done)**

Run: `pnpm -F @tierkit/core vitest run test/Server.anthropicGateway.test.ts`

If Tasks 5 and 6 were done correctly, this should PASS. If not, fix Tasks 5 or 6 before continuing.

- [ ] **Step 3: Run full suite to make sure no regressions**

Run: `pnpm -F @tierkit/core vitest run`
Expected: all 978+ tests pass (976 prior + ~10 new).

- [ ] **Step 4: Commit**

```bash
git add packages/core/test/Server.anthropicGateway.test.ts
git commit -m "test(core): integration test for /v1/messages passthrough"
```

---

### Task 8: Smoke-test script for manual validation

**Files:**
- Create: `scripts/spike-anthropic-gateway.sh`

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Manual smoke test for the Anthropic gateway spike.
# Usage:
#   ANTHROPIC_API_KEY=sk-... ./scripts/spike-anthropic-gateway.sh
#
# Prerequisites:
#   - Tierkit daemon is running on 127.0.0.1:4101 (check: curl -sf http://127.0.0.1:4101/v1/health)
#   - ANTHROPIC_API_KEY is set in the current shell (for BYOK path; subscription users see Task 10)
#   - `jq` is installed
set -euo pipefail

BASE="${TIERKIT_BASE:-http://127.0.0.1:4101}"
KEY="${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY must be set}"

echo "==> 1. Non-streaming round-trip via Tierkit"
curl -sS -X POST "$BASE/v1/messages" \
  -H "x-api-key: $KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":32,"messages":[{"role":"user","content":"reply with exactly the word OK"}]}' \
  | jq '.content'
echo

echo "==> 2. Streaming round-trip via Tierkit (raw SSE — should see message_start, deltas, message_stop)"
curl -sS -N -X POST "$BASE/v1/messages" \
  -H "x-api-key: $KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -H "accept: text/event-stream" \
  -d '{"model":"claude-haiku-4-5","max_tokens":32,"stream":true,"messages":[{"role":"user","content":"reply with exactly the word OK"}]}'
echo
echo

echo "==> 3. count_tokens via Tierkit"
curl -sS -X POST "$BASE/v1/messages/count_tokens" \
  -H "x-api-key: $KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","messages":[{"role":"user","content":"hi"}]}' \
  | jq .
echo

echo "==> 4. Auth-failure passthrough (401 should propagate verbatim)"
curl -sS -X POST "$BASE/v1/messages" \
  -H "x-api-key: sk-deliberately-invalid" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-haiku-4-5","max_tokens":4,"messages":[{"role":"user","content":"x"}]}' \
  -o /tmp/tierkit-spike-401.json -w "HTTP %{http_code}\n"
cat /tmp/tierkit-spike-401.json | jq .
echo

echo "All four checks passed if you see real content, SSE chunks, an input_tokens number, and a 401 with an Anthropic-shaped error body."
```

- [ ] **Step 2: Make it executable and run it**

```bash
chmod +x scripts/spike-anthropic-gateway.sh
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" ./scripts/spike-anthropic-gateway.sh
```

Expected: All four checks produce sensible output. If any fail, debug before continuing to Task 9.

- [ ] **Step 3: Commit**

```bash
git add scripts/spike-anthropic-gateway.sh
git commit -m "chore(spike): manual smoke-test script for anthropic gateway"
```

---

### Task 9: Smoke test with real Claude Code (BYOK / API key path)

**Files:** none (manual procedure)

This is the first end-to-end Claude Code test. We use the BYOK path (ANTHROPIC_API_KEY env var) because it's the simpler case — subscription OAuth is Task 10.

- [ ] **Step 1: Open a fresh shell and configure**

```bash
# Make sure no stale Claude Code login is interfering — we want pure BYOK.
unset CLAUDE_CODE_OAUTH_TOKEN
export ANTHROPIC_API_KEY="sk-..."           # your real key
export ANTHROPIC_BASE_URL="http://127.0.0.1:4101"

# Sanity: confirm the daemon is up.
curl -sf "$ANTHROPIC_BASE_URL/v1/health" | jq .ok
# Expected: true
```

- [ ] **Step 2: Tail the daemon log in a side terminal**

```bash
# In a separate terminal — find the daemon's stdout. If running as a VS Code
# auto-start, this is the "Tierkit" Output channel inside VS Code. If running
# from CLI, the log goes to your terminal.
```

- [ ] **Step 3: Run Claude Code against Tierkit**

```bash
cd /tmp
mkdir -p tierkit-spike && cd tierkit-spike
claude
```

In the Claude Code REPL, type:

```
ask: reply with exactly the word OK
```

Expected: Claude replies with `OK` (or close to it). The Tierkit daemon log shows a `POST /v1/messages` entry. The roundtrip should complete in normal time (no perceptible added latency).

- [ ] **Step 4: Try a multi-turn with a tool call**

```
ask: list the files in the current directory
```

Expected: Claude calls its built-in `Read` / `Bash` / `ls` tool. The conversation continues normally. Tierkit log shows multiple `POST /v1/messages` entries (one per turn).

- [ ] **Step 5: Record observations**

Open `docs/RFC-anthropic-gateway.md` (create if missing). Add a section:

```markdown
### Validation: BYOK passthrough (Task 9)

- Date: <YYYY-MM-DD>
- Tierkit version: <git rev-parse --short HEAD>
- Claude Code version: <claude --version>
- ANTHROPIC_BASE_URL: http://127.0.0.1:4101

Result:
- [ ] simple round-trip (`OK`) works
- [ ] multi-turn with tool_use works
- [ ] no perceptible added latency
- [ ] Tierkit log shows all expected POST /v1/messages entries

Notes:
- <anything surprising>
```

- [ ] **Step 6: Commit findings**

```bash
git add docs/RFC-anthropic-gateway.md
git commit -m "docs(spike): record Task 9 BYOK validation results"
```

---

### Task 10: Validation A — Subscription OAuth user

**Files:** none (manual procedure)

This is the question the critic flagged as needing real verification: can a user signed in via `claude login` (Pro/Max/Team subscription) actually use Tierkit as a proxy?

**Hypothesis to test:** When Claude Code uses subscription OAuth and `ANTHROPIC_BASE_URL` points at Tierkit, does Claude Code include a reusable Authorization credential in the gateway-bound request, and does forwarding that credential verbatim allow the upstream Anthropic Messages request to succeed?

(The proxy doesn't *attach* credentials — it forwards whatever Claude Code sent. So failure can come from either side: Claude Code may not send a credential to a custom base URL at all, OR Anthropic may not accept a forwarded subscription credential.)

The two failure modes have different Phase 1 implications:
- **Claude Code sends no credential to custom base URL** → subscription is fundamentally incompatible with gateway mode; Phase 1 = BYOK-only with detect-and-warn.
- **Credential sent but Anthropic rejects forwarded value** → may be fixable with a credential-exchange bridge; Phase 1 needs additional design.

- [ ] **Step 1: Configure for subscription path**

```bash
# Clear any BYOK env var so it doesn't override.
unset ANTHROPIC_API_KEY
unset CLAUDE_CODE_OAUTH_TOKEN  # only if not signed in via claude login
export ANTHROPIC_BASE_URL="http://127.0.0.1:4101"

# Verify subscription login is active
claude config get
# Expected: shows a subscription credential, not an API key
```

- [ ] **Step 2: Try Claude Code with gateway on**

```bash
cd /tmp/tierkit-spike
claude
```

In the REPL:
```
ask: reply with exactly the word OK
```

- [ ] **Step 3: Observe and record — SAFELY**

Possible outcomes and what they mean:

| Outcome | Interpretation |
|---|---|
| Claude replies normally | Tierkit is forwarding credentials correctly. Record the *scheme* + *fingerprint*, never the verbatim token. |
| Upstream 401 from Anthropic | Subscription OAuth doesn't survive the proxy. As predicted. Phase 1 = BYOK only. |
| Claude Code refuses to start ("not authenticated") | Claude Code's own preflight blocks gateway use for subscription. Document. |
| Mixed (preflight OK, requests fail) | Most likely. Document the exact upstream error code (not the request body). |

**Safe observation via `observeAuthHeaders`** — the spike includes a helper at `packages/core/src/runtime/anthropicGateway.ts::observeAuthHeaders(headers)` that returns:

```ts
{
  hasAuthorization: boolean,
  authorizationScheme: "Bearer" | "Basic" | ... | null,
  authorizationFingerprint: "3a7f9e0c4b21" | null,   // sha256(value)[:12]
  hasApiKey: boolean,
  apiKeyFingerprint: "f04b1c8a3e22" | null,
}
```

Wire it in temporarily for this task only:

```ts
// At the top of the /v1/messages handler in Server.ts, gated by env so it
// doesn't run in production:
if (process.env.TIERKIT_ANTHROPIC_SPIKE_DIAGNOSTICS === "1") {
  console.log("[spike] auth observation:", observeAuthHeaders(req.headers));
}
```

```bash
export TIERKIT_ANTHROPIC_SPIKE_DIAGNOSTICS=1
# Restart the spike daemon, run Task 10, copy the printed observation
# objects into the RFC verbatim — they're already safe to share.
```

**Alternative if you don't want to edit the daemon temporarily:** run the helper directly against a curl-captured header. Use shell sha256:

```bash
# From a curl -v output that shows the request you want to fingerprint:
echo -n 'Bearer THE_TOKEN_GOES_HERE' | shasum -a 256 | cut -c 1-12
# Example output: 3a7f9e0c4b21
```

Add to `docs/RFC-anthropic-gateway.md`:

```markdown
### Validation A: Subscription OAuth (Task 10)

- Claude Code authentication mode: subscription login / BYOK / unknown
- ANTHROPIC_API_KEY set: yes / no
- ANTHROPIC_AUTH_TOKEN set: yes / no
- Authorization header received by Tierkit: absent / bearer-present / other-scheme
- Authorization fingerprint (sha256, first 12 hex): <e.g. 3a7f9e0c4b21>
- x-api-key header received by Tierkit: absent / present
- x-api-key fingerprint (sha256, first 12 hex): <e.g. f04b1c8a3e22>
- Upstream response: HTTP <status>, error type only (e.g. "authentication_error")

Decision:
- [ ] subscription credential passes through successfully (Phase 1 can support subscription users)
- [ ] only API-key/BYOK mode works (Phase 1 must detect-and-warn for subscription users)
- [ ] result inconclusive — additional credential-flow investigation needed before Phase 1
```

**Hard rule for this task and the RFC:** under no circumstance paste the verbatim Authorization or x-api-key value into git-tracked files, daemon logs, screenshots, or chat. If you accidentally do, rotate the credential immediately.

- [ ] **Step 4: Commit findings**

```bash
git add docs/RFC-anthropic-gateway.md
git commit -m "docs(spike): record Task 10 subscription OAuth validation results"
```

---

### Task 11: Validation B — MCP coexistence + Tool Search mode

**Files:** none (manual procedure)

The previous version of this task asked "does MCP still work" as a single yes/no question. That misses what actually changes: Anthropic's docs say that when `ANTHROPIC_BASE_URL` points at a non-first-party host, Claude Code **defaults `ENABLE_TOOL_SEARCH` to off** and falls back to *preloading* MCP tools rather than searching for them on demand. The MCP server connection itself is not the variable — Tool Search behavior is. Phase 1's design depends on which of three end-states we land in:

- Both preload and `ENABLE_TOOL_SEARCH=true` work → Phase 1 can offer either mode
- Only preload works → Phase 1 must document "Tool Search disabled under gateway" and surface it
- MCP connection itself breaks → Phase 1 must offer gateway OR MCP, not both

So this task runs **two sub-scenarios**, B-1 and B-2.

#### B-1: Default behavior (gateway on, Tool Search unset)

- [ ] **Step 1: Configure for default fallback**

```bash
unset ENABLE_TOOL_SEARCH                       # default behavior
export ANTHROPIC_BASE_URL="http://127.0.0.1:4101"
export ANTHROPIC_API_KEY="sk-..."
cd /Users/you/code/Tierkit                     # workspace with tierkit MCP wired (.mcp.json + CLAUDE.md)
claude
```

- [ ] **Step 2: In the REPL, check status**

```
/mcp
```

Record the tierkit server status (connected / loading / failed / missing).

- [ ] **Step 3: Identify an actually-exposed read-only Tierkit tool, then invoke it**

The MCP surface evolves between versions. Before constructing the prompt, list what's actually loaded — never assume a specific tool name. Then pick the first matching read-only candidate from this priority list:

1. `tierkit.read_file`
2. `tierkit.get_file_digest`
3. `tierkit.codebase_search`
4. `tierkit.get_policy_status`

In the REPL:
```
/mcp
```

Note which tools are listed under `tierkit`. Pick the highest-priority one that's present. Then:

```
Use the available Tierkit MCP read-only tool to read or inspect
packages/core/src/runtime/anthropicGateway.ts. Do not use built-in file tools.
```

Observe:
- Does Claude pick the tierkit tool? (model-dependent — prompt explicitly if needed)
- Which tool did it pick? Record the name.
- Does the call succeed?
- Does `.tierkit/runtime/usage.jsonl` get a new `mcp-tool` entry?
- What evidence (if any) suggests Claude is using preloaded tools vs. on-demand search? (e.g., size of initial system prompt)

#### B-2: Tool Search forced on (gateway on, ENABLE_TOOL_SEARCH=true)

- [ ] **Step 4: Reconfigure**

```bash
export ENABLE_TOOL_SEARCH=true
# All other env vars unchanged from B-1
claude
```

- [ ] **Step 5: Repeat the `/mcp` check and tool invocation**

Same prompts as Steps 2–3.

Observe additionally:
- Does Claude Code surface any `tool_reference`-related errors in its output or in the Tierkit daemon log?
- Does the proxy preserve any new request shape that didn't appear under B-1 (e.g., `tool_reference` content blocks in the request body)?

- [ ] **Step 6: Record findings in RFC**

```markdown
### Validation B: MCP coexistence and Tool Search mode (Task 11)

#### B-1: Default gateway behavior
- ANTHROPIC_BASE_URL: enabled
- ENABLE_TOOL_SEARCH: unset
- /mcp tierkit server status: connected / loading / failed / missing
- Tool loading mode observed: preloaded / search / unknown
- tierkit MCP tool invocation: succeeded / failed
- usage.jsonl mcp-tool entry written: yes / no

#### B-2: Forced Tool Search behavior
- ANTHROPIC_BASE_URL: enabled
- ENABLE_TOOL_SEARCH: true
- /mcp tierkit server status: connected / loading / failed / missing
- Tool Search invocation observed: yes / no / not surfaced
- tool_reference-related error: none / observed (details below)
- tierkit MCP tool invocation after search: succeeded / failed
- Proxy needed to forward any request shape it didn't see in B-1: yes / no

Decision:
- [ ] Gateway and MCP coexist in fallback preload mode only (Phase 1 = leave Tool Search off)
- [ ] Gateway and MCP coexist with Tool Search enabled (Phase 1 = optional toggle)
- [ ] MCP connection itself breaks under gateway (Phase 1 = mutually exclusive modes)
```

- [ ] **Step 7: Commit findings**

```bash
git add docs/RFC-anthropic-gateway.md
git commit -m "docs(spike): record Task 11 MCP coexistence + Tool Search results"
```

---

### Task 12: Validation C — Protocol-semantic streaming fidelity in a real conversation

**Files:** none (manual procedure)

This catches the failure mode where the proxy looks fine for simple cases but corrupts something in a multi-turn `tool_use` loop — reorders SSE events, drops a `content_block_stop`, splits a JSON chunk across the buffer boundary, etc.

**Important framing**: we are NOT checking whether the natural-language final assistant message is byte-identical to a direct-Anthropic call. Claude's free-text outputs are non-deterministic — that comparison generates false negatives. We are checking *protocol-semantic fidelity*: the SSE event sequence is order-preserving and complete, the `tool_use` → `tool_result` loop closes, and the observable side-effects (files actually modified, commands actually run) match what a successful turn requires.

The fully-automated half of Validation C is the `expect(piped).toBe(events.join(""))` assertion in the Task 3 unit test. This task is the harder human-in-the-loop half: does the integration survive a real Claude Code session?

- [ ] **Step 1: Run a known-multi-turn task (gateway ON)**

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:4101"
export ANTHROPIC_API_KEY="sk-..."
cd /tmp/tierkit-spike
echo "module.exports = function broken() { return 1 + }" > broken.js
claude
```

> **Note on request counting:** the original draft suggested computing `BEFORE_REQS / AFTER_REQS` deltas against a daemon log file, but the spike intentionally does NOT add a gateway request log (that's Phase 2 work behind the safe-logging guardrails of `observeAuthHeaders`). For Phase 0, the qualitative check is "did POST /v1/messages requests happen at all?" rather than a precise count — observe via the OS-level activity (`lsof -i :4101` periodically, or the VS Code Tierkit Output channel if visible) and record yes/no in the table below.

In the REPL:
```
fix the syntax error in broken.js, then verify by running node broken.js
```

This forces Claude to: Read → reason → Edit → Bash → reason → reply. Many turns, all using `tool_use`.

- [ ] **Step 2: Record gateway-on functional outcome**

Capture these specific signals (NOT the natural-language assistant reply):

| Signal | How to check | Pass criterion |
|---|---|---|
| File actually fixed | `cat broken.js` | Contains a valid JS expression (e.g. `return 1 + 1`) |
| Verification command ran | Did Claude actually invoke `node broken.js`? | Exit code 0 reported back to Claude |
| Session terminated cleanly | Claude returned control or said "done" | No hang, no timeout |
| `tool_use` loop closed for every tool call | Claude Code's own turn display (each tool_use should produce a subsequent tool_result message) | No "orphan" tool_use without follow-up |
| Some POST /v1/messages requests reached the gateway | OS-level: `lsof -i :4101` during the session shows active connections, OR VS Code Tierkit Output channel shows incoming requests | At least one observed |

- [ ] **Step 3: Run the same task with gateway OFF (baseline)**

```bash
unset ANTHROPIC_BASE_URL
cd /tmp/tierkit-spike
echo "module.exports = function broken() { return 1 + }" > broken.js   # reset
claude
```

Same prompt. Same five signals above. The point of the baseline is **not** "do the natural-language replies match" — they won't — but to confirm the functional outcome is reachable for this task at all (in case the model just can't fix this kind of bug today, gateway-irrelevant).

- [ ] **Step 4: Record findings**

```markdown
### Validation C: Protocol-semantic streaming fidelity (Task 12)

Functional outcome — gateway ON:
- broken.js fixed to valid JS: yes / no
- Claude invoked `node broken.js`: yes / no
- Reported exit code: 0 / non-zero / not observed
- Session terminated cleanly: yes / no (hang)
- All tool_use blocks paired with tool_result: yes / no (orphan count: <n>)
- POST /v1/messages reached gateway: yes (count if easy) / no

Functional outcome — gateway OFF (baseline):
- broken.js fixed to valid JS: yes / no
- Claude invoked `node broken.js`: yes / no
- Reported exit code: 0 / non-zero / not observed
- Session terminated cleanly: yes / no
- POST requests went directly to api.anthropic.com: yes / no

Differences observed under gateway-on that DON'T appear in baseline:
- <list any: extra retries, malformed events seen in daemon log, partial tool_result, etc.>

Decision:
- [ ] Protocol-semantic fidelity confirmed — functional outcomes match, no proxy-specific errors. Phase 1 OK.
- [ ] Minor non-functional differences (e.g. timing, retry count). Phase 1 OK but document.
- [ ] Functional break under gateway. Fix anthropicGateway.ts before Phase 1.
```

- [ ] **Step 5: Commit findings**

```bash
git add docs/RFC-anthropic-gateway.md
git commit -m "docs(spike): record Task 12 protocol-semantic fidelity results"
```

---

### Task 13: Spike RFC — synthesize results, decide go/no-go for Phase 1

**Files:**
- Modify: `docs/RFC-anthropic-gateway.md`

- [ ] **Step 1: Read the three validation sections you wrote in Tasks 10-12**

Open `docs/RFC-anthropic-gateway.md`. Make sure all three sections (A/B/C) have outcomes recorded.

- [ ] **Step 2: Add an Executive Summary at the top**

```markdown
# RFC: Anthropic Gateway

Status: Experimental spike branch — not shipped in a Tierkit release
Target release if promoted: v0.23.0 or later
Phase 1 recommendation: <RECOMMENDED / BLOCKED / NEEDS-DESIGN>

## Executive Summary

Tierkit can intercept Claude Code's Anthropic Messages API calls via
ANTHROPIC_BASE_URL with <high / medium / low — fill in based on Task 9> confidence.
The three open questions from the 2026-05-26 design discussion resolved as follows:

| Question | Outcome | Implication for Phase 1 |
|---|---|---|
| A: Subscription OAuth (Task 10) | <one of: passes through, BYOK-only, inconclusive> | <Phase 1 supports both modes / Phase 1 BYOK-only with detect-and-warn / Phase 1 paused pending credential investigation> |
| B-1: Default MCP fallback (Task 11) | <connected/preloaded works, or broken> | <No mitigation / Tool Search disabled by design under gateway / MCP mode toggle required> |
| B-2: ENABLE_TOOL_SEARCH=true (Task 11) | <Tool Search proxies cleanly, or breaks> | <Phase 1 exposes ENABLE_TOOL_SEARCH toggle / Phase 1 explicitly leaves it off> |
| C: Protocol-semantic fidelity (Task 12) | <functional outcomes match, minor non-functional diffs, or break> | <Phase 1 OK / Phase 1 OK with documented caveats / fix anthropicGateway.ts first> |

## Recommendation

<2-3 sentences. Examples:
- "Proceed to Phase 1 (UI toggle + ANTHROPIC_BASE_URL auto-wire) with BYOK-only support and a clear in-UI message for subscription users. MCP coexists in preload mode; Tool Search stays off by default. Protocol-semantic fidelity confirmed for the broken.js multi-turn case."
- "Do not proceed to Phase 1 yet. Multi-turn tool_use loses tool_result blocks intermittently under gateway. Spike needs a follow-up to identify whether the issue is chunk reassembly or content_block_stop timing.">
```

- [ ] **Step 3: Add the "what Phase 1 looks like now" subsection**

Based on the spike results, sketch the Phase 1 plan in 5-10 bullets. Examples:
- VS Code extension auto-sets ANTHROPIC_BASE_URL on activation when "Gateway mode" is enabled
- Sidebar toggle "Route Claude Code through Tierkit" (off by default, opt-in)
- If subscription user detected → disable toggle with explanation
- Usage logging in `.tierkit/runtime/usage.jsonl` per /v1/messages call
- Health endpoint reports gateway status

DO NOT plan Phase 1 in detail here — that's a separate plan. Just bullet the scope.

- [ ] **Step 4: Commit the RFC**

```bash
git add docs/RFC-anthropic-gateway.md
git commit -m "docs(spike): RFC executive summary + Phase 1 sketch"
```

- [ ] **Step 5: Open a GitHub Discussion or PR for review**

The spike is complete. Push the branch and either:
- Open a draft PR titled "spike: Anthropic gateway — Phase 0 results" with the RFC and code as the artifact for human review
- Or paste the RFC into a GitHub Discussion under the Tierkit repo for async review

Do NOT merge to main until a human reviewer signs off on the Phase 1 go/no-go.

---

## Self-Review Checklist

After implementing through Task 13, before declaring the spike done:

- [ ] All 7 tasks of code work merged into the spike branch
- [ ] `pnpm -F @tierkit/core vitest run` passes (978+ tests)
- [ ] `pnpm -F @tierkit/core typecheck` clean
- [ ] `scripts/spike-anthropic-gateway.sh` runs cleanly with valid API key
- [ ] `docs/RFC-anthropic-gateway.md` has filled-in sections A, B, C
- [ ] Executive Summary and Recommendation in the RFC are concrete (no "TBD")
- [ ] Branch is pushed, PR or Discussion is open for human review
- [ ] CHANGELOG / version bump NOT done (spike does not ship to users)

## What This Spike Does NOT Do

Explicitly out of scope — these are Phase 1+ work and should not creep in:
- Auto-setting `ANTHROPIC_BASE_URL` from the VS Code extension
- Any UI toggle, sidebar card, or status indicator
- Compression, redaction, dedupe, or any tool_result transformation
- Routing requests to local LLMs based on policy
- Counting tokens or computing savings from gateway traffic
- Version bump / npm publish / vsix release
- Documentation in the user-facing README

If you find yourself adding any of the above during this spike, stop — you're scope-creeping. File it as a Phase 1 item in the RFC and continue with the spike.
