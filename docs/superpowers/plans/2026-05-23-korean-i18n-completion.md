# Korean i18n Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit all visible English strings in Settings + Chat tabs, wire them through `data-i18n`/`data-i18n-title`/`data-i18n-placeholder`, populate `LOCALES.ko`, and add a CI test that fails when new keys lack Korean translations.

**Architecture:** Pure GUI change in `packages/core/src/runtime/ui/gui.ts`. Extend the existing i18n-application loop (currently handles `data-i18n` only) to also process `data-i18n-title` and `data-i18n-placeholder`. Then sweep the file: for each English-literal in a `<button>`, `<h2>`/`<h3>`/`<summary>`, or `title=` tooltip, wrap it with a `data-i18n` attribute and add a Korean entry to `LOCALES.ko`. New test `i18nCoverage.test.ts` enforces that every `data-i18n*` key has a Korean entry.

**Tech Stack:** Vanilla DOM + CSS in the single-file webview. Vitest for the coverage test.

Spec: [`docs/superpowers/specs/2026-05-23-korean-i18n-completion-design.md`](../specs/2026-05-23-korean-i18n-completion-design.md)

---

## File Structure

**Only modified file** (mostly):
- `packages/core/src/runtime/ui/gui.ts` — HTML attribute wrapping + LOCALES.ko entries + i18n-applier extension

**New file**:
- `packages/core/test/i18nCoverage.test.ts` — extracts all `data-i18n*` keys from `GUI_HTML` and asserts every key has a Korean entry

---

## Task 1: Extend i18n applier for title + placeholder

**Files:** Modify `packages/core/src/runtime/ui/gui.ts` (the existing i18n loop)

- [ ] **Step 1: Find the current applier**

Run from `/Users/siwal/code/Tierkit`:
```
grep -n "querySelectorAll..data-i18n" packages/core/src/runtime/ui/gui.ts
```
Identifies the existing loop (around line 1361). Current shape:

```js
if (lang !== 'en' && LOCALES[lang]) {
  const t = LOCALES[lang];
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const k = el.getAttribute('data-i18n');
    if (t[k]) el.textContent = t[k];
  });
}
```

- [ ] **Step 2: Verify whether `data-i18n-placeholder` is already handled**

Run:
```
grep -n "data-i18n-placeholder\|data-i18n-title" packages/core/src/runtime/ui/gui.ts | head -10
```

If `data-i18n-placeholder` ALREADY appears in the applier (i.e., the file has `querySelectorAll('[data-i18n-placeholder]')`), DO NOT duplicate that loop in Step 3 — only add the `data-i18n-title` loop. Note what you found.

- [ ] **Step 3: Extend the loop**

Replace the current block with:

```js
if (lang !== 'en' && LOCALES[lang]) {
  const t = LOCALES[lang];
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const k = el.getAttribute('data-i18n');
    if (t[k]) el.textContent = t[k];
  });
  // v0.23: tooltip + placeholder support. Same locale dict, different
  // attribute target. Lets us translate `title=` on icon-only buttons
  // and `placeholder=` on input fields without faking them as inner text.
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const k = el.getAttribute('data-i18n-title');
    if (t[k]) el.setAttribute('title', t[k]);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const k = el.getAttribute('data-i18n-placeholder');
    if (t[k]) el.setAttribute('placeholder', t[k]);
  });
}
```

If Step 2 showed `data-i18n-placeholder` already exists, REMOVE only the placeholder block to keep the file's pre-existing handling intact (just add the title block).

- [ ] **Step 4: Run GUI tests**

Run: `pnpm --filter @tierkit/core test guiHtml`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/ui/gui.ts
git -c commit.gpgsign=false commit -m "feat(ui): i18n applier handles data-i18n-title + data-i18n-placeholder

Previously only data-i18n inner-text was translated. Icon-only buttons
that show their meaning via title= tooltips and form fields with
placeholders were stuck in English. Same LOCALES dict, new attribute
targets — keeps the single-source-of-truth pattern.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 2: Add i18n coverage test

**Files:**
- Create: `packages/core/test/i18nCoverage.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/core/test/i18nCoverage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { GUI_HTML } from "../src/runtime/ui/gui.js";

describe("i18n coverage", () => {
  /**
   * Extract every key referenced by data-i18n / data-i18n-title /
   * data-i18n-placeholder attributes inside the GUI_HTML constant. The
   * pattern is forgiving: matches both single and double quotes.
   */
  function collectKeys(html: string): Set<string> {
    const re = /\bdata-i18n(?:-title|-placeholder)?\s*=\s*["']([^"']+)["']/g;
    const out = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) out.add(m[1]!);
    return out;
  }

  /**
   * Read the LOCALES.ko keys directly out of the JS source. The block is a
   * static object literal; a regex on its inside is the cheapest reliable
   * extraction without evaluating the script. The match is intentionally
   * loose — we only need to know which key names exist.
   */
  function collectKoKeys(html: string): Set<string> {
    // Find the ko block — opens with `ko: {` after `LOCALES = {`
    const blockMatch = /ko:\s*\{([\s\S]*?)\n\s{4}\}/.exec(html);
    if (!blockMatch) throw new Error("LOCALES.ko block not found in GUI_HTML");
    const body = blockMatch[1]!;
    const keyRe = /^\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/gm;
    const out = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = keyRe.exec(body)) !== null) out.add(m[1]!);
    return out;
  }

  it("every data-i18n* attribute resolves to a LOCALES.ko entry", () => {
    const htmlKeys = collectKeys(GUI_HTML);
    const koKeys = collectKoKeys(GUI_HTML);
    const missing = [...htmlKeys].filter((k) => !koKeys.has(k));
    if (missing.length > 0) {
      throw new Error(
        `${missing.length} HTML i18n key(s) have no Korean translation in LOCALES.ko:\n` +
        missing.map((k) => `  - ${k}`).join("\n") +
        `\nAdd Korean entries for these keys, or change the HTML to use a key that exists.`,
      );
    }
    expect(htmlKeys.size).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @tierkit/core test i18nCoverage`
Expected: likely **FAIL** initially, listing the keys that currently lack Korean translations. That's exactly the punch list for the audit tasks below.

- [ ] **Step 3: Save the failure output as a working list**

The failure message lists missing keys. Note them — they're the input to Tasks 3–5. If the test PASSES on first run, the audit is unexpectedly complete and Tasks 3–5 collapse to verification.

- [ ] **Step 4: Commit**

```bash
git add packages/core/test/i18nCoverage.test.ts
git -c commit.gpgsign=false commit -m "test(ui): i18nCoverage — fail CI when a data-i18n key lacks Korean translation

Extracts every data-i18n / data-i18n-title / data-i18n-placeholder key
from GUI_HTML and asserts each has an entry in LOCALES.ko. Prevents
silent English-leakage when new UI ships.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

(Commit even if test fails — the test goes red on purpose; subsequent tasks turn it green.)

---

## Task 3: Wire Settings tab — Connect Claude Code MCP card

**Files:** Modify `packages/core/src/runtime/ui/gui.ts`

The MCP Bridge card (around line 815) has several untranslated buttons + tooltips.

- [ ] **Step 1: Find the card region**

Run:
```
grep -n "mcpBridgeIntro\|cardMcpBridge\|mcpShowSnippet" packages/core/src/runtime/ui/gui.ts
```
Identifies the card boundaries (~lines 815–855).

- [ ] **Step 2: Wire the Connect/Disconnect buttons**

Find:
```html
<button id="tk-claude-connect-ws" class="tiny primary" title="register tierkit MCP server in workspace .mcp.json + append CLAUDE.md block">Connect (workspace)</button>
<button id="tk-claude-connect-global" class="tiny" title="register tierkit MCP server in ~/.claude.json (all projects)">Connect (global)</button>
<button id="tk-claude-disconnect" class="tiny" title="remove MCP entry + strip CLAUDE.md block (current scope)">Disconnect</button>
```

Replace with:
```html
<button id="tk-claude-connect-ws" class="tiny primary" data-i18n="claudeConnectWs" data-i18n-title="claudeConnectWsTitle" title="register tierkit MCP server in workspace .mcp.json + append CLAUDE.md block">Connect (workspace)</button>
<button id="tk-claude-connect-global" class="tiny" data-i18n="claudeConnectGlobal" data-i18n-title="claudeConnectGlobalTitle" title="register tierkit MCP server in ~/.claude.json (all projects)">Connect (global)</button>
<button id="tk-claude-disconnect" class="tiny" data-i18n="claudeDisconnect" data-i18n-title="claudeDisconnectTitle" title="remove MCP entry + strip CLAUDE.md block (current scope)">Disconnect</button>
```

- [ ] **Step 3: Wire the "How to verify" steps**

Find the `<ol>` with steps inside `#tk-claude-verify`. Each `<li>` should already have `data-i18n="ctxGatewayVerifyStep1"` etc. If any are missing, add them. (Likely already present — verify with grep.)

- [ ] **Step 4: Add Korean entries to LOCALES.ko**

Find the `ko:` block (around line 1100) and add (alphabetically OK; pick a spot among existing keys):

```js
      claudeConnectWs: 'Connect (워크스페이스)',
      claudeConnectWsTitle: 'tierkit MCP 서버를 워크스페이스 .mcp.json에 등록 + CLAUDE.md 블록 추가',
      claudeConnectGlobal: 'Connect (전역)',
      claudeConnectGlobalTitle: 'tierkit MCP 서버를 ~/.claude.json에 등록 (모든 프로젝트)',
      claudeDisconnect: '연결 해제',
      claudeDisconnectTitle: 'MCP 엔트리 제거 + CLAUDE.md 블록 정리 (현재 범위)',
```

- [ ] **Step 5: Run tests**

```
pnpm --filter @tierkit/core test i18nCoverage guiHtml
```
Expected: i18nCoverage progresses (still failing for other keys, but these 6 are now satisfied). guiHtml still passes.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime/ui/gui.ts
git -c commit.gpgsign=false commit -m "i18n(ui): Korean for Claude Code Connect/Disconnect buttons

Three buttons (workspace / global / disconnect) plus their title tooltips
go through data-i18n + data-i18n-title now. LOCALES.ko gains six new
entries.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 4: Audit + wire remaining Settings tab strings

**Files:** Modify `packages/core/src/runtime/ui/gui.ts`

This task is grep-driven. The implementer iterates until the audit grep returns empty.

- [ ] **Step 1: Run the audit grep**

```bash
# English-literal in visible <button> elements without data-i18n
grep -nE '<button[^>]*>(?![^<]*data-i18n)[A-Z]' packages/core/src/runtime/ui/gui.ts > /tmp/audit-buttons.txt
# English-literal in h2/h3/summary without data-i18n
grep -nE '<(h2|h3|summary)[^>]*>(?![^<]*data-i18n)[A-Z]' packages/core/src/runtime/ui/gui.ts > /tmp/audit-headers.txt
# title="English …" attributes on visible (non-hidden) elements
grep -nE 'title="[A-Z][a-z][^"]+"' packages/core/src/runtime/ui/gui.ts > /tmp/audit-titles.txt
wc -l /tmp/audit-*.txt
```

- [ ] **Step 2: Walk the audit lists, wire each hit**

For each line in `/tmp/audit-*.txt` that's inside the Settings tab (after `<main class="tab-panel" data-tab-panel="settings">`):

1. Pick a `camelCase` key reflecting the section + control purpose. Examples:
   - "Show config snippet" button → `mcpShowSnippet` (may already exist; check)
   - "File digest cache" h3 → `cardFileDigestCache`
   - "Refresh" button (inside file digest cache) → `fileDigestRefresh`
   - "Clear cache" button → `fileDigestClear`
   - "+ Custom key" button (secrets) → already `secretAddCustom` — verify
   - "Reload" button (daemon controls) → `reloadBtn` (likely exists)
2. Add `data-i18n="<key>"` to the element. If it's a `title=` tooltip, ALSO add `data-i18n-title="<key>Title"` and create that key.
3. Add the Korean translation to `LOCALES.ko`.

Skip elements with `hidden` attribute — they're legacy controls, not user-visible.

Skip elements containing only mono identifiers (e.g., `<li>tierkit.compress_command</li>`) — those are intentional English.

- [ ] **Step 3: Re-run the audit grep**

After each round of fixes, re-run Step 1's greps. The `/tmp/audit-*.txt` files should shrink. Stop when only legacy/hidden/identifier hits remain.

- [ ] **Step 4: Run the coverage test**

```
pnpm --filter @tierkit/core test i18nCoverage
```
Expected: PASS, or fewer missing keys than before. If new keys were added in HTML without Korean translations, the test reports them — add the translations.

- [ ] **Step 5: Commit each meaningful sub-section as its own commit**

Don't squash all Settings-tab translations into one mega-commit. Split by card:
- "i18n(ui): Korean for Settings → Context Gateway card"
- "i18n(ui): Korean for Settings → File digest cache section"
- etc.

Use this template:

```bash
git add packages/core/src/runtime/ui/gui.ts
git -c commit.gpgsign=false commit -m "i18n(ui): Korean for Settings → <section name>

<one line about what got wired>

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 5: Audit + wire Chat tab strings

**Files:** Modify `packages/core/src/runtime/ui/gui.ts`

Same grep-driven pattern but scoped to the chat tab.

- [ ] **Step 1: Find chat tab boundaries**

```
grep -n 'data-tab-panel="chat"' packages/core/src/runtime/ui/gui.ts
grep -n "/tab-panel:chat" packages/core/src/runtime/ui/gui.ts
```
Identifies the start + end lines.

- [ ] **Step 2: Hit list — known-to-need-wiring elements**

Walk these elements in order; for each, add `data-i18n` and a Korean entry:

| Element | Existing English | Key suggestion | Korean |
|---|---|---|---|
| `#tk-chat-sessions-toggle` title | `sessions menu` | `chatSessionsToggleTitle` (use `data-i18n-title`) | 세션 메뉴 |
| `#tk-chat-sidebar-toggle` (if still present) | `toggle` | (skip — element no longer in DOM after the hamburger redesign; verify) | — |
| `<label>perm:</label>` text | `perm:` | `permLabel` | 권한: |
| `<label>📦 → Claude (⌘V)</label>` | `📦 → Claude (⌘V)` | `tkAutoForwardLabel` | 📦 → Claude (⌘V) (keep symbols) |
| `agent-input` placeholder | `Chat with Claude (proxied through claude CLI). Enter to send · Shift+Enter for newline.` | already `data-i18n-placeholder="agentPlaceholder"` — verify Korean exists | (use existing) |

For each hit:
1. Add the attribute.
2. Add the Korean translation.

- [ ] **Step 3: Re-run audit greps (Step 1 of Task 4) but scoped**

```bash
sed -n '<chat-start>,<chat-end>p' packages/core/src/runtime/ui/gui.ts > /tmp/chat-region.txt
grep -nE '<button[^>]*>(?![^<]*data-i18n)[A-Z]' /tmp/chat-region.txt
grep -nE 'title="[A-Z][a-z][^"]+"' /tmp/chat-region.txt
```

Iterate until empty (excluding hidden/legacy).

- [ ] **Step 4: Coverage test**

```
pnpm --filter @tierkit/core test i18nCoverage
```
Expected: PASS or near-PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime/ui/gui.ts
git -c commit.gpgsign=false commit -m "i18n(ui): Korean for Chat tab — composer meta + sessions menu

Wires data-i18n on perm label, sessions hamburger title, auto-forward
checkbox label. LOCALES.ko gains the matching entries.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 6: Translate toast-only JS strings

**Files:** Modify `packages/core/src/runtime/ui/gui.ts`

`toast('...', 'err'|'ok')` calls with English literals need to go through `i18n.<key>`.

- [ ] **Step 1: Find them**

```
grep -nE "toast\(['\"][A-Z]" packages/core/src/runtime/ui/gui.ts
```

- [ ] **Step 2: For each hit**

1. Pick a `camelCase` key in `LOCALES.ko`.
2. Replace `toast('Saved', 'ok')` with `toast(i18n.savedOk || 'Saved', 'ok')` (the `||` fallback keeps English working).
3. Add the Korean entry.

- [ ] **Step 3: Coverage test**

```
pnpm --filter @tierkit/core test i18nCoverage
```
Expected: still PASS (JS-only keys don't surface in HTML attributes — the test won't fail for these). But this keeps Korean coverage consistent.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/runtime/ui/gui.ts
git -c commit.gpgsign=false commit -m "i18n(ui): Korean for JS-emitted toasts

Replaces English literals in toast() calls with i18n.<key> + Korean
LOCALES entries. English fallback via || keeps the en path intact.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

## Task 7: Build, deploy, manual smoke

**Files:** none — packaging only.

- [ ] **Step 1: Full test suite**

```
pnpm --filter @tierkit/core test
```
Expected: all tests pass including the new `i18nCoverage`.

- [ ] **Step 2: Build core + extension + vsix**

```
pnpm --filter @tierkit/core build
cd packages/vscode-tierkit && pnpm run build && pnpm run package:sideload
```
Expected: clean build, vsix produced.

- [ ] **Step 3: Hot-deploy to live daemon**

```bash
EXT_DIR=/Users/siwal/.local/share/code-server/extensions/leesiwal.tierkit-vscode-0.21.12
VSIX=/Users/siwal/code/Tierkit/packages/vscode-tierkit/tierkit-vscode-0.22.0.vsix
TMP=$(mktemp -d) && unzip -q "$VSIX" -d "$TMP"
cp "$TMP/extension/dist/extension.js" "$EXT_DIR/dist/extension.js"
cp "$TMP/extension/dist/extension.js.map" "$EXT_DIR/dist/extension.js.map" 2>/dev/null
rm -rf "$TMP"
```

- [ ] **Step 4: Manual smoke — Korean locale**

After the user reloads the code-server window:
- Settings tab: walk every card, confirm no untranslated English in headers, buttons, tooltips
- Chat tab: walk composer, hamburger dropdown, tools menu — same check
- Toasts: trigger a save / delete / error path and confirm Korean message

No commit for this task — build outputs are gitignored.

---

## Self-Review

**Spec coverage:**
- i18n applier extension (title + placeholder) → Task 1 ✓
- Coverage test → Task 2 ✓
- Settings tab audit → Tasks 3 + 4 ✓
- Chat tab audit → Task 5 ✓
- JS toasts → Task 6 ✓
- Build/deploy/smoke → Task 7 ✓
- Korean translations in LOCALES.ko → embedded in Tasks 3–6 ✓

**Placeholder scan:** No TBDs / "implement later". Tasks 4 and 5 are explicitly grep-driven and iterative — the spec says so, and the steps describe the iteration mechanically (run grep → fix → re-grep). That's not a placeholder; that's the actual process.

**Type consistency:** Key naming convention is consistent — `camelCase`, section-prefixed (`claudeConnectWs`, `mcpShowSnippet`, `cardFileDigestCache`). `data-i18n-title` keys use the `<base>Title` suffix consistently.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-23-korean-i18n-completion.md`.**

(Execution offer skipped — both this plan and the per-model savings plan will be executed in sequence; see the per-model plan for the handoff prompt.)
