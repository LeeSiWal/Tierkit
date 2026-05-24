# Savings SSE stream — design

**Date:** 2026-05-24
**Target release:** v0.22.3
**Status:** Approved — ready for implementation plan

## Problem

The Tierkit sidebar's Savings card shows a stale "0" until the user clicks the refresh button. The GUI already polls every 5 seconds ([`gui.ts:7184`](../../../packages/core/src/runtime/ui/gui.ts#L7184)), but two things conspire against the user feeling auto-updated:

1. VS Code throttles `setInterval` in hidden webviews even when `retainContextWhenHidden: true` is set, so the panel re-opens with a stale snapshot until the next interval tick.
2. The webview has no `onDidChangeVisibility` hook ([`extension.ts`](../../../packages/vscode-tierkit/src/extension.ts) confirmed absent), so it doesn't even re-fetch on re-show.

We want the Savings card to update with sub-second latency when an MCP compression tool is called from any client, without the user pressing a button.

## Solution at a glance

Add a Server-Sent Events endpoint `GET /v1/tierkit/savings/stream` that pushes a full `TierkitMcpSavingsSummary` snapshot every time `logMcpActivity` records a tool call, plus a 30-second heartbeat snapshot. The webview subscribes once at init and renders each event. Polling for savings is removed; other cards (activity, usage, health) keep their existing 5s polling unchanged.

## Architecture

```
┌─ MCP tool call (any client) ────────────┐
│  logMcpActivity(root, input)            │
│    ├─ append usage.jsonl                │
│    └─ activityListener?.(root)  ◀────── NEW: optional callback
└─────────────────────────────────────────┘
            │
            ▼
┌─ savingsBroadcaster (NEW, per daemon) ──┐
│  • Set<{res, send}> subscribers         │
│  • broadcast(root):                     │
│      summary = computeTierkitMcpSavings │
│      write SSE to every subscriber      │
│  • 30s heartbeat → broadcast()          │
└─────────────────────────────────────────┘
            │
            ▼ SSE
┌─ GET /v1/tierkit/savings/stream ────────┐
│  on connect: push current snapshot once │
│  on tool call: push snapshot            │
│  on 30s tick: push snapshot             │
│  on req close: unsubscribe              │
└─────────────────────────────────────────┘
            │  (webview uses transport.stream() — CSP-safe proxy via extension host)
            ▼
┌─ webview gui.ts ────────────────────────┐
│  init: subscribeSavings()               │
│  on event: renderSavings(snapshot)      │
│  setInterval no longer calls            │
│    refreshSavings()                     │
└─────────────────────────────────────────┘
```

### Circular-import avoidance

`activityLog.ts` lives under `packages/core/src/mcp/`; broadcaster lives under `packages/core/src/runtime/`. The mcp layer must not import runtime. We invert the dependency: `activityLog` exposes `setActivityListener(fn | null)`, and the daemon (runtime) injects a listener at startup that calls `savingsBroadcaster.broadcast(root)`.

### Event payload format

Follows the existing chat-stream convention (chat SSE intentionally omits the SSE `event:` line since the JSON payload carries `.type` — see [`Server.ts:557`](../../../packages/core/src/runtime/Server.ts#L557)):

```
data: {"type":"savings-snapshot","summary":{...TierkitMcpSavingsSummary}}\n\n
```

Heartbeat sends the same shape — no separate heartbeat type. A full snapshot every 30s also self-corrects any state drift between server and webview.

## File-level changes

| File | Status | Change |
|---|---|---|
| `packages/core/src/mcp/activityLog.ts` | modify | Add `setActivityListener(fn \| null)` export. In `logMcpActivity`, after `fs.appendFile` succeeds, call `listener?.(workspaceRoot)` wrapped in `try/catch` so listener errors cannot break the append return path |
| `packages/core/src/runtime/savingsBroadcaster.ts` | **new** | Module-scoped state: `subscribers: Set<http.ServerResponse>`, `heartbeat: NodeJS.Timeout \| null`. Exports: `start(workspaceRoot)`, `stop()`, `subscribe(res, workspaceRoot)`, `broadcast(workspaceRoot)`. Heartbeat = 30_000 ms. The baseline `inputUsdPerMillion` is re-resolved inside `broadcast()` per call (same logic as `/v1/tierkit/savings/today`) so live profile edits take effect without a daemon restart |
| `packages/core/src/runtime/Server.ts` | modify | (1) On daemon start: call `savingsBroadcaster.start(...)` and `setActivityListener((root) => savingsBroadcaster.broadcast(root))`. (2) Add route `GET /v1/tierkit/savings/stream` — SSE headers, register subscriber, immediately write current snapshot, `req.on("close", unsubscribe)`. (3) On daemon stop: `savingsBroadcaster.stop()` and `setActivityListener(null)` |
| `packages/core/src/runtime/ui/gui.ts` | modify | (1) Extract the savings DOM-update body of `refreshSavings()` into a pure `renderSavings(summary)` helper so both the fetch path and the stream path share rendering. (2) Add `subscribeSavings()` using existing `transport.stream()` against `/v1/tierkit/savings/stream`; on `payload.type === "savings-snapshot"` call `renderSavings(payload.summary)`. (3) Call `subscribeSavings()` once at init right after `refreshAll()`. (4) Remove `refreshSavings()` from the 5-second `setInterval`; keep it as the initial fetch and as the manual refresh button handler |
| `packages/core/test/savingsBroadcaster.test.ts` | **new** | Unit tests (see Testing) |
| `packages/core/test/activityLog.test.ts` | modify or new | Tests for `setActivityListener` lifecycle |
| `packages/core/test/Server.savingsStream.test.ts` | **new** | In-process integration test (see Testing) |

Estimated diff: ≈ 200 lines new, ≈ 80 lines modified.

## Out of scope (YAGNI)

- SSE for other cards (activity, usage, health) — user pain is savings-specific
- Per-subscriber filtering or auth — daemon is loopback-only, single-workspace
- Backpressure handling — payload <2 KB, expected subscriber count 1–3 (editor windows)
- `Last-Event-ID` resume semantics — EventSource auto-reconnects and the server immediately re-sends a full snapshot on (re)connect

## Testing

### Unit (vitest, in-process)

`savingsBroadcaster.test.ts`:
1. `subscribe()` writes a snapshot synchronously on first connect.
2. `broadcast()` writes to every subscriber.
3. If a subscriber's `res.write` throws, only that subscriber is removed; others continue receiving.
4. Heartbeat fires after 30 s (use `vi.useFakeTimers()`).
5. `stop()` clears the heartbeat timer and the subscriber set.

`activityLog.test.ts` additions:
1. `setActivityListener(fn)` + `logMcpActivity()` invokes `fn(workspaceRoot)` exactly once after append.
2. A throwing listener does not propagate — `logMcpActivity` still resolves and the entry is appended.
3. `setActivityListener(null)` clears the listener.

### Integration (in-process Server)

`Server.savingsStream.test.ts`:
1. Boot daemon against a tmp workspace, open SSE via `fetch`, parse first event → assert shape matches `TierkitMcpSavingsSummary`.
2. Call `logMcpActivity(tmp, fixtureToolCall)` → assert a second event arrives within 100 ms.
3. `AbortController` cancels the request → assert subscriber set is empty.
4. Daemon shutdown clears the heartbeat (no pending timers leak).

### Manual (webview)

E2E webview testing is out of band for this repo. Verification checklist for the manual smoke test in the release PR:

- [ ] Open sidebar. Trigger an MCP compression tool from a second Claude Code instance. Savings card updates without clicking refresh, within ~500 ms.
- [ ] Collapse and re-expand the sidebar. Savings card retains the latest value (no stale "0").
- [ ] Kill and restart the daemon (Reload Window). Webview reconnects automatically and resumes updates.

## Error handling

- **`computeTierkitMcpSavings` throws** (e.g., unreadable activity file): broadcaster catches, logs, holds the previous snapshot. Subscribers stay connected.
- **Subscriber write fails** (client gone, broken pipe): catch on write, remove that subscriber from the set, never propagate to other subscribers or the listener path.
- **Daemon shutdown mid-write**: `stop()` calls `res.end()` on every subscriber before clearing the set.
- **Listener exception inside `logMcpActivity`**: caught and swallowed (with `console.error`). The append return path is unaffected.

## Coexistence with existing endpoint

`GET /v1/tierkit/savings/today` stays. It serves:
- The initial fetch path inside `refreshSavings()` (still used at webview init and for the manual refresh button)
- Programmatic clients that don't want a long-lived stream
- A fallback if SSE setup fails

The stream is purely additive.

## Rollback

Single-line revert in `gui.ts`: re-add `refreshSavings()` to the 5-second `setInterval` and remove the `subscribeSavings()` init call. The SSE endpoint can stay — idle cost is negligible (one Set lookup per tool call, no active subscribers).

## Release

Ship as a patch in **v0.22.3**:
1. `pnpm bump 0.22.3`
2. `pnpm -F @tierkit/core build && pnpm -F tierkit-vscode build`
3. `pnpm -F tierkit-vscode package`
4. Install vsix, reload window, update `.mcp.json` paths (both project and user scope) to 0.22.3.

No data migration. No breaking changes for SDK consumers (additive endpoint).
