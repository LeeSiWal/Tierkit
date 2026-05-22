# Chat sessions in chat tab — design (2026-05-22)

## Problem

The chat tab today shows a single in-flight thread. The list of past sessions sits in the Settings tab as raw metrics (turns, tokens, cost) with no way to open one and see its messages. Users can't browse history per session or resume a past conversation from inside Tierkit Chat.

## Goals

1. List the user's chat sessions inside the chat tab (not Settings).
2. Clicking a session loads its message history into the chat thread.
3. Clicking a session continues that session — the next message resumes it via `claude --resume <id>`.
4. `+ New` clears the thread and starts a fresh session.
5. Cover **all** Claude sessions in the current workspace, not just Tierkit-originated ones — so a conversation started in Claude Code's VS Code extension can be resumed from Tierkit Chat.

## Non-goals (YAGNI)

- Rename a session
- Delete an individual session (Claude's jsonl is its own store; we don't touch it)
- Full-text search across sessions
- Cross-workspace session list
- Mirroring message bodies in localStorage

## Source of truth for messages

Claude CLI already persists every session as `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. Each line is a JSON event (`user`, `assistant`, `tool-use`, `tool-result`, plus internal events like `queue-operation`, `attachment`). We read this directly through new daemon endpoints — no duplicate storage, always in sync with Claude's actual state.

Tierkit's existing localStorage `tk_chat_sessions` map stays — it carries token/cost/savedTokens metadata that the jsonl doesn't surface. We join it client-side onto the session rows.

## Architecture

### New daemon endpoints

`GET /v1/claude-code/sessions`
- Lists session metadata for the workspace.
- Resolves dir: `path.join(os.homedir(), ".claude/projects", encodeCwd(opts.cwd))` where `encodeCwd` replaces every `/` and `.` with `-`. Verified examples: `/Users/siwal/code/Tierkit` → `-Users-siwal-code-Tierkit`; `/Users/siwal/code/Tierkit/.claude/worktrees/feat/v0.13/sub` → `-Users-siwal-code-Tierkit--claude-worktrees-feat-v0-13-sub`.
- For each `*.jsonl` file: read the file, walk lines to find `messageCount` (count of `type==="user"` + `type==="assistant"`), first-user-message `preview` (first 120 chars stripped to one line), and `mtime`.
- Skip files whose only events are `queue-operation` / `attachment` (no real conversation).
- Sort by `mtime` descending.
- Response: `{ ok: true, sessions: [{ id, mtime, messageCount, preview }] }`.
- If the projects dir doesn't exist yet: `{ ok: true, sessions: [] }`.

`GET /v1/claude-code/sessions/:id`
- Returns the parsed message thread for one session.
- `id` validated against `/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/`. Anything else → 400. This guards path traversal.
- Reads the jsonl, line by line. For each line: parse JSON; emit one output entry per relevant event:
  - `user` → `{ role: "user", text }`
  - `assistant` text content → `{ role: "assistant", text }`
  - `tool_use` (inside an assistant message) → `{ role: "assistant", toolUse: { name, input, id } }`
  - `tool_result` → `{ role: "tool", toolResultFor: callId, text }`
- Drop: `queue-operation`, `attachment` (hook output, screenshots), `summary`, anything we don't render in the live chat thread.
- Response: `{ ok: true, id, messages: [...] }`. File missing → 404 `{ code: "not-found" }`.

Both endpoints are loopback-only like the rest of the daemon and don't take a body.

### GUI changes

**HTML** — wrap the existing `agent-shell` inside a flex container and add an `aside` for the sidebar:

```html
<div class="tab-panel active" data-tab-panel="chat">
  <div id="host-banner" …></div>
  <div class="chat-layout">
    <aside id="tk-chat-sidebar" class="chat-sidebar">
      <div class="chat-sidebar-header">
        <button id="tk-chat-sidebar-toggle" title="…">«</button>
        <button id="tk-chat-new-session" class="primary tiny">+ New</button>
      </div>
      <div id="tk-chat-session-list">
        <div class="dim">loading…</div>
      </div>
    </aside>
    <div class="agent-shell"> … existing … </div>
  </div>
</div>
```

**CSS** — flex layout, sidebar 220px expanded / 36px collapsed. Collapsed state persists in localStorage as `tk_chat_sidebar_collapsed`. Toggle button text flips `«`/`»`. On very narrow widths (<480px) sidebar auto-collapses.

**JS** — new functions:

- `loadChatSessions()` — fetch `/v1/claude-code/sessions`, join localStorage `tk_chat_sessions` metadata onto each row by id, render rows: id-short (first 8 chars), preview, mtime, optional token/cost line. Highlight `tkChatSessionId` row. Empty state: "No chat sessions yet."
- `loadChatSessionMessages(id)` — fetch `/v1/claude-code/sessions/:id`, clear `agent-thread`, walk messages and synthesize bubbles using the existing factories (`chatAssistantBubble`, plus a new user-bubble factory if not present). Set `tkChatSessionId = id`, update sidebar selected highlight.
- `newChatSession()` — set `tkChatSessionId = null`, clear `agent-thread`, restore the original empty placeholder.

**Hooks into existing code**:
- `recordSessionEvent` (existing) still updates localStorage; add a single line at the end to call `loadChatSessions()` so the sidebar refreshes after each turn.
- After a streamed `result` event sets a new `tkChatSessionId`, call `loadChatSessions()` (covered by the line above).
- On chat-tab activation (in `setActiveTab('chat')`): call `loadChatSessions()` if list is empty.

### Settings tab cleanup

Remove the existing `<section class="card">` containing `#tk-sessions-list` and its `Clear history` button (currently at lines ~951–960 in `gui.ts`). `refreshSessionsCard` function gets renamed to `refreshChatSidebar` and rewired to the new list element.

The "Clear history" button isn't replicated in the sidebar — clearing the localStorage metadata wouldn't delete the jsonl files anyway, so the button would have been misleading. Users who actually want to wipe history delete the jsonl files themselves.

## Error handling

| Failure | Behavior |
|---|---|
| `GET /sessions` 5xx or network | Sidebar shows "세션 불러오기 실패" + Retry button |
| `GET /sessions` returns `[]` | Sidebar shows "No chat sessions yet." |
| `GET /sessions/:id` 404 | Toast "이 세션은 사라졌습니다 — 다른 세션을 선택해주세요", sidebar refreshes |
| `GET /sessions/:id` 5xx | Toast with message, thread stays as-is |
| jsonl line fails to parse | Skip that line silently (Claude has known internal events we don't model) |
| `id` in URL doesn't match UUID regex | 400 immediately, no FS access |

## Testing

**Daemon** (`packages/core/test/claudeCodeSessions.test.ts`):
- Fixtures: a tmp `.claude/projects/<encoded>/` with three jsonl files (well-formed, malformed, queue-operation-only)
- `GET /sessions` returns 2 sessions (skips the queue-only one), sorted by mtime desc, preview matches first user content
- `GET /sessions/<valid-id>` returns the message thread
- `GET /sessions/<malformed-id>` returns 400
- `GET /sessions/<missing-id>` returns 404
- Path traversal: `GET /sessions/../etc/passwd` → 400
- Empty projects dir → `{ sessions: [] }`

**GUI** — existing `gui.html.test.ts` snapshot updates expected. Add a small unit test that the message-thread parser handles tool_use/tool_result events.

## Risks

1. **Coupling to Claude's jsonl format.** If Anthropic changes the event schema, our parser breaks. Mitigated by treating unknown events as skip-list (forward-compatible) rather than failing loudly. Format has been stable since early 2025.
2. **Reading large jsonl on every sidebar render.** A long chat could be a few MB. We only read the file to count messages + extract preview in the index endpoint — that's two passes per file but each pass is line-streamed, not loaded whole. For the message endpoint we accept loading the file fully (only triggered on click).
3. **Workspace cwd mismatch.** Claude encodes `/` as `-` in directory names. If the user opens Tierkit in `/some/nested/dir` but Claude was run in a different cwd, the sidebar will be empty. That's correct behavior — sessions belong to the cwd they were created in.

## Open questions

None — all clarifying questions answered during brainstorming.
