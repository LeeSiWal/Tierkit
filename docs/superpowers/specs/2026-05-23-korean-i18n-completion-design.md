# Korean i18n Completion — design (2026-05-23)

## Problem

The Tierkit webview already has a `LOCALES.ko` block with ~1,440 entries, and most `data-i18n` HTML attributes resolve to it. But pockets of untranslated English remain:

- Buttons rendered with inline HTML text instead of `data-i18n` attributes (e.g. "Connect (workspace)", "Disconnect", "Show config snippet")
- Section headers that were never wired (e.g. "Auto-wire Claude Code" as a sub-h3 inside the Context Gateway card)
- `title=` tooltips on icon buttons
- Toasts emitted from JS without going through `i18n.*`
- Newly-shipped sections from v0.22 (chat-tab hamburger dropdown, AskUserQuestion form, sessions card) that have partial coverage

The user reports specific English-still-shows spots in Settings AND Chat tabs.

## Goals

1. Every user-visible string in the Settings tab and Chat tab uses `data-i18n` (HTML) or `i18n.*` (JS) so the Korean locale can override it.
2. Every Korean override is present in `LOCALES.ko`.
3. English remains the fallback (no `LOCALES.en` — English uses the static HTML inner text, per existing architecture).
4. New string additions follow the same pattern, so future translations don't drift.

## Non-goals (YAGNI)

- Adding a third language (Japanese, Chinese, etc.)
- Pluralization rules / ICU MessageFormat
- Date-format localization (locale's `toLocaleString` already handles dates)
- RTL layout
- Translating tooltip-only diagnostic strings on hidden debug controls (e.g. legacy `#btn-agent-export` which is permanently `hidden`)

## Architecture

Pure GUI changes in `packages/core/src/runtime/ui/gui.ts`. Three steps per missing string:

1. **HTML**: wrap the visible text in a `data-i18n="<key>"` attribute. The HTML inner text becomes the English default.
2. **i18n table**: add the key to `LOCALES.ko` with the Korean translation.
3. **(Tooltips only)** Wrap the `title=` attribute via `data-i18n-title="<key>"` and ensure the existing applyI18n loop (or extend it) substitutes it.

For JS-emitted strings (toasts, dynamic row labels):

1. Add the key to `LOCALES.ko`.
2. Use `i18n.<key>` at the call site. Provide an English fallback via `||` when needed: `toast(i18n.savedOk || 'Saved', 'ok')`.

## i18n-application code (verify or extend)

Current logic (search `LOCALES[lang]` near line 1361 — already verified during the sidebar work):

```js
if (lang !== 'en' && LOCALES[lang]) {
  const t = LOCALES[lang];
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const k = el.getAttribute('data-i18n');
    if (t[k]) el.textContent = t[k];
  });
}
```

This already covers `data-i18n`. To support `title=` tooltips and placeholders, **extend** the loop in this commit:

```js
if (lang !== 'en' && LOCALES[lang]) {
  const t = LOCALES[lang];
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const k = el.getAttribute('data-i18n');
    if (t[k]) el.textContent = t[k];
  });
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

(`data-i18n-placeholder` may already exist; verify and don't duplicate.)

## Audit list (concrete strings to translate)

Each item below is a "translation slot" — the spot where Korean is currently missing. The full enumeration happens during implementation by grep-ing the file for English literals inside `<button>`, `<h3>`, `<summary>`, `<p>` etc. that lack `data-i18n`. Below are the categories with representative examples; the implementer expands each into concrete edits.

### Settings tab — Connect Claude Code MCP card
- "Show config snippet" button — currently `data-i18n="mcpShowSnippet"` ✓ (verify Korean exists; add if missing)
- "Auto-wire Claude Code" h3 — `data-i18n="ctxGatewayClaudeLabel"` ✓
- "Connect (workspace)" / "Connect (global)" / "Disconnect" buttons — currently bare HTML. Add `data-i18n="claudeConnectWs"` / `"claudeConnectGlobal"` / `"claudeDisconnect"`
- Tooltip `title="register tierkit MCP server in workspace .mcp.json + append CLAUDE.md block"` — add `data-i18n-title="claudeConnectWsTitle"` etc.
- "How to verify:" + steps — wire `data-i18n` for each `<li>`
- "Reload now" / "Later" modal — already in code paths (verify)

### Settings tab — Context Gateway card
- "MCP tools exposed (v0.18)" h3 — `data-i18n="ctxGatewayToolsLabel"` ✓ (verify)
- "+ Add custom Ollama profile" button — currently `data-i18n="ctxGatewayRefineAddBtn"` ✓ (verify Korean exists)
- "File digest cache" + "Refresh" / "Clear cache" buttons — wire `data-i18n`

### Settings tab — Cost routing card
- "Local + private + cloud models" h2 — `data-i18n="cardLocalModels"` ✓
- "Local Compressor" divider label — verify
- "Auto-escalation up to:" label — verify
- "Risk score thresholds" summary — verify
- Per-tier badges ("ready", "disabled", "not viable: cli-not-found") — verify each is in `i18n.statusReady` / `statusDisabled` / `statusCliNotFound` etc.

### Settings tab — API Keys card
- "+ Custom key" button — verify
- Empty-state hint — verify

### Settings tab — Daemon controls (Advanced)
- "Daemon controls" h2 — `data-i18n="cardDaemon"` ✓
- "Reload" button — `data-i18n="reloadBtn"` ✓
- "Config / Daemon" sub-divider — verify
- "Raw usage log" card title — `data-i18n="cardUsage"` ✓

### Chat tab — hamburger dropdown
- "+ New session" / "Clear thread" buttons — already covered (`chatNewSession`, `chatClearThread`)
- Sidebar header tooltip "sessions menu" — add `data-i18n-title="chatSessionsToggleTitle"`
- Session-row preview/meta — these are dynamic JS-rendered (no data-i18n); they show the Claude message preview verbatim, no translation needed

### Chat tab — composer + meta
- "Stop" button — `data-i18n="tkChatStop"` ✓
- "perm:" label — wire `data-i18n="permLabel"`
- Permission options (`Accept edits`, `Bypass all`, `Default`, `Plan`) — already wired via `tkPermAcceptEdits` etc. (verify Korean exists)
- "📦 → Claude (⌘V)" checkbox label — wire if missing
- Tools menu items (`Compress`, `Build Context Pack…`, `Digest file…`, etc.) — already wired (`tkToolCompress` etc., verify Korean exists)

### Chat tab — AskUserQuestion form
- "🤔 Claude is asking" title — already conditional `lang === 'ko' ? '🤔 Claude가 묻습니다' : '🤔 Claude is asking'` ✓
- "Other:" / "Submit answer" / "✓ Sent" / `[multi-select]` / `(no answer)` — all already conditional in `renderAskUserQuestion` ✓ (no LOCALES key — inline switch is fine here)

### Toasts (JS-only)
- `toast('key + value required', 'err')` — wire `i18n.secretKeyValueRequired`
- `toast(id + ' ✓ deleted', 'ok')` — wire via existing patterns
- Any `toast()` call with English literal — replace with `i18n.<key>`

## Implementation method

The implementer should NOT enumerate every string up-front. Instead:

1. Grep for hardcoded English in `gui.ts`:
   ```bash
   # English-literal buttons missing data-i18n:
   grep -nE '<button[^>]*>(?![^<]*data-i18n)[A-Z][a-z]' packages/core/src/runtime/ui/gui.ts
   # English-literal h3/summary missing data-i18n:
   grep -nE '<(h3|summary)[^>]*>(?![^<]*data-i18n)[A-Z]' packages/core/src/runtime/ui/gui.ts
   # title="..." with English on visible buttons:
   grep -nE 'title="[A-Z][a-z][^"]+"' packages/core/src/runtime/ui/gui.ts
   ```
2. For each hit:
   - Pick a `camelCase` key name based on the section (e.g. `claudeConnectWs`).
   - Wrap the HTML element with `data-i18n` or `data-i18n-title`.
   - Add the Korean translation to `LOCALES.ko`.
3. Repeat the grep until output stabilizes.
4. Verify the i18n-application code handles `data-i18n-title` and `data-i18n-placeholder` (extend if not).

## Testing

- Existing `guiHtml.test.ts` (3 tests) must remain green. The change adds attributes and locale entries but doesn't alter parse-time structure.
- Add a new unit test `i18nCoverage.test.ts` that:
  1. Extracts all `data-i18n="..."` keys from `GUI_HTML`.
  2. Verifies every key has a `LOCALES.ko` entry.
  3. Fails CI if a key is added in HTML without a Korean translation.
- Manual smoke: open Tierkit in Korean locale, walk through every settings card + chat tab elements, confirm no English text remains (except mono identifiers like `tierkit.compress_command` which are deliberately English).

## Failure modes

| Case | Behavior |
|---|---|
| New `data-i18n` key has no Korean entry | New CI test fails. Implementer adds the translation. |
| Korean string contains template-literal-breaking chars (`` ` ``) | Build fails — gui.ts is inside a TS template literal. Use plain string (already the pattern). |
| `i18n[key]` is `undefined` at runtime | Falls back to HTML default text (existing behavior). |

## Risks

1. **Translation quality**. The implementer writes Korean by inferring from English context. A native Korean reviewer should sweep the locale block once before tagging the release. (Out of scope for this implementation cycle — flag as a follow-up.)
2. **Tooltip overflow**. Korean text is sometimes longer than English when verbose. If a `title=` tooltip wraps oddly in the browser native tooltip, it's the OS's job, not ours.
3. **Scope creep**. The audit could expand into "translate the entire settings tab including legacy hidden controls". The non-goals section explicitly excludes hidden/legacy controls — stick to it.

## Open questions

None — the audit method (grep-driven, iterative) handles whatever specific strings turn up.
