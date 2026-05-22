# Interactive `AskUserQuestion` in Tierkit Chat — design (2026-05-23)

## Problem

Tierkit Chat invokes `claude -p` (single-shot print mode) with stdin closed after the user's message. When an agent inside that turn calls Anthropic's built-in `AskUserQuestion` tool, the runtime has no harness to answer, so the tool errors out with "Answer questions?" and Claude moves on without an answer. The user sees the raw tool_use JSON + an error and can't act on it.

## Goals

1. Detect `tool_use` events where `name === "AskUserQuestion"` (Anthropic's built-in tool — input shape `{ questions: [{ question, header, multiSelect, options: [{ label, description }] }] }`).
2. Render an interactive form in place of the generic tool card — radio for single-select, checkboxes for multi-select, plus an "Other (specify)" free-form input that's always available.
3. When the user submits, post the answer as a **new chat message** in the same `tkChatSessionId` — Claude picks it up via `--resume` and continues the conversation as if the user had typed the answer themselves.

## Non-goals (YAGNI)

- True bidirectional tool result (would require ripping out `claude -p` for interactive mode — separate spec).
- Persisting form state across reloads (transient is fine — the agent's question is gone after a refresh anyway).
- Validating that the agent actually requested AskUserQuestion (we just respond to the name).
- Cancel button — the user can just send any other message, which ends that line of questioning.
- Time-out / auto-submit.

## Architecture

Pure GUI change. No daemon endpoints, no server code, no claude CLI argument changes.

### Detection

Inside `chatAssistantBubble().addToolUse(d)` (`packages/core/src/runtime/ui/gui.ts` ~line 5024), branch:

```js
if (d.name === 'AskUserQuestion' && d.input && Array.isArray(d.input.questions)) {
  renderInteractiveQuestion(d);
  return;
}
// ... existing generic tool card path
```

### Form rendering

A new helper `renderInteractiveQuestion(d)` builds:

```
┌───────────────────────────────────────────────┐
│ 🤔 Claude is asking                           │
├───────────────────────────────────────────────┤
│ Q1. 어떤 관점으로 리뷰할까요? [복수 선택]      │
│   ☐ 현재 상태/진행 점검                       │
│   ☐ 아키텍처/코드 품질                        │
│   ☐ v1.0 SPEC 대비 갭                         │
│   ☐ 릴리스 준비 상태                          │
│   📝 Other: [          ]                      │
│                                               │
│ Q2. 리뷰 깊이와 출력은? [단일 선택]            │
│   ◯ 요약 리포트                               │
│   ◯ 상세 리포트 + 인용                        │
│   ◯ 리뷰 + 즉시 수정 제안                     │
│   📝 Other: [          ]                      │
│                                               │
│              [   Submit answer   ]            │
└───────────────────────────────────────────────┘
```

Styling mirrors the existing `.agent-thread` tool card (`background: var(--bg-input); border: 1px solid var(--border); border-radius: 4px`). Each question is its own block. Radio uses `name="tk-aqq-<id>-<qi>"` (scoped by tool-use id + question index) so multiple parallel AskUserQuestion cards don't collide.

### Submission

Submit button click handler:

1. Collect answers per question:
   - `radio`/`checkbox` picks +
   - `Other` value if non-empty
2. Format as a Markdown user message:
   ```
   **Q1: 어떤 관점으로 리뷰할까요?**
   - 현재 상태/진행 점검
   - 아키텍처/코드 품질

   **Q2: 리뷰 깊이와 출력은?**
   - 요약 리포트
   ```
3. Call the existing `streamChat(formattedText)` (defined ~line 5130 in gui.ts — the function the textarea+Enter handler uses). This already POSTs to `/v1/claude-code/chat` with the current `tkChatSessionId` and renders the user bubble + assistant stream.
4. Disable the form and replace the Submit button with a "✓ Sent" pill so the user sees the action took effect.

### Failure modes

| Case | Behavior |
|---|---|
| User clicks Submit with nothing selected and no Other text | Toast "Pick at least one option or type in Other." Form stays editable. |
| The wrapping chat turn has already ended (most common case) | Submit creates a NEW chat turn via `--resume`. Claude sees the answer as the next user message — agent picks up where it left off as long as it's a stateful agent. |
| User reloads the window | The form vanishes (transient DOM). The agent's question is also gone (claude already returned an error). User starts over. |
| `d.input.questions` malformed | Fall through to the generic tool card path. Don't crash. |

## Testing

Existing `gui.html.test.ts` snapshot check stays green (we add HTML/JS but don't change existing structure). Manual smoke:

1. Open Tierkit Chat, send a message that triggers a slash command using AskUserQuestion (the very `/audit` or `/review` flow that produced the original screenshot).
2. Verify form renders with the agent's exact options, radio vs checkbox per `multiSelect`, Other field present.
3. Pick options, click Submit. Verify next user-bubble in the thread shows the formatted answer, and Claude resumes from there.
4. Verify a second AskUserQuestion in the same session also renders interactively (no collision on radio `name`).

No new unit tests — this is a single-file UI feature.

## Risks

- **Format drift**: if Anthropic ships a v2 AskUserQuestion with different field names (e.g. `multiselect` lowercase, or new fields), the form would mis-render. Acceptable — we'd notice from a single user report.
- **Race**: the user might click Submit AFTER starting a new turn (typing in the composer). Mitigation: the chat send path queues — claude is single-flight per session, so the answer either lands first or gets queued. We don't need to guard against this client-side.

## Open questions

None — the user's "B (의사인터랙티브)" choice locks the scope.
