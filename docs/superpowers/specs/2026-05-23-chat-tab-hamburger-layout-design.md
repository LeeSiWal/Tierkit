# Chat Tab Hamburger Layout — design (2026-05-23)

## Problem

The chat-tab sidebar shipped earlier today (per `2026-05-22-chat-sessions-in-chat-tab-design.md`) eats horizontal space that the thread can't spare. On code-server with a Claude Code companion pane open, the 220px sidebar squashes the chat composer into ~80px wide and forces the user to either collapse the sidebar (losing the session list) or close the companion pane.

We need to keep the session-browsing capability but stop renting permanent horizontal real estate.

## Goals

1. Remove the always-visible left sidebar from the chat tab.
2. Surface session list and session-management actions via a hamburger button (`☰`) inside the agent-card's `<h2>` header — right-aligned, inside the card frame.
3. Clicking the hamburger opens a dropdown anchored to the button: `+ New session`, `Clear thread`, then the session list.
4. The dropdown overlays the chat thread (absolute positioning, doesn't push content). Closes on outside click, Escape, or session selection.
5. Preserve all session-load functionality already shipped: clicking a session restores history into the thread, sets `tkChatSessionId`, and the next message resumes via `claude --resume`.

## Non-goals (YAGNI)

- Keyboard navigation through session rows (↑/↓)
- Filter/search the dropdown
- Rename / delete individual sessions
- Multiple hamburger items (settings shortcut, theme switcher, etc.)
- Animating the dropdown (CSS transitions)
- Mobile-specific tweaks beyond what the existing 600px media query covers

## Source of truth

Sessions still come from the two daemon endpoints shipped earlier:
- `GET /v1/claude-code/sessions`
- `GET /v1/claude-code/sessions/:id`

No daemon changes in this redesign — only the GUI presentation moves.

## Architecture

Pure GUI change in `packages/core/src/runtime/ui/gui.ts`.

### What to delete

The left-sidebar layout from the previous spec:

- HTML: the entire `<div class="chat-layout">` wrapper and its `<aside id="tk-chat-sidebar">`. The `.agent-shell` returns to being a direct child of the chat tab panel.
- CSS: `.chat-layout`, `.chat-sidebar`, `.chat-sidebar.collapsed`, `.chat-sidebar-header`, `.chat-sidebar-header > button`, `.chat-sidebar-header > #tk-chat-new-session`. The 480px media-query block that auto-collapsed the sidebar.
- JS: the sidebar-toggle wire-up (`TK_SIDEBAR_LS_KEY`, `tk-chat-sidebar-toggle` click handler).
- The `.agent-shell { min-width: 0 }` that we added solely for the flex-row collapse — no longer needed once the flex row is gone.

The session-list CSS (`.chat-session-row`, `.session-preview`, `.session-meta`) **stays** — the new dropdown reuses the same row markup.

### What to add

**HTML** — add a hamburger button inside the existing `.h2-actions` span (already there but currently `hidden`), and a dropdown div inside `.agent-card`:

```html
<div class="agent-card">
  <h2>
    <span data-i18n="cardAgent">Tierkit Compressor</span>
    <span id="agent-status" …>idle</span>
    <span id="agent-usage-meter" …>0 tok</span>
    <span id="tk-chat-cost-meter" …>$0.0000</span>
    <span id="tk-chat-saved-meter" …>절감 0 tok</span>
    <span class="h2-actions">  <!-- no longer hidden -->
      <button id="tk-chat-sessions-toggle" class="tiny" title="…" aria-expanded="false" aria-controls="tk-chat-sessions-dropdown">☰</button>
    </span>
  </h2>

  <div id="tk-chat-sessions-dropdown" class="chat-sessions-dropdown" hidden role="menu" aria-labelledby="tk-chat-sessions-toggle">
    <div class="chat-sessions-dropdown-header">
      <button id="tk-chat-new-session" class="tiny primary" title="start a new session">+ <span data-i18n="chatNewSession">New session</span></button>
      <button id="tk-chat-clear-thread" class="tiny" title="clear visible thread, keep session id"><span data-i18n="chatClearThread">Clear thread</span></button>
    </div>
    <div id="tk-chat-session-list">
      <div class="empty dim" data-i18n="loading">loading…</div>
    </div>
  </div>

  <div id="agent-thread" class="agent-thread">…</div>
  <div class="agent-composer">…</div>
</div>
```

The legacy hidden buttons inside `.h2-actions` (`#btn-agent-export`, `#btn-agent-import`, `#btn-agent-clear`) stay hidden — they're already null-checked by existing JS and we don't want to revive code we just buried.

**CSS** — add `position: relative` to `.agent-card` so the dropdown anchors to it, plus the dropdown's own styles:

```css
.agent-card { position: relative; }

.chat-sessions-dropdown {
  position: absolute;
  top: 38px;             /* below h2; tuned to actual h2 height + small gap */
  right: 8px;
  width: 280px;
  max-width: calc(100% - 16px);
  max-height: 50vh;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  z-index: 10;
  display: flex;
  flex-direction: column;
}
.chat-sessions-dropdown[hidden] { display: none; }
.chat-sessions-dropdown-header {
  display: flex;
  gap: 6px;
  padding: 6px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.chat-sessions-dropdown-header > button { flex: 0 0 auto; }
.chat-sessions-dropdown-header > #tk-chat-new-session { flex: 1 1 auto; min-width: 0; }
.chat-sessions-dropdown #tk-chat-session-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 4px;
}
```

On screens where the agent-card itself is narrower than ~300px, `width: 280px; max-width: calc(100% - 16px)` lets the dropdown shrink. No separate mobile media query needed — the existing 600px block doesn't apply here.

**JS** — three changes:

1. Wire the hamburger toggle. Replace the old `tk-chat-sidebar-toggle` wire-up with:

   ```js
   const sessionsToggleBtn = $('tk-chat-sessions-toggle');
   const sessionsDropdown = $('tk-chat-sessions-dropdown');
   function closeSessionsDropdown() {
     if (!sessionsDropdown.hasAttribute('hidden')) {
       sessionsDropdown.setAttribute('hidden', '');
       sessionsToggleBtn.setAttribute('aria-expanded', 'false');
     }
   }
   function openSessionsDropdown() {
     sessionsDropdown.removeAttribute('hidden');
     sessionsToggleBtn.setAttribute('aria-expanded', 'true');
     loadChatSessions();  // refresh each open
   }
   if (sessionsToggleBtn && sessionsDropdown) {
     sessionsToggleBtn.onclick = (e) => {
       e.stopPropagation();
       if (sessionsDropdown.hasAttribute('hidden')) openSessionsDropdown();
       else closeSessionsDropdown();
     };
     document.addEventListener('click', (e) => {
       if (sessionsDropdown.hasAttribute('hidden')) return;
       if (!sessionsDropdown.contains(e.target) && e.target !== sessionsToggleBtn) {
         closeSessionsDropdown();
       }
     });
     document.addEventListener('keydown', (e) => {
       if (e.key === 'Escape') closeSessionsDropdown();
     });
   }
   ```

2. After a session row is clicked, close the dropdown. Inside `loadChatSessionMessages` (just before `loadChatSessions()` at the very end), add `closeSessionsDropdown();`. After `newChatSession()` runs, also close.

3. Add `clearChatThread()` and wire its button:

   ```js
   function clearChatThread() {
     const thread = $('agent-thread');
     if (!thread) return;
     thread.innerHTML = '';
     const empty = document.createElement('div');
     empty.className = 'agent-empty';
     empty.style.lineHeight = '1.6';
     empty.innerHTML = i18n.agentEmpty || TK_INITIAL_AGENT_EMPTY_HTML;
     thread.appendChild(empty);
     closeSessionsDropdown();
     // tkChatSessionId stays — next message continues the same claude session.
   }
   const clearThreadBtn = $('tk-chat-clear-thread');
   if (clearThreadBtn) clearThreadBtn.onclick = () => clearChatThread();
   ```

`loadChatSessions()`, `loadChatSessionMessages()`, `newChatSession()` keep their current implementations — they target `#tk-chat-session-list` and `#agent-thread` by id, both of which remain in the DOM (just under a new parent).

### i18n

Add `chatClearThread`:
- `en`: HTML default `Clear thread` (no LOCALES entry needed; English uses static HTML)
- `ko`: `chatClearThread: '대화 비우기'` in LOCALES.ko

`chatNewSession` already exists from the prior spec.

## Tab activation behavior

The existing `setActiveTab(name)` hook still calls `loadChatSessions()` when switching to the chat tab. With the new layout, the dropdown is closed by default — so the first session-list fetch on tab switch primes the data, but the user doesn't see it until they click the hamburger. That's the intended UX: nothing on screen unless invoked.

To avoid a wasted fetch on every chat-tab activation, drop the proactive `loadChatSessions()` call from `setActiveTab`. The dropdown's `openSessionsDropdown` already fetches each open, which is the moment the user actually wants to see the list. The sidebar implementation's eager-load was a workaround for always-visible UI; the dropdown doesn't need it.

`recordSessionEvent` keeps calling `loadChatSessions()` — that's harmless when the dropdown is hidden (silently updates the offscreen DOM), and means the list is fresh the next time the user opens it.

## Failure modes

| Case | Behavior |
|---|---|
| User clicks hamburger before `tk-chat-sessions-dropdown` is in the DOM | Element-existence check (`if (sessionsToggleBtn && sessionsDropdown)`) prevents wiring at all — no error. |
| User clicks outside the dropdown while it's loading | Closes immediately. Pending fetch settles into the (now offscreen) DOM. |
| Esc pressed while focus is in the textarea | Dropdown closes (if open). Textarea keeps focus. No conflict — Esc has no other binding in the textarea. |
| Dropdown is wider than agent-card on a very narrow viewport | `max-width: calc(100% - 16px)` caps it; rows wrap within. |
| Multiple chat-tab activations don't redundantly fetch | The proactive `loadChatSessions()` call in `setActiveTab` is removed; only `recordSessionEvent` and `openSessionsDropdown` trigger fetches. |

## Testing

Existing `gui.html.test.ts` should pass unchanged (it's structural, not snapshot — verified during earlier reviews). Manual smoke:

1. Chat tab opens with no sidebar, full-width thread + composer.
2. Click `☰` → dropdown drops below the h2, anchored right. Shows `+ New session` + `Clear thread` + session list.
3. Click a session → thread restores, dropdown closes.
4. Reopen `☰`, click `+ New session` → thread clears to empty placeholder, dropdown closes, `tkChatSessionId` null.
5. Reopen `☰`, click `Clear thread` → thread clears, dropdown closes, `tkChatSessionId` unchanged. Next message continues the same session.
6. Click anywhere outside the dropdown → closes.
7. Press Esc with dropdown open → closes.
8. Settings tab is unaffected.

## Risks

1. **Dropdown anchor accuracy.** `top: 38px` is tuned to the h2's measured height. If a future change makes the h2 taller (wrapping pills on narrow viewport, extra status content), the dropdown will visually overlap the pills. Mitigation: keep `position: absolute` keyed to `agent-card` and pick `top` based on h2 height at runtime, OR live with the static value and trust the existing pill row's `flex-wrap` to handle narrow widths. Pick the static value for v0 (simpler, predictable); revisit if a user reports overlap.
2. **`document.addEventListener('click', …)` leak.** The handler closes the dropdown on outside clicks but registers permanently. The webview lives for the session, so no leak in practice. If we ever needed to dispose, the handler would need to be a named function so `removeEventListener` works.
3. **Pill row + hamburger on narrow viewports.** With 4 pills + title + hamburger, narrow viewports could wrap the h2 to two lines. The existing `flex-wrap: wrap` on `.topbar` doesn't apply to `.agent-card h2` — verify the h2's flex behavior allows wrapping, or accept a 2-line header on phone widths.

## Open questions

None — all clarifying questions answered during brainstorming.
