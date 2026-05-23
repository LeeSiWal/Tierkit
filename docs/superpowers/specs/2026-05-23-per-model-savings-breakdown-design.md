# Per-Model + Per-Client Savings Breakdown — design (2026-05-23)

## Problem

The "Today — Tierkit MCP 압축 절감" card shows one number: total tokens compressed across all tool calls today. Users want to see WHERE the savings came from — which client (Claude Code vs Codex), and inside Claude Code, which model (Sonnet vs Opus 4.6 vs Opus 4.7 vs Haiku). The breakdown answers "which model is benefiting most from compression" and validates that expensive models are getting the most compression value.

## Goals

1. Surface per-client savings: Claude Code / Codex / other.
2. Inside Claude Code, surface per-model savings: Opus 4.7 / Sonnet 4.6 / Haiku 4.5 / etc.
3. Show three metrics per row: tokens saved, MCP tool calls, USD saved.
4. Keep the existing total + visual bar + by-tool list at the top.

## Non-goals (YAGNI)

- 7-day / 30-day windows (today only)
- Per-tool × per-model cross-tabulation
- Parsing Codex's local session storage to attribute Codex calls to specific models
- Charts or graphs — plain rows
- Per-user attribution
- Persistence beyond today (the MCP activity log already rotates)

## Data sources

**Client name**: MCP SDK exposes `server.getClientVersion()` which returns the `Implementation` (`{ name, version }`) the client sent during the `initialize` handshake. We don't currently capture this. We will, in the CallTool handler, and stamp every activity log entry with it.

**Claude model**: Each Claude Code session writes `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` where assistant messages carry `message.model: "claude-opus-4-7"` (verified on disk). We cross-reference MCP activity timestamps against assistant turn timestamps in those jsonls.

**Codex**: No equivalent local jsonl is exposed (per our survey). Codex savings stay at the client level — no model attribution. Acceptable for v1; can be revisited if Codex ships a similar transcript format.

## Architecture

### Component 1: MCP server enrichment

`packages/mcp-server/src/server.ts` — inside the `CallToolRequestSchema` handler:

```ts
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const ci = server.getClientVersion();
  const clientName = ci?.name ?? "unknown";
  // ... existing tool execution ...
  await logMcpActivity(workspaceRoot, {
    tool, ok, code, durationMs, redactionHits,
    inputSummary, outputSummary, envelope,
    clientName,  // NEW
  });
});
```

`packages/core/src/mcp/activityLog.ts` — extend `McpActivityInput`:

```ts
export interface McpActivityInput {
  tool: string;
  ok: boolean;
  code: string | null;
  durationMs: number;
  redactionHits: number;
  inputSummary: unknown;
  outputSummary: unknown;
  envelope?: { ... };
  clientName?: string;  // NEW
}
```

Existing log lines without `clientName` get treated as `"unknown"` at read time.

### Component 2: Model attribution

New file `packages/core/src/runtime/attributeModelFromJsonls.ts`:

```ts
export interface AttributedActivity {
  ts: string;
  clientName: string;
  model: string;       // "claude-opus-4-7", "unknown", or raw provider value
  savedTokens: number;
}

/**
 * Cross-reference MCP activity entries against Claude session jsonls in the
 * workspace's project directory to attribute each entry to the model that
 * was active when the tool was called. Only applies to entries whose
 * clientName begins with "claude" (Codex etc. stay at client-level only,
 * with model = "unknown").
 *
 * Matching rule: for each Claude activity entry at time T, find the most
 * recent assistant turn in any local session jsonl whose timestamp is
 * ≤ T AND within 5 minutes of T. Use that turn's message.model. If none
 * found, model = "unknown".
 *
 * Fuzzy 5-minute window absorbs the natural skew between when Claude
 * emits the tool_use block (assistant turn timestamp) and when our MCP
 * server records the activity (after tool finishes).
 */
export async function attributeModelFromJsonls(input: {
  cwd: string;
  homeDirOverride?: string;
  activities: Array<{ ts: string; clientName: string; savedTokens: number }>;
}): Promise<AttributedActivity[]> { ... }
```

Implementation outline:
- Compute `encodedCwd` via `encodeCwdForClaudeProjects` (reused from listClaudeSessions).
- Read all `*.jsonl` files in `~/.claude/projects/<encodedCwd>/`. For each, line-stream and collect a sorted list of `{ ts, model }` from every assistant message.
- For each activity entry where clientName starts with `claude`: binary-search the sorted assistant turns for the closest preceding `ts`; if within 5 minutes, use that model. Else "unknown".
- For non-Claude clients: `model: "unknown"` (these are excluded from the byModel aggregate at the caller level anyway).

### Component 3: Aggregation in tierkitSavings.ts

Existing `computeTierkitMcpSavings` walks the activity log and returns a total + byTool. We extend the return type:

```ts
export interface TierkitMcpSavingsSummary {
  // existing
  toolCallCount: number;
  beforeTokensTotal: number;
  afterTokensTotal: number;
  savedTokensTotal: number;
  estimatedSavedUsd?: number;
  byTool: Record<string, number>;
  windowStart: string;
  // NEW
  byClient: Record<string, {
    toolCallCount: number;
    savedTokens: number;
    estimatedSavedUsd?: number;
  }>;
  byModel: Record<string, {
    toolCallCount: number;
    savedTokens: number;
    estimatedSavedUsd?: number;
  }>;
}
```

Flow:
1. Read activity log (existing).
2. Run `attributeModelFromJsonls` to add `model` to each entry.
3. Group by `clientName` → `byClient`.
4. Group entries WHERE clientName starts with `claude` AND model !== `unknown` BY `model` → `byModel`. (`unknown` model still appears in `byModel` as a fallback bucket when the timestamp match fails.)
5. Compute USD per row using `baselineInputUsdPerMillion`.

### Component 4: GUI

`packages/core/src/runtime/ui/gui.ts` — extend `refreshSavings` to render two new `<details>` blocks under the existing metric rows:

```html
<details class="savings-breakdown" id="m-routing-by-client">
  <summary data-i18n="savingsByClient">By client</summary>
  <div class="savings-rows"></div>
</details>
<details class="savings-breakdown" id="m-routing-by-model">
  <summary data-i18n="savingsByModel">By Claude model</summary>
  <div class="savings-rows"></div>
</details>
```

Each `.savings-rows` populates with `.row.dense` children. Per row:

```
{prettyClientName | prettyModelName} · {tokensShort} tok · {callCount} calls · {usd}
```

Pretty-name helper:

```ts
function prettyModel(id: string): string {
  if (id === "unknown") return "(unknown)";
  const m = id.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  return id;
}
function prettyClient(name: string): string {
  if (name === "claude-code") return "Claude Code";
  if (name === "codex") return "Codex";
  if (name === "unknown") return "(unknown)";
  return name;
}
```

Empty state: when `byClient`/`byModel` is empty (or only contains `unknown` with 0 tokens), the `<details>` block hides its rows and shows a single dim line "데이터 없음 / no data yet".

### Component 5: i18n keys

Add to `LOCALES.ko`:

```js
savingsByClient: '클라이언트별',
savingsByModel: 'Claude 모델별',
savingsModelUnknown: '(알 수 없음)',
savingsNoData: '데이터 없음',
```

(English HTML defaults serve English users — consistent with existing pattern.)

## Performance

- No caching. Every `/v1/tierkit/savings/today` request:
  1. Reads activity log (already cheap — same as today)
  2. Reads all `~/.claude/projects/<encoded-cwd>/*.jsonl` files
  3. Aggregates in memory
- Workspaces have typically ≤30 sessions, each ≤5 MB. Cold read estimate: 100–300ms.
- The savings card polls every 5 seconds — that's the natural cadence ceiling. If a workspace ever exceeds this and starts feeling sluggish, add mtime-based caching in a follow-up.

## Failure modes

| Case | Behavior |
|---|---|
| Activity log empty / missing | All counts 0; both `<details>` show "데이터 없음" |
| Activity log entry has no `clientName` (pre-bump) | Bucket as `"unknown"` in byClient |
| Activity entry has clientName "claude-code" but no matching jsonl turn (within 5 min) | Bucket as model `"unknown"` |
| Jsonl file unreadable / corrupt | Skip that file silently (forward-compat) |
| Codex / Cursor / other client | Appears in byClient; absent from byModel |
| Workspace has no `.claude/projects/<encoded>` dir | All Claude activities bucket to model `"unknown"` |

## Testing

**Unit tests**:
- `packages/core/test/attributeModelFromJsonls.test.ts`: fixture with 3 assistant turns at staggered timestamps + 3 activity entries; verify each maps to the correct model, and a 6-minute-distant entry maps to `unknown`.
- `packages/core/test/tierkitSavings.byClient.test.ts`: activity log with entries from claude-code + codex + unknown; verify byClient totals.
- `packages/core/test/tierkitSavings.byModel.test.ts`: integration of the above with jsonl fixture; verify byModel populates only for claude clients.
- `packages/core/test/prettyModel.test.ts`: name mapping table — Opus/Sonnet/Haiku at various versions, plus unknown fallback.

**Integration**:
- Extend the existing tierkit savings route test to verify `byClient` and `byModel` fields in the response.

**GUI**:
- `guiHtml.test.ts` snapshot stays green (the new HTML is additive).

## Risks

1. **Timestamp matching is fuzzy**. The 5-minute window is generous but if a user has multiple Claude windows open concurrently calling tools, the wrong model might be attributed for some calls. Acceptable for an aggregate display; not for billing-quality attribution. If this becomes a problem, we add session-id matching via MCP `_meta` (requires Claude Code to forward it, which it currently doesn't).

2. **Jsonl scan cost grows linearly with sessions**. A power user with 500 sessions × 10MB each would feel it. We start without caching to keep code simple; the next iteration adds an in-memory cache keyed on `(file, mtime)` and reads only changed files.

3. **`clientName` is freeform**. Any value the MCP client puts in `clientInfo.name` we accept. We use it as the bucket key. If a client uses inconsistent names across sessions, it appears as separate buckets. Acceptable — the user can spot it visually.

## Open questions

None — all clarifying questions answered during brainstorming.
