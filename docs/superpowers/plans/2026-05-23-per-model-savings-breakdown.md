# Per-Model Savings Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the "Today — Tierkit MCP 압축 절감" card with two collapsible breakdown sections: by-client (Claude Code / Codex / other) and by-Claude-model (Opus 4.7 / Sonnet 4.6 / Haiku 4.5 / etc.), each showing tokens saved + tool call count + USD saved.

**Architecture:** Three layers added to the existing pipeline. (1) MCP server captures `clientInfo.name` via `server.getClientVersion()` and stamps each activity log entry. (2) A new `attributeModelFromJsonls` usecase cross-references Claude session jsonls (5-minute fuzzy window) to infer which model was active for each tool call. (3) `computeTierkitMcpSavings` aggregates by-client + by-model and the GUI renders two new `<details>` sections inside the existing savings card.

**Tech Stack:** TypeScript + Node `fs/promises` + readline (streamed jsonl scan). Vitest for unit + integration tests. Vanilla DOM for the GUI.

Spec: [`docs/superpowers/specs/2026-05-23-per-model-savings-breakdown-design.md`](../specs/2026-05-23-per-model-savings-breakdown-design.md)

---

## File Structure

**Modified files**:
- `packages/core/src/mcp/activityLog.ts` — add optional `clientName` to `McpActivityInput`
- `packages/mcp-server/src/server.ts` — capture `getClientVersion().name` in the CallTool handler, pass to `logMcpActivity`
- `packages/core/src/runtime/tierkitSavings.ts` — extend `TierkitMcpSavingsSummary` with `byClient` + `byModel`, integrate `attributeModelFromJsonls`
- `packages/core/src/runtime/Server.ts` — no change (existing /v1/tierkit/savings/today already returns the summary verbatim)
- `packages/core/src/runtime/ui/gui.ts` — `prettyModel` + `prettyClient` helpers, two new `<details>` sections, i18n keys

**New files**:
- `packages/core/src/runtime/attributeModelFromJsonls.ts` — cross-reference logic
- `packages/core/test/attributeModelFromJsonls.test.ts` — unit tests for the timestamp matcher
- `packages/core/test/tierkitSavings.byClientByModel.test.ts` — integration test for the extended summary

---

## Task 1: Add clientName to McpActivityInput

**Files:**
- Modify: `packages/core/src/mcp/activityLog.ts`

- [ ] **Step 1: Add the field**

Find `export interface McpActivityInput`. Add `clientName?: string`:

```ts
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
  /**
   * v0.23: the MCP client's self-reported name (from initialize handshake).
   * Sourced from server.getClientVersion()?.name. Common values: "claude-code",
   * "codex", "Cursor". Used by tierkitSavings to bucket savings per client.
   * Optional for forward compat with older activity log entries.
   */
  clientName?: string;
}
```

The output type `McpActivityEntry extends McpActivityInput` automatically picks up the new field.

- [ ] **Step 2: Run existing tests to confirm no breakage**

Run: `pnpm --filter @tierkit/core test mcpActivityLog`
Expected: PASS (existing tests don't pass `clientName`, but it's optional).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/mcp/activityLog.ts
git -c commit.gpgsign=false commit -m "feat(core): McpActivityInput.clientName for savings attribution

Optional field, sourced from MCP server.getClientVersion()?.name. Used
by tierkitSavings to bucket savings per client. Older log entries
without the field are treated as 'unknown' at read time.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Capture clientName in mcp-server CallTool handler

**Files:**
- Modify: `packages/mcp-server/src/server.ts`

- [ ] **Step 1: Find the CallTool handler**

Run:
```
grep -n "CallToolRequestSchema\|logMcpActivity" packages/mcp-server/src/server.ts
```
Locates the handler (around line 321) and the activity log call.

- [ ] **Step 2: Capture client name + pass to logMcpActivity**

Inside the handler, near the top (before tool execution begins), add:

```ts
const ci = server.getClientVersion();
const clientName = (ci?.name ?? "unknown").toString();
```

At each `await logMcpActivity(workspaceRoot, { ... })` call, add `clientName` to the input object:

```ts
await logMcpActivity(workspaceRoot, {
  tool,
  ok,
  code,
  durationMs,
  redactionHits,
  inputSummary,
  outputSummary,
  envelope,
  clientName,  // NEW
});
```

(If there are multiple `logMcpActivity` calls — one for ok-path, one for error — both get `clientName`.)

- [ ] **Step 3: Verify the build still passes**

```
pnpm --filter @tierkit/mcp-server build
```
Expected: clean build.

- [ ] **Step 4: Existing mcp-server tests pass**

```
pnpm --filter @tierkit/mcp-server test
```
Expected: PASS — the new field is optional and existing tests don't read it.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/server.ts
git -c commit.gpgsign=false commit -m "feat(mcp-server): capture clientInfo.name into activity log

Every CallTool handler invocation now stamps the activity entry with
server.getClientVersion()?.name (e.g. 'claude-code', 'codex', 'Cursor').
Falls back to 'unknown' when the client didn't send clientInfo or
when the handshake happened before this fix.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: attributeModelFromJsonls usecase

**Files:**
- Create: `packages/core/src/runtime/attributeModelFromJsonls.ts`
- Test: `packages/core/test/attributeModelFromJsonls.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/test/attributeModelFromJsonls.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { attributeModelFromJsonls } from "../src/runtime/attributeModelFromJsonls.js";

async function makeFixture(): Promise<{ home: string; cwd: string; dir: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tk-attr-"));
  const cwd = "/Users/test/proj";
  const dir = path.join(home, ".claude", "projects", "-Users-test-proj");
  await fs.mkdir(dir, { recursive: true });
  return { home, cwd, dir };
}

async function writeJsonl(dir: string, id: string, lines: object[]): Promise<void> {
  await fs.writeFile(
    path.join(dir, `${id}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n"),
  );
}

describe("attributeModelFromJsonls", () => {
  it("maps each claude activity to the nearest preceding assistant model within 5min", async () => {
    const { home, cwd, dir } = await makeFixture();
    await writeJsonl(dir, "11111111-1111-1111-1111-111111111111", [
      { type: "assistant", message: { model: "claude-sonnet-4-6" }, timestamp: "2026-05-23T10:00:00Z" },
      { type: "assistant", message: { model: "claude-opus-4-7" },   timestamp: "2026-05-23T10:05:00Z" },
    ]);
    const r = await attributeModelFromJsonls({
      cwd,
      homeDirOverride: home,
      activities: [
        { ts: "2026-05-23T10:00:30Z", clientName: "claude-code", savedTokens: 100 }, // sonnet
        { ts: "2026-05-23T10:05:30Z", clientName: "claude-code", savedTokens: 200 }, // opus
        { ts: "2026-05-23T10:15:00Z", clientName: "claude-code", savedTokens: 50 },  // 10 min after opus → unknown
      ],
    });
    expect(r).toEqual([
      { ts: "2026-05-23T10:00:30Z", clientName: "claude-code", model: "claude-sonnet-4-6", savedTokens: 100 },
      { ts: "2026-05-23T10:05:30Z", clientName: "claude-code", model: "claude-opus-4-7",   savedTokens: 200 },
      { ts: "2026-05-23T10:15:00Z", clientName: "claude-code", model: "unknown",            savedTokens: 50 },
    ]);
  });

  it("non-claude clients always get model:unknown (no jsonl source)", async () => {
    const { home, cwd, dir } = await makeFixture();
    await writeJsonl(dir, "22222222-2222-2222-2222-222222222222", [
      { type: "assistant", message: { model: "claude-opus-4-7" }, timestamp: "2026-05-23T10:00:00Z" },
    ]);
    const r = await attributeModelFromJsonls({
      cwd,
      homeDirOverride: home,
      activities: [
        { ts: "2026-05-23T10:00:30Z", clientName: "codex",   savedTokens: 100 },
        { ts: "2026-05-23T10:00:30Z", clientName: "unknown", savedTokens: 100 },
      ],
    });
    expect(r.map((a) => a.model)).toEqual(["unknown", "unknown"]);
  });

  it("empty projects dir → all attributions are 'unknown'", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "tk-attr-empty-"));
    const r = await attributeModelFromJsonls({
      cwd: "/no/such/proj",
      homeDirOverride: home,
      activities: [
        { ts: "2026-05-23T10:00:00Z", clientName: "claude-code", savedTokens: 100 },
      ],
    });
    expect(r[0]?.model).toBe("unknown");
  });

  it("ignores assistant turns AFTER the activity timestamp (only preceding count)", async () => {
    const { home, cwd, dir } = await makeFixture();
    await writeJsonl(dir, "33333333-3333-3333-3333-333333333333", [
      { type: "assistant", message: { model: "claude-opus-4-7" }, timestamp: "2026-05-23T10:10:00Z" },
    ]);
    const r = await attributeModelFromJsonls({
      cwd,
      homeDirOverride: home,
      activities: [
        { ts: "2026-05-23T10:09:00Z", clientName: "claude-code", savedTokens: 100 },
      ],
    });
    expect(r[0]?.model).toBe("unknown");
  });

  it("scans all jsonl files in the projects dir, not just one", async () => {
    const { home, cwd, dir } = await makeFixture();
    await writeJsonl(dir, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", [
      { type: "assistant", message: { model: "claude-sonnet-4-6" }, timestamp: "2026-05-23T10:00:00Z" },
    ]);
    await writeJsonl(dir, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", [
      { type: "assistant", message: { model: "claude-opus-4-7" }, timestamp: "2026-05-23T11:00:00Z" },
    ]);
    const r = await attributeModelFromJsonls({
      cwd,
      homeDirOverride: home,
      activities: [
        { ts: "2026-05-23T10:00:30Z", clientName: "claude-code", savedTokens: 100 },
        { ts: "2026-05-23T11:00:30Z", clientName: "claude-code", savedTokens: 200 },
      ],
    });
    expect(r.map((a) => a.model)).toEqual(["claude-sonnet-4-6", "claude-opus-4-7"]);
  });
});
```

- [ ] **Step 2: Verify they fail**

Run: `pnpm --filter @tierkit/core test attributeModelFromJsonls`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/core/src/runtime/attributeModelFromJsonls.ts`:

```ts
/**
 * Cross-reference MCP activity entries against Claude session jsonls in the
 * workspace's project directory to attribute each entry to the model that
 * was active when the tool was called. Used by tierkitSavings to compute
 * by-model breakdowns.
 *
 * Matching rule: for each `claude*`-clientName activity at time T, find the
 * most recent assistant turn (across all jsonls in the project dir) whose
 * timestamp is ≤ T AND within 5 minutes of T. That turn's `message.model`
 * is the attribution. No match → "unknown". Non-claude clients always get
 * "unknown" (no jsonl source for them).
 *
 * The 5-minute window absorbs the natural skew between when Claude emits
 * the tool_use block (assistant turn timestamp) and when our MCP server
 * records the activity (after the tool finishes). It's not billing-quality
 * attribution — it's a "best-effort UI signal" so the user can see which
 * model is benefiting most from compression.
 */
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { encodeCwdForClaudeProjects } from "../usecases/listClaudeSessions.js";

const MAX_LOOKBACK_MS = 5 * 60 * 1000; // 5 minutes

interface AssistantTurn {
  /** ms since epoch (Date.parse of the jsonl timestamp). */
  ts: number;
  model: string;
}

export interface ActivityForAttribution {
  ts: string;
  clientName: string;
  savedTokens: number;
}

export interface AttributedActivity extends ActivityForAttribution {
  /** Anthropic model id (e.g. "claude-opus-4-7") or "unknown". */
  model: string;
}

export interface AttributeInput {
  cwd: string;
  /** Override `os.homedir()` for tests. */
  homeDirOverride?: string;
  activities: ActivityForAttribution[];
}

export async function attributeModelFromJsonls(
  input: AttributeInput,
): Promise<AttributedActivity[]> {
  const home = input.homeDirOverride ?? os.homedir();
  const dir = path.join(home, ".claude", "projects", encodeCwdForClaudeProjects(input.cwd));

  // Read every jsonl in the projects dir, extract assistant turns with model.
  let turns: AssistantTurn[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return input.activities.map((a) => ({ ...a, model: "unknown" }));
    }
    throw err;
  }
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
    const full = path.join(dir, ent.name);
    try {
      turns.push(...(await readAssistantTurns(full)));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue; // raced deletion
      throw err;
    }
  }
  turns.sort((a, b) => a.ts - b.ts);

  return input.activities.map((a) => {
    if (!a.clientName.startsWith("claude")) {
      return { ...a, model: "unknown" };
    }
    const tMs = Date.parse(a.ts);
    if (!Number.isFinite(tMs)) return { ...a, model: "unknown" };
    // Binary-search the largest turn.ts ≤ tMs.
    let lo = 0, hi = turns.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (turns[mid]!.ts <= tMs) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (found < 0) return { ...a, model: "unknown" };
    const turn = turns[found]!;
    if (tMs - turn.ts > MAX_LOOKBACK_MS) return { ...a, model: "unknown" };
    return { ...a, model: turn.model };
  });
}

/**
 * Stream a jsonl file and collect every `{ type: "assistant", message: { model, … }, timestamp }`.
 * Other event types (queue-operation, attachment, user) are skipped. Lines that don't parse are
 * dropped silently — Claude has internal events we don't model.
 */
async function readAssistantTurns(filePath: string): Promise<AssistantTurn[]> {
  const out: AssistantTurn[] = [];
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line) continue;
    let event: { type?: string; message?: { model?: unknown }; timestamp?: unknown };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== "assistant") continue;
    const model = event.message?.model;
    const tsStr = event.timestamp;
    if (typeof model !== "string" || typeof tsStr !== "string") continue;
    const ts = Date.parse(tsStr);
    if (!Number.isFinite(ts)) continue;
    out.push({ ts, model });
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @tierkit/core test attributeModelFromJsonls`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/attributeModelFromJsonls.ts packages/core/test/attributeModelFromJsonls.test.ts
git -c commit.gpgsign=false commit -m "feat(core): attributeModelFromJsonls — model attribution via Claude session scan

For each claude-client MCP activity, find the most recent assistant turn
(across all jsonls in ~/.claude/projects/<encoded-cwd>/) within 5 minutes
and attribute the activity to that turn's message.model. Non-claude
clients always get 'unknown'. The 5-minute fuzzy window absorbs the
skew between when Claude emits tool_use and when our server logs the
activity.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Extend computeTierkitMcpSavings with byClient + byModel

**Files:**
- Modify: `packages/core/src/runtime/tierkitSavings.ts`
- Test: `packages/core/test/tierkitSavings.byClientByModel.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `packages/core/test/tierkitSavings.byClientByModel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { computeTierkitMcpSavings } from "../src/runtime/tierkitSavings.js";

async function makeWorkspace(): Promise<{ ws: string; home: string }> {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "tk-savings-"));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "tk-savings-home-"));
  return { ws, home };
}

async function appendActivity(ws: string, entries: object[]): Promise<void> {
  const dir = path.join(ws, ".tierkit", "runtime");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "usage.jsonl");
  for (const e of entries) {
    await fs.appendFile(file, JSON.stringify(e) + "\n");
  }
}

const todayIso = (offsetMinutes = 0): string => {
  const d = new Date();
  d.setMinutes(d.getMinutes() + offsetMinutes);
  return d.toISOString();
};

describe("computeTierkitMcpSavings — byClient + byModel", () => {
  it("groups today's activities by clientName", async () => {
    const { ws, home } = await makeWorkspace();
    await appendActivity(ws, [
      { ts: todayIso(0), type: "mcp-tool", workspaceRoot: ws, tool: "tierkit.compress_command", ok: true, code: null, durationMs: 5, redactionHits: 0, inputSummary: {}, outputSummary: { beforeTokens: 1000, afterTokens: 100, savedTokens: 900 }, clientName: "claude-code" },
      { ts: todayIso(1), type: "mcp-tool", workspaceRoot: ws, tool: "tierkit.compress_command", ok: true, code: null, durationMs: 5, redactionHits: 0, inputSummary: {}, outputSummary: { beforeTokens: 500, afterTokens: 50, savedTokens: 450 }, clientName: "codex" },
    ]);
    const r = await computeTierkitMcpSavings(ws, undefined, { homeDirOverride: home });
    expect(r.byClient["claude-code"]?.savedTokens).toBe(900);
    expect(r.byClient["codex"]?.savedTokens).toBe(450);
  });

  it("groups Claude activities by model when jsonl turns exist", async () => {
    const { ws, home } = await makeWorkspace();
    // Seed a jsonl with one assistant turn at "now - 30s" using Sonnet.
    const projDir = path.join(home, ".claude", "projects", ws.replace(/[/.]/g, "-"));
    await fs.mkdir(projDir, { recursive: true });
    const turnTs = new Date(Date.now() - 30_000).toISOString();
    await fs.writeFile(
      path.join(projDir, "11111111-1111-1111-1111-111111111111.jsonl"),
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-4-6" }, timestamp: turnTs }) + "\n",
    );
    await appendActivity(ws, [
      { ts: todayIso(0), type: "mcp-tool", workspaceRoot: ws, tool: "tierkit.compress_command", ok: true, code: null, durationMs: 5, redactionHits: 0, inputSummary: {}, outputSummary: { beforeTokens: 1000, afterTokens: 100, savedTokens: 900 }, clientName: "claude-code" },
    ]);
    const r = await computeTierkitMcpSavings(ws, undefined, { homeDirOverride: home });
    expect(r.byModel["claude-sonnet-4-6"]?.savedTokens).toBe(900);
  });

  it("computes USD per row when baselineInputUsdPerMillion provided", async () => {
    const { ws, home } = await makeWorkspace();
    await appendActivity(ws, [
      { ts: todayIso(0), type: "mcp-tool", workspaceRoot: ws, tool: "tierkit.compress_command", ok: true, code: null, durationMs: 5, redactionHits: 0, inputSummary: {}, outputSummary: { beforeTokens: 1_000_000, afterTokens: 0, savedTokens: 1_000_000 }, clientName: "claude-code" },
    ]);
    const r = await computeTierkitMcpSavings(ws, 3, { homeDirOverride: home }); // $3 per million
    expect(r.byClient["claude-code"]?.estimatedSavedUsd).toBeCloseTo(3, 5);
  });

  it("activity without clientName goes to byClient.unknown", async () => {
    const { ws, home } = await makeWorkspace();
    await appendActivity(ws, [
      // No clientName field — older entry shape
      { ts: todayIso(0), type: "mcp-tool", workspaceRoot: ws, tool: "tierkit.compress_command", ok: true, code: null, durationMs: 5, redactionHits: 0, inputSummary: {}, outputSummary: { beforeTokens: 100, afterTokens: 10, savedTokens: 90 } },
    ]);
    const r = await computeTierkitMcpSavings(ws, undefined, { homeDirOverride: home });
    expect(r.byClient["unknown"]?.savedTokens).toBe(90);
  });
});
```

- [ ] **Step 2: Run — expect compilation error**

Run: `pnpm --filter @tierkit/core test tierkitSavings.byClientByModel`
Expected: FAIL — `computeTierkitMcpSavings` doesn't accept third options arg yet; `byClient`/`byModel` fields don't exist.

- [ ] **Step 3: Extend tierkitSavings.ts**

Modify `packages/core/src/runtime/tierkitSavings.ts`:

1. Add new optional third param `options?: { homeDirOverride?: string }`.
2. Extend `TierkitMcpSavingsSummary` with the two new fields.
3. After the existing accumulation loop, call `attributeModelFromJsonls` and bucket.

```ts
import { attributeModelFromJsonls } from "./attributeModelFromJsonls.js";

export interface ClientOrModelSummary {
  toolCallCount: number;
  savedTokens: number;
  estimatedSavedUsd?: number;
}

export interface TierkitMcpSavingsSummary {
  toolCallCount: number;
  beforeTokensTotal: number;
  afterTokensTotal: number;
  savedTokensTotal: number;
  estimatedSavedUsd?: number;
  byTool: Record<string, number>;
  windowStart: string;
  // v0.23: per-client breakdown (Claude Code, Codex, etc) + per-model
  // breakdown within Claude (Sonnet, Opus, Haiku). Codex stays in byClient
  // only — we don't parse its session transcripts.
  byClient: Record<string, ClientOrModelSummary>;
  byModel: Record<string, ClientOrModelSummary>;
}

export interface ComputeOptions {
  homeDirOverride?: string;
}

export async function computeTierkitMcpSavings(
  workspaceRoot: string,
  baselineInputUsdPerMillion?: number,
  options: ComputeOptions = {},
): Promise<TierkitMcpSavingsSummary> {
  // ... existing windowStart + entries iteration: unchanged ...
  // (KEEP all existing logic that accumulates toolCallCount / beforeTokensTotal /
  //  afterTokensTotal / byTool. Add a parallel collection of activity rows for
  //  attribution:)
  const forAttribution: Array<{ ts: string; clientName: string; savedTokens: number }> = [];

  for (const e of entries) {
    // ... existing skip conditions (timestamp, prefix, isCompressionTool) ...
    // ... existing summary extraction ...
    forAttribution.push({
      ts: e.ts,
      clientName: (e as { clientName?: string }).clientName ?? "unknown",
      savedTokens: Math.max(0, before - after),
    });
    // ... existing totals + byTool update ...
  }

  // ... existing savedTokensTotal + estimatedSavedUsd calculation ...

  // Cross-reference jsonls for model attribution.
  const attributed = await attributeModelFromJsonls({
    cwd: workspaceRoot,
    ...(options.homeDirOverride ? { homeDirOverride: options.homeDirOverride } : {}),
    activities: forAttribution,
  });

  // Aggregate byClient + byModel.
  const byClient: Record<string, ClientOrModelSummary> = {};
  const byModel: Record<string, ClientOrModelSummary> = {};
  const usdFor = (tokens: number): number | undefined =>
    typeof baselineInputUsdPerMillion === "number" && baselineInputUsdPerMillion > 0
      ? (tokens * baselineInputUsdPerMillion) / 1_000_000
      : undefined;

  for (const a of attributed) {
    const cb = (byClient[a.clientName] ??= { toolCallCount: 0, savedTokens: 0 });
    cb.toolCallCount += 1;
    cb.savedTokens += a.savedTokens;
    if (a.clientName.startsWith("claude")) {
      const mb = (byModel[a.model] ??= { toolCallCount: 0, savedTokens: 0 });
      mb.toolCallCount += 1;
      mb.savedTokens += a.savedTokens;
    }
  }
  for (const v of Object.values(byClient)) {
    const usd = usdFor(v.savedTokens);
    if (usd !== undefined) v.estimatedSavedUsd = usd;
  }
  for (const v of Object.values(byModel)) {
    const usd = usdFor(v.savedTokens);
    if (usd !== undefined) v.estimatedSavedUsd = usd;
  }

  return {
    toolCallCount,
    beforeTokensTotal,
    afterTokensTotal,
    savedTokensTotal,
    ...(estimatedSavedUsd !== undefined ? { estimatedSavedUsd } : {}),
    byTool,
    windowStart: windowStart.toISOString(),
    byClient,
    byModel,
  };
}
```

- [ ] **Step 4: Run tests**

```
pnpm --filter @tierkit/core test tierkitSavings
```
Expected: PASS — existing `tierkitSavings.test.ts` AND the new `tierkitSavings.byClientByModel.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/tierkitSavings.ts packages/core/test/tierkitSavings.byClientByModel.test.ts
git -c commit.gpgsign=false commit -m "feat(core): tierkitSavings byClient + byModel aggregation

Extends the savings summary with two new breakdowns. byClient buckets
every today's MCP activity by clientName (defaulting to 'unknown' for
older entries). byModel additionally cross-references Claude jsonls
via attributeModelFromJsonls to bucket Claude activities by their
message.model. Codex / other clients appear only in byClient.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Thread homeDir through the savings endpoint

**Files:**
- Modify: `packages/core/src/runtime/Server.ts`

Server.ts already accepts `opts.homeDir` (added earlier for chat-session routes). The savings route calls `computeTierkitMcpSavings(opts.cwd, inputUsdPerMillion)` and needs to forward homeDir.

- [ ] **Step 1: Find the savings route**

```
grep -n "computeTierkitMcpSavings" packages/core/src/runtime/Server.ts
```

- [ ] **Step 2: Forward homeDir**

Change:
```ts
const summary = await computeTierkitMcpSavings(opts.cwd, inputUsdPerMillion);
```
to:
```ts
const summary = await computeTierkitMcpSavings(
  opts.cwd,
  inputUsdPerMillion,
  opts.homeDir ? { homeDirOverride: opts.homeDir } : {},
);
```

- [ ] **Step 3: Run full test**

```
pnpm --filter @tierkit/core test
```
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/runtime/Server.ts
git -c commit.gpgsign=false commit -m "fix(http): thread homeDir into the savings endpoint

Lets the savings integration test point Claude's jsonl scan at a tmp
dir instead of the real ~/.claude. Production callers leave homeDir
undefined and the function defaults to os.homedir().

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: GUI — pretty helpers + two new details sections

**Files:**
- Modify: `packages/core/src/runtime/ui/gui.ts`

- [ ] **Step 1: Add pretty helpers**

Find a spot near other small helpers (e.g. above `refreshSavings`). Add:

```js
  // v0.23: pretty-print Anthropic model ids for the savings breakdown.
  // claude-opus-4-7 → "Opus 4.7", claude-sonnet-4-6 → "Sonnet 4.6",
  // claude-haiku-4-5-20251001 → "Haiku 4.5". Unknown families pass through.
  function prettyModel(id) {
    if (!id || id === 'unknown') return lang === 'ko' ? '(알 수 없음)' : '(unknown)';
    const m = String(id).match(/^claude-(opus|sonnet|haiku)-(\\d+)-(\\d+)/);
    if (m) return m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + '.' + m[3];
    return id;
  }
  function prettyClient(name) {
    if (!name || name === 'unknown') return lang === 'ko' ? '(알 수 없음)' : '(unknown)';
    if (name === 'claude-code') return 'Claude Code';
    if (name === 'codex') return 'Codex';
    return name;
  }
```

- [ ] **Step 2: Add the two `<details>` sections in HTML**

Find the savings card HTML (search for `m-routing-input-tokens` — around line 1118). The card looks like:

```html
<section class="card">
  <h2>...</h2>
  <div id="card-savings-today-body">
    <div id="m-routing-visual">...</div>
    <div class="metric">...input tokens...</div>
    <div class="metric">...cost...</div>
    <div class="metric">...calls...</div>
    <!-- byTool list, hint, etc -->
  </div>
</section>
```

Inside `#card-savings-today-body`, after the last existing metric but BEFORE the closing `</div>`, add:

```html
      <details id="m-routing-by-client" class="savings-breakdown" style="margin-top:10px">
        <summary style="cursor:pointer;font-size:11.5px;font-weight:600" data-i18n="savingsByClient">By client</summary>
        <div id="m-routing-by-client-rows" style="margin-top:4px"></div>
      </details>
      <details id="m-routing-by-model" class="savings-breakdown" style="margin-top:6px">
        <summary style="cursor:pointer;font-size:11.5px;font-weight:600" data-i18n="savingsByModel">By Claude model</summary>
        <div id="m-routing-by-model-rows" style="margin-top:4px"></div>
      </details>
```

- [ ] **Step 3: Render rows inside refreshSavings**

Find `function refreshSavings`. After the existing rendering (just before the function's final close), add:

```js
      // v0.23: byClient + byModel breakdowns.
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
      renderBreakdown('m-routing-by-client-rows', byClient, prettyClient);
      renderBreakdown('m-routing-by-model-rows', byModel, prettyModel);
```

- [ ] **Step 4: Add i18n keys**

In `LOCALES.ko`, add:

```js
      savingsByClient: '클라이언트별',
      savingsByModel: 'Claude 모델별',
```

- [ ] **Step 5: Run GUI tests**

```
pnpm --filter @tierkit/core test guiHtml i18nCoverage
```
Expected: PASS. (`i18nCoverage` from the i18n plan; if that hasn't shipped yet, just `guiHtml`.)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime/ui/gui.ts
git -c commit.gpgsign=false commit -m "feat(ui): savings card — byClient + byModel collapsible sections

Adds two <details> blocks inside the existing 'Today — Tierkit MCP 압축
절감' card. byClient lists Claude Code / Codex / unknown with saved
tokens + call count + USD. byModel (Claude only) lists Opus 4.7 /
Sonnet 4.6 / Haiku 4.5 / etc. with the same triplet. Pretty-name
helpers map raw Anthropic ids to human-readable labels.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Build vsix + deploy + smoke

**Files:** none — packaging + verification only.

- [ ] **Step 1: Full test suite**

```
pnpm --filter @tierkit/core test
```
Expected: all tests pass.

- [ ] **Step 2: Build + package**

```
pnpm --filter @tierkit/core build
cd packages/vscode-tierkit && pnpm run build && pnpm run package:sideload
```
Expected: vsix produced.

- [ ] **Step 3: Hot-deploy**

```bash
EXT_DIR=/Users/siwal/.local/share/code-server/extensions/leesiwal.tierkit-vscode-0.21.12
VSIX=/Users/siwal/code/Tierkit/packages/vscode-tierkit/tierkit-vscode-0.22.0.vsix
TMP=$(mktemp -d) && unzip -q "$VSIX" -d "$TMP"
cp "$TMP/extension/dist/extension.js" "$EXT_DIR/dist/extension.js"
cp "$TMP/extension/dist/extension.js.map" "$EXT_DIR/dist/extension.js.map" 2>/dev/null
rm -rf "$TMP"
echo "deployed at $(stat -f '%Sm' -t '%H:%M:%S' $EXT_DIR/dist/extension.js)"
```

- [ ] **Step 4: Manual smoke (after user reloads window)**

Confirm in the running webview:
- Savings card still shows the existing top-level metrics (total tokens, cost, calls).
- Two new collapsible sections appear: "클라이언트별 / By client" + "Claude 모델별 / By Claude model".
- When the user triggers a Tierkit MCP tool call via Claude Code Chat, both sections eventually populate.
- Codex calls (if any) appear in byClient but NOT in byModel.

No commit for this task — build outputs are gitignored.

---

## Self-Review

**Spec coverage:**
- clientName capture via getClientVersion → Task 2 ✓
- McpActivityInput.clientName field → Task 1 ✓
- attributeModelFromJsonls 5-minute fuzzy window → Task 3 ✓
- byClient / byModel aggregation → Task 4 ✓
- prettyModel / prettyClient helpers → Task 6 ✓
- Two new collapsible sections in card → Task 6 ✓
- i18n keys (savingsByClient, savingsByModel) → Task 6 ✓
- Tests for all three layers → Tasks 3, 4 ✓
- Build/deploy/smoke → Task 7 ✓

**Placeholder scan:** No TBDs. Each step shows the code. The "existing logic / KEEP" placeholders in Task 4 Step 3 are explicit pointers ("KEEP all existing logic that accumulates toolCallCount / …") — they describe what NOT to touch, not what to fill in.

**Type consistency:**
- `clientName` is `string | undefined` in source, defaults to `"unknown"` at read time. Consistent across Tasks 1, 2, 3, 4.
- `attributeModelFromJsonls` returns `AttributedActivity[]` with `model: string` (never undefined). Consumer in Task 4 uses `a.model` directly. ✓
- `ClientOrModelSummary` defined once in Task 4 and used by both `byClient` and `byModel`. ✓
- `prettyModel("unknown")` and `prettyClient("unknown")` both return `(unknown)` / `(알 수 없음)`. ✓
- `attributeModelFromJsonls` accepts `homeDirOverride?: string` and `computeTierkitMcpSavings` accepts `options?: { homeDirOverride?: string }` — names line up.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-23-per-model-savings-breakdown.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
