# Savings SSE stream Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Savings card's 5-second polling with a server-pushed SSE stream so the sidebar updates within ~100 ms of any MCP compression tool call.

**Architecture:** A new module `savingsBroadcaster` holds the subscriber set + 30s heartbeat. `logMcpActivity` calls an injected listener after each append; the listener calls `broadcaster.broadcast()`. A new `GET /v1/tierkit/savings/stream` endpoint subscribes the HTTP response to the broadcaster. The webview's existing `transport.stream()` consumes the stream and feeds events into a new `renderSavings(summary)` helper extracted from `refreshSavings()`.

**Tech Stack:** TypeScript, Node http, vitest, tsup (no runtime deps added). Reuses the existing chat-SSE pattern in `Server.ts:546+` and the webview message-router proxy in `messageRouter.ts:streamProxy`.

**Reference spec:** `docs/superpowers/specs/2026-05-24-savings-sse-stream-design.md`.

---

## Task 1: Extract `resolveSavingsBaseline` helper

The baseline-resolution heuristic (which model profile to use for the `$/M input` multiplier) currently lives inline inside the `GET /v1/tierkit/savings/today` handler at `Server.ts:896-930`. The broadcaster (Task 3) needs the same logic. Pull it into `tierkitSavings.ts` first so the broadcaster has something to call.

**Files:**
- Modify: `packages/core/src/runtime/tierkitSavings.ts` (add export)
- Modify: `packages/core/src/runtime/Server.ts:896-943` (consume helper)
- Test: `packages/core/test/resolveSavingsBaseline.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/resolveSavingsBaseline.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveSavingsBaseline } from "../src/runtime/tierkitSavings.js";
import type { TierkitConfig } from "../src/config/TierkitConfig.js";

const cfg = (profiles: Record<string, any>, baseline?: string): TierkitConfig =>
  ({ modelProfiles: profiles, routingBaseline: baseline } as unknown as TierkitConfig);

describe("resolveSavingsBaseline", () => {
  it("uses routingBaseline when it has per-token cost", () => {
    const out = resolveSavingsBaseline(cfg({
      claudeSonnet: { provider: "anthropic", cost: { type: "per-token", inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
    }, "claudeSonnet"));
    expect(out.baselineId).toBe("claudeSonnet");
    expect(out.inputUsdPerMillion).toBe(3);
  });

  it("falls back to a same-family priced profile when baseline is flat-rate", () => {
    const out = resolveSavingsBaseline(cfg({
      claudeCode: { provider: "claude-code", cost: { type: "flat", monthlyUsd: 20 } },
      claudeSonnet: { provider: "anthropic", cost: { type: "per-token", inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
      gpt4o: { provider: "openai", cost: { type: "per-token", inputUsdPerMillion: 5, outputUsdPerMillion: 15 } },
    }, "claudeCode"));
    expect(out.baselineId).toBe("claudeSonnet");
    expect(out.inputUsdPerMillion).toBe(3);
  });

  it("returns inputUsdPerMillion=undefined when no priced profile exists", () => {
    const out = resolveSavingsBaseline(cfg({
      localCoder: { provider: "ollama", cost: { type: "free" } },
    }, "localCoder"));
    expect(out.baselineId).toBe("localCoder");
    expect(out.inputUsdPerMillion).toBeUndefined();
  });

  it("defaults to claudeCode baseline when routingBaseline is unset", () => {
    const out = resolveSavingsBaseline(cfg({
      claudeCode: { provider: "claude-code" },
      claudeSonnet: { provider: "anthropic", cost: { type: "per-token", inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
    }));
    expect(out.baselineId).toBe("claudeSonnet"); // falls back from default claudeCode
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tierkit/core test -- resolveSavingsBaseline.test`
Expected: FAIL — `resolveSavingsBaseline` is not exported from `tierkitSavings.js`.

- [ ] **Step 3: Implement `resolveSavingsBaseline`**

Append to `packages/core/src/runtime/tierkitSavings.ts`:

```typescript
import type { TierkitConfig } from "../config/TierkitConfig.js";

export interface ResolvedSavingsBaseline {
  baselineId: string;
  baseProfile: { provider?: string; cost?: { type: string; inputUsdPerMillion?: number } } | undefined;
  inputUsdPerMillion: number | undefined;
}

/**
 * Pick the model profile whose input $/M will be used to convert savedTokens
 * into a dollar number for the Savings card. Same heuristic as the
 * /v1/tierkit/savings/today route (v0.21.6): if the routing baseline is
 * flat-rate or free, fall back to a priced profile of the same provider family
 * (claude → claude-*, openai → openai-*) before falling back across families.
 */
export function resolveSavingsBaseline(config: TierkitConfig): ResolvedSavingsBaseline {
  const profiles = config.modelProfiles ?? {};
  const requestedId = config.routingBaseline ?? "claudeCode";
  const claudeProviders = new Set(["anthropic", "claude-code"]);
  const openaiProviders = new Set(["openai", "openai-compatible"]);
  const requestedProv = profiles[requestedId]?.provider ?? "claude-code";
  const requestedFam = claudeProviders.has(requestedProv) ? "claude"
    : openaiProviders.has(requestedProv) ? "openai" : "other";
  const famOf = (p: { provider?: string } | undefined): string => {
    const prov = p?.provider ?? "";
    if (claudeProviders.has(prov)) return "claude";
    if (openaiProviders.has(prov)) return "openai";
    return "other";
  };
  let baselineId = requestedId;
  let baseProfile = profiles[baselineId];
  if (!baseProfile?.cost || baseProfile.cost.type !== "per-token") {
    const priced = Object.entries(profiles)
      .filter(([, p]) => p?.cost?.type === "per-token");
    priced.sort(([, a], [, b]) => {
      const af = famOf(a) === requestedFam ? 0 : 1;
      const bf = famOf(b) === requestedFam ? 0 : 1;
      if (af !== bf) return af - bf;
      const ac = (a.cost as { inputUsdPerMillion?: number }).inputUsdPerMillion ?? 0;
      const bc = (b.cost as { inputUsdPerMillion?: number }).inputUsdPerMillion ?? 0;
      return bc - ac;
    });
    const cand = priced[0];
    if (cand) { baselineId = cand[0]; baseProfile = cand[1]; }
  }
  const inputUsdPerMillion = baseProfile?.cost?.type === "per-token"
    ? (baseProfile.cost as { inputUsdPerMillion?: number }).inputUsdPerMillion
    : undefined;
  return { baselineId, baseProfile, inputUsdPerMillion };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tierkit/core test -- resolveSavingsBaseline.test`
Expected: PASS, 4 tests.

- [ ] **Step 5: Consume helper in Server.ts route**

In `packages/core/src/runtime/Server.ts` find the existing route at line 896 and replace lines 897-930 (the inline baseline resolution) with a call to the helper. Concretely, replace:

```typescript
      if (route === "GET /v1/tierkit/savings/today") {
        const cfg = await loadConfig(opts.cwd);
        const profiles = cfg.config.modelProfiles ?? {};
        const requestedId = cfg.config.routingBaseline ?? "claudeCode";
        // ... ~30 lines of inline baseline resolution ...
        const inputUsdPerMillion = baseProfile?.cost?.type === "per-token"
          ? (baseProfile.cost as { inputUsdPerMillion?: number }).inputUsdPerMillion
          : undefined;
        const summary = await computeTierkitMcpSavings(
          opts.cwd,
          inputUsdPerMillion,
          opts.homeDir ? { homeDirOverride: opts.homeDir } : {},
        );
```

with:

```typescript
      if (route === "GET /v1/tierkit/savings/today") {
        const cfg = await loadConfig(opts.cwd);
        const { baselineId, baseProfile, inputUsdPerMillion } = resolveSavingsBaseline(cfg.config);
        const summary = await computeTierkitMcpSavings(
          opts.cwd,
          inputUsdPerMillion,
          opts.homeDir ? { homeDirOverride: opts.homeDir } : {},
        );
```

Then update the import block near the top of `Server.ts`. Find:

```typescript
import { computeTierkitMcpSavings } from "./tierkitSavings.js";
```

and change to:

```typescript
import { computeTierkitMcpSavings, resolveSavingsBaseline } from "./tierkitSavings.js";
```

- [ ] **Step 6: Run the full core test suite — no regressions**

Run: `pnpm --filter @tierkit/core test`
Expected: all tests pass, with the suite count up by 4 (the new file).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runtime/tierkitSavings.ts packages/core/src/runtime/Server.ts packages/core/test/resolveSavingsBaseline.test.ts
git commit -m "refactor(core): extract resolveSavingsBaseline from /v1/tierkit/savings/today

Pure extraction — savingsBroadcaster (next task) needs the same baseline
heuristic, so factor it out of the route handler. Same behavior, four
unit tests pinning the contract."
```

---

## Task 2: Add `setActivityListener` to `activityLog.ts`

Inject the post-append callback hook so the daemon can react to every MCP tool call without `activityLog` importing the runtime layer.

**Files:**
- Modify: `packages/core/src/mcp/activityLog.ts`
- Test: `packages/core/test/activityLog.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/activityLog.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  logMcpActivity,
  setActivityListener,
  readMcpActivity,
} from "../src/mcp/activityLog.js";

describe("setActivityListener", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-activity-"));
  });
  afterEach(async () => {
    setActivityListener(null);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("invokes the listener with workspaceRoot after logMcpActivity appends", async () => {
    const calls: string[] = [];
    setActivityListener((root) => { calls.push(root); });
    await logMcpActivity(tmp, {
      tool: "tierkit.get_file_digest",
      ok: true, code: null, durationMs: 5, redactionHits: 0,
      inputSummary: { path: "x.ts" }, outputSummary: { beforeTokens: 100, afterTokens: 10, savedTokens: 90 },
    });
    expect(calls).toEqual([tmp]);
    const entries = await readMcpActivity(tmp);
    expect(entries).toHaveLength(1);
  });

  it("does not propagate listener exceptions — entry is still appended", async () => {
    setActivityListener(() => { throw new Error("boom"); });
    await expect(logMcpActivity(tmp, {
      tool: "tierkit.compress_command",
      ok: true, code: null, durationMs: 1, redactionHits: 0,
      inputSummary: null, outputSummary: null,
    })).resolves.toBeUndefined();
    const entries = await readMcpActivity(tmp);
    expect(entries).toHaveLength(1);
  });

  it("setActivityListener(null) clears a previously registered listener", async () => {
    const calls: string[] = [];
    setActivityListener((root) => { calls.push(root); });
    setActivityListener(null);
    await logMcpActivity(tmp, {
      tool: "tierkit.compress_command",
      ok: true, code: null, durationMs: 1, redactionHits: 0,
      inputSummary: null, outputSummary: null,
    });
    expect(calls).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tierkit/core test -- activityLog.test`
Expected: FAIL — `setActivityListener` is not exported from `activityLog.js`.

- [ ] **Step 3: Implement listener hook in `activityLog.ts`**

In `packages/core/src/mcp/activityLog.ts`, replace the file content with:

```typescript
import fs from "node:fs/promises";
import path from "node:path";

export interface McpActivityInput {
  tool: string;
  ok: boolean;
  code: string | null;
  durationMs: number;
  redactionHits: number;
  inputSummary: unknown;
  outputSummary: unknown;
  envelope?: {
    truncated: boolean;
    hasCursor: boolean;
    remainingLines?: number;
  };
  clientName?: string;
}

export interface McpActivityEntry extends McpActivityInput {
  ts: string;
  type: "mcp-tool";
  workspaceRoot: string;
}

const LOG_REL = ".tierkit/runtime/usage.jsonl";

type ActivityListener = (workspaceRoot: string) => void;
let activityListener: ActivityListener | null = null;

/**
 * Register a fire-and-forget callback that runs after each logMcpActivity
 * append. Used by the runtime's savingsBroadcaster to push SSE events on
 * every MCP tool call without activityLog (mcp/) importing runtime/.
 *
 * Pass null to clear.
 */
export function setActivityListener(fn: ActivityListener | null): void {
  activityListener = fn;
}

export async function logMcpActivity(workspaceRoot: string, input: McpActivityInput): Promise<void> {
  const entry: McpActivityEntry = {
    ts: new Date().toISOString(),
    type: "mcp-tool",
    workspaceRoot,
    ...input,
  };
  const file = path.join(workspaceRoot, LOG_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(entry) + "\n");
  // Fire-and-forget. Listener exceptions must not propagate — broadcaster
  // failure must not corrupt the MCP tool's response path.
  if (activityListener) {
    try { activityListener(workspaceRoot); }
    catch (err) { console.error("[tierkit] activityListener threw:", err); }
  }
}

export async function readMcpActivity(workspaceRoot: string): Promise<McpActivityEntry[]> {
  const file = path.join(workspaceRoot, LOG_REL);
  let raw: string;
  try { raw = await fs.readFile(file, "utf8"); }
  catch (err: any) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const out: McpActivityEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as McpActivityEntry); }
    catch { /* malformed line — forward-compat skip */ }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tierkit/core test -- activityLog.test`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/mcp/activityLog.ts packages/core/test/activityLog.test.ts
git commit -m "feat(core): activityLog.setActivityListener post-append hook

Lets the runtime react to every MCP tool call without activityLog (mcp/)
importing runtime/. Listener exceptions are swallowed so a broken
listener cannot break tool responses."
```

---

## Task 3: Create `savingsBroadcaster` module

Hub that holds the SSE subscriber set, broadcasts a full `TierkitMcpSavingsSummary` snapshot to each subscriber, and runs a 30s heartbeat.

**Files:**
- Create: `packages/core/src/runtime/savingsBroadcaster.ts`
- Test: `packages/core/test/savingsBroadcaster.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/savingsBroadcaster.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logMcpActivity } from "../src/mcp/activityLog.js";
import * as broadcaster from "../src/runtime/savingsBroadcaster.js";

class MockRes extends EventEmitter {
  written: string[] = [];
  ended = false;
  shouldThrow = false;
  write(chunk: string): boolean {
    if (this.shouldThrow) throw new Error("EPIPE");
    this.written.push(chunk);
    return true;
  }
  end() { this.ended = true; }
  setHeader() { /* noop */ }
  flushHeaders() { /* noop */ }
  get writableEnded() { return this.ended; }
  get destroyed() { return false; }
}

// Build a tiny TierkitConfig with a priced baseline so resolveSavingsBaseline
// produces a non-undefined inputUsdPerMillion.
const cfg = {
  modelProfiles: {
    claudeSonnet: { provider: "anthropic", cost: { type: "per-token", inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
  },
  routingBaseline: "claudeSonnet",
} as any;

describe("savingsBroadcaster", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-bcast-"));
  });
  afterEach(async () => {
    broadcaster.stop();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("subscribe writes a snapshot immediately", async () => {
    broadcaster.start({ getConfig: () => cfg });
    const res = new MockRes();
    await broadcaster.subscribe(res as any, tmp);
    expect(res.written.length).toBe(1);
    expect(res.written[0]).toMatch(/^data: /);
    const payload = JSON.parse(res.written[0].slice(6).trim());
    expect(payload.type).toBe("savings-snapshot");
    expect(payload.summary).toBeDefined();
  });

  it("broadcast writes to every subscriber", async () => {
    broadcaster.start({ getConfig: () => cfg });
    const a = new MockRes();
    const b = new MockRes();
    await broadcaster.subscribe(a as any, tmp);
    await broadcaster.subscribe(b as any, tmp);
    a.written.length = 0;
    b.written.length = 0;
    await broadcaster.broadcast(tmp);
    expect(a.written.length).toBe(1);
    expect(b.written.length).toBe(1);
  });

  it("write failure removes only the broken subscriber", async () => {
    broadcaster.start({ getConfig: () => cfg });
    const ok = new MockRes();
    const broken = new MockRes();
    broken.shouldThrow = true;
    await broadcaster.subscribe(ok as any, tmp);
    await broadcaster.subscribe(broken as any, tmp).catch(() => { /* expected to swallow */ });
    ok.written.length = 0;
    broken.written.length = 0;
    await broadcaster.broadcast(tmp);
    expect(ok.written.length).toBe(1);
    expect(broken.written.length).toBe(0);
    // Second broadcast — broken is gone, ok still receives.
    await broadcaster.broadcast(tmp);
    expect(ok.written.length).toBe(2);
  });

  it("heartbeat fires every 30s", async () => {
    vi.useFakeTimers();
    try {
      broadcaster.start({ getConfig: () => cfg, workspaceRootForHeartbeat: tmp });
      const res = new MockRes();
      await broadcaster.subscribe(res as any, tmp);
      res.written.length = 0;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(res.written.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop clears the subscriber set and stops the heartbeat", async () => {
    vi.useFakeTimers();
    try {
      broadcaster.start({ getConfig: () => cfg, workspaceRootForHeartbeat: tmp });
      const res = new MockRes();
      await broadcaster.subscribe(res as any, tmp);
      broadcaster.stop();
      res.written.length = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(res.written.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Cross-module integration with logMcpActivity is covered by the
  // in-process HTTP test in Task 4 (Server.savingsStream.test.ts).
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tierkit/core test -- savingsBroadcaster.test`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `savingsBroadcaster`**

Create `packages/core/src/runtime/savingsBroadcaster.ts`:

```typescript
import type { ServerResponse } from "node:http";
import { computeTierkitMcpSavings, resolveSavingsBaseline } from "./tierkitSavings.js";
import type { TierkitConfig } from "../config/TierkitConfig.js";

interface StartOptions {
  /** Re-resolved on every broadcast so profile edits take effect live. */
  getConfig: () => TierkitConfig;
  /** Workspace root used by the periodic heartbeat. */
  workspaceRootForHeartbeat?: string;
  /** Override the home dir (test fixture). */
  homeDirOverride?: string;
}

const HEARTBEAT_MS = 30_000;

const subscribers = new Set<ServerResponse>();
let heartbeat: NodeJS.Timeout | null = null;
let opts: StartOptions | null = null;

export function start(o: StartOptions): void {
  opts = o;
  if (heartbeat) clearInterval(heartbeat);
  if (o.workspaceRootForHeartbeat) {
    const root = o.workspaceRootForHeartbeat;
    heartbeat = setInterval(() => { void broadcast(root); }, HEARTBEAT_MS);
    // Allow the process to exit even if the heartbeat is pending.
    heartbeat.unref?.();
  }
}

export function stop(): void {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  for (const res of subscribers) {
    try { res.end(); } catch { /* socket closed */ }
  }
  subscribers.clear();
  opts = null;
}

/**
 * Register an SSE response as a subscriber and immediately push the current
 * snapshot so the client sees state without waiting for the next event.
 */
export async function subscribe(res: ServerResponse, workspaceRoot: string): Promise<void> {
  subscribers.add(res);
  await pushTo(res, workspaceRoot);
}

/**
 * Compute the current snapshot once and write it to every subscriber.
 * Subscribers whose write throws are removed.
 */
export async function broadcast(workspaceRoot: string): Promise<void> {
  if (!opts) return;
  let payload: string;
  try {
    payload = await buildPayload(workspaceRoot);
  } catch (err) {
    console.error("[tierkit] savingsBroadcaster.broadcast: computeTierkitMcpSavings threw:", err);
    return;
  }
  const frame = `data: ${payload}\n\n`;
  for (const res of [...subscribers]) {
    try {
      if (res.writableEnded || res.destroyed) {
        subscribers.delete(res);
        continue;
      }
      res.write(frame);
    } catch {
      subscribers.delete(res);
    }
  }
}

async function pushTo(res: ServerResponse, workspaceRoot: string): Promise<void> {
  if (!opts) return;
  let payload: string;
  try { payload = await buildPayload(workspaceRoot); }
  catch (err) {
    console.error("[tierkit] savingsBroadcaster.pushTo: computeTierkitMcpSavings threw:", err);
    subscribers.delete(res);
    return;
  }
  try { res.write(`data: ${payload}\n\n`); }
  catch { subscribers.delete(res); }
}

async function buildPayload(workspaceRoot: string): Promise<string> {
  const cfg = opts!.getConfig();
  const { baselineId, baseProfile, inputUsdPerMillion } = resolveSavingsBaseline(cfg);
  const summary = await computeTierkitMcpSavings(
    workspaceRoot,
    inputUsdPerMillion,
    opts!.homeDirOverride ? { homeDirOverride: opts!.homeDirOverride } : {},
  );
  return JSON.stringify({
    type: "savings-snapshot",
    summary: {
      ok: true,
      baselineProfileId: baselineId,
      baselineProvider: baseProfile?.provider,
      inputUsdPerMillion,
      ...summary,
    },
  });
}

// Test-only access — exported so the integration test in Task 4 can assert
// the subscriber set size from outside the module.
export function _subscriberCount(): number {
  return subscribers.size;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tierkit/core test -- savingsBroadcaster.test`
Expected: PASS, 5 tests.

If the heartbeat test is flaky under fake timers, adjust the assertion to `expect(res.written.length).toBeGreaterThan(0)` (already the case).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/savingsBroadcaster.ts packages/core/test/savingsBroadcaster.test.ts
git commit -m "feat(core): savingsBroadcaster hub for SSE push

Holds the SSE subscriber set, broadcasts a full TierkitMcpSavingsSummary
snapshot per call, runs a 30s heartbeat. Re-resolves the baseline price
on every broadcast so model-profile edits take effect without a daemon
restart. Broken subscribers are dropped per-write, never propagated."
```

---

## Task 4: Wire broadcaster into `Server.ts` + add SSE route + integration test

Boot the broadcaster when the daemon starts, register the activityLog listener, add the `GET /v1/tierkit/savings/stream` route, and tear everything down on shutdown.

**Files:**
- Modify: `packages/core/src/runtime/Server.ts`
- Test: `packages/core/test/Server.savingsStream.test.ts` (new)

- [ ] **Step 1: Write the failing integration test**

Create `packages/core/test/Server.savingsStream.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/runtime/Server.js";
import { logMcpActivity, setActivityListener } from "../src/mcp/activityLog.js";

async function writeMinimalConfig(cwd: string): Promise<void> {
  const cfg = {
    version: 1,
    modelProfiles: {
      claudeSonnet: { kind: "private-remote", provider: "anthropic", model: "x", apiKeyEnv: "K", cost: { type: "per-token", inputUsdPerMillion: 3, outputUsdPerMillion: 15 }, roles: ["code"] },
    },
    routingBaseline: "claudeSonnet",
  };
  await fs.writeFile(path.join(cwd, "tierkit.config.json"), JSON.stringify(cfg));
}

describe("/v1/tierkit/savings/stream", () => {
  let cwd: string;
  let server: any;
  let url: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "tierkit-sse-"));
    await fs.mkdir(path.join(cwd, ".tierkit", "runtime"), { recursive: true });
    await writeMinimalConfig(cwd);
    server = await createServer({ cwd, homeDir: cwd });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    url = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    setActivityListener(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("emits an initial snapshot on connect and a new snapshot after logMcpActivity", async () => {
    const ac = new AbortController();
    const res = await fetch(`${url}/v1/tierkit/savings/stream`, { signal: ac.signal });
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    async function readOneEvent(): Promise<any> {
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream closed before event");
        buf += decoder.decode(value, { stream: true });
        const idx = buf.indexOf("\n\n");
        if (idx >= 0) {
          const block = buf.slice(0, idx);
          if (block.startsWith("data:")) return JSON.parse(block.slice(5).trim());
          buf = buf.slice(idx + 2);
        }
      }
    }

    const first = await readOneEvent();
    expect(first.type).toBe("savings-snapshot");
    expect(first.summary.baselineProfileId).toBe("claudeSonnet");

    // Trigger an MCP activity record — must produce a second event.
    await logMcpActivity(cwd, {
      tool: "tierkit.get_file_digest",
      ok: true, code: null, durationMs: 5, redactionHits: 0,
      inputSummary: { path: "f.ts" },
      outputSummary: { beforeTokens: 1000, afterTokens: 100, savedTokens: 900 },
    });

    const second = await Promise.race([
      readOneEvent(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout waiting for second event")), 2000)),
    ]);
    expect(second.type).toBe("savings-snapshot");

    ac.abort();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tierkit/core test -- Server.savingsStream.test`
Expected: FAIL — `unknown route GET /v1/tierkit/savings/stream`.

- [ ] **Step 3: Wire broadcaster into `Server.ts`**

In `packages/core/src/runtime/Server.ts`, update the import line for tierkitSavings (already done in Task 1) and add the broadcaster import. Find:

```typescript
import { computeTierkitMcpSavings, resolveSavingsBaseline } from "./tierkitSavings.js";
```

and add immediately below:

```typescript
import * as savingsBroadcaster from "./savingsBroadcaster.js";
import { setActivityListener } from "../mcp/activityLog.js";
```

Then locate `createServer` (around line 230, the `const server = http.createServer(...)` line). **Immediately before** the `http.createServer(...)` call, add:

```typescript
  savingsBroadcaster.start({
    getConfig: () => {
      // loadConfig is async; the broadcaster needs a sync snapshot. Cache the
      // last successfully loaded config and refresh it lazily. For v0.22.3 we
      // pay one synchronous read of the in-memory config that loadConfig
      // already caches; in practice the daemon process holds the latest
      // config because every request that mutates it calls loadConfig.
      return cachedConfig ?? { modelProfiles: {}, routingBaseline: "claudeCode" } as any;
    },
    workspaceRootForHeartbeat: opts.cwd,
    ...(opts.homeDir ? { homeDirOverride: opts.homeDir } : {}),
  });
  setActivityListener((root) => { void savingsBroadcaster.broadcast(root); });
```

And introduce `cachedConfig` at the top of `createServer` (right after the function opens):

```typescript
  let cachedConfig: any = null;
  const refreshCachedConfig = async () => {
    try { cachedConfig = (await loadConfig(opts.cwd)).config; }
    catch { /* leave previous cache */ }
  };
  await refreshCachedConfig();
```

In the existing `GET /v1/tierkit/savings/today` handler (now using `resolveSavingsBaseline`), after `const cfg = await loadConfig(opts.cwd);`, add:

```typescript
        cachedConfig = cfg.config;
```

so the broadcaster sees fresh values whenever the route is hit. (This is the cheapest no-extra-fs cache strategy.)

Now add the SSE route. Insert **immediately after** the existing `GET /v1/tierkit/savings/today` block (just before `if (route === "GET /v1/savings/today")`):

```typescript
      if (route === "GET /v1/tierkit/savings/stream") {
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("connection", "keep-alive");
        res.flushHeaders?.();
        await savingsBroadcaster.subscribe(res, opts.cwd);
        req.on("close", () => {
          // Subscriber set self-prunes on next write failure; explicit removal
          // is not strictly needed but speeds it up by one broadcast cycle.
          try { res.end(); } catch { /* already closed */ }
        });
        return;
      }
```

Finally, register a shutdown hook. Find the `server.on("close", ...)` or equivalent shutdown sequence near the bottom of `createServer`. If none exists, add one immediately before `return server;`:

```typescript
  server.on("close", () => {
    savingsBroadcaster.stop();
    setActivityListener(null);
  });
```

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `pnpm --filter @tierkit/core test -- Server.savingsStream.test`
Expected: PASS, 1 test. If the second event times out, double-check the `setActivityListener` registration order — it must be set BEFORE the test calls `logMcpActivity`.

- [ ] **Step 5: Run full core suite — no regressions**

Run: `pnpm --filter @tierkit/core test`
Expected: all tests pass; total count up by 1 (the new integration file).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime/Server.ts packages/core/test/Server.savingsStream.test.ts
git commit -m "feat(core): GET /v1/tierkit/savings/stream SSE endpoint

Wires savingsBroadcaster into the daemon: boots on createServer, listens
to logMcpActivity, exposes the SSE route, tears down on server close.
In-process integration test asserts initial snapshot + tool-call-driven
push within 2s."
```

---

## Task 5: Extract `renderSavings(summary)` helper in `gui.ts`

Pure refactor of `refreshSavings()`. Pull the DOM-update body into a standalone `renderSavings(summary)` function so the SSE path (Task 6) and the existing fetch path share the same rendering.

**Files:**
- Modify: `packages/core/src/runtime/ui/gui.ts:2863-2950` (approximately — locate `refreshSavings`)

This file is too large for tsx test harness, so verification is by inspection + tsup build success.

- [ ] **Step 1: Locate the function and the end of its body**

The body to extract starts at the line after `try {` inside `refreshSavings()` (currently `const r = await jget('/v1/tierkit/savings/today');`) and runs until the matching closing brace before the `} catch (e) {` clause (if there is one) or the closing brace of `refreshSavings`.

Run: `grep -n "async function refreshSavings\|} *$\|catch (e)" packages/core/src/runtime/ui/gui.ts | head -20`

Note the line numbers so the edit is unambiguous.

- [ ] **Step 2: Replace `refreshSavings()` with a thin wrapper + extracted helper**

Locate `async function refreshSavings() {` (currently `gui.ts:2863`) and replace the entire function (including its body up through the closing `}`) with the following two-function pair:

```javascript
  // Pure DOM update — fed by both the /v1/tierkit/savings/today fetch path
  // and the /v1/tierkit/savings/stream SSE path. `r` is the same shape both
  // routes return (the "today" route inlined the summary fields).
  function renderSavings(r) {
    if (!r || r.ok === false) {
      $('m-routing-input-tokens').textContent = '—';
      $('m-routing-cost-saved').textContent = '—';
      $('m-routing-calls-avoided').textContent = '—';
      $('m-routing-baseline').textContent = '—';
      $('m-routing-by-tool').textContent = '';
      $('m-routing-empty-hint').hidden = true;
      return;
    }
    const saved = Number(r.savedTokensTotal || 0);
    const before = Number(r.beforeTokensTotal || 0);
    const after = Number(r.afterTokensTotal || 0);
    const calls = Number(r.toolCallCount || 0);
    const usd = typeof r.estimatedSavedUsd === 'number' ? r.estimatedSavedUsd : null;
    const k = saved >= 1000 ? (saved / 1000).toFixed(1) + 'k' : String(saved);
    $('m-routing-input-tokens').textContent = k + ' tok';
    $('m-routing-cost-saved').textContent = usd !== null ? '$' + usd.toFixed(4) : '—';
    $('m-routing-calls-avoided').textContent = String(calls);

    const visual = $('m-routing-visual');
    if (before > 0) {
      visual.style.display = '';
      const fmt = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k tok' : n + ' tok';
      $('m-routing-before-label').textContent = fmt(before);
      $('m-routing-after-label').textContent = fmt(after);
      const ratio = before > 0 ? Math.min(100, Math.max(0, (after / before) * 100)) : 0;
      $('m-routing-after-bar').style.width = ratio.toFixed(1) + '%';
      const pct = (100 - ratio).toFixed(0);
      $('m-routing-saved-summary').textContent =
        (lang === 'ko' ? '▼ ' : '▼ ') + pct + '% (' + fmt(saved) + ' ' + (lang === 'ko' ? '절감' : 'saved') + (usd !== null ? ' · $' + usd.toFixed(4) : '') + ')';
    } else {
      visual.style.display = 'none';
    }
    const baseLabel = String(r.baselineProfileId || '—');
    $('m-routing-baseline').textContent = (typeof r.inputUsdPerMillion === 'number')
      ? baseLabel + ' ($' + r.inputUsdPerMillion + '/M input)'
      : baseLabel;
    const byTool = r.byTool || {};
    const entries = Object.entries(byTool).sort((a, b) => b[1] - a[1]);
    $('m-routing-by-tool').textContent = entries.length
      ? entries.map(([n, c]) => n.replace('tierkit.', '') + ' ×' + c).join(' · ')
      : '';
    const byClient = r.byClient || {};
    const byModel = r.byModel || {};
    const fmtTok = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    const noDataLabel = lang === 'ko' ? '데이터 없음' : 'no data yet';
    function renderBreakdown(hostId, data, prettyFn) {
      const host = $(hostId);
      if (!host) return;
      const rows = Object.entries(data)
        .filter(([, v]) => v && v.savedTokens > 0)
        .sort(([, a], [, b]) => b.savedTokens - a.savedTokens);
      if (rows.length === 0) {
        host.innerHTML = '<div class="dim" style="font-size:11px;padding:4px 0">' + escapeHtmlMd(noDataLabel) + '</div>';
        return;
      }
      let html = '';
      for (const [key, v] of rows) {
        const usd = typeof v.estimatedSavedUsd === 'number' ? ' · $' + v.estimatedSavedUsd.toFixed(4) : '';
        html += '<div class="row dense" style="font-size:11px"><span style="flex:1;min-width:0">' +
          escapeHtmlMd(prettyFn(key)) + '</span>' +
          '<span class="mono dim" style="font-size:10.5px">' + fmtTok(v.savedTokens) + ' tok · ' +
          v.toolCallCount + ' ' + (lang === 'ko' ? '호출' : 'calls') + usd +
          '</span></div>';
      }
      host.innerHTML = html;
    }
    renderBreakdown('m-routing-by-client', byClient, (s) => s);
    renderBreakdown('m-routing-by-model', byModel, (s) => s);
  }

  async function refreshSavings() {
    try {
      const r = await jget('/v1/tierkit/savings/today');
      renderSavings(r);
    } catch { /* card stays at last-good state */ }
  }
```

(Keep the original surrounding code — the comment block above `refreshSavings`, the `// ── Card: routing savings` banner, etc. — untouched. Only the function body changes.)

Inspect the original `refreshSavings()` lines you removed to confirm no logic was dropped. Compare side-by-side: every `$('...')` assignment in the old body must appear in `renderSavings()`. If the original had extra logic after `renderBreakdown(...)` calls (e.g., `empty-hint` toggling), preserve it inside `renderSavings()` at the equivalent position.

- [ ] **Step 3: Build to verify the file still compiles**

Run: `pnpm -F @tierkit/core build`
Expected: tsup build succeeds. No type errors (gui.ts is JS-in-string so type errors won't surface, but the build must complete).

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/runtime/ui/gui.ts
git commit -m "refactor(gui): extract renderSavings(summary) from refreshSavings()

Pure refactor — the fetch path and the upcoming SSE path will share this
DOM-update helper. No behavior change."
```

---

## Task 6: Subscribe to SSE in `gui.ts` + remove `refreshSavings` from polling

**Files:**
- Modify: `packages/core/src/runtime/ui/gui.ts`

- [ ] **Step 1: Add `subscribeSavings()` near `refreshSavings`**

Locate the new `refreshSavings()` function (now ~10 lines, just after `renderSavings`). Insert **immediately after** `refreshSavings`:

```javascript
  // SSE subscription: replaces the 5s polling for the Savings card.
  // transport.stream() proxies via the extension host so VS Code webview CSP
  // doesn't block the loopback EventSource. The proxy yields one chunk per
  // SSE `data:` line — payload.type === "savings-snapshot" carries the same
  // shape as the /v1/tierkit/savings/today JSON response.
  async function subscribeSavings() {
    while (true) {
      try {
        for await (const chunk of transport.stream('/v1/tierkit/savings/stream', { method: 'GET' })) {
          let payload;
          try { payload = JSON.parse(chunk.data); }
          catch { continue; }
          if (payload && payload.type === 'savings-snapshot' && payload.summary) {
            renderSavings(payload.summary);
          }
        }
      } catch (err) {
        // Connection broke — daemon restart, network blip, whatever. Wait a
        // few seconds and reconnect. The first message after reconnect is a
        // full snapshot, so we're guaranteed to catch up.
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  }
```

- [ ] **Step 2: Kick off `subscribeSavings()` at init**

Locate the `refreshAll();` call followed by `setInterval(...)` near the end of the script (currently `gui.ts:7183-7184`). Replace those two lines with:

```javascript
  refreshAll();
  void subscribeSavings();
  // Auto-refresh activity + usage + health every 5s. Savings is handled by
  // the SSE stream above and is intentionally absent here.
  setInterval(() => { refreshActivity(); refreshUsage(); refreshHealth(); }, 5_000);
```

(Note: `refreshSavings` is removed from the setInterval tuple. The remaining three calls are unchanged.)

- [ ] **Step 3: Build**

Run: `pnpm -F @tierkit/core build`
Expected: build succeeds.

- [ ] **Step 4: Smoke-build the extension**

Run: `pnpm -F tierkit-vscode build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/ui/gui.ts
git commit -m "feat(gui): subscribe to /v1/tierkit/savings/stream, drop polling

The Savings card now renders on every MCP tool call via SSE instead of
waiting up to 5s for the next poll. transport.stream() proxies through
the extension host so the VS Code webview CSP doesn't block it.
Reconnect-on-error with a 3s backoff handles daemon restarts."
```

---

## Task 7: Release 0.22.3 and verify in the live extension

**Files:**
- Modify (auto): all `package.json` (via `pnpm bump`)
- Build: vsix
- Modify: `.mcp.json` (project) + `~/.claude.json` (user-scope tierkit path)

- [ ] **Step 1: Bump version**

Run: `pnpm bump 0.22.3`
Expected: "Done. 11 updated, 0 already at 0.22.3."

- [ ] **Step 2: Build core + extension**

Run: `pnpm -F @tierkit/core build && pnpm -F tierkit-vscode build`
Expected: both succeed.

- [ ] **Step 3: Package vsix**

Run: `pnpm -F tierkit-vscode package`
Expected: `Packaged: tierkit-vscode-0.22.3.vsix`.
Capture: file size + path. Surface them to the user with the install command per session memory `feedback_always_share_vsix`.

- [ ] **Step 4: Update `.mcp.json` paths**

In `packages/core/.mcp.json` (project root `.mcp.json`), replace `0.22.2` with `0.22.3` on the `cli/index.js` path argument. The file is loaded but untracked — edit in place.

In `~/.claude.json` (user-scope), run:

```bash
python3 -c "
import json
p='/Users/siwal/.claude.json'
d=json.load(open(p))
t=d['mcpServers']['tierkit']
t['args']=[a.replace('leesiwal.tierkit-vscode-0.22.2','leesiwal.tierkit-vscode-0.22.3') for a in t['args']]
json.dump(d, open(p,'w'), indent=2)
print(t)
"
```

- [ ] **Step 5: Release commit**

```bash
git add package.json packages/adapter-cline/package.json packages/adapter-continue/package.json packages/adapter-roo/package.json packages/agent/package.json packages/cli/package.json packages/client/package.json packages/core/package.json packages/mcp-server/package.json packages/plugin-superpowers/package.json packages/vscode-tierkit/package.json
git commit -m "chore(release): 0.22.3"
```

- [ ] **Step 6: Manual verification checklist**

Tell the user:

```
Install:
  code --install-extension /Users/siwal/code/Tierkit/packages/vscode-tierkit/tierkit-vscode-0.22.3.vsix --force

Then:
  1. Reload VS Code window.
  2. Restart Claude Code session.
  3. Open Tierkit sidebar.
  4. From a separate Claude Code session, ask it to read a large file via
     Tierkit MCP (e.g., "tierkit.get_file_digest on a 50k-token file").
  5. Confirm the Savings card updates within ~500 ms WITHOUT pressing
     refresh.
  6. Collapse and re-expand the sidebar — card retains latest value
     (no stale "0").
```

If verification fails, the rollback path is in the design spec (re-add `refreshSavings()` to the 5s `setInterval`, remove `subscribeSavings()` call).

- [ ] **Step 7: Done**

Done. The implementation is complete. Report back: vsix path, size, mtime, and the manual verification checklist outcome.
