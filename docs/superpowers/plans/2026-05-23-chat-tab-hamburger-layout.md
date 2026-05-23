# Chat Tab Hamburger Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chat-tab left sidebar (just shipped) with a hamburger button + dropdown anchored to the agent-card h2. The thread + composer recover full width.

**Architecture:** Single-file GUI change in `packages/core/src/runtime/ui/gui.ts`. Delete the sidebar HTML/CSS/JS, add a `☰` button inside `<h2>.h2-actions`, add an absolute-positioned dropdown that hosts `+ New session` + `Clear thread` + the session list. Reuse `loadChatSessions / loadChatSessionMessages / newChatSession` unchanged — they target ids that stay in the DOM, just under a new parent.

**Tech Stack:** Vanilla DOM JS + CSS in the existing single-file webview. Vitest for the structural HTML test.

Spec: [`docs/superpowers/specs/2026-05-23-chat-tab-hamburger-layout-design.md`](../specs/2026-05-23-chat-tab-hamburger-layout-design.md)

---

## File Structure

**Only modified file:** `packages/core/src/runtime/ui/gui.ts`

The 4 tasks are mechanical edits in a single file. Splitting into more tasks would create coordination overhead without benefit. Each task has one focused purpose:
- Task 1: rip out the sidebar (HTML + CSS)
- Task 2: rip out the sidebar (JS handler + dead identifiers)
- Task 3: add hamburger + dropdown HTML/CSS, wire the toggle JS, add `clearChatThread`
- Task 4: build + deploy + smoke test

---

## Task 1: Remove the sidebar HTML + CSS

**Files:**
- Modify: `packages/core/src/runtime/ui/gui.ts`

- [ ] **Step 1: Delete the `.chat-layout` wrapper and `<aside id="tk-chat-sidebar">` HTML**

Find in `gui.ts` (search for `<div class="chat-layout">`):

```html
<div class="chat-layout">
  <aside id="tk-chat-sidebar" class="chat-sidebar">
    <div class="chat-sidebar-header">
      <button id="tk-chat-sidebar-toggle" class="tiny" title="toggle">«</button>
      <button id="tk-chat-new-session" class="tiny primary" title="start a new session">+ <span data-i18n="chatNewSession">New</span></button>
    </div>
    <div id="tk-chat-session-list">
      <div class="empty dim" data-i18n="loading">loading…</div>
    </div>
  </aside>

<div class="agent-shell">
```

Replace with:

```html
<div class="agent-shell">
```

(Removes the `<div class="chat-layout">` opener and the entire `<aside>` block. The `<div class="agent-shell">` line stays.)

- [ ] **Step 2: Delete the matching closing `</div><!-- /chat-layout -->`**

Search for `</div><!-- /chat-layout -->`. It should be one line above `</div><!-- /tab-panel:chat -->`. Delete that one line:

```html
</div><!-- /chat-layout -->
```

After this edit, the chat tab panel close should look like:

```html
</div>
</div><!-- /tab-panel:chat -->
```

(Two `</div>`s before the panel close: agent-card's close + agent-shell's close. Verify by counting open/close pairs inside the chat panel.)

- [ ] **Step 3: Delete the sidebar CSS block**

Find this block (search for the comment `Chat tab: split into sidebar + main thread`):

```css
  /* Chat tab: split into sidebar + main thread. The sidebar lists past sessions
     and is collapsible to keep the chat thread roomy. */
  .chat-layout {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }
  .chat-sidebar {
    flex: 0 1 220px;
    min-width: 0;
    border-right: 1px solid var(--border);
    background: var(--bg-card);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .chat-sidebar.collapsed { flex-basis: 36px; }
  .chat-sidebar.collapsed .chat-sidebar-header > #tk-chat-new-session,
  .chat-sidebar.collapsed #tk-chat-session-list { display: none; }
  .chat-sidebar-header {
    display: flex;
    gap: 4px;
    padding: 6px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .chat-sidebar-header > button { flex: 0 0 auto; }
  .chat-sidebar-header > #tk-chat-new-session { flex: 1 1 auto; min-width: 0; }
  #tk-chat-session-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 4px;
  }
```

Delete the entire block. **Keep** `.chat-session-row`, `.session-preview`, `.session-meta`, `.chat-session-row.selected`, `.chat-session-row:hover` — the dropdown reuses those row styles.

- [ ] **Step 4: Delete the 480px sidebar media-query block**

Find:

```css
  /* On narrow viewports, the sidebar auto-collapses so the thread isn't squeezed. */
  @media (max-width: 480px) {
    .chat-sidebar { flex-basis: 36px; }
    .chat-sidebar .chat-sidebar-header > #tk-chat-new-session,
    .chat-sidebar #tk-chat-session-list { display: none; }
  }
```

Delete the entire block including the comment.

- [ ] **Step 5: Remove the `min-width: 0` we added to `.agent-shell` for the flex row**

Find `.agent-shell {` and the property `min-width: 0;` that was added by Task 5 of the previous plan. Remove just that one line. The block currently looks like:

```css
  .agent-shell {
    max-width: 880px;
    width: 100%;
    margin: 14px auto 0;
    padding: 0 12px 12px;
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
```

Remove the `min-width: 0;` line so the block reverts to:

```css
  .agent-shell {
    max-width: 880px;
    width: 100%;
    margin: 14px auto 0;
    padding: 0 12px 12px;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
```

- [ ] **Step 6: Run the GUI tests**

Run: `pnpm --filter @tierkit/core test guiHtml`
Expected: PASS, 3 tests. (Snapshot-free structural tests; deletion shouldn't break them.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runtime/ui/gui.ts
git -c commit.gpgsign=false commit -m "refactor(ui): remove chat-tab left sidebar HTML + CSS

Layout redesign: replace the always-visible sidebar with a hamburger
dropdown (next commit). This commit just deletes the sidebar's HTML
shell and CSS rules — JS handler removal + dropdown addition follow.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Remove the sidebar JS

**Files:**
- Modify: `packages/core/src/runtime/ui/gui.ts`

- [ ] **Step 1: Delete the sidebar toggle wire-up**

Find (around line 4993 — search for `Chat sidebar toggle`):

```js
  // ── Chat sidebar toggle + new-session button ─────────────────────────────
  const TK_SIDEBAR_LS_KEY = 'tk_chat_sidebar_collapsed';
  const sidebarEl = $('tk-chat-sidebar');
  const sidebarToggleBtn = $('tk-chat-sidebar-toggle');
  if (sidebarEl && sidebarToggleBtn) {
    if (localStorage.getItem(TK_SIDEBAR_LS_KEY) === '1') {
      sidebarEl.classList.add('collapsed');
      sidebarToggleBtn.textContent = '»';
    }
    sidebarToggleBtn.onclick = () => {
      const collapsed = sidebarEl.classList.toggle('collapsed');
      sidebarToggleBtn.textContent = collapsed ? '»' : '«';
      try { localStorage.setItem(TK_SIDEBAR_LS_KEY, collapsed ? '1' : '0'); } catch { /* quota */ }
    };
  }
  const newSessionBtn = $('tk-chat-new-session');
  if (newSessionBtn) {
    newSessionBtn.onclick = () => newChatSession();
  }
```

Delete the entire block. (Task 3 re-wires `tk-chat-new-session` inside the new dropdown.)

- [ ] **Step 2: Remove the proactive `loadChatSessions` call from `setActiveTab`**

Find `function setActiveTab(name)` (search for `function setActiveTab`). At the bottom of the function body, there is:

```js
    if (name === 'chat') loadChatSessions();
```

Delete that one line. The dropdown will fetch on open instead — no need to fetch on tab activation.

- [ ] **Step 3: Verify no dangling references**

Run from `/Users/siwal/code/Tierkit`:

```
grep -nE "tk-chat-sidebar|TK_SIDEBAR_LS_KEY|sidebarEl|sidebarToggleBtn|newSessionBtn|chat-layout|chat-sidebar" packages/core/src/runtime/ui/gui.ts
```

Expected: zero output. (`chat-session-row`, `chat-session-list`, `chat-sessions-dropdown`, `chat-sessions-dropdown-header` are new — added in Task 3 — so they shouldn't appear here yet.)

If any remain, investigate. There may be stray references in comments or strings — those need cleanup too.

- [ ] **Step 4: Run the GUI tests**

Run: `pnpm --filter @tierkit/core test guiHtml`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/ui/gui.ts
git -c commit.gpgsign=false commit -m "refactor(ui): remove chat-tab sidebar JS handlers

Drops TK_SIDEBAR_LS_KEY, the toggle button wire-up, the +New wiring
through the sidebar header, and the proactive loadChatSessions call
from setActiveTab. The dropdown (next commit) will own these.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 3: Add hamburger + dropdown HTML/CSS/JS

**Files:**
- Modify: `packages/core/src/runtime/ui/gui.ts`

- [ ] **Step 1: Add the hamburger button + dropdown HTML inside `.agent-card`**

Find the existing chat tab `<h2>` block (search for `data-i18n="cardAgent"`). The current `<h2>` ends with:

```html
      <span class="h2-actions" hidden>
        <button id="btn-agent-export" class="tiny" hidden>Export</button>
        <button id="btn-agent-import" class="tiny" hidden>Import</button>
        <button id="btn-agent-clear" class="tiny" title="clear results" data-i18n="clearBtn">Clear</button>
      </span>
    </h2>
```

Replace with:

```html
      <span class="h2-actions">
        <button id="btn-agent-export" class="tiny" hidden>Export</button>
        <button id="btn-agent-import" class="tiny" hidden>Import</button>
        <button id="btn-agent-clear" class="tiny" hidden title="clear results" data-i18n="clearBtn">Clear</button>
        <button id="tk-chat-sessions-toggle" class="tiny" title="sessions menu" aria-expanded="false" aria-controls="tk-chat-sessions-dropdown">☰</button>
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
```

(Changes: removed `hidden` from `.h2-actions`; added `hidden` to `#btn-agent-clear` individually since it's not actively wired today; added the hamburger button and the dropdown div.)

- [ ] **Step 2: Add the dropdown CSS**

Find the existing `.agent-card {` rule (around line 262 in the file). Insert `position: relative;` so the dropdown can anchor:

Current:

```css
  .agent-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    /* … other props … */
  }
```

Add `position: relative;` as the first declaration:

```css
  .agent-card {
    position: relative;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    /* … other props … */
  }
```

Then immediately after the closing `}` of `.agent-card h2` (or any nearby agent-card rule), add the dropdown styles. A good place is right after `.agent-card h2 .agent-status` rule:

```css
  /* v0.22: hamburger dropdown anchored to .agent-card. Floats over the thread
     when open; hidden by default. Outside-click / Esc close handled by JS. */
  .chat-sessions-dropdown {
    position: absolute;
    top: 38px;
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

- [ ] **Step 3: Add the Korean i18n key for the new "Clear thread" label**

Find the `LOCALES.ko` block (search for `chatNewSession: '새 세션'` from the prior task — around line 1224). Right after that key, add:

```js
      chatClearThread: '대화 비우기',
```

(English uses the static HTML "Clear thread" by design — no en entry needed, consistent with how `chatNewSession` is handled.)

- [ ] **Step 4: Wire the hamburger toggle JS**

Find the spot where the old sidebar toggle wire-up used to be (Task 2 deleted it — same general area, around line 4993). Insert the new dropdown wire-up:

```js
  // ── Chat sessions hamburger dropdown ─────────────────────────────────────
  const sessionsToggleBtn = $('tk-chat-sessions-toggle');
  const sessionsDropdown = $('tk-chat-sessions-dropdown');
  function closeSessionsDropdown() {
    if (!sessionsDropdown || sessionsDropdown.hasAttribute('hidden')) return;
    sessionsDropdown.setAttribute('hidden', '');
    if (sessionsToggleBtn) sessionsToggleBtn.setAttribute('aria-expanded', 'false');
  }
  function openSessionsDropdown() {
    if (!sessionsDropdown) return;
    sessionsDropdown.removeAttribute('hidden');
    if (sessionsToggleBtn) sessionsToggleBtn.setAttribute('aria-expanded', 'true');
    loadChatSessions();
  }
  if (sessionsToggleBtn && sessionsDropdown) {
    sessionsToggleBtn.onclick = (e) => {
      e.stopPropagation();
      if (sessionsDropdown.hasAttribute('hidden')) openSessionsDropdown();
      else closeSessionsDropdown();
    };
    document.addEventListener('click', (e) => {
      if (sessionsDropdown.hasAttribute('hidden')) return;
      const tgt = e.target;
      if (!sessionsDropdown.contains(tgt) && tgt !== sessionsToggleBtn) {
        closeSessionsDropdown();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeSessionsDropdown();
    });
  }
  const newSessionBtn = $('tk-chat-new-session');
  if (newSessionBtn) {
    newSessionBtn.onclick = () => { newChatSession(); closeSessionsDropdown(); };
  }
  const clearThreadBtn = $('tk-chat-clear-thread');
  if (clearThreadBtn) {
    clearThreadBtn.onclick = () => clearChatThread();
  }

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
```

- [ ] **Step 5: Close the dropdown after a session row click**

Find `async function loadChatSessionMessages(id)`. At the end of the success path (just before the function ends — after the `if (currentAssistantBubble) currentAssistantBubble.finalize({});` and `loadChatSessions();` lines), add:

```js
    closeSessionsDropdown();
```

So the tail of the function reads:

```js
    if (currentAssistantBubble) currentAssistantBubble.finalize({});
    loadChatSessions(); // refresh highlight
    closeSessionsDropdown();
  }
```

Also at the END of the error-handling branch in `loadChatSessionMessages` (the spot where `toast(msg, 'err')` runs), add `closeSessionsDropdown();` too — if the user clicks a 404'd row, the dropdown should still close:

```js
      toast(msg, 'err');
      loadChatSessions();
      closeSessionsDropdown();
      return;
```

- [ ] **Step 6: Run the GUI tests**

Run: `pnpm --filter @tierkit/core test guiHtml`
Expected: PASS, 3 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/runtime/ui/gui.ts
git -c commit.gpgsign=false commit -m "feat(ui): chat-tab hamburger dropdown replaces left sidebar

Adds a ☰ button inside the agent-card h2. Click opens a dropdown
anchored to the card with + New session, Clear thread, and the
session list. Closes on outside-click, Escape, session selection,
or +New/Clear. Reuses the existing session-row CSS and the daemon
endpoints unchanged.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Build vsix + deploy + smoke test

**Files:** none — packaging + verification only.

- [ ] **Step 1: Build core + extension**

Run from `/Users/siwal/code/Tierkit`:

```
pnpm --filter @tierkit/core build && cd packages/vscode-tierkit && pnpm run build
```

Expected: clean build, no TS errors.

- [ ] **Step 2: Package vsix**

Run from `packages/vscode-tierkit`:

```
pnpm run package:sideload
```

Expected: `tierkit-vscode-0.21.12.vsix` produced (~1.2 MB).

- [ ] **Step 3: Hot-deploy to live code-server daemon**

Run from `/Users/siwal/code/Tierkit`:

```bash
EXT_DIR=/Users/siwal/.local/share/code-server/extensions/leesiwal.tierkit-vscode-0.21.12
VSIX=/Users/siwal/code/Tierkit/packages/vscode-tierkit/tierkit-vscode-0.21.12.vsix
TMP=$(mktemp -d) && unzip -q "$VSIX" -d "$TMP"
cp "$TMP/extension/dist/extension.js" "$EXT_DIR/dist/extension.js"
cp "$TMP/extension/dist/extension.js.map" "$EXT_DIR/dist/extension.js.map" 2>/dev/null
rm -rf "$TMP"
echo "deployed at $(stat -f '%Sm' -t '%H:%M:%S' $EXT_DIR/dist/extension.js)"
```

- [ ] **Step 4: Verify hamburger + dropdown markers are in the deployed file**

```
grep -c "tk-chat-sessions-dropdown\|tk-chat-sessions-toggle\|tk-chat-clear-thread\|chat-sessions-dropdown" /Users/siwal/.local/share/code-server/extensions/leesiwal.tierkit-vscode-0.21.12/dist/extension.js
```

Expected: ≥ 8 matches.

- [ ] **Step 5: Tell the user to Reload Window and smoke-test**

After the user reloads the code-server window manually, verify:
- Chat tab opens with NO left sidebar. Thread + composer fill the full agent-card width.
- The h2 row shows the title + pills + `☰` button (right-aligned).
- Click `☰`: a dropdown drops below the h2 with `+ New session`, `Clear thread`, and the session list.
- Click a session: thread restores its history, dropdown closes.
- Reopen `☰`, click `+ New session`: thread clears to empty placeholder, sessionId nulled, dropdown closes.
- Reopen `☰`, click `Clear thread`: thread clears, sessionId unchanged. Next message continues the same session.
- Click outside the dropdown: closes.
- Press Esc: dropdown closes.
- Settings tab: no Chat Sessions card (already removed in the prior plan), nothing else changed.

No commit for this task — build outputs are gitignored.

---

## Self-Review

**Spec coverage:**
- Remove sidebar HTML / CSS / JS → Tasks 1 + 2 ✓
- Hamburger button in `.h2-actions` → Task 3 Step 1 ✓
- `.agent-card { position: relative }` → Task 3 Step 2 ✓
- Dropdown CSS (width 280, max-width calc(100% - 16px), 50vh, z-index 10, shadow, hidden default) → Task 3 Step 2 ✓
- `+ New session` button reuses `newChatSession()` and closes dropdown → Task 3 Step 4 ✓
- `clearChatThread()` clears thread without nulling sessionId → Task 3 Step 4 ✓
- Outside-click + Esc close → Task 3 Step 4 ✓
- Session row click closes dropdown → Task 3 Step 5 ✓
- `loadChatSessions()` fetched on each open (not on tab activation) → Task 2 Step 2 removes proactive fetch + Task 3 Step 4 fetches inside `openSessionsDropdown` ✓
- `recordSessionEvent` still calls `loadChatSessions()` (harmless when dropdown hidden) — preserved (no task touches it) ✓
- Korean i18n `chatClearThread` → Task 3 Step 3 ✓
- Manual smoke checklist matches spec's testing section → Task 4 Step 5 ✓

**Placeholder scan:** No TBDs, no "implement later", no "similar to Task N", code blocks in every code step.

**Type consistency:** Function names used across tasks — `loadChatSessions`, `loadChatSessionMessages`, `newChatSession`, `clearChatThread`, `closeSessionsDropdown`, `openSessionsDropdown` — all defined exactly once in Task 3 (with `loadChatSessions` etc. inherited from the prior plan, unchanged here). Element ids — `tk-chat-sessions-toggle`, `tk-chat-sessions-dropdown`, `tk-chat-new-session`, `tk-chat-clear-thread`, `tk-chat-session-list`, `agent-thread` — consistent across HTML / CSS / JS in Task 3.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-23-chat-tab-hamburger-layout.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
