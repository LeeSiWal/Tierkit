/**
 * Single-file browser UI for the Tierkit runtime daemon — Cost Control.
 *
 * Tierkit's role is a routing/policy layer behind agents (Roo Code, Cline, Continue, etc.),
 * not a chat agent itself. This UI reflects that: it's a control panel that shows which
 * tools are connected, what plugins are active, and what calls are flowing through, with
 * inline actions for connecting tools / managing plugins / adding profiles.
 *
 * Inlined as a TypeScript string so the runtime ships as one self-contained build artifact.
 *
 * Works in two contexts:
 *   - Direct browser: served by the daemon at `/`; fetch uses relative paths.
 *   - VS Code sidebar webview: the host extension injects `window.__TIERKIT_BASE_URL__`,
 *     `window.__TIERKIT_HOST__ = "vscode"`, and optionally `window.__TIERKIT_DAEMON_ERROR__`.
 *
 * Localization: `data-i18n="<key>"` on default-rendered strings. At load time we look at
 * `navigator.language`; `ko` → Korean labels. Runtime-built strings come from the `i18n`
 * runtime object (parallel English/Korean tables).
 */
import { TRANSPORT_INLINE_JS } from "./transport.js";

// Stamped at build time. The GUI HTML carries this version inline so the running webview
// can compare it against the daemon's reported version and show a banner when they diverge
// (typically: user installed a new vsix but didn't reload the VS Code window, so the
// previous daemon is still serving the OLD GUI which had EXPECTED_GUI_VERSION = old value).
// Sourced from package.json via tsup's `define` at build time — see src/version.ts.
import { TIERKIT_VERSION } from "../../version.js";
const GUI_BUILD_VERSION = TIERKIT_VERSION;

export const GUI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Tierkit</title>
<style>
  :root {
    --bg: #0f1115;
    --bg-card: #161922;
    --bg-input: #1f2330;
    --bg-hover: #252a38;
    --fg: #e6e9ef;
    --fg-dim: #8a92a3;
    --accent: #7aa2f7;
    --ok: #9ece6a;
    --warn: #e0af68;
    --err: #f7768e;
    --border: #2a2f3d;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100vh; }
  body {
    background: var(--bg);
    color: var(--fg);
    font: 13px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif;
    /* Flex column so the chat tab can claim remaining viewport for its thread.
       Settings tab uses its own scroll container — body itself doesn't scroll. */
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  /* ── Top bar ─────────────────────────────────────────────────────────────── */
  .topbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
    position: sticky;
    top: 0;
    background: var(--bg);
    z-index: 5;
  }
  .brand { font-size: 13px; font-weight: 600; letter-spacing: 0.01em; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .pill-ok    { background: rgba(158, 206, 106, 0.12); color: var(--ok); }
  .pill-warn  { background: rgba(224, 175, 104, 0.12); color: var(--warn); }
  .pill-err   { background: rgba(247, 118, 142, 0.12); color: var(--err); }
  .pill-accent{ background: rgba(122, 162, 247, 0.12); color: var(--accent); }
  .pill-dim   { background: var(--bg-input); color: var(--fg-dim); }
  .topbar .spacer { flex: 1; }
  /* ── Inputs / buttons ────────────────────────────────────────────────────── */
  button, input, select {
    font: inherit;
    color: var(--fg);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 8px;
    cursor: pointer;
    font-size: 12px;
  }
  button:hover { background: var(--bg-hover); }
  button.tiny    { padding: 2px 6px; font-size: 11px; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #0f1115; font-weight: 600; }
  button.primary:hover { filter: brightness(1.1); }
  button.ghost   { background: transparent; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  input { cursor: text; }
  /* ── Banner ──────────────────────────────────────────────────────────────── */
  .err-banner {
    background: rgba(247, 118, 142, 0.12);
    color: var(--err);
    padding: 8px 12px;
    font-family: var(--mono);
    font-size: 11px;
    border-bottom: 1px solid rgba(247, 118, 142, 0.3);
  }
  .err-banner button { margin-top: 6px; }
  /* ── v0.12 cost-aware routing: per-profile budget bars ───────────────────── */
  .c12-budget-bar { font-size: 11px; margin-top: 4px; }
  .c12-bar-track {
    background: rgba(255, 255, 255, 0.08);
    height: 6px;
    border-radius: 3px;
    overflow: hidden;
  }
  .c12-bar-fill { height: 6px; transition: width 200ms ease-out; }
  .c12-bar-fill.budget-bar-green { background: #28a745; }
  .c12-bar-fill.budget-bar-amber { background: #f0a020; }
  .c12-bar-fill.budget-bar-red   { background: #d73a49; }
  .c12-bar-text { color: var(--fg-dim); margin-top: 2px; font-size: 10.5px; }
  .c12-bar-status { font-weight: 600; padding: 0 4px; }
  .c12-flat-rate-metadata {
    font-size: 11px;
    color: var(--fg-dim);
    margin-top: 2px;
  }
  .c12-aggregate {
    font-size: 12px;
    padding: 6px 0;
    border-bottom: 1px dashed var(--border);
    margin-bottom: 6px;
  }
  .c12-aggregate .c12-bar-track { margin-top: 3px; }
  .banner-blocked {
    background: rgba(215, 58, 73, 0.12);
    border: 1px solid rgba(215, 58, 73, 0.55);
    color: var(--fg);
    padding: 8px;
    border-radius: 4px;
    margin: 6px 0;
    font-size: 11.5px;
    line-height: 1.4;
  }
  /* ── Layout / cards ──────────────────────────────────────────────────────── */
  main {
    max-width: 880px;
    width: 100%;
    margin: 0 auto;
    padding: 14px 12px;
    display: grid;
    /* minmax(0, 1fr) — 1fr alone defaults to minmax(auto, 1fr), which lets grid
       items grow to their content's intrinsic width and push the column past the
       viewport. minmax(0, 1fr) forces the column to never exceed the available
       space, so cards always wrap inside the panel. */
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
    /* min-width:0 — CSS grid items default to min-width:auto, which makes the column
       widen to fit non-wrapping content (long file paths, mono lines). In a narrow
       sidebar that pushes the tab-panel horizontally and clips the right edge. */
    min-width: 0;
    box-sizing: border-box;
  }
  @media (min-width: 720px) {
    main { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .card.full { grid-column: 1 / -1; }
  }
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    /* Same min-width fix at the card level — narrow flex / grid descendants would
       otherwise stretch to their content. overflow-wrap:anywhere forces wrapping
       on long tokens (URLs, paths, .config keys) without touching white-space. */
    min-width: 0;
    /* Belt + suspenders: max-width:100% + box-sizing keeps the card inside its
       grid column. Without this, an inner table / pre / long flex row could
       still inflate the card past the column width even with min-width:0. */
    max-width: 100%;
    box-sizing: border-box;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  /* Same for everything inside main so descendants don't escape past their grid cell. */
  main > * { min-width: 0; }
  .card h2 {
    margin: 0 0 10px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--fg-dim);
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }
  .card h2 .h2-actions { margin-left: auto; display: flex; gap: 6px; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); }
  .row:last-child { border-bottom: none; }
  .row.dense { padding: 4px 0; }
  .row .col-grow { flex: 1; min-width: 0; }
  .row .mono { font-family: var(--mono); font-size: 12px; }
  .row .dim { color: var(--fg-dim); font-size: 11px; }
  .row .nowrap { white-space: nowrap; }
  .empty {
    color: var(--fg-dim);
    font-size: 12px;
    font-style: italic;
    padding: 8px 0;
    text-align: center;
  }
  /* ── Activity feed ───────────────────────────────────────────────────────── */
  .activity-row { padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
  .activity-row:last-child { border-bottom: none; }
  .activity-line1 { display: flex; align-items: baseline; gap: 8px; font-family: var(--mono); }
  .activity-line2 { color: var(--fg-dim); font-size: 10.5px; margin-top: 2px; font-family: var(--mono); }
  /* ── Stat blocks ─────────────────────────────────────────────────────────── */
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .stat { background: var(--bg-input); padding: 8px; border-radius: 6px; text-align: center; }
  .stat-label { font-size: 10px; color: var(--fg-dim); text-transform: uppercase; letter-spacing: 0.05em; }
  .stat-value { font-size: 14px; font-weight: 600; font-family: var(--mono); margin-top: 2px; }
  /* ── Inline forms (profile add, plugin new) ──────────────────────────────── */
  .inline-form {
    background: var(--bg-input);
    border: 1px dashed var(--border);
    border-radius: 6px;
    padding: 10px;
    margin-top: 8px;
  }
  /* minmax(0, …) on grid columns is essential — without it grid items default to
     min-width:auto and refuse to shrink below their intrinsic content width. Long
     mono labels or option text would then push the second column (and the whole
     card) past the sidebar's right edge. */
  .inline-form .form-grid { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr); gap: 6px 8px; align-items: center; font-size: 12px; }
  .inline-form label { font-size: 11px; color: var(--fg-dim); min-width: 0; overflow-wrap: anywhere; }
  .inline-form input, .inline-form select { width: 100%; min-width: 0; padding: 4px 6px; box-sizing: border-box; }
  .inline-form .actions { display: flex; gap: 6px; justify-content: flex-end; margin-top: 10px; }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--bg-card); border: 1px solid var(--border); padding: 8px 14px; border-radius: 6px; font-size: 12px; box-shadow: 0 4px 14px rgba(0,0,0,0.3); animation: fadeIn 0.2s; z-index: 10; }
  .toast.err { color: var(--err); border-color: rgba(247, 118, 142, 0.4); }
  .toast.ok { color: var(--ok); border-color: rgba(158, 206, 106, 0.4); }
  @keyframes fadeIn { from { opacity: 0; transform: translate(-50%, 6px); } to { opacity: 1; transform: translate(-50%, 0); } }
  /* ── Agent chat panel ──────────────────────────────────────────────────── */
  /* Inside the chat tab (which is a flex column), the shell takes all remaining
     vertical space and contains the card. min-height:0 is critical — without it,
     flex children refuse to shrink past their content height and the thread can't
     overflow-scroll. */
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
  .agent-card {
    position: relative;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }
  .agent-card h2 {
    margin: 0 0 10px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--fg-dim);
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }
  .agent-card h2 .agent-status { margin-left: auto; font-size: 10px; }
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
  .agent-thread {
    flex: 1;
    min-height: 80px;
    overflow-y: auto;
    padding: 6px 0;
    font-size: 12.5px;
    line-height: 1.5;
  }
  .agent-msg { margin-bottom: 10px; }
  .agent-msg-user {
    color: var(--accent);
    font-family: var(--mono);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .agent-msg-user::before { content: "▸ "; opacity: 0.7; }
  .agent-msg-assistant {
    color: var(--fg);
    white-space: pre-wrap;
    word-break: break-word;
  }
  /* Subtle pulse while a streaming bubble is still receiving chunks. The class is removed
     when the final assistant_text event replaces the text — so the indicator stops as soon
     as the model is done generating. */
  .agent-msg-streaming::after {
    content: "▊";
    display: inline-block;
    margin-left: 2px;
    animation: tk-blink 1.05s steps(2, end) infinite;
    color: var(--accent);
    font-weight: 600;
  }
  @keyframes tk-blink { to { visibility: hidden; } }
  .agent-msg-meta {
    font-size: 10.5px;
    color: var(--fg-dim);
    font-family: var(--mono);
    margin-top: 2px;
  }
  .agent-tool {
    margin: 4px 0 4px 12px;
    padding: 5px 8px;
    background: var(--bg-input);
    border-left: 2px solid var(--accent);
    border-radius: 0 4px 4px 0;
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .agent-tool.err { border-left-color: var(--err); }
  .agent-tool.ok { border-left-color: var(--ok); }
  .agent-tool-head { display: flex; gap: 6px; align-items: baseline; }
  .agent-tool-name { color: var(--accent); }
  .agent-tool-args { color: var(--fg-dim); }
  .agent-tool-result {
    margin-top: 4px;
    color: var(--fg-dim);
    font-size: 10.5px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 140px;
    overflow-y: auto;
  }
  .agent-tool-result.expanded { max-height: none; }
  /* v0.17: per-tool envelope cards rendered inside .agent-tool-result. */
  .env-card { border: 1px solid var(--border, #ddd); border-radius: 6px; margin: 4px 0; padding: 6px 8px; font-size: 11px; color: var(--fg); }
  .env-card.env-failure { border-color: var(--err, #c00); background: rgba(245, 80, 80, 0.06); }
  .env-header { display: flex; gap: 6px; align-items: center; padding-bottom: 4px; border-bottom: 1px solid var(--border-light, rgba(255,255,255,0.06)); }
  .env-body { padding-top: 6px; font-family: 'SF Mono', Menlo, Consolas, monospace; font-size: 10.5px; white-space: pre; overflow-x: auto; max-height: 220px; overflow-y: auto; }
  .env-body.env-error-message { font-family: inherit; white-space: normal; color: var(--err, #c00); padding-top: 6px; }
  .env-hint { padding-top: 6px; font-size: 10.5px; color: var(--fg-dim); }
  .env-badge { font-size: 10px; padding: 1px 6px; border-radius: 3px; }
  .env-badge.badge-ok { background: rgba(158, 206, 106, 0.15); color: var(--ok, #058); }
  .env-badge.badge-fail { background: rgba(245, 80, 80, 0.15); color: var(--err, #c00); }
  .env-badge.badge-warn { background: rgba(245, 176, 65, 0.15); color: var(--warn, #a64); }
  .env-badge.badge-truncated { background: rgba(245, 176, 65, 0.15); color: var(--warn, #a64); }
  .env-code { background: rgba(255,255,255,0.04); padding: 6px 8px; border-radius: 3px; }
  .env-key-arg { font-family: monospace; color: var(--accent, #058); }
  .env-footer { padding-top: 6px; font-size: 10.5px; color: var(--fg-dim); }
  .copy-cursor-btn { font-size: 10px; padding: 1px 6px; margin-left: 6px; cursor: pointer; }
  .env-warning { padding-top: 4px; font-size: 10.5px; color: var(--warn, #a64); }
  .env-stream-label { font-size: 10px; color: var(--fg-dim); padding: 4px 0; }
  .env-stream { max-height: 180px; overflow-y: auto; }
  .env-stream.env-stderr { color: var(--err, #c00); }
  .env-tree { max-height: 220px; overflow-y: auto; }
  .env-match { margin: 4px 0; }
  .env-match-path { font-size: 10.5px; color: var(--accent, #058); font-family: monospace; padding-bottom: 2px; }
  mark { background: rgba(245, 217, 47, 0.35); color: inherit; padding: 0 2px; border-radius: 2px; }
  .agent-tool-toggle {
    color: var(--fg-dim);
    cursor: pointer;
    user-select: none;
    margin-top: 2px;
    font-size: 10px;
  }
  .agent-complete {
    margin-top: 6px;
    padding: 6px 8px;
    background: rgba(158, 206, 106, 0.08);
    border-left: 2px solid var(--ok);
    border-radius: 0 4px 4px 0;
    color: var(--ok);
    font-size: 12px;
  }
  .agent-error {
    margin-top: 6px;
    padding: 6px 8px;
    background: rgba(247, 118, 142, 0.08);
    border-left: 2px solid var(--err);
    border-radius: 0 4px 4px 0;
    color: var(--err);
    font-family: var(--mono);
    font-size: 11px;
  }
  /* v0.22: interactive AskUserQuestion form rendered in place of the default
     tool_use card when Claude's built-in AskUserQuestion tool fires inside
     a Tierkit Chat turn. Submit pipes the answer through streamChat() so
     Claude continues via --resume. */
  .tk-aqq-card {
    margin: 6px 0;
    padding: 10px 12px;
    border: 1px solid var(--accent);
    border-radius: 6px;
    background: rgba(122, 162, 247, 0.06);
    font-size: 12px;
  }
  .tk-aqq-card .tk-aqq-title { font-weight: 600; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
  .tk-aqq-card .tk-aqq-q { margin: 8px 0; }
  .tk-aqq-card .tk-aqq-q-text { font-weight: 600; margin-bottom: 4px; }
  .tk-aqq-card .tk-aqq-q-header { font-size: 10px; text-transform: uppercase; color: var(--fg-dim); letter-spacing: 0.05em; margin-right: 4px; }
  .tk-aqq-card label.tk-aqq-option {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 4px 6px;
    margin: 2px 0;
    border-radius: 4px;
    cursor: pointer;
  }
  .tk-aqq-card label.tk-aqq-option:hover { background: rgba(122, 162, 247, 0.08); }
  .tk-aqq-card label.tk-aqq-option input { margin-top: 3px; flex-shrink: 0; }
  .tk-aqq-card label.tk-aqq-option .tk-aqq-option-text { flex: 1; min-width: 0; }
  .tk-aqq-card label.tk-aqq-option .tk-aqq-option-desc { display: block; font-size: 11px; color: var(--fg-dim); margin-top: 2px; }
  .tk-aqq-card .tk-aqq-other {
    margin: 4px 0 0 24px;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .tk-aqq-card .tk-aqq-other input[type="text"] {
    flex: 1;
    min-width: 0;
    font-size: 11px;
    padding: 3px 6px;
    background: var(--bg-input);
    border: 1px solid var(--border);
    color: var(--fg);
    border-radius: 4px;
    box-sizing: border-box;
  }
  .tk-aqq-card .tk-aqq-actions {
    display: flex;
    gap: 6px;
    margin-top: 10px;
    align-items: center;
  }
  .tk-aqq-card .tk-aqq-submitted {
    color: var(--ok);
    font-size: 11px;
    font-weight: 600;
  }

  .agent-composer {
    margin-top: 8px;
    display: flex;
    gap: 6px;
  }
  .agent-composer textarea {
    flex: 1 1 auto;
    min-height: 36px;
    max-height: 140px;
    resize: none;
    font-family: var(--mono);
    font-size: 12.5px;
    line-height: 1.45;
  }
  .agent-composer button { flex: 0 0 auto; padding: 0 12px; font-size: 14px; align-self: stretch; }
  .agent-empty {
    color: var(--fg-dim);
    font-style: italic;
    font-size: 12px;
    padding: 18px 0;
    text-align: center;
  }
  /* Plugin ON/OFF toggle (used in Active plugins rows). Self-contained 36×18 switch
     with a 14×14 knob that slides on data-state="on". Touch-friendly target via
     touch-action:manipulation from the global rule above. */
  .plugin-toggle {
    width: 36px;
    height: 18px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--bg-input);
    padding: 0;
    position: relative;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 120ms ease, border-color 120ms ease;
  }
  .plugin-toggle[data-state="on"] {
    background: var(--accent);
    border-color: var(--accent);
  }
  .plugin-toggle .plugin-toggle-knob {
    display: block;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--fg);
    position: absolute;
    top: 1px;
    left: 1px;
    transition: left 140ms ease, background 140ms ease;
  }
  .plugin-toggle[data-state="on"] .plugin-toggle-knob {
    left: 19px;
    background: #0f1115;
  }
  .plugin-toggle:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Settings group section headers */
  .settings-group {
    grid-column: 1 / -1;
    margin: 14px 0 -2px;
    padding: 0 2px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg-dim);
  }
  .settings-group:first-of-type { margin-top: 4px; }
  /* "Today" usage hero — single full-width card with stats inline */
  .usage-hero {
    background: linear-gradient(135deg, rgba(122,162,247,0.10), rgba(158,206,106,0.06));
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 10px 14px;
    display: flex;
    align-items: baseline;
    gap: 16px;
    flex-wrap: wrap;
    font-family: var(--mono);
    grid-column: 1 / -1;
    min-width: 0;
  }
  /* Per-profile pills row inside the hero — must be allowed to shrink so its parent
     can wrap, otherwise its intrinsic content width pushes the hero past the sidebar. */
  #usage-by-profile { min-width: 0; flex: 1 1 auto; }
  .usage-hero .hero-stat { display: flex; align-items: baseline; gap: 4px; }
  .usage-hero .hero-stat .label { color: var(--fg-dim); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; }
  .usage-hero .hero-stat .value { color: var(--fg); font-size: 14px; font-weight: 600; }
  .usage-hero .hero-cost { color: var(--accent); }
  /* Subdivider inside merged Config / Daemon card */
  .card-divider {
    margin: 10px 0 8px;
    border-top: 1px solid var(--border);
    padding-top: 8px;
  }
  .card-divider-label {
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-dim);
    margin-bottom: 4px;
  }
  .tab-nav {
    display: flex;
    border-bottom: 1px solid var(--border);
    background: var(--bg-card);
    padding: 0 6px;
    flex-shrink: 0;
  }
  .tab-btn {
    background: none;
    border: none;
    padding: 8px 14px;
    font-size: 12px;
    color: var(--fg-dim);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    font-family: inherit;
  }
  .tab-btn:hover { color: var(--fg); }
  .tab-btn.active {
    color: var(--fg);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }
  .tab-panel { display: none; min-height: 0; }
  /* overflow-x:hidden — defensive guard. Without it, any descendant that escapes its
     container width (long mono lines, fixed-min-width form fields) ends up visible past
     the tab panel boundary on narrow sidebars. Children should still wrap properly via
     min-width:0 + overflow-wrap chains; this is the belt-and-suspenders catch. */
  .tab-panel.active { display: block; flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }

  /* ── Settings tab: blanket overflow protection ─────────────────────────────
     Descendants that get innerHTML'd after refresh (mcp snippet pre, model
     ids, file paths in activity rows, anything mono) must never push their
     parent card past the right edge of the sidebar. These rules don't
     replace per-element fixes — they're the final safety net for content
     we don't control directly. */
  .tab-panel[data-tab-panel="settings"] pre {
    max-width: 100%;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-wrap: anywhere;
    box-sizing: border-box;
  }
  .tab-panel[data-tab-panel="settings"] code,
  .tab-panel[data-tab-panel="settings"] .mono {
    overflow-wrap: anywhere;
    word-break: break-word;
    min-width: 0;
  }
  .tab-panel[data-tab-panel="settings"] input,
  .tab-panel[data-tab-panel="settings"] textarea,
  .tab-panel[data-tab-panel="settings"] select {
    max-width: 100%;
    box-sizing: border-box;
  }
  .tab-panel[data-tab-panel="settings"] .card > * {
    max-width: 100%;
  }
  /* Chat tab: full-height layout. Thread expands to fill, composer stays pinned just
     below via natural flex flow (NOT sticky — sticky needs a scroll-root that webview
     iframes don't provide, which is what broke 0.8.2). */
  .tab-panel.active[data-tab-panel="chat"] {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .chat-session-row {
    padding: 6px 8px;
    margin-bottom: 2px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .chat-session-row:hover { background: var(--bg-hover); }
  .chat-session-row.selected { background: var(--bg-hover); border-left: 2px solid var(--accent); padding-left: 6px; }
  .chat-session-row .session-preview { color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chat-session-row .session-meta { color: var(--fg-dim); font-family: var(--mono); font-size: 10px; }
  /* Touch responsiveness (all viewports). Strips iOS 300ms tap-delay +
     double-tap zoom on interactive controls. Without touch-action:manipulation
     taps were getting eaten by webview gesture pipeline in code-server. */
  button, .tab-btn, .tiny, select, input, textarea {
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  button, .tab-btn, .tiny {
    cursor: pointer;
    user-select: none;
    -webkit-user-select: none;
  }
  /* Empty slash-suggest container shouldn't intercept clicks behind it. */
  #agent-slash-suggest:empty { pointer-events: none; }

  /* ── Narrow viewports (≤600px, covers phone full-screen AND mobile sidebar).
        Sidebar webviews in code-server on phones are ~280–360px wide, so
        triggering at 480px (phone-only) misses them. ── */
  @media (max-width: 600px) {
    /* Density: trimmed down from 14px (v0.8.2) — sidebar is narrow, big text crowds it */
    body { font-size: 13px; }
    .dim, .mono { font-size: 11px; }

    /* Topbar compact: hide brand label, keep pills */
    .topbar { padding: 6px 8px; flex-wrap: wrap; row-gap: 4px; }
    .topbar .brand { display: none; }
    .topbar .pill { font-size: 10px; }

    /* Tab nav: equal split, smaller touch target than phone full-screen */
    .tab-nav { padding: 0; }
    .tab-btn {
      flex: 1;
      min-height: 36px;
      padding: 8px 12px;
      font-size: 13px;
    }
    .tab-btn.active { border-bottom-width: 3px; }

    /* .tiny buttons: still tappable but proportional to sidebar density */
    .tiny {
      min-height: 32px;
      padding: 6px 10px;
      font-size: 12px;
    }

    /* Agent card: tighter padding, smaller header */
    .agent-card { padding: 8px; }
    .agent-card h2 { font-size: 13px; margin: 4px 0 8px; }
    .agent-thread { font-size: 13px; padding: 6px; }

    /* Long URLs and code in messages must not blow out the viewport */
    .agent-thread pre, .agent-thread code { overflow-x: auto; word-break: break-word; }
    .agent-thread .msg, .agent-thread p { overflow-wrap: anywhere; }

    /* Composer: NO sticky/safe-area (v0.8.2 broke webview scrolling).
       Natural flex flow + iOS-zoom-safe font size on inputs. */
    .agent-composer { gap: 6px; }
    .agent-composer textarea {
      max-height: 25vh;
      font-size: 16px; /* prevents iOS Safari auto-zoom on focus */
    }
    .agent-composer button {
      min-width: 36px;
      min-height: 36px;
      font-size: 15px;
      padding: 0 10px;
    }

    /* Composer meta: hide redundant labels, keep selects + slash hint */
    #agent-composer-meta [data-i18n="modeLabel"],
    #agent-composer-meta [data-i18n="approvalLabel"],
    #agent-composer-meta [data-i18n="forSlash"] { display: none; }
    #agent-composer-meta .kbd { display: none; }
    #agent-composer-meta select {
      font-size: 16px;
      min-height: 30px;
      padding: 2px 6px;
    }

    /* Smaller attachment thumbs so multiple fit one row in the narrow pane */
    #agent-attachments img { max-width: 60px !important; max-height: 60px !important; }

    /* Settings tab: tighter card density */
    main { padding: 8px; gap: 8px; }
    .card { padding: 8px; }
    .card h2 { font-size: 13px; }
  }
  /* v0.12.2 — UI validation flow */
  .c122-validation-card { display: flex; flex-direction: column; gap: 8px; }
  .c122-state-row { display: flex; gap: 8px; align-items: center; }
  .c122-files-list { list-style: none; padding-left: 0; margin: 4px 0; max-height: 120px; overflow-y: auto; }
  .c122-files-list li { font-family: monospace; font-size: 11px; color: var(--fg-muted, #999); }
  .c122-prompt-path-row { font-size: 11px; color: var(--fg-muted, #999); display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .c122-response-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 6px 0; }
  .c122-response-col { border: 1px solid var(--border, #444); padding: 6px; overflow-y: auto; max-height: 240px; font-size: 12px; white-space: pre-wrap; }
  .c122-compare-summary { width: 100%; font-size: 11px; border-collapse: collapse; }
  .c122-compare-summary td, .c122-compare-summary th { padding: 2px 6px; border-bottom: 1px dotted var(--border, #444); text-align: left; }
  .c122-verdict-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .c122-notes-counter { font-size: 10px; color: var(--fg-muted, #999); }
  .c122-notes-counter.over { color: #d73a49; }
  .c122-modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1000; display: flex; align-items: center; justify-content: center; }
  .c122-modal-backdrop[hidden] { display: none; }
  .c122-modal { background: var(--bg, #1e1e1e); padding: 16px; border-radius: 6px; max-width: 460px; border: 1px solid var(--border, #444); }
  .c122-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .c122-error-banner { background: rgba(215,58,73,0.1); border: 1px solid #d73a49; padding: 8px; border-radius: 4px; margin: 6px 0; font-size: 12px; }
  .c122-cancelled-note { font-size: 11px; color: var(--fg-muted, #999); margin-top: 4px; }
  .c122-saved-verdict { background: rgba(40,167,69,0.1); padding: 4px 8px; border-radius: 3px; font-size: 12px; }
  .c122-api-key-hint { font-size: 11px; color: var(--fg-muted, #999); margin: 4px 0; }
  .c122-progress { font-size: 10px; color: var(--fg-muted, #999); }
  /* v0.14 — onboarding card */
  .onboarding-card { background: rgba(80,200,120,0.06); border: 1px solid rgba(80,200,120,0.35); border-radius: 6px; padding: 12px 14px; margin-bottom: 10px; }
  .onboarding-card h3 { margin: 0 0 8px; font-size: 13px; font-weight: 700; color: var(--fg); }
  .onboarding-list { list-style: none; padding: 0; margin: 0 0 10px; display: flex; flex-direction: column; gap: 4px; }
  .onboarding-list li { display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .onboarding-list .ob-icon { width: 16px; text-align: center; flex-shrink: 0; }
  .onboarding-list .ob-label { flex: 1; }
  .onboarding-list .ob-action button { font-size: 11px; padding: 1px 7px; }
  .onboarding-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .onboarding-actions button { font-size: 12px; padding: 4px 12px; }
  /* v0.14 — profile inline editor */
  .profile-editor { margin-top: 6px; padding: 8px 10px; background: rgba(0,0,0,0.15); border-radius: 5px; font-size: 12px; display: flex; flex-direction: column; gap: 6px; }
  .profile-editor label { color: var(--fg-dim); font-size: 11px; font-weight: 600; margin-bottom: 2px; display: block; }
  .chip-input { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-height: 24px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 4px; padding: 3px 6px; }
  .chip { display: inline-flex; align-items: center; gap: 3px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; padding: 1px 7px; font-size: 11px; font-family: var(--mono); }
  .chip.chip-invalid { border-color: #d73a49; color: #d73a49; }
  .chip .chip-x { cursor: pointer; opacity: 0.6; margin-left: 2px; }
  .chip .chip-x:hover { opacity: 1; }
  .chip-add-btn { background: none; border: none; color: var(--accent); cursor: pointer; padding: 0 4px; font-size: 14px; line-height: 1; }
  .chip-input-field { border: none; background: transparent; color: var(--fg); font-size: 11px; outline: none; width: 120px; }
  .chip-suggest { position: absolute; background: var(--bg-card); border: 1px solid var(--border); border-radius: 5px; max-height: 140px; overflow-y: auto; z-index: 10; font-size: 11px; font-family: var(--mono); box-shadow: 0 4px 12px rgba(0,0,0,0.4); min-width: 140px; }
  .chip-suggest div { padding: 4px 8px; cursor: pointer; }
  .chip-suggest div:hover { background: var(--bg-input); }
  .profile-editor-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
  /* v0.14 — secrets card */
  .secrets-card { display: flex; flex-direction: column; gap: 8px; }
  .secrets-card h2 { margin-bottom: 0; }
  /* flex-wrap so a narrow sidebar wraps the value + buttons onto a second line
     instead of overflowing horizontally past the card edge. */
  .secret-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 4px 0; font-size: 12px; border-bottom: 1px solid var(--border); }
  .secret-row:last-of-type { border-bottom: none; }
  /* Allow shrink, but bias toward a reasonable column width via flex-basis. The
     previous flex-shrink:0 + min-width:160px combo refused to compress and pushed
     the row out of the sidebar on widths below ~300px. */
  .secret-row .secret-key { font-family: var(--mono); font-weight: 600; flex: 0 1 auto; min-width: 0; overflow-wrap: anywhere; }
  .secret-row .secret-val { font-family: var(--mono); color: var(--fg-dim); flex: 1 1 120px; min-width: 0; font-size: 11px; overflow-wrap: anywhere; }
  .secret-row .secret-notset { color: var(--warn); font-size: 11px; }
  .secret-inline-form { padding: 6px 0; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .secret-inline-form input[type=password], .secret-inline-form input[type=text] { font-family: var(--mono); font-size: 12px; flex: 1 1 100px; min-width: 0; background: var(--bg-input); border: 1px solid var(--border); color: var(--fg); padding: 3px 6px; border-radius: 4px; }
  /* mcp-patch rows render comma-separated file path lists — without flex-wrap +
     overflow-wrap the long paths push past the sidebar's right edge. */
  .mcp-patch-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 11.5px; }
  .mcp-patch-row:last-child { border-bottom: none; }
  .mcp-patch-row .mcp-patch-id { font-family: var(--mono); font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
  .mcp-patch-row .mcp-patch-files { font-family: var(--mono); color: var(--fg-dim); font-size: 11px; flex: 1 1 100%; min-width: 0; overflow-wrap: anywhere; word-break: break-all; }
  .mcp-patch-row .mcp-patch-risk { font-size: 10px; padding: 1px 5px; border-radius: 3px; }
  .mcp-patch-row .mcp-patch-risk.risk-high { background: rgba(247, 118, 142, 0.15); color: var(--err); }
  .mcp-patch-row .mcp-patch-risk.risk-medium { background: rgba(224, 175, 104, 0.15); color: var(--warn); }
  .mcp-patch-row .mcp-patch-risk.risk-low { background: rgba(158, 206, 106, 0.15); color: var(--ok); }
  .mcp-patch-row .mcp-patch-risk.risk-unknown { background: rgba(138, 146, 163, 0.15); color: var(--fg-dim); }
</style>
</head>
<body>

<div class="topbar">
  <span class="brand">Tierkit</span>
  <span id="health-pill" class="pill pill-warn">…</span>
  <span id="freedom-pill" class="pill pill-accent">freedom: …</span>
  <span class="spacer"></span>
  <button id="btn-refresh" class="tiny" title="refresh all panels">↻</button>
</div>

<div class="tab-nav" role="tablist">
  <button class="tab-btn active" data-tab="chat" role="tab" data-i18n="tabChat">Chat</button>
  <button class="tab-btn" data-tab="settings" role="tab" data-i18n="tabSettings">Settings</button>
</div>

<div class="tab-panel active" data-tab-panel="chat">
<div id="host-banner" class="err-banner" style="display:none"></div>

<div class="agent-shell">
  <div class="agent-card">
    <h2>
      <span data-i18n="cardAgent">Tierkit Compressor</span>
      <!-- v0.19: agent loop (status/usage/export/import/clear) hidden. The Chat tab
           is now a thin shell for the v0.18 digest pipeline. The hidden DOM nodes
           remain so existing JS handlers that null-check them keep compiling. -->
      <span id="agent-status" class="agent-status pill pill-dim">idle</span>
      <span id="agent-usage-meter" class="pill pill-dim" style="font-size:10px;font-family:var(--mono)">0 tok</span>
      <span id="tk-chat-cost-meter" class="pill pill-dim" style="font-size:10px;font-family:var(--mono);display:none">$0.0000</span>
      <!-- v0.21.10: session-cumulative compression savings. Shows once the user
           has triggered at least one Tierkit MCP digest tool through chat. -->
      <span id="tk-chat-saved-meter" class="pill" style="font-size:10px;font-family:var(--mono);display:none;background:rgba(74,222,128,0.15);border:1px solid rgba(74,222,128,0.4);color:rgb(74,222,128)" title="cumulative tokens saved by Tierkit MCP compression this chat session">절감 0 tok</span>
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
    <div id="agent-thread" class="agent-thread">
      <div class="agent-empty" data-i18n="agentEmpty" style="line-height:1.6">
        <b>Tierkit Chat = your Claude Code chat.</b><br>
        <br>
        Type a task and press Enter. Tierkit spawns <code>claude</code> in the background and streams the response right here — assistant text, tool calls, results, the works. Sessions persist across messages.<br>
        <br>
        If you've wired the Tierkit MCP server (Settings → Auto-wire Claude Code), Claude will compress your input via <code>tierkit.compress_command</code> when it helps. No clipboard, no ⌘V, no separate Claude Code sidebar required.<br>
        <br>
        Use 📦 for explicit local digests (Context Pack, file/diff/json — these don't go to Claude unless you click "→ Claude Code" on the card).
      </div>
    </div>
    <div class="agent-composer" style="position:relative">
      <textarea id="agent-input" rows="2" data-i18n-placeholder="agentPlaceholder" placeholder="Chat with Claude (proxied through claude CLI). Enter to send · Shift+Enter for newline."></textarea>
      <!-- v0.21.3: visible Stop button shown only while a chat turn is streaming.
           Clicking it aborts the in-flight claude subprocess via the SSE
           abort signal. Hidden by default; streamChat toggles it. -->
      <button id="tk-chat-stop" title="stop the current Claude turn" style="display:none">⏹ <span data-i18n="tkChatStop">Stop</span></button>
      <!-- v0.19: legacy agent send / stop hidden. Enter now defaults to chat. -->
      <button id="agent-send" class="primary" hidden>→</button>
      <button id="agent-stop" hidden>■</button>
      <button id="tk-tools-btn" class="primary" title="Tierkit context tools — compress, pack, digest" style="position:relative">📦 ▾</button>
      <div id="tk-tools-menu" style="display:none;position:absolute;right:0;bottom:calc(100% + 4px);min-width:220px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.4);z-index:10;font-size:12px;overflow:hidden">
        <button class="tk-tool-item" data-tk-tool="compress" style="display:block;width:100%;text-align:left;padding:8px 12px;border:0;background:transparent;color:inherit;cursor:pointer;border-bottom:1px solid var(--border)">🗜️ <span data-i18n="tkToolCompress">Compress → Claude Code (Enter)</span></button>
        <button class="tk-tool-item" data-tk-tool="pack" style="display:block;width:100%;text-align:left;padding:8px 12px;border:0;background:transparent;color:inherit;cursor:pointer;border-bottom:1px solid var(--border)">📦 <span data-i18n="tkToolPack">Build Context Pack…</span></button>
        <button class="tk-tool-item" data-tk-tool="file" style="display:block;width:100%;text-align:left;padding:8px 12px;border:0;background:transparent;color:inherit;cursor:pointer;border-bottom:1px solid var(--border)">📁 <span data-i18n="tkToolFile">Digest file…</span></button>
        <button class="tk-tool-item" data-tk-tool="diff" style="display:block;width:100%;text-align:left;padding:8px 12px;border:0;background:transparent;color:inherit;cursor:pointer;border-bottom:1px solid var(--border)">🔍 <span data-i18n="tkToolDiff">Digest diff</span></button>
        <button class="tk-tool-item" data-tk-tool="diff-staged" style="display:block;width:100%;text-align:left;padding:8px 12px;border:0;background:transparent;color:inherit;cursor:pointer">🔍 <span data-i18n="tkToolDiffStaged">Digest staged diff</span></button>
      </div>
    </div>
    <!-- v0.21.3: chat-mode controls. The composer's default Enter behavior
         sends a message to claude via the streaming proxy. These controls
         affect that flow:
           - tk-perm-mode: what permission policy claude uses for tool calls
             (acceptEdits / bypassPermissions / default / plan).
           - tk-auto-forward: the legacy "compress + ⌘V → Claude Code" toggle
             used by the 📦 dropdown's manual Compress/Pack/Digest paths. -->
    <div style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:11px;color:var(--fg-dim);flex-wrap:wrap">
      <label style="display:flex;align-items:center;gap:4px;cursor:pointer" title="how claude handles tool permissions (Edit/Write/Bash) in this chat turn">
        <span data-i18n="permLabel">perm:</span>
        <select id="tk-perm-mode" style="padding:2px 6px;font-size:11px">
          <option value="acceptEdits" data-i18n="tkPermAcceptEdits">Accept edits only (Bash blocked)</option>
          <option value="bypassPermissions" data-i18n="tkPermBypass">Accept all tools (Edit + Bash + MCP, ⚠)</option>
          <option value="default" data-i18n="tkPermDefault">Default (denies all in -p)</option>
          <option value="plan" data-i18n="tkPermPlan">Plan (read-only)</option>
        </select>
      </label>
      <label style="display:flex;align-items:center;gap:4px;cursor:pointer" title="legacy: when ON, the 📦 dropdown's Compress/Pack/Digest results auto-copy + focus Claude Code's sidebar so you can ⌘V. Unrelated to Enter, which now chats with claude directly.">
        <input type="checkbox" id="tk-auto-forward" style="margin:0">
        <span>📦 → Claude (⌘V)</span>
      </label>
    </div>
    <!-- v0.19: composer meta (mode/approval/force-edit) hidden. Modes were tied to
         the agent loop which is no longer running. -->
    <div id="agent-composer-meta" hidden>
      <select id="agent-mode-select" hidden></select>
      <select id="agent-approval-select" hidden>
        <option value="auto">auto</option>
        <option value="interactive">ask each</option>
      </select>
      <input type="checkbox" id="agent-force-edit" hidden>
    </div>
    <div id="agent-slash-suggest" hidden></div>
    <div id="agent-attachments" hidden></div>
  </div>
</div>
</div><!-- /tab-panel:chat -->

<main class="tab-panel" data-tab-panel="settings">

  <!-- ── ONBOARDING CARD (v0.14; hidden by JS when seenOnboarding===true) ── -->
  <div class="onboarding-card" id="onboarding-card" style="display:none">
    <h3 data-i18n="onboardingTitle">Setup</h3>
    <ul class="onboarding-list" id="onboarding-list"></ul>
    <div class="onboarding-actions">
      <button id="onboarding-test" data-i18n="onboardingQuickTest">Quick check ▷</button>
      <button id="onboarding-dismiss" data-i18n="onboardingDismiss">Got it, hide</button>
    </div>
    <div id="onboarding-trace" style="display:none;font-size:11px;margin-top:8px;padding:6px 8px;background:var(--bg-input);border-radius:4px;font-family:var(--mono);color:var(--fg-dim)"></div>
  </div>

  <!-- ── ANTHROPIC GATEWAY PHASE 1 toggle card ──────────────────────── -->
  <section class="card tk-anthropic-gateway-card">
    <h2>Route Claude Code through Tierkit</h2>
    <p class="dim" style="font-size:11.5px;margin-top:0">Phase 1 passthrough connection. Requests are routed through the local Tierkit daemon without modifying message content.</p>
    <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
      <label class="toggle-label" style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" id="tk-gateway-toggle" disabled style="width:16px;height:16px">
        <span id="tk-gateway-toggle-label" style="font-size:12px">Loading…</span>
      </label>
    </div>
    <div id="tk-gateway-browser-note" class="dim" style="font-size:10.5px;margin-top:6px;display:none">Use the VS Code sidebar to toggle.</div>
  </section>

  <!-- ── MCP BRIDGE card (v0.15, extended in v0.18) ──────────────────── -->
  <section class="card mcp-bridge-card">
    <h2 data-i18n="cardMcpBridge">Connect Claude Code (MCP)</h2>
    <p data-i18n="mcpBridgeIntro">Let Claude Code, Claude Desktop, or any MCP-aware agent use Tierkit's gated tools: safe file editing + command execution (v0.15) and the v0.18 Context Gateway (compress / digest / build_context_pack) for token-cheap context.</p>
    <button id="btn-mcp-show-snippet" data-i18n="mcpShowSnippet">Show config snippet</button>
    <pre id="mcp-snippet-output" style="display:none"></pre>
    <button id="btn-mcp-copy-snippet" style="display:none" data-i18n="mcpCopySnippet">Copy to clipboard</button>
    <div class="dim" style="font-size:10.5px;margin-top:6px" data-i18n="mcpBridgeToolsHint">14 tools registered: 7 base (list/read/search/patch/run/policy) + 7 v0.18 (compress_command, get_error_digest, get_test_digest, get_json_digest, get_file_digest, get_diff_summary, build_context_pack)</div>
  </section>

  <!-- ── PENDING MCP PATCHES panel (v0.15) ──────────────────────────── -->
  <section class="card mcp-patches-card">
    <h2 data-i18n="cardMcpPatches">Pending MCP patches</h2>
    <div id="mcp-patches-list" class="mcp-patches-list"></div>
  </section>

  <!-- ── CONTEXT GATEWAY card (v0.18) ──────────────────────────────── -->
  <section class="card tk-ctx-gateway-card">
    <h2 data-i18n="cardContextGateway">Context Gateway</h2>
    <p class="dim" style="font-size:11.5px;margin-top:0" data-i18n="ctxGatewayIntro">Local compression for commands, error logs, tests, files, diffs, and JSON. Use the 📦 Tierkit dropdown in Chat, the CLI, or call these via MCP from Claude Code.</p>

    <div style="margin-top:10px">
      <h3 style="font-size:12px;margin:6px 0" data-i18n="ctxGatewayRefineLabel">Refine profile for "Compress task"</h3>
      <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11.5px">
        <select id="tk-refine-profile" style="flex:1 1 140px;min-width:0;padding:4px 6px;max-width:100%;box-sizing:border-box">
          <option value="" data-i18n="ctxGatewayRefineNone">(rule-only — no LLM)</option>
        </select>
        <button id="tk-refine-clear" class="tiny" style="flex-shrink:0" title="reset to rule-only" data-i18n="ctxGatewayRefineReset">Reset</button>
      </div>
      <div class="dim" style="font-size:10.5px;margin-top:4px" data-i18n="ctxGatewayRefineHint">When set, Chat "Compress task" sends the rule-based brief through this local model for further compression. Falls back to rule output on failure.</div>
      <!-- v0.21.9: dynamic hint surfaced when picker has no usable options (no
           local profiles found, or all disabled/unreachable). Empty/idle otherwise. -->
      <div id="tk-refine-hint" style="font-size:10.5px;margin-top:4px"></div>
      <!-- v0.21.12: inline "+ Custom Ollama" form. The default discovery only
           finds Ollama on the SAME host as the daemon — useless on code-server
           where the daemon runs on a remote container but Ollama runs on the
           user's local machine. This form lets the user point at any reachable
           Ollama instance (e.g. http://host.docker.internal:11434, or a LAN IP). -->
      <div style="margin-top:6px">
        <button id="tk-refine-add-toggle" class="tiny" data-i18n="ctxGatewayRefineAddBtn">+ Add custom Ollama profile</button>
      </div>
      <div id="tk-refine-add-form" style="display:none;margin-top:6px;padding:8px;background:var(--bg-input);border-radius:4px;font-size:11px">
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;align-items:center">
          <label style="min-width:50px">id:</label>
          <input id="tk-refine-add-id" type="text" placeholder="myOllama" style="flex:1 1 120px;min-width:0;padding:3px 6px;font-size:11px;box-sizing:border-box">
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;align-items:center">
          <label style="min-width:50px">model:</label>
          <input id="tk-refine-add-model" type="text" placeholder="qwen2.5-coder:7b" style="flex:1 1 120px;min-width:0;padding:3px 6px;font-size:11px;box-sizing:border-box">
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;align-items:center">
          <label style="min-width:50px">baseUrl:</label>
          <input id="tk-refine-add-url" type="text" placeholder="http://host.docker.internal:11434" style="flex:1 1 120px;min-width:0;padding:3px 6px;font-size:11px;box-sizing:border-box" value="http://127.0.0.1:11434">
        </div>
        <div class="dim" style="font-size:10px;margin-bottom:6px">
          <span data-i18n="ctxGatewayRefineAddHint">code-server tip: if Ollama runs on your local laptop, use http://host.docker.internal:11434 (Docker Desktop) or your laptop's LAN IP.</span>
        </div>
        <div style="display:flex;gap:6px;justify-content:flex-end">
          <button id="tk-refine-add-cancel" class="tiny" data-i18n="cancel">Cancel</button>
          <button id="tk-refine-add-save" class="tiny primary" data-i18n="saveBtn">Save</button>
        </div>
      </div>
    </div>

    <div style="margin-top:14px">
      <h3 style="font-size:12px;margin:6px 0" data-i18n="ctxGatewayCacheLabel">File digest cache</h3>
      <div id="tk-cache-stats" style="font-size:11px;font-family:var(--mono);color:var(--fg-dim)">—</div>
      <div style="margin-top:4px;display:flex;gap:6px">
        <button id="tk-cache-refresh" class="tiny" data-i18n="ctxGatewayCacheRefresh">↻ Refresh</button>
        <button id="tk-cache-clear" class="tiny" data-i18n="ctxGatewayCacheClear">🗑 Clear cache</button>
      </div>
    </div>

    <div style="margin-top:14px">
      <h3 style="font-size:12px;margin:6px 0" data-i18n="ctxGatewayToolsLabel">MCP tools exposed (v0.18)</h3>
      <ul style="font-size:10.5px;font-family:var(--mono);color:var(--fg-dim);margin:0;padding-left:18px">
        <li>tierkit.compress_command</li>
        <li>tierkit.get_error_digest</li>
        <li>tierkit.get_test_digest</li>
        <li>tierkit.get_json_digest</li>
        <li>tierkit.get_file_digest</li>
        <li>tierkit.get_diff_summary</li>
        <li>tierkit.build_context_pack</li>
      </ul>
    </div>

    <!-- v0.20: Claude Code auto-wire. Adds the tierkit MCP server entry to
         the user's Claude config + injects a CLAUDE.md instruction block. -->
    <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:10px">
      <h3 style="font-size:12px;margin:6px 0" data-i18n="ctxGatewayClaudeLabel">Auto-wire Claude Code</h3>
      <div id="tk-claude-status" style="font-size:11px;color:var(--fg-dim);margin-bottom:6px">—</div>
      <div id="tk-claude-paths" style="font-size:10.5px;margin-bottom:6px;display:none"></div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button id="tk-claude-connect-ws" class="tiny primary" data-i18n="claudeConnectWs" data-i18n-title="claudeConnectWsTitle" title="register tierkit MCP server in workspace .mcp.json + append CLAUDE.md block">Connect (workspace)</button>
        <button id="tk-claude-connect-global" class="tiny" data-i18n="claudeConnectGlobal" data-i18n-title="claudeConnectGlobalTitle" title="register tierkit MCP server in ~/.claude.json (all projects)">Connect (global)</button>
        <button id="tk-claude-disconnect" class="tiny" data-i18n="claudeDisconnect" data-i18n-title="claudeDisconnectTitle" title="remove MCP entry + strip CLAUDE.md block (current scope)">Disconnect</button>
      </div>
      <div id="tk-claude-verify" class="dim" style="font-size:10.5px;margin-top:8px;display:none;padding:6px 8px;background:var(--bg-input);border-radius:4px;line-height:1.5">
        <b data-i18n="ctxGatewayVerifyTitle">How to verify:</b>
        <ol style="margin:4px 0 0 16px;padding:0">
          <li data-i18n="ctxGatewayVerifyStep1">Reload window (already done if you clicked Reload now).</li>
          <li data-i18n="ctxGatewayVerifyStep2">Open Claude Code. Type <code>/mcp</code> in its chat — <code>tierkit</code> should appear with green status.</li>
          <li data-i18n="ctxGatewayVerifyStep3">If missing, click the config path above to inspect the JSON entry directly.</li>
        </ol>
      </div>
    </div>
  </section>

  <!-- ── TODAY hero ─────────────────────────────────────────────────── -->
  <div class="usage-hero">
    <div class="hero-stat"><span class="label" data-i18n="calls">calls</span><span class="value" id="stat-calls">—</span></div>
    <div class="hero-stat"><span class="label" data-i18n="tokens">tokens</span><span class="value" id="stat-tokens">—</span></div>
    <div class="hero-stat"><span class="label" data-i18n="cost">cost</span><span class="value hero-cost" id="stat-cost">—</span></div>
    <span class="spacer" style="flex:1"></span>
    <div id="usage-by-profile" style="font-size:10.5px;color:var(--fg-dim)"></div>
  </div>

  <!-- ── SAVINGS ─────────────────────────────────────────────────────── -->
  <h3 class="settings-group" data-i18n="groupSavings">Savings</h3>

  <!-- v0.17: routing-based savings — sums local-device LLM calls today and
       multiplies by the configured baseline (default claudeCode) cost. Polls
       /v1/savings/today every 5s alongside refreshUsage/refreshActivity. -->
  <section class="card">
    <h2><span data-i18n="cardSavingsTodayRouting">Today — Tierkit MCP compression savings</span></h2>
    <div id="card-savings-today-body">
      <!-- v0.21.10: before/after visual bar — the user can see at a glance
           how much smaller the compressed payload is vs what would have been
           sent without Tierkit. -->
      <div id="m-routing-visual" style="margin-bottom:10px;display:none">
        <div style="display:flex;align-items:baseline;justify-content:space-between;font-size:10.5px;color:var(--fg-dim);margin-bottom:4px">
          <span data-i18n="labelBefore">압축 전 (원본 입력)</span>
          <span id="m-routing-before-label" style="font-family:var(--mono)">—</span>
        </div>
        <div style="position:relative;height:8px;background:rgba(245,176,65,0.18);border-radius:4px;overflow:hidden">
          <div id="m-routing-before-bar" style="position:absolute;left:0;top:0;bottom:0;background:rgba(245,176,65,0.6);width:100%"></div>
        </div>
        <div style="display:flex;align-items:baseline;justify-content:space-between;font-size:10.5px;color:var(--fg-dim);margin:6px 0 4px">
          <span data-i18n="labelAfter">압축 후 (Claude로 전달)</span>
          <span id="m-routing-after-label" style="font-family:var(--mono)">—</span>
        </div>
        <div style="position:relative;height:8px;background:rgba(74,222,128,0.15);border-radius:4px;overflow:hidden">
          <div id="m-routing-after-bar" style="position:absolute;left:0;top:0;bottom:0;background:rgba(74,222,128,0.6);width:0%"></div>
        </div>
        <div style="display:flex;justify-content:flex-end;font-size:11px;font-weight:600;color:rgb(74,222,128);margin-top:6px">
          <span id="m-routing-saved-summary">—</span>
        </div>
      </div>
      <div class="metric"><span data-i18n="metricInputTokensSaved">Input tokens saved (compression)</span>: <span id="m-routing-input-tokens">—</span></div>
      <div class="metric"><span data-i18n="metricCostSaved">Estimated cost saved</span>: <span id="m-routing-cost-saved">—</span></div>
      <div class="metric"><span data-i18n="metricCloudCallsAvoided">MCP compression calls</span>: <span id="m-routing-calls-avoided">—</span></div>
      <div class="metric dim"><span data-i18n="labelBaseline">Priced against</span>: <span id="m-routing-baseline">—</span></div>
      <div class="metric dim" style="font-size:10.5px;margin-top:6px" id="m-routing-by-tool"></div>
      <details id="m-routing-by-client" class="savings-breakdown" style="margin-top:10px">
        <summary style="cursor:pointer;font-size:11.5px;font-weight:600" data-i18n="savingsByClient">By client</summary>
        <div id="m-routing-by-client-rows" style="margin-top:4px"></div>
      </details>
      <details id="m-routing-by-model" class="savings-breakdown" style="margin-top:6px">
        <summary style="cursor:pointer;font-size:11.5px;font-weight:600" data-i18n="savingsByModel">By Claude model</summary>
        <div id="m-routing-by-model-rows" style="margin-top:4px"></div>
      </details>
      <div id="m-routing-empty-hint" class="dim" style="font-size:10.5px;margin-top:6px" hidden></div>
    </div>
  </section>

  <!-- v0.21.7: removed legacy cards (Compression measurements + Current project validation) -->
  <div id="c122-legacy-removed-placeholder" hidden></div>

  <!-- v0.21.10: layout toggle. Sidebar webview is cramped on small windows /
       tablets; this button reveals the same UI in the main editor area. -->
  <section class="card">
    <h2><span data-i18n="cardLayout">Layout</span></h2>
    <div class="dim" style="font-size:11px;margin-bottom:8px" data-i18n="hintLayoutPanel">Open Tierkit in the main editor pane — much roomier than the sidebar. Useful on tablets / narrow screens.</div>
    <button id="tk-open-panel" class="tiny primary" data-i18n="openInPanel">📱 Open in main editor (mobile / wide view)</button>
  </section>

  <!-- ── COST ROUTING ───────────────────────────────────────────────── -->
  <h3 class="settings-group" data-i18n="groupCostRouting">Cost routing</h3>

  <!-- v0.13: pinned-no-fallback one-time banner (hidden by default; shown by JS when notices.seenPinnedNoFallbackV013 !== true) -->
  <div id="v013-pinned-banner" style="display:none;background:rgba(245,176,65,0.1);border:1px solid rgba(245,176,65,0.45);border-radius:6px;padding:10px 12px;margin-bottom:10px;font-size:12px"></div>

  <section class="card">
    <h2>
      <span data-i18n="cardLocalModels">Local + private + cloud models</span>
      <span class="h2-actions">
        <button id="btn-profile-add" class="tiny" data-i18n="profileAdd">+ Add</button>
      </span>
    </h2>
    <div class="card-divider"><div class="card-divider-label" data-i18n="labelLocalCompressor">Local Compressor</div></div>
    <!-- v0.12: banner rendered when every per-token profile with a cap is at ≥100%. -->
    <div id="all-capped-blocked-banner" style="display:none"></div>
    <!-- v0.11.2: consolidated banner for missing API keys. Populated by refreshModels()
         from the secrets map; hidden when nothing is missing. -->
    <div id="missing-keys-banner" style="display:none;font-size:11px;background:rgba(245,176,65,0.08);border:1px solid rgba(245,176,65,0.35);color:var(--fg);border-radius:6px;padding:6px 8px;margin-bottom:8px;align-items:center;gap:6px;flex-wrap:wrap"></div>
    <!-- v0.12: aggregate "this month per-token spend" bar, populated by refreshModels(). -->
    <div id="cost-aggregate-row"></div>
    <!-- v0.11.2: Each label sits directly above its control so the label↔value
         pairing is always visible, even when the sidebar is narrow. Previously
         these two rows looked like an empty "Auto-escalation up to: Preset:" pair. -->
    <div id="auto-ceiling-row" style="font-size:11px;color:var(--fg-dim);margin-bottom:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
      <label for="auto-ceiling-select" style="font-weight:600"><span data-i18n="autoCeilingLabel">Auto-escalation up to</span>:</label>
      <select id="auto-ceiling-select" class="tiny">
        <option value="local-device">local-device</option>
        <option value="private-remote">private-remote</option>
        <option value="public-cloud">public-cloud</option>
      </select>
      <button id="btn-discover-ollama" class="tiny" style="margin-left:auto" data-i18n="discoverBtn">🔍 Discover Ollama models</button>
    </div>
    <div id="presets-row" style="font-size:11px;color:var(--fg-dim);margin-bottom:8px;display:flex;align-items:center;flex-wrap:wrap;gap:4px">
      <span style="font-weight:600;margin-right:2px" data-i18n="presetsLabel">Preset:</span>
      <button class="tiny" data-preset="local-coder-first" title="Optimized for strong local coders (Qwen3-Coder, DeepSeek-Coder, ...)">🚀 <span data-i18n="presetLocalCoder">Local-coder-first</span></button>
      <button class="tiny" data-preset="private-only" title="Local + private-remote only — no public cloud">🔒 <span data-i18n="presetPrivateOnly">Private only</span></button>
      <button class="tiny" data-preset="tierkit-default" title="Reset to Tierkit defaults">↺ <span data-i18n="presetDefault">Defaults</span></button>
    </div>
    <details id="risk-thresholds-row" style="font-size:11px;color:var(--fg-dim);margin-bottom:6px">
      <summary style="cursor:pointer;outline:none;user-select:none"><span data-i18n="riskThresholdsLabel">Risk score thresholds</span></summary>
      <div style="display:grid;grid-template-columns:minmax(0,1fr) 60px;gap:4px 8px;align-items:center;padding:6px 0 0 0;font-size:11px">
        <label for="rt-local-fast" style="min-width:0;overflow-wrap:anywhere"><code>localFastMax</code> <span class="dim" data-i18n="rtLocalFastHint">small tasks → local-fast</span></label>
        <input type="number" id="rt-local-fast" min="0" max="100" step="1" style="width:100%;min-width:0;font-size:11px;padding:1px 4px;box-sizing:border-box">
        <label for="rt-local-strong" style="min-width:0;overflow-wrap:anywhere"><code>localStrongMax</code> <span class="dim" data-i18n="rtLocalStrongHint">most coding tasks → strong local</span></label>
        <input type="number" id="rt-local-strong" min="0" max="100" step="1" style="width:100%;min-width:0;font-size:11px;padding:1px 4px;box-sizing:border-box">
        <label for="rt-private-remote" style="min-width:0;overflow-wrap:anywhere"><code>privateRemoteMax</code> <span class="dim" data-i18n="rtPrivateRemoteHint">complex / sensitive → private-remote</span></label>
        <input type="number" id="rt-private-remote" min="0" max="100" step="1" style="width:100%;min-width:0;font-size:11px;padding:1px 4px;box-sizing:border-box">
        <label for="rt-public-cloud" style="min-width:0;overflow-wrap:anywhere"><code>publicCloudReviewMin</code> <span class="dim" data-i18n="rtPublicCloudHint">≥ this score → public-cloud (review-only)</span></label>
        <input type="number" id="rt-public-cloud" min="0" max="100" step="1" style="width:100%;min-width:0;font-size:11px;padding:1px 4px;box-sizing:border-box">
      </div>
      <div style="margin-top:6px;display:flex;gap:6px">
        <button id="rt-save" class="tiny primary" data-i18n="saveBtn">Save</button>
        <span id="rt-status" class="dim"></span>
      </div>
    </details>
    <div id="models-list"><div class="empty" data-i18n="loading">loading…</div></div>
    <div id="profile-add-form" style="display:none"></div>
    <div class="card-divider"><div class="card-divider-label" data-i18n="labelTierOrder">Tier order</div></div>
    <div class="dim" data-i18n="labelTierOrderValue">local → private → public</div>
  </section>

  <!-- ── INTEGRATIONS ───────────────────────────────────────────────── -->
  <h3 class="settings-group" data-i18n="groupIntegrations">Integrations</h3>

  <section class="card">
    <h2>
      <span data-i18n="cardTools">Connected tools</span>
      <span class="h2-actions">
        <button id="btn-sync" class="tiny" data-i18n="sync">Sync plugins</button>
      </span>
    </h2>
    <div id="tools-list"><div class="empty" data-i18n="loading">loading…</div></div>
  </section>

  <!-- ── SECRETS (v0.14) ───────────────────────────────────────────── -->
  <section class="card secrets-card" id="secrets-card">
    <h2 data-i18n="cardSecrets">API Keys</h2>
    <div id="secrets-list"><div class="empty" data-i18n="loading">loading…</div></div>
    <button id="btn-add-secret" class="tiny" data-i18n="secretAddCustom">+ Custom key</button>
    <div id="secrets-add-form" style="display:none;margin-top:8px"></div>
  </section>

  <!-- ── ADVANCED ───────────────────────────────────────────────────── -->
  <h3 class="settings-group" data-i18n="groupAdvanced">Advanced</h3>

  <details class="advanced-collapse">
    <summary>Show advanced cards</summary>

    <section class="card">
      <h2>
        <span data-i18n="cardPlugins">Active policy rules</span>
        <span class="h2-actions">
          <button id="btn-plugin-install" class="tiny" data-i18n="pluginInstall">+ Install</button>
          <button id="btn-plugin-new" class="tiny" data-i18n="pluginNew">+ New</button>
          <button id="btn-plugin-gen" class="tiny" data-i18n="genPluginBtn">+ Describe &amp; generate</button>
        </span>
      </h2>
      <div id="plugins-list"><div class="empty" data-i18n="loading">loading…</div></div>
      <div id="plugin-install-form" style="display:none"></div>
      <div id="plugin-new-form" style="display:none"></div>
    </section>

    <section class="card">
      <h2>
        <span data-i18n="cardDaemon">Daemon controls</span>
        <span class="h2-actions">
          <button id="btn-settings-reload" class="tiny" data-i18n="reloadBtn">Reload</button>
        </span>
      </h2>
      <div id="settings-view" class="row mono dim" data-i18n="loading">loading…</div>
      <div class="card-divider">
        <div class="card-divider-label" data-i18n="cardConfigDaemon">Config / Daemon</div>
        <div id="daemon-info" class="row mono dim" data-i18n="loading">loading…</div>
      </div>
    </section>

    <section class="card full">
      <h2>
        <span data-i18n="cardUsage">Raw usage log</span>
        <span id="activity-dot" class="pill pill-dim" style="font-size:10px">●</span>
      </h2>
      <div id="activity-list"><div class="empty" data-i18n="loading">loading…</div></div>
    </section>
  </details>

</main>

<script>
(function () {
  // ── Localization tables ────────────────────────────────────────────────────
  const LOCALES = {
    ko: {
      cardTools: '연결된 도구', cardPlugins: '활성 정책 규칙', cardActivity: '최근 활동',
      cardUsage: '원본 사용량 로그', cardModels: '모델 프로파일 편집', cardDaemon: '데몬 제어',
      cardAgent: '에이전트',
      sync: '플러그인 동기화', pluginNew: '+ 새 플러그인', profileAdd: '+ 추가',
      calls: '호출', tokens: '토큰', cost: '비용',
      loading: '불러오는 중…',
      agentEmpty: '아래 입력창에 작업을 입력하면 Tierkit 에이전트가 실행됩니다. 모든 모델 호출은 Tierkit 라우팅·정책 스택을 거칩니다.',
      agentPlaceholder: '예: src/ 폴더 구조를 분석하고 설명해줘',
      modeLabel: '모드:',
      approvalLabel: '승인:',
      approvalAuto: '자동',
      approvalInteractive: '매번 묻기',
      forSlash: '플러그인 명령',
      approveBtn: '승인',
      denyBtn: '거부',
      modeAll: '(모든 도구)',
      exportBtn: '내보내기',
      importBtn: '불러오기',
      clearBtn: '비우기',
      cardSettings: '설정',
      cardConfigDaemon: '설정 / 데몬',
      reloadBtn: '다시 불러오기',
      sessionApproveAll: '이번 세션 동안 모두 승인',
      tabChat: '채팅',
      tabSettings: '설정',
      chatNewSession: '새 세션',
      chatClearThread: '대화 비우기',
      groupSavings: '절감',
      groupCurrentProject: '현재 프로젝트',
      groupCostRouting: '비용 라우팅',
      groupIntegrations: '연결된 도구',
      groupAdvanced: '고급',
      cardSavingsToday: '오늘',
      cardSavingsTodayRouting: '오늘 (라우팅 절감)',
      metricInputTokensSaved: '클라우드 입력 토큰 절감',
      metricCloudCallsAvoided: '회피된 클라우드 호출',
      labelBaseline: '비교 대상',
      hintBaselineNotConfigured: '(가격 정보가 있는 baseline profile이 없음 — tierkit.config.json에 per-token cost가 있는 profile 추가)',
      cardCompressionMeasurements: '압축 측정',
      hintCompressionMeasurements: '\`tierkit context compare\`를 실행하면 압축 A/B 측정이 채워집니다.',
      cardCurrentArtifact: '마지막 압축 컨텍스트',
      cardLocalModels: '로컬 + 프라이빗 + 클라우드 모델',
      labelLocalCompressor: '로컬 압축기',
      labelLocalReviewer: '로컬 리뷰어',
      labelCloudFinal: '클라우드 최종',
      labelTierOrder: '계층 순서',
      labelTierOrderValue: '로컬 → 프라이빗 → 퍼블릭',
      actionBuild: '압축 컨텍스트 생성',
      actionCompare: '베이스라인 vs 압축 비교',
      actionSend: '압축 프롬프트 전송',
      hintBuildContext: '\`tierkit context build\` 를 실행해 생성하세요.',
      hintNoMeasurements: '\`tierkit context compare\` 를 실행하면 절감 측정이 시작됩니다.',
      metricTokensSaved: '클라우드 입력 토큰 절감',
      metricCostSaved: '예상 비용 절감',
      metricCallsAvoided: '회피된 클라우드 호출',
      // v0.12 cost-aware routing: per-profile budget bars
      groupPerTokenSpend:       '이번 달 per-token 지출',
      labelMonthlyCap:          '월 한도',
      labelInputTokensUsed:     '입력 토큰 사용',
      labelUsdUsed:             'USD 사용',
      labelNoCap:               '한도 없음',
      labelBlockedThisMonth:    '한도 도달 — 다음 달까지 차단됨',
      labelStatusOk:            '정상',
      labelStatusWarning:       '주의',
      labelStatusNearLimit:     '임박',
      labelStatusBlocked:       '차단됨',
      labelMetadataOnly:        '표시 전용 — 적용 안 됨',
      labelFixedMonthlyCost:    '월 고정 비용',
      warnBudgetThreshold:      '한도의 {pct}% 도달',
      warnAllCappedPerTokenBlocked:
        '한도가 설정된 모든 per-token 프로파일이 소진되었습니다. 한도 초기화, 상향, ' +
        '또는 다른 프로파일 추가 전까지 per-token 퍼블릭 클라우드 fallback이 제한될 수 ' +
        '있습니다. 로컬/한도 없는 프로파일로 라우팅 가능한 작업은 정상 동작합니다.',
      // v0.12.2 — UI validation flow
      cardCurrentProjectValidation:     '현재 프로젝트 — 검증',
      labelTask:                        '작업',
      labelRecentContexts:              '최근',
      labelNewContext:                  '+ 새 컨텍스트',
      labelContextId:                   '컨텍스트',
      labelFilesCount:                  '파일',
      labelCopyPathButton:              '경로 복사',
      labelPromptPath:                  '프롬프트',
      labelBaselineEst:                 '베이스라인 (추정)',
      labelCompressedEst:               '압축 (추정)',
      labelSavingsEst:                  '예상 절감률',
      labelFilesInScope:                '선택된 파일',
      labelProfile:                     '프로파일',
      labelBuildButton:                 '압축 컨텍스트 생성',
      labelCompareButton:               '베이스라인 vs 압축 비교',
      labelCancelButton:                '취소',
      labelRunCompareButton:            '비교 실행',
      labelApiKeyHint:                  '선택한 프로파일에 API 키가 필요할 수 있습니다. 인증 실패 시 provider 오류가 표시됩니다.',
      modalCompareTitle:                '베이스라인 vs 압축 비교',
      modalCompareDescription:          '프로파일 "{profile}"에서 2번의 유료 모델 호출이 발생합니다:',
      modalCompareCostCaveat:           '추정 입력 비용만 표시 — 출력 비용은 포함되지 않습니다. 호출 시작 후 취소해도 토큰이 청구될 수 있습니다.',
      labelCompareSummary:              '비교 요약',
      labelCompareMetric:               '항목',
      labelCompareBaseline:             '베이스라인',
      labelCompareCompressed:           '압축',
      labelCompareSavings:              '절감',
      labelMetricInput:                 '입력',
      labelMetricOutput:                '출력',
      labelMetricCost:                  '비용',
      labelMetricLatency:               '지연',
      labelVerdictHeader:               '품질 판정',
      labelVerdictSame:                 '동등 (same)',
      labelVerdictBetter:               '더 나음 (better)',
      labelVerdictWorse:                '못함 (worse)',
      labelVerdictUnusable:             '쓸 수 없음 (unusable)',
      labelVerdictMissingContext:       '맥락 누락',
      labelVerdictNotes:                '메모',
      labelVerdictSaveButton:           '판정 저장',
      labelVerdictEditButton:           '판정 수정',
      labelVerdictSaved:                '판정 저장됨',
      labelRetryCompareButton:          '비교 재시도',
      hintNoRecentContexts:             '아직 컨텍스트가 없습니다.',
      hintShowingOfTotal:               '20개 표시 / 전체 {total}개 — 오래된 컨텍스트는 \`tierkit context show <id>\` (CLI)',
      hintCompareCancelled:             '비교가 취소되었습니다. provider 호출이 이미 시작된 경우 일부 토큰이 청구될 수 있습니다.',
      hintCompareFailedPartial:         '압축 단계에서 비교가 실패했습니다. 베이스라인 응답은 저장되었지만 비교 결과는 기록되지 않았습니다.',
      hintNotesCounter:                 '{count} / 2000자',
      hintNotesExceeded:                '메모는 2000자 이하여야 합니다.',
      errBuildFailed:                   '빌드 실패',
      errCompareFailed:                 '비교 실패',
      errCompareAlreadyRunning:         '다른 비교가 이미 실행 중입니다. 끝나기를 기다리거나 다른 창에서 취소하세요.',
      errContextNotFound:               '컨텍스트를 찾을 수 없습니다 (디스크에서 삭제됐을 수 있습니다).',
      errDaemonOffline:                 '데몬에 연결할 수 없습니다. \`tierkit runtime status\`로 확인하세요.',
    },
  };
  const lang = (navigator.language || 'en').toLowerCase().startsWith('ko') ? 'ko' : 'en';
  if (lang !== 'en' && LOCALES[lang]) {
    const t = LOCALES[lang];
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const k = el.getAttribute('data-i18n');
      if (t[k]) el.textContent = t[k];
    });
    // v0.23: tooltip + placeholder support. Same locale dict, different
    // attribute target. Lets us translate title= on icon-only buttons
    // and placeholder= on input fields without faking them as inner text.
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const k = el.getAttribute('data-i18n-title');
      if (t[k]) el.setAttribute('title', t[k]);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const k = el.getAttribute('data-i18n-placeholder');
      if (t[k]) el.setAttribute('placeholder', t[k]);
    });
    document.documentElement.setAttribute('lang', lang);
  }
  const RUNTIME = {
    en: {
      offline: 'offline',
      routed: 'routed to Tierkit',
      notRouted: 'not routed',
      present: 'detected',
      notPresent: 'not installed',
      connect: 'Connect',
      reconnect: 'Re-connect',
      enable: 'Enable',
      disable: 'Disable',
      remove: 'Remove',
      noActivity: 'no calls yet — use Roo / Cline / Continue (or call /v1/openai) to see them here',
      noPlugins: 'no plugins active. + New to author one, or install one from a directory.',
      pluginIdLabel: 'plugin id',
      modelLabel: 'model',
      providerLabel: 'provider',
      tierLabel: 'tier',
      apiKeyLabel: 'API key env',
      baseUrlLabel: 'base URL',
      idLabel: 'profile id',
      scopeLabel: 'save to',
      scopeWorkspace: 'workspace (this project only)',
      scopeUser: 'user (all folders)',
      saveBtn: 'Save',
      cancelBtn: 'Cancel',
      added: 'added',
      enabled: 'enabled',
      disabled: 'disabled',
      synced: 'sync complete',
      newCreated: 'plugin scaffolded',
      failed: 'failed',
      runTaskHint: 'Run a task in Roo Code (or another connected tool) to see entries here',
      configHintWorkspace: '~/.workspace/tierkit.config.json',
      configHintUser: '~/.tierkit/config.json',
      configHintBundled: 'bundled default',
      activityFrom: 'from',
      activityRedactions: 'redacted',
      activityBlocked: 'BLOCKED',
      profilePromptName: 'Profile id (e.g. claudeCustom)',
      pluginInstall: '+ Install',
      pluginNameLabel: 'name',
      pluginDescLabel: 'description',
      freedomLabel: 'freedom',
      firstCommandLabel: 'first command',
      generateBtn: 'Generate →',
      installBtn: 'Install',
      removeBtn: 'Remove',
      bundledSamplesLabel: 'Bundled samples',
      fromPathLabel: 'From path',
      noBundledSamples: 'No bundled samples available (open in VS Code to see them).',
      installEnableBtn: 'Install + Enable',
      emptyPluginsHint: 'No plugins active. Click below to install + enable a bundled sample (one click — auto-initializes the project config if needed).',
      deleteBtn: 'Delete',
      confirmDeleteProfile: 'Delete profile "{id}"?',
      deletedOk: 'deleted',
      keyMissing: 'API key not set',
      setKeyBtn: 'Set key',
      keySaved: 'API key saved',
      apiKeyValueLabel: 'API key value',
      apiKeyValuePlaceholder: 'paste sk-… (optional)',
      sectionApiKeys: 'API Keys',
      keyExternal: 'set by shell env — cannot delete here',
      confirmCloseForm: 'Close the open form?',
      forceEditLabel: '🪄 force edit',
      presetsLabel: 'Preset:',
      presetLocalCoder: 'Local-coder-first',
      presetPrivateOnly: 'Private only',
      presetDefault: 'Defaults',
      presetApplied: 'preset applied',
      riskThresholdsLabel: 'Risk score thresholds',
      rtLocalFastHint: 'small tasks → local-fast',
      rtLocalStrongHint: 'most coding → strong local',
      rtPrivateRemoteHint: 'complex/sensitive → private-remote',
      rtPublicCloudHint: '≥ this → public-cloud (review-only)',
      thresholdsSaved: 'thresholds saved',
      autoCeilingLabel: 'Auto-escalation up to',
      autoCeilingSaved: 'routing policy updated',
      goodAtLabel: 'Good at (comma-separated)',
      goodAtPlaceholder: 'code-review, korean, summarize',
      moreOptionsLabel: 'More options',
      escalatedNote: 'escalated',
      qualityRejectedNote: 'quality-rejected',
      genPluginBtn: '+ Describe & generate',
      genDescribeLabel: 'Describe the plugin you want',
      genDescribePlaceholder: 'e.g. A TDD-first plugin for Python that requires a failing pytest test before any implementation. Prefers small commits.',
      genButton: 'Generate →',
      genGenerating: 'Generating… this may take 10–30s (auto-routed)',
      genPreviewTitle: 'Preview',
      genGeneratedBy: 'generated by',
      genRulesCount: 'rules',
      genInstallEnable: 'Install + Enable',
      genInstallOnly: 'Install only',
      genDiscard: 'Discard',
      genInstalled: 'plugin installed',
      genRawOutputLabel: 'Last raw output (for debugging)',
      enabledOn: 'ON · click to disable',
      enabledOff: 'OFF · click to enable',
      enabledNowOn: 'enabled',
      enabledNowOff: 'disabled',
      daemonMismatch: 'Daemon shows v{daemon} but expected v{expected}. Reload the VS Code window (Cmd+Shift+P → "Developer: Reload Window") so the new code picks up.',
      enableToggle: 'enable',
      discoverBtn: '🔍 Discover Ollama models',
      discoverDone: 'discovered',
      // v0.12 cost-aware routing: per-profile budget bars (used by JS, not data-i18n)
      labelStatusOk:         'OK',
      labelStatusWarning:    'Warning',
      labelStatusNearLimit:  'Near limit',
      labelStatusBlocked:    'Blocked',
      labelMetadataOnly:     'metadata only',
      labelFixedMonthlyCost: 'Fixed monthly cost',
      groupPerTokenSpend:    'This month — per-token spend',
      warnBudgetThreshold:   '{pct}% of cap reached',
      warnAllCappedPerTokenBlocked:
        'All capped per-token profiles are exhausted. Until you reset caps, raise limits, or ' +
        'add another profile, per-token public-cloud fallback may be restricted. Tasks that can ' +
        'route to local or uncapped profiles still work normally.',
      // v0.12.2 — UI validation flow (JS-accessed strings)
      hintNoRecentContexts:     'No contexts yet.',
      hintShowingOfTotal:       'Showing 20 of {total} — older contexts via \`tierkit context show <id>\` (CLI)',
      hintCompareCancelled:     'Compare cancelled. If a provider call had already started, some tokens may have been billed.',
      hintCompareFailedPartial: 'Compare failed during the compressed leg. The baseline response was saved but the comparison was not recorded.',
      hintNotesCounter:         '{count} / 2000 chars',
      hintNotesExceeded:        'Notes must be 2000 characters or fewer.',
      errBuildFailed:           'Build failed',
      errCompareFailed:         'Compare failed',
      errCompareAlreadyRunning: 'Another compare is already running. Wait for it to finish or cancel it from the other window.',
      errContextNotFound:       'Context not found (it may have been deleted from disk).',
      errDaemonOffline:         'Cannot reach the daemon. Check \`tierkit runtime status\`.',
      labelApiKeyHint:          'The selected profile may require an API key. Authentication failures will surface as provider errors.',
      modalCompareTitle:        'Baseline vs compressed compare',
      modalCompareDescription:  'Profile "{profile}" will be invoked twice (paid model calls):',
      modalCompareCostCaveat:   'Estimated input cost only — output cost not included. Tokens may be billed even if you cancel after a call has started.',
      statusBuilding:           'Building compressed context (no model call)…',
      labelCompareMetric:          'Metric',
      labelCompareBaseline:        'Baseline',
      labelCompareCompressed:      'Compressed',
      labelCompareSavings:         'Savings',
      labelMetricInput:            'Input',
      labelMetricOutput:           'Output',
      labelMetricCost:             'Cost',
      labelMetricLatency:          'Latency',
      labelVerdictSame:            'Same (same)',
      labelVerdictBetter:          'Better (better)',
      labelVerdictWorse:           'Worse (worse)',
      labelVerdictUnusable:        'Unusable (unusable)',
      labelVerdictMissingContext:  'Missing context',
      labelVerdictSaved:           'Verdict saved',
      labelVerdictEditButton:      'Edit verdict',
      labelCancelButton:           'Cancel',
      labelRetryCompareButton:     'Retry compare',
      // v0.13 — viability badges + test button + pinned-no-fallback banner
      statusReady:                 'ready',
      statusDisabled:              'disabled',
      statusCliNotFound:           'CLI not found',
      statusCliHealthcheckFailed:  'CLI healthcheck failed',
      statusMissingApiKey:         'missing API key',
      statusOllamaUnreachable:     'Ollama unreachable',
      statusModelNotInstalled:     'model not installed',
      actionTest:                  'Test',
      testConfirmBody:             'Running a test sends a short request via your local CLI session or API key. This may consume subscription quota or API credits.',
      testDisabledNote:            'This profile is currently disabled. Test will check whether it can run, but it will not be used for routing until enabled.',
      testRun:                     'Run test',
      testCancel:                  'Cancel',
      bannerV013PinnedTitle:       'Tierkit v0.13 changed pinned-model behavior.',
      bannerV013PinnedBody:        'Pinned profiles now fail with a clear error instead of silently falling back to local. Use model:"auto" if you want fallback routing.',
      bannerGotIt:                 'Got it',
      warningStreamDegraded:       'stream degraded',
      modelTestBadge:              'model-test',
      // v0.14 — onboarding card
      onboardingTitle:              'Setup',
      onboardingDetectOllama:       'Ollama',
      onboardingDetectClaude:       'claude CLI',
      onboardingDetectClaudeProfile:'claudeCode enabled',
      onboardingDetectKey:          '\${name}',
      onboardingActionEnable:       'Enable',
      onboardingActionAddKey:       'Add key',
      onboardingActionInstall:      'Install',
      onboardingQuickTest:          'Quick check ▷',
      onboardingDismiss:            'Got it, hide',
      onboardingTracePrefix:        'Route trace:',
      // v0.14 — secrets card
      cardSecrets:                  'API Keys',
      secretEditBtn:                'Edit',
      secretRemoveBtn:              'Remove',
      secretAddCustom:              '+ Custom key',
      secretSave:                   'Save',
      secretCancel:                 'Cancel',
      secretNotSet:                 '(not set)',
      // v0.14 — profile editor
      profileEditBtn:               'Edit',
      profileSaveBtn:               'Save',
      profileResetBundled:          'Reset to bundled',
      profileDeleteBtn:             'Delete',
      profileFieldRoles:            'roles',
      profileFieldGoodAt:           'goodAt',
      profileFieldNotGoodAt:        'notGoodAt',
      profileChipAddPlaceholder:    'type a value, enter to add',
      profileResetConfirm:          'Remove the workspace override and use the bundled default for \${id}?',
      profileDeleteConfirm:         'Delete profile \${id}? This cannot be undone.',
      // v0.14.2 — single-shot footer + timeout error
      singleShotFooter:             '📝 Single-shot planner output. To enable multi-turn file editing, set an API key in Settings → API Keys.',
      timeoutError:                 'claudeCode timed out after \${seconds}s. Try a shorter prompt, or enable an API-key profile in Settings → API Keys.',
      // v0.15 — MCP Bridge card + pending patches panel
      cardMcpBridge:                'Connect Claude Code (MCP)',
      mcpBridgeIntro:               "Let Claude Code, Claude Desktop, or any MCP-aware agent use Tierkit's gated tools for safe file editing and command execution.",
      mcpShowSnippet:               'Show config snippet',
      mcpCopySnippet:               'Copy to clipboard',
      cardMcpPatches:               'Pending MCP patches',
      mcpPatchApprove:              'Approve',
      mcpPatchReject:               'Reject',
      mcpPatchNoneYet:              'No pending patches',
      mcpPatchRiskHigh:             'high risk',
      mcpPatchRiskMedium:           'medium risk',
    },
    ko: {
      offline: '오프라인',
      routed: 'Tierkit으로 라우팅됨',
      notRouted: '라우팅 안 됨',
      present: '설치 감지됨',
      notPresent: '미설치',
      connect: '연결',
      reconnect: '재연결',
      enable: '활성',
      disable: '비활성',
      remove: '제거',
      permLabel: '권한:',
      tkPermAcceptEdits: 'Edit만 자동 승인 (Bash 차단)',
      tkPermBypass: '모든 도구 자동 승인 (Edit + Bash + MCP, ⚠)',
      tkPermDefault: '기본 (모두 차단)',
      tkPermPlan: '계획 모드 (읽기 전용)',
      permDeniedHint: 'Bash 또는 MCP 도구가 권한 차단됨. 위 perm 드롭다운을 \\"모든 도구 자동 승인\\"으로 변경 후 다시 시도하세요.',
      claudeConnectWs: 'Connect (워크스페이스)',
      claudeConnectWsTitle: 'tierkit MCP 서버를 워크스페이스 .mcp.json에 등록 + CLAUDE.md 블록 추가',
      claudeConnectGlobal: 'Connect (전역)',
      claudeConnectGlobalTitle: 'tierkit MCP 서버를 ~/.claude.json에 등록 (모든 프로젝트)',
      claudeDisconnect: '연결 해제',
      claudeDisconnectTitle: 'MCP 엔트리 제거 + CLAUDE.md 블록 정리 (현재 범위)',
      mcpBridgeToolsHint: '14개 도구 등록됨: 기본 7개 (list/read/search/patch/run/policy) + v0.18 추가 7개 (compress_command, get_error_digest, get_test_digest, get_json_digest, get_file_digest, get_diff_summary, build_context_pack)',
      cardContextGateway: 'Context Gateway',
      ctxGatewayIntro: '명령어, 에러 로그, 테스트, 파일, diff, JSON을 로컬에서 압축합니다. Chat의 📦 Tierkit 드롭다운, CLI, 또는 Claude Code에서 MCP로 호출하세요.',
      ctxGatewayRefineLabel: '"작업 압축" 정제 프로파일',
      ctxGatewayRefineNone: '(규칙 기반만 — LLM 미사용)',
      ctxGatewayRefineReset: '재설정',
      ctxGatewayRefineHint: '설정 시, Chat의 "작업 압축"이 규칙 기반 브리프를 이 로컬 모델로 한 번 더 압축합니다. 실패하면 규칙 결과로 폴백.',
      ctxGatewayRefineAddBtn: '+ 커스텀 Ollama 프로파일 추가',
      ctxGatewayRefineAddHint: 'code-server 팁: Ollama가 로컬 노트북에서 실행 중이라면 http://host.docker.internal:11434 (Docker Desktop) 또는 노트북의 LAN IP를 사용하세요.',
      cancel: '취소',
      ctxGatewayCacheLabel: '파일 digest 캐시',
      ctxGatewayCacheRefresh: '↻ 새로고침',
      ctxGatewayCacheClear: '🗑 캐시 비우기',
      ctxGatewayToolsLabel: '노출된 MCP 도구 (v0.18)',
      ctxGatewayClaudeLabel: 'Claude Code 자동 연결',
      ctxGatewayVerifyTitle: '확인 방법:',
      ctxGatewayVerifyStep1: 'VS Code 창 다시 로드 (위 "지금 다시 로드" 클릭했다면 완료).',
      ctxGatewayVerifyStep2: 'Claude Code 열기. 채팅창에 <code>/mcp</code> 입력 — <code>tierkit</code>이 녹색 상태로 표시되어야 함.',
      ctxGatewayVerifyStep3: '없으면 위 설정 경로를 클릭해 JSON 엔트리를 직접 확인.',
      labelBefore: '압축 전 (원본 입력)',
      labelAfter: '압축 후 (Claude로 전달)',
      cardLayout: '레이아웃',
      hintLayoutPanel: '메인 에디터 영역에서 Tierkit 열기 — 사이드바보다 훨씬 넓습니다. 태블릿이나 좁은 화면에서 유용.',
      openInPanel: '📱 메인 에디터에서 열기 (모바일 / 넓은 화면)',
      tkChatStop: '중지',
      tkToolCompress: '압축 → Claude Code (Enter)',
      tkToolPack: 'Context Pack 만들기…',
      tkToolFile: '파일 digest…',
      tkToolDiff: 'diff digest',
      tkToolDiffStaged: 'staged diff digest',
      descRequired: '설명을 입력하세요',
      secretKeyValueRequired: '키와 값을 모두 입력하세요',
      idAndModelRequired: 'id와 model 값을 모두 입력하세요',
      apiKeyEnvRequired: '값을 입력했다면 API key env 이름도 필요합니다',
      keyNameRequired: '키 이름을 입력하세요',
      valueRequired: '값을 입력하세요',
      savingsByClient: '클라이언트별',
      savingsByModel: 'Claude 모델별',
      noActivity: '아직 호출 기록 없음 — Roo/Cline/Continue 사용(또는 /v1/openai 호출) 시 여기 표시',
      noPlugins: '활성 플러그인 없음. + 새 플러그인으로 만들거나 디렉토리에서 install 하세요.',
      pluginIdLabel: '플러그인 id',
      modelLabel: '모델',
      providerLabel: '프로바이더',
      tierLabel: '계층',
      apiKeyLabel: 'API 키 env',
      baseUrlLabel: 'Base URL',
      idLabel: '프로파일 id',
      scopeLabel: '저장 위치',
      scopeWorkspace: '워크스페이스 (이 프로젝트만)',
      scopeUser: '사용자 (모든 폴더)',
      saveBtn: '저장',
      cancelBtn: '취소',
      added: '추가됨',
      enabled: '활성화됨',
      disabled: '비활성화됨',
      synced: '동기화 완료',
      newCreated: '플러그인 생성됨',
      failed: '실패',
      runTaskHint: 'Roo Code(또는 다른 연결 도구)에서 작업 실행 시 여기 표시됩니다',
      configHintWorkspace: '워크스페이스 설정',
      configHintUser: '사용자 설정',
      configHintBundled: '번들 기본값',
      activityFrom: '호출자',
      activityRedactions: '마스킹',
      activityBlocked: '차단됨',
      profilePromptName: '프로파일 id (예: claudeCustom)',
      pluginInstall: '+ 설치',
      pluginNameLabel: '이름',
      pluginDescLabel: '설명',
      freedomLabel: 'freedom',
      firstCommandLabel: '첫 명령어',
      generateBtn: '생성하기 →',
      installBtn: '설치',
      removeBtn: '삭제',
      bundledSamplesLabel: '번들 샘플',
      fromPathLabel: '경로로 설치',
      noBundledSamples: '번들 샘플 없음 (VS Code 확장에서만 노출).',
      installEnableBtn: '설치 + 활성화',
      emptyPluginsHint: '활성 플러그인이 없습니다. 아래에서 번들 샘플을 클릭하면 한 번에 설치 + 활성화됩니다 (Tierkit 프로젝트 설정 없으면 자동 생성).',
      deleteBtn: '삭제',
      confirmDeleteProfile: '"{id}" 프로파일을 삭제할까요?',
      deletedOk: '삭제됨',
      keyMissing: 'API 키 미설정',
      setKeyBtn: '키 입력',
      keySaved: 'API 키 저장됨',
      apiKeyValueLabel: 'API 키 값',
      apiKeyValuePlaceholder: 'sk-… 붙여넣기 (선택)',
      sectionApiKeys: 'API 키',
      keyExternal: '셸 env에서 설정됨 — 여기서 삭제 불가',
      confirmCloseForm: '열려있는 폼을 닫을까요?',
      forceEditLabel: '🪄 강제 편집',
      presetsLabel: '프리셋:',
      presetLocalCoder: '로컬-코더 우선',
      presetPrivateOnly: '비공개만',
      presetDefault: '기본값',
      presetApplied: '프리셋 적용됨',
      riskThresholdsLabel: '위험도 임계값',
      rtLocalFastHint: '작은 task → 빠른 로컬',
      rtLocalStrongHint: '일반 코딩 → 강한 로컬',
      rtPrivateRemoteHint: '복잡/민감 → private-remote',
      rtPublicCloudHint: '이 이상 → public-cloud (검토만)',
      thresholdsSaved: '임계값 저장됨',
      autoCeilingLabel: '자동 escalation 한계',
      autoCeilingSaved: '라우팅 정책 업데이트됨',
      goodAtLabel: '잘하는 작업 (콤마 구분)',
      goodAtPlaceholder: 'code-review, korean, summarize',
      moreOptionsLabel: '추가 옵션',
      escalatedNote: '상위 모델로 전환',
      qualityRejectedNote: '응답 품질 미달',
      genPluginBtn: '+ 설명으로 만들기',
      genDescribeLabel: '원하는 플러그인을 설명하세요',
      genDescribePlaceholder: '예: Python 프로젝트용 TDD-first 플러그인. 구현 전에 항상 실패하는 pytest 테스트를 먼저 작성하게 함. 작은 커밋 선호.',
      genButton: '생성 →',
      genGenerating: '생성 중… 10–30초 소요 (auto-routed)',
      genPreviewTitle: '미리보기',
      genGeneratedBy: '생성 모델',
      genRulesCount: '규칙',
      genInstallEnable: '설치 + 활성화',
      genInstallOnly: '설치만',
      genDiscard: '취소',
      genInstalled: '플러그인 설치됨',
      genRawOutputLabel: '마지막 원본 출력 (디버깅용)',
      enabledOn: '활성 · 클릭하여 비활성화',
      enabledOff: '비활성 · 클릭하여 활성화',
      enabledNowOn: '활성화됨',
      enabledNowOff: '비활성화됨',
      daemonMismatch: '데몬은 v{daemon} 표시. 확장은 v{expected} 기대. VS Code window를 reload 하세요 (Cmd+Shift+P → "Developer: Reload Window").',
      enableToggle: '활성/비활성 토글',
      discoverBtn: '🔍 Ollama 모델 자동 찾기',
      discoverDone: '발견됨',
      // v0.12.2 — UI validation flow (JS-accessed strings)
      hintNoRecentContexts:     '아직 컨텍스트가 없습니다.',
      hintShowingOfTotal:       '20개 표시 / 전체 {total}개 — 오래된 컨텍스트는 \`tierkit context show <id>\` (CLI)',
      hintCompareCancelled:     '비교가 취소되었습니다. provider 호출이 이미 시작된 경우 일부 토큰이 청구될 수 있습니다.',
      hintCompareFailedPartial: '압축 단계에서 비교가 실패했습니다. 베이스라인 응답은 저장되었지만 비교 결과는 기록되지 않았습니다.',
      hintNotesCounter:         '{count} / 2000자',
      hintNotesExceeded:        '메모는 2000자 이하여야 합니다.',
      errBuildFailed:           '빌드 실패',
      errCompareFailed:         '비교 실패',
      errCompareAlreadyRunning: '다른 비교가 이미 실행 중입니다. 끝나기를 기다리거나 다른 창에서 취소하세요.',
      errContextNotFound:       '컨텍스트를 찾을 수 없습니다 (디스크에서 삭제됐을 수 있습니다).',
      errDaemonOffline:         '데몬에 연결할 수 없습니다. \`tierkit runtime status\`로 확인하세요.',
      labelApiKeyHint:          '선택한 프로파일에 API 키가 필요할 수 있습니다. 인증 실패 시 provider 오류가 표시됩니다.',
      modalCompareTitle:        '베이스라인 vs 압축 비교',
      modalCompareDescription:  '프로파일 "{profile}"에서 2번의 유료 모델 호출이 발생합니다:',
      modalCompareCostCaveat:   '추정 입력 비용만 표시 — 출력 비용은 포함되지 않습니다. 호출 시작 후 취소해도 토큰이 청구될 수 있습니다.',
      statusBuilding:           '압축 컨텍스트 생성 중 (모델 호출 없음)…',
      labelCompareMetric:          '항목',
      labelCompareBaseline:        '베이스라인',
      labelCompareCompressed:      '압축',
      labelCompareSavings:         '절감',
      labelMetricInput:            '입력',
      labelMetricOutput:           '출력',
      labelMetricCost:             '비용',
      labelMetricLatency:          '지연',
      labelVerdictSame:            '동등 (same)',
      labelVerdictBetter:          '더 나음 (better)',
      labelVerdictWorse:           '못함 (worse)',
      labelVerdictUnusable:        '쓸 수 없음 (unusable)',
      labelVerdictMissingContext:  '맥락 누락',
      labelVerdictSaved:           '판정 저장됨',
      labelVerdictEditButton:      '판정 수정',
      labelCancelButton:           '취소',
      labelRetryCompareButton:     '비교 재시도',
      // v0.13 — viability badges + test button + pinned-no-fallback banner
      statusReady:                 '준비됨',
      statusDisabled:              '비활성',
      statusCliNotFound:           'CLI 없음',
      statusCliHealthcheckFailed:  'CLI 상태 확인 실패',
      statusMissingApiKey:         'API key 없음',
      statusOllamaUnreachable:     'Ollama 연결 불가',
      statusModelNotInstalled:     '모델 미설치',
      actionTest:                  '테스트',
      testConfirmBody:             '로컬 CLI 세션 또는 API key로 짧은 요청을 보냅니다. 구독 크레딧 또는 API 사용량이 발생할 수 있습니다.',
      testDisabledNote:            '현재 비활성 상태입니다. Test로 동작 여부만 확인할 수 있고, 활성화 전에는 라우팅에 사용되지 않습니다.',
      testRun:                     '실행',
      testCancel:                  '취소',
      bannerV013PinnedTitle:       'Tierkit v0.13에서 pinned 모델 동작이 바뀌었습니다.',
      bannerV013PinnedBody:        'Pinned 프로파일은 이제 조용히 local로 떨어지지 않고 명확한 에러를 반환합니다. fallback 라우팅이 필요하면 model:"auto"를 사용하세요.',
      bannerGotIt:                 '확인',
      warningStreamDegraded:       '스트림 강등',
      modelTestBadge:              '모델 테스트',
      // v0.14 — onboarding card
      onboardingTitle:              '설정',
      onboardingDetectOllama:       'Ollama',
      onboardingDetectClaude:       'claude CLI',
      onboardingDetectClaudeProfile:'claudeCode 활성화',
      onboardingDetectKey:          '\${name}',
      onboardingActionEnable:       '활성화',
      onboardingActionAddKey:       '키 추가',
      onboardingActionInstall:      '설치',
      onboardingQuickTest:          '빠른 점검 ▷',
      onboardingDismiss:            '확인했어요',
      onboardingTracePrefix:        '라우팅 흐름:',
      // v0.14 — secrets card
      cardSecrets:                  'API 키',
      secretEditBtn:                '편집',
      secretRemoveBtn:              '삭제',
      secretAddCustom:              '+ 사용자 키',
      secretSave:                   '저장',
      secretCancel:                 '취소',
      secretNotSet:                 '(미설정)',
      // v0.14 — profile editor
      profileEditBtn:               '편집',
      profileSaveBtn:               '저장',
      profileResetBundled:          '기본값으로',
      profileDeleteBtn:             '삭제',
      profileFieldRoles:            'roles',
      profileFieldGoodAt:           '잘하는 작업',
      profileFieldNotGoodAt:        '못하는 작업',
      profileChipAddPlaceholder:    '값 입력 후 Enter',
      profileResetConfirm:          '\${id}의 워크스페이스 오버라이드를 제거하고 기본값을 사용할까요?',
      profileDeleteConfirm:         '\${id} 프로파일을 삭제할까요? 되돌릴 수 없습니다.',
      // v0.14.2 — single-shot footer + timeout error
      singleShotFooter:             '📝 단발 planner 응답입니다. 멀티턴 파일 편집을 활성화하려면 Settings → API Keys 에서 키를 설정하세요.',
      timeoutError:                 'claudeCode가 \${seconds}초 후 타임아웃됐습니다. 더 짧은 프롬프트를 시도하거나 Settings → API Keys 에서 API 키를 설정하세요.',
      // v0.15 — MCP Bridge card + pending patches panel
      cardMcpBridge:                'Claude Code (MCP) 연결',
      mcpBridgeIntro:               'Claude Code / Claude Desktop 또는 MCP 호환 에이전트가 Tierkit의 게이트된 도구를 사용할 수 있도록 합니다.',
      mcpShowSnippet:               '설정 스니펫 보기',
      mcpCopySnippet:               '클립보드에 복사',
      cardMcpPatches:               '대기 중인 MCP 패치',
      mcpPatchApprove:              '승인',
      mcpPatchReject:               '거부',
      mcpPatchNoneYet:              '대기 중인 패치 없음',
      mcpPatchRiskHigh:             '위험',
      mcpPatchRiskMedium:           '주의',
    },
  };
  const i18n = RUNTIME[lang] || RUNTIME.en;

  // ── Tab nav ────────────────────────────────────────────────────────────────
  // Chat / Settings split. Webview localStorage is session-scoped but works for
  // intra-session persistence; HTTP mode persists across page loads.
  const TAB_STORAGE_KEY = 'tierkit.activeTab';
  function loadActiveTab() {
    try { return localStorage.getItem(TAB_STORAGE_KEY); } catch { return null; }
  }
  function saveActiveTab(name) {
    try { localStorage.setItem(TAB_STORAGE_KEY, name); } catch { /* ignore */ }
  }
  function setActiveTab(name) {
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.dataset.tabPanel === name);
    });
    saveActiveTab(name);
  }
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.addEventListener('click', () => setActiveTab(b.dataset.tab));
  });
  // ── State + helpers ────────────────────────────────────────────────────────
  const BASE = (typeof window !== 'undefined' && window.__TIERKIT_BASE_URL__) || '';
  ${TRANSPORT_INLINE_JS}
  const transport = (typeof window !== 'undefined' && window.__TIERKIT_HOST__ === 'vscode')
    ? createVsCodeTransport()
    : createHttpTransport(BASE);
  // VS Code postMessage handle. createVsCodeTransport already called acquireVsCodeApi
  // (and the webview API only permits ONE call per page — a second call throws). So we
  // pick the handle off the transport rather than acquiring it again. null in browser mode.
  const vsApi = transport.vsApi;
  const $ = (id) => document.getElementById(id);
  // Capture the initial agent-empty placeholder HTML so newChatSession can
  // restore it without depending on the locale dictionary (which only has
  // the Korean translation — the English content lives in the static HTML).
  const TK_INITIAL_AGENT_EMPTY_HTML = (() => {
    if (typeof document.querySelector !== 'function') return '';
    const node = document.querySelector('#agent-thread .agent-empty');
    return node ? node.innerHTML : '';
  })();
  // v0.14: on first activation (seenOnboarding !== true), force tab to 'chat'.
  // This is resolved later after config is loaded in the main init block.
  // NOTE: must run AFTER $ is declared so loadChatSessions() can use it.
  setActiveTab(loadActiveTab() || 'chat');
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmtCost(n) { return '$' + (Number(n) || 0).toFixed(4); }
  // v0.12: short-form token count formatter — "1.2k", "850", "3.4M".
  function formatK(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000) return (v / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (v >= 1_000)     return (v / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
    return String(Math.round(v));
  }
  // v0.12: mirror of effectivePaymentModel(profile) in packages/core/src/model/ModelProfile.ts.
  // Kept inline because the GUI script can't import TS.
  function computeEffectivePaymentModel(profile) {
    if (!profile) return 'per-token';
    if (profile.paymentModel) return profile.paymentModel;
    switch (profile.kind) {
      case 'local-device':   return 'free';
      case 'private-remote': return 'free';
      case 'public-cloud':   return 'per-token';
    }
    return 'per-token';
  }
  function fmtTime(iso) {
    try {
      const d = new Date(iso);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      return hh + ':' + mm + ':' + ss;
    } catch { return iso; }
  }
  async function jget(p) {
    const r = await transport.request(p, { method: 'GET' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.data;
  }
  async function jpost(p, b) {
    const r = await transport.request(p, { method: 'POST', body: b });
    if (!r.ok && r.status !== 400 && r.status !== 404) throw new Error(r.data?.error || r.data?.message || ('HTTP ' + r.status));
    return { ok: r.ok, status: r.status, data: r.data };
  }

  /**
   * POST with text/event-stream response. Parses each \\n\\n-delimited block as
   * one SSE event (single-line JSON \`data:\` payloads only — see spec §3).
   * Calls the matching handler per event name. Aborts on supplied AbortSignal.
   *
   * NOTE: Uses raw fetch() rather than the transport abstraction because the
   * transport.stream() helper drops SSE event names (yields only data: payloads).
   * v0.12.2 compare needs to distinguish phase / delta / side-result / compare-done /
   * error event names. In VS Code webview mode raw loopback fetch may be blocked
   * by the sandbox; the compare flow will surface that as 'fetch-failed'.
   */
  async function streamSsePost(url, body, handlers, abortSignal) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        body: JSON.stringify(body),
        signal: abortSignal,
      });
    } catch (err) {
      if (err.name === 'AbortError') return;
      handlers.onError && handlers.onError({ code: 'fetch-failed', message: String(err.message || err) });
      return;
    }
    if (!res.ok) {
      let err;
      try { err = await res.json(); } catch { err = { code: 'http-' + res.status, message: res.statusText }; }
      handlers.onError && handlers.onError(err);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      // Normalize CRLF → LF so injected proxies don't break the parser
      buffer += decoder.decode(value, { stream: true }).replace(/\\r\\n/g, '\\n');
      let idx;
      while ((idx = buffer.indexOf('\\n\\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (raw.startsWith(':')) continue;          // SSE comment / keepalive
        const evt = parseSseChunk(raw);
        switch (evt.event) {
          case 'phase':        handlers.onPhase        && handlers.onPhase(evt.data);        break;
          case 'delta':        handlers.onDelta        && handlers.onDelta(evt.data);        break;
          case 'side-result':  handlers.onSideResult   && handlers.onSideResult(evt.data);   break;
          case 'compare-done': handlers.onCompareDone  && handlers.onCompareDone(evt.data);  break;
          case 'error':        handlers.onError        && handlers.onError(evt.data);        break;
        }
      }
    }
  }

  function parseSseChunk(raw) {
    const lines = raw.split('\\n');
    let event = 'message', data = '';
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    return { event, data: data ? JSON.parse(data) : undefined };
  }

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

  // VS Code webviews disable window.confirm() (returns undefined / silently no-ops). Using
  // the bare browser confirm() in a webview made every "Delete?" click silently abort —
  // the early-return on a falsy result fired and the action never reached the daemon. Our
  // safeConfirm shows the native dialog in plain-browser mode AND lets the action proceed
  // when confirm() isn't usable. Trade-off: VS Code users get effectively one-click delete
  // (they already clicked an explicit Delete button — that IS the confirmation).
  function safeConfirm(msg) {
    try {
      if (typeof window.confirm !== 'function') return true;
      const r = window.confirm(msg);
      if (typeof r === 'boolean') return r;
      return true;
    } catch {
      return true;
    }
  }

  // ── Card: Connected tools ──────────────────────────────────────────────────
  async function refreshTools() {
    try {
      const r = await jget('/v1/connections');
      const list = r.connections || [];
      const root = $('tools-list');
      root.innerHTML = '';
      for (const c of list) {
        const row = document.createElement('div');
        row.className = 'row';
        const statusPill = c.routed
          ? '<span class="pill pill-ok">' + escapeHtml(i18n.routed) + '</span>'
          : c.present
            ? '<span class="pill pill-warn">' + escapeHtml(i18n.present) + '</span>'
            : '<span class="pill pill-dim">' + escapeHtml(i18n.notPresent) + '</span>';
        const modelHint = c.modelId ? '<span class="dim mono">model: ' + escapeHtml(c.modelId) + '</span>' : '';
        const btnLabel = c.routed ? i18n.reconnect : i18n.connect;
        row.innerHTML =
          '<div class="col-grow">' +
            '<div><b>' + escapeHtml(c.tool) + '</b> ' + statusPill + '</div>' +
            (modelHint ? '<div style="margin-top:2px">' + modelHint + '</div>' : '') +
          '</div>' +
          '<button class="tiny" data-action="connect" data-tool="' + escapeHtml(c.tool) + '">' + escapeHtml(btnLabel) + '</button>';
        root.appendChild(row);
      }
      root.querySelectorAll('button[data-action="connect"]').forEach((b) => {
        b.onclick = async () => {
          const tool = b.getAttribute('data-tool');
          b.disabled = true;
          try {
            const resp = await jpost('/v1/connect', { tool });
            if (!resp.ok) { toast((resp.data?.code || 'err') + ': ' + (resp.data?.message || i18n.failed), 'err'); return; }
            toast(tool + ' ✓ ' + i18n.routed, 'ok');
            await refreshTools();
          } finally { b.disabled = false; }
        };
      });
    } catch (e) {
      $('tools-list').innerHTML = '<div class="empty">' + escapeHtml(e.message) + '</div>';
    }
  }

  // ── Card: Plugins ──────────────────────────────────────────────────────────
  // ── Plugin install/enable helpers ──────────────────────────────────────────
  // Enable needs tierkit.config.json to exist (lifecycle usecase throws "no-config" without
  // it). The CLI flow tells the user to run "tierkit init" first; in the GUI we auto-
  // initialize and retry once. Init is idempotent and safe (just writes default config if
  // missing) — no destructive surprises.
  async function safeEnable(pluginId) {
    let resp = await jpost('/v1/plugins/enable', { pluginId });
    if (!resp.ok && (resp.data?.code === 'no-config' || /no-config/.test(resp.data?.message || ''))) {
      const initResp = await jpost('/v1/config/init', {});
      if (initResp.ok) resp = await jpost('/v1/plugins/enable', { pluginId });
    }
    return resp;
  }
  // Single-click flow: install at a path, then immediately enable it (auto-init if needed).
  // Used by the empty-state bundled-sample rows AND by the + Install dropdown.
  async function installAndEnable(pluginPath) {
    const installResp = await jpost('/v1/plugins/install', { pluginPath });
    if (!installResp.ok) {
      toast(installResp.data?.message || i18n.failed, 'err');
      return false;
    }
    const pluginId = installResp.data?.pluginId || pluginPath;
    const enableResp = await safeEnable(pluginId);
    if (!enableResp.ok) {
      toast(pluginId + ': ' + (enableResp.data?.message || i18n.failed), 'err');
      await Promise.all([refreshPlugins(), refreshTools()]);
      return false;
    }
    toast(pluginId + ' ✓ ' + (lang === 'ko' ? '설치 및 활성화됨' : 'installed + enabled'), 'ok');
    await Promise.all([refreshPlugins(), refreshTools()]);
    return true;
  }

  async function refreshPlugins() {
    try {
      const r = await jget('/v1/plugins');
      const list = r.plugins || [];
      const root = $('plugins-list');
      root.innerHTML = '';
      if (list.length === 0) {
        // Empty state — surface bundled samples right here so users don't have to hunt for
        // the + Install dropdown. Each row installs AND enables in one click.
        const samples = (typeof window !== 'undefined' && Array.isArray(window.__TIERKIT_SAMPLES__)) ? window.__TIERKIT_SAMPLES__ : [];
        if (samples.length === 0) {
          root.innerHTML = '<div class="empty">' + escapeHtml(i18n.noPlugins) + '</div>';
          return;
        }
        const empty = document.createElement('div');
        empty.innerHTML =
          '<div class="dim" style="font-size:11px;margin-bottom:6px">' + escapeHtml(i18n.emptyPluginsHint) + '</div>';
        for (const s of samples) {
          const row = document.createElement('div');
          row.className = 'row dense';
          row.innerHTML =
            '<div class="col-grow">' +
              '<div><b>' + escapeHtml(s.id) + '</b>' +
                (s.freedom ? ' <span class="pill pill-accent" style="font-size:9px">' + escapeHtml(s.freedom) + '</span>' : '') +
              '</div>' +
              (s.description ? '<div class="dim" style="font-size:10.5px;margin-top:1px">' + escapeHtml(s.description) + '</div>' : '') +
            '</div>' +
            '<button class="tiny primary" data-action="install-enable" data-path="' + escapeHtml(s.path) + '">' + escapeHtml(i18n.installEnableBtn) + '</button>';
          empty.appendChild(row);
        }
        root.appendChild(empty);
        empty.querySelectorAll('button[data-action="install-enable"]').forEach((b) => {
          b.onclick = async () => {
            b.disabled = true;
            try { await installAndEnable(b.getAttribute('data-path')); }
            finally { b.disabled = false; }
          };
        });
        return;
      }
      for (const p of list) {
        const row = document.createElement('div');
        row.className = 'row dense';
        // ON/OFF toggle switch — clearer than two separate Enable/Disable text buttons.
        // The role + aria-checked make it screen-reader friendly. data-state drives the
        // visual (CSS rules below in <style>).
        const toggleHtml =
          '<button class="plugin-toggle" role="switch" aria-checked="' + (p.enabled ? 'true' : 'false') +
            '" data-action="toggle" data-id="' + escapeHtml(p.id) +
            '" data-state="' + (p.enabled ? 'on' : 'off') +
            '" title="' + escapeHtml(p.enabled ? i18n.disable : i18n.enable) + '">' +
            '<span class="plugin-toggle-knob"></span>' +
          '</button>';
        row.innerHTML =
          '<div class="col-grow"><div><b>' + escapeHtml(p.id) + '</b>' +
            (p.manifest?.freedom?.level ? ' <span class="pill pill-accent" style="font-size:10px">' + escapeHtml(p.manifest.freedom.level) + '</span>' : '') +
            '</div>' +
            (p.manifest?.description ? '<div class="dim" style="margin-top:2px">' + escapeHtml(p.manifest.description) + '</div>' : '') +
          '</div>' +
          toggleHtml +
          '<button class="tiny" data-action="remove" data-id="' + escapeHtml(p.id) + '" title="' + escapeHtml(i18n.removeBtn) + '">✕</button>';
        root.appendChild(row);
      }
      root.querySelectorAll('button[data-action="toggle"]').forEach((b) => {
        b.onclick = async () => {
          const id = b.getAttribute('data-id');
          const currentlyOn = b.getAttribute('data-state') === 'on';
          b.disabled = true;
          try {
            const resp = currentlyOn
              ? await jpost('/v1/plugins/disable', { pluginId: id })
              : await safeEnable(id);
            if (!resp.ok) { toast(resp.data?.message || i18n.failed, 'err'); return; }
            toast(id + ' ✓ ' + (currentlyOn ? i18n.disabled : i18n.enabled), 'ok');
            await Promise.all([refreshPlugins(), refreshTools()]);
          } finally { b.disabled = false; }
        };
      });
      root.querySelectorAll('button[data-action="remove"]').forEach((b) => {
        b.onclick = async () => {
          const id = b.getAttribute('data-id');
          // safeConfirm: native confirm() is blocked in VS Code webviews. See its definition.
          if (!safeConfirm((lang === 'ko' ? '플러그인을 삭제할까요? ' : 'Remove plugin? ') + id)) return;
          b.disabled = true;
          try {
            const resp = await jpost('/v1/plugins/remove', { pluginId: id });
            if (!resp.ok) { toast(resp.data?.message || i18n.failed, 'err'); return; }
            toast(id + ' ✓ ' + (lang === 'ko' ? '삭제됨' : 'removed'), 'ok');
            await Promise.all([refreshPlugins(), refreshTools()]);
          } finally { b.disabled = false; }
        };
      });
    } catch (e) {
      $('plugins-list').innerHTML = '<div class="empty">' + escapeHtml(e.message) + '</div>';
    }
  }

  $('btn-plugin-new').onclick = () => {
    const host = $('plugin-new-form');
    // Hide the install form if it's open.
    const installHost = $('plugin-install-form');
    installHost.style.display = 'none'; installHost.innerHTML = '';
    host.style.display = 'block';
    host.innerHTML =
      '<div class="inline-form">' +
        '<div class="form-grid">' +
          '<label>' + escapeHtml(i18n.pluginIdLabel) + '</label>' +
          '<input id="pn-id" placeholder="my-team-rules" />' +
          '<label>' + escapeHtml(i18n.pluginNameLabel) + '</label>' +
          '<input id="pn-name" placeholder="" />' +
          '<label>' + escapeHtml(i18n.pluginDescLabel) + '</label>' +
          '<input id="pn-desc" placeholder="" />' +
          '<label>' + escapeHtml(i18n.freedomLabel) + '</label>' +
          '<select id="pn-freedom">' +
            '<option value="free">free</option>' +
            '<option value="guided" selected>guided</option>' +
            '<option value="balanced">balanced</option>' +
            '<option value="strict">strict</option>' +
          '</select>' +
          '<label>' + escapeHtml(i18n.firstCommandLabel) + '</label>' +
          '<input id="pn-cmd" placeholder="review" />' +
        '</div>' +
        '<div class="actions">' +
          '<button id="pn-cancel">' + escapeHtml(i18n.cancelBtn) + '</button>' +
          '<button id="pn-save" class="primary">' + escapeHtml(i18n.generateBtn) + '</button>' +
        '</div>' +
      '</div>';
    $('pn-cancel').onclick = () => { host.style.display = 'none'; host.innerHTML = ''; };
    $('pn-save').onclick = async () => {
      const id = ($('pn-id').value || '').trim();
      if (!id) { toast(i18n.pluginIdLabel + ' ?', 'err'); return; }
      const body = { id };
      const name = ($('pn-name').value || '').trim();
      const description = ($('pn-desc').value || '').trim();
      const freedomLevel = $('pn-freedom').value;
      const firstCommand = ($('pn-cmd').value || '').trim();
      if (name) body.name = name;
      if (description) body.description = description;
      if (freedomLevel) body.freedomLevel = freedomLevel;
      if (firstCommand) body.firstCommand = firstCommand;
      const resp = await jpost('/v1/plugins/new', body);
      if (!resp.ok) { toast(resp.data?.message || i18n.failed, 'err'); return; }
      toast(id + ' ✓ ' + i18n.newCreated, 'ok');
      // If we're in VS Code, offer to open the new plugin's manifest in the editor.
      const pluginDir = resp.data?.pluginDir;
      if (vsApi && pluginDir) {
        const manifestPath = pluginDir + '/tierkit.plugin.json';
        // Inline action button in the toast area — append to the panel as a follow-up note.
        const note = document.createElement('div');
        note.className = 'empty';
        note.style.cssText = 'font-style:normal;text-align:left;padding:8px;background:var(--bg-input);border-radius:6px;margin-top:6px';
        const openBtn = document.createElement('button');
        openBtn.className = 'tiny primary';
        openBtn.textContent = lang === 'ko' ? '에디터에서 열기' : 'Open in editor';
        openBtn.style.marginLeft = '8px';
        openBtn.onclick = () => vsApi.postMessage({ type: 'openFile', path: manifestPath });
        note.textContent = (lang === 'ko' ? '플러그인 생성: ' : 'Created: ') + pluginDir;
        note.appendChild(openBtn);
        host.appendChild(note);
        // Keep the form host visible until the user dismisses; just hide the inputs.
        const inline = host.querySelector('.inline-form');
        if (inline) inline.style.display = 'none';
      } else {
        host.style.display = 'none'; host.innerHTML = '';
      }
      await refreshPlugins();
    };
  };

  // ── + Describe & generate: LLM-generated plugin flow ───────────────────────
  $('btn-plugin-gen').onclick = () => openGeneratePluginForm();

  function openGeneratePluginForm() {
    const host = $('plugin-new-form');
    if (!host) return;
    host.style.display = 'block';
    host.innerHTML =
      '<div class="inline-form">' +
        '<div style="margin-bottom:6px">' + escapeHtml(i18n.genDescribeLabel) + '</div>' +
        '<textarea id="gen-desc" rows="5" style="width:100%;font-family:inherit;font-size:12px" placeholder="' + escapeHtml(i18n.genDescribePlaceholder) + '"></textarea>' +
        '<div class="actions">' +
          '<button id="gen-cancel">' + escapeHtml(i18n.cancelBtn) + '</button>' +
          '<button id="gen-go" class="primary">' + escapeHtml(i18n.genButton) + '</button>' +
        '</div>' +
      '</div>';
    $('gen-cancel').onclick = () => { host.innerHTML = ''; host.style.display = 'none'; };
    $('gen-go').onclick = async () => {
      const desc = ($('gen-desc').value || '').trim();
      if (!desc) { toast(i18n.descRequired || 'description required', 'err'); return; }
      host.innerHTML = '<div class="empty">' + escapeHtml(i18n.genGenerating) + '</div>';
      try {
        const resp = await jpost('/v1/plugins/generate', { description: desc });
        if (!resp.ok) {
          const code = (resp.data && resp.data.code) ? resp.data.code : 'error';
          const msg = (resp.data && resp.data.message) ? resp.data.message : 'failed';
          const raw = (resp.data && resp.data.rawOutput) ? resp.data.rawOutput : '';
          host.innerHTML =
            '<div class="empty" style="color:var(--warn)">' + escapeHtml(code + ': ' + msg) + '</div>' +
            (raw ? '<details><summary>' + escapeHtml(i18n.genRawOutputLabel) + '</summary><pre style="white-space:pre-wrap;font-size:11px">' + escapeHtml(raw) + '</pre></details>' : '') +
            '<div class="actions"><button id="gen-back">' + escapeHtml(i18n.cancelBtn) + '</button></div>';
          $('gen-back').onclick = () => { host.innerHTML = ''; host.style.display = 'none'; };
          return;
        }
        renderGenPreview(host, resp.data);
      } catch (e) {
        host.innerHTML = '<div class="empty" style="color:var(--warn)">' + escapeHtml(e.message || 'error') + '</div>';
      }
    };
  }

  function renderGenPreview(host, data) {
    const m = data.manifest || {};
    const rules = data.rules || [];
    const meta =
      'id: ' + escapeHtml(m.id || '?') + '<br>' +
      'name: ' + escapeHtml(m.name || '?') + '<br>' +
      'version: ' + escapeHtml(m.version || '?') + '<br>' +
      'freedom: ' + escapeHtml(m.freedom && m.freedom.level ? m.freedom.level : '?');
    let rulesHtml = '';
    for (const r of rules) {
      rulesHtml +=
        '<details>' +
          '<summary>' + escapeHtml(r.filename) + ' <span class="dim">(' + r.content.length + ' chars)</span></summary>' +
          '<pre style="white-space:pre-wrap;font-size:11px">' + escapeHtml(r.content) + '</pre>' +
        '</details>';
    }
    host.innerHTML =
      '<div class="inline-form">' +
        '<div style="font-weight:600;margin-bottom:6px">' + escapeHtml(i18n.genPreviewTitle) + '</div>' +
        '<div class="mono" style="font-size:11px;margin-bottom:8px">' + meta + '</div>' +
        '<div class="dim" style="font-size:11px;margin-bottom:6px">' + escapeHtml(i18n.genRulesCount) + ' (' + rules.length + ')</div>' +
        rulesHtml +
        '<div class="dim" style="font-size:11px;margin-top:8px">' + escapeHtml(i18n.genGeneratedBy) + ' <span class="mono">' + escapeHtml(data.modelUsed || '?') + '</span></div>' +
        '<div class="actions">' +
          '<button id="gen-discard">' + escapeHtml(i18n.genDiscard) + '</button>' +
          '<button id="gen-install-only">' + escapeHtml(i18n.genInstallOnly) + '</button>' +
          '<button id="gen-install-enable" class="primary">' + escapeHtml(i18n.genInstallEnable) + '</button>' +
        '</div>' +
      '</div>';
    $('gen-discard').onclick = () => { host.innerHTML = ''; host.style.display = 'none'; };
    $('gen-install-only').onclick = () => installDraft(host, data.draftId, false);
    $('gen-install-enable').onclick = () => installDraft(host, data.draftId, true);
  }

  async function installDraft(host, draftId, enable) {
    const resp = await jpost('/v1/plugins/generate/install', { draftId: draftId, enable: enable });
    if (!resp.ok) {
      toast((resp.data && resp.data.message) || i18n.failed, 'err');
      return;
    }
    toast(resp.data.pluginId + ' ✓ ' + i18n.genInstalled, 'ok');
    host.innerHTML = '';
    host.style.display = 'none';
    if (typeof refreshPlugins === 'function') await refreshPlugins();
  }

  // ── + Install: bundled samples dropdown + path input ────────────────────────
  $('btn-plugin-install').onclick = () => {
    const newHost = $('plugin-new-form');
    newHost.style.display = 'none'; newHost.innerHTML = '';
    const host = $('plugin-install-form');
    if (host.style.display === 'block') {
      host.style.display = 'none'; host.innerHTML = '';
      return;
    }
    host.style.display = 'block';
    const samples = (typeof window !== 'undefined' && Array.isArray(window.__TIERKIT_SAMPLES__)) ? window.__TIERKIT_SAMPLES__ : [];
    const bundledRows = samples.length === 0
      ? '<div class="empty" style="font-size:11px;padding:6px 0">' + escapeHtml(i18n.noBundledSamples) + '</div>'
      : samples.map((s) =>
          '<div class="row dense" style="font-size:12px">' +
            '<div class="col-grow">' +
              '<div><b>' + escapeHtml(s.id) + '</b>' +
                (s.freedom ? ' <span class="pill pill-accent" style="font-size:9px">' + escapeHtml(s.freedom) + '</span>' : '') +
              '</div>' +
              (s.description ? '<div class="dim" style="font-size:10.5px;margin-top:1px">' + escapeHtml(s.description) + '</div>' : '') +
            '</div>' +
            '<button class="tiny primary" data-action="install-bundled" data-path="' + escapeHtml(s.path) + '" data-id="' + escapeHtml(s.id) + '">' + escapeHtml(i18n.installBtn) + '</button>' +
          '</div>',
        ).join('');
    host.innerHTML =
      '<div class="inline-form">' +
        '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--fg-dim);margin-bottom:4px">' +
          escapeHtml(i18n.bundledSamplesLabel) +
        '</div>' +
        bundledRows +
        '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:var(--fg-dim);margin:10px 0 4px">' +
          escapeHtml(i18n.fromPathLabel) +
        '</div>' +
        '<div style="display:flex;gap:6px">' +
          '<input id="pi-path" placeholder="/absolute/path/to/plugin-dir" style="flex:1" />' +
          '<button id="pi-install" class="primary">' + escapeHtml(i18n.installBtn) + '</button>' +
        '</div>' +
        '<div class="actions" style="margin-top:8px">' +
          '<button id="pi-cancel">' + escapeHtml(i18n.cancelBtn) + '</button>' +
        '</div>' +
      '</div>';
    host.querySelectorAll('button[data-action="install-bundled"]').forEach((b) => {
      b.onclick = async () => {
        const pluginPath = b.getAttribute('data-path');
        b.disabled = true;
        try { if (await installAndEnable(pluginPath)) { host.style.display = 'none'; host.innerHTML = ''; } }
        finally { b.disabled = false; }
      };
    });
    $('pi-install').onclick = async () => {
      const p = ($('pi-path').value || '').trim();
      if (!p) return;
      const btn = $('pi-install'); btn.disabled = true;
      try { if (await installAndEnable(p)) { host.style.display = 'none'; host.innerHTML = ''; } }
      finally { btn.disabled = false; }
    };
    $('pi-cancel').onclick = () => { host.style.display = 'none'; host.innerHTML = ''; };
  };

  $('btn-sync').onclick = async () => {
    const btn = $('btn-sync');
    btn.disabled = true;
    try {
      const r = await jpost('/v1/plugins/sync', {});
      if (!r.ok) { toast(r.data?.message || i18n.failed, 'err'); return; }
      const d = r.data || { synced: [] };
      const count = (d.synced || []).reduce((s, x) => s + (x.filesWritten || 0), 0);
      toast(i18n.synced + ' (' + count + ' files)', 'ok');
      await refreshTools();
    } finally { btn.disabled = false; }
  };

  // ── v0.17: Tool-result envelope rendering ────────────────────────────────
  // Every long-output tool returns tool-result-envelope.v1 JSON. The agent's
  // tool_result handler used to dump the raw JSON into the card body; now it
  // routes through ENVELOPE_RENDERERS based on env.tool, falling back to a
  // generic success card and ultimately to a raw <pre> for non-envelope
  // results. Failure envelopes (ok:false) share a single failure card with a
  // hint table keyed by error.code (16 codes, plus unknown).

  // Dispatch table maps both Agent-side names (read_file, ...) and MCP-side
  // (tierkit.codebase_search, ...) to the same renderer.
  function envelopeRenderers() {
    return {
      'read_file':                renderReadFileEnvelope,
      'tierkit.read_file':        renderReadFileEnvelope,
      'list_files':               renderListFilesEnvelope,
      'tierkit.list_files':       renderListFilesEnvelope,
      'search_files':             renderSearchFilesEnvelope,
      'codebase_search':          renderSearchFilesEnvelope,
      'tierkit.codebase_search':  renderSearchFilesEnvelope,
      'execute_command':          renderRunCommandEnvelope,
      'tierkit.run_command':      renderRunCommandEnvelope,
    };
  }

  function isEnvelopeV1(payload) {
    return payload && typeof payload === 'object' && payload.version === 'tool-result-envelope.v1';
  }

  // 16-code hint table — covers every v0.17 envelope error code that has a
  // user-actionable hint. Unknown codes show the badge but no hint row.
  const FAILURE_HINTS = {
    'not-a-file':              'Pass a regular file path, not a directory',
    'not-a-directory':         'Pass a directory path, not a file',
    'path-escape':             'Path must stay within the workspace',
    'outside-workspace':       'Path must stay within the workspace',
    'ignored-path':            'This path is on the ignore/denylist',
    'sensitive-file-blocked':  'This path matches a sensitive-file pattern',
    'invalid-args':            'Check the required arguments',
    'invalid-query':           'Pattern is empty or invalid regex',
    'cursor-invalid':          'Re-issue the read without cursor',
    'stale-cursor':            'File changed; re-read from beginning (no cursor)',
    'payload-corrupt':         'Patch payload sha256 mismatch — re-propose the patch',
    'payload-missing':         'Patch payload sidecar missing — re-propose the patch',
    'approval-required':       'Run the command yourself in your shell',
    'command-timeout':         'Increase transport.timeoutMs or narrow the command',
    'spawn-failed':            'Verify the CLI binary is on PATH and executable',
    'dangerous-command-blocked': 'Tierkit policy blocked: review and run manually if intended',
  };

  function iconForTool(tool) {
    if (!tool) return '🔧';
    if (tool.endsWith('read_file')) return '📄';
    if (tool.endsWith('list_files')) return '📁';
    if (tool.endsWith('search_files') || tool.endsWith('codebase_search')) return '🔍';
    if (tool.endsWith('execute_command') || tool.endsWith('run_command')) return '⚡';
    return '🔧';
  }

  function escapeRegex(s) {
    return s.replace(/[.*+?^\${}()|[\]\\]/g, '\\\\$&');
  }

  function fmtBytes(n) {
    if (n == null || !Number.isFinite(n)) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function renderEnvelopeFailure(env) {
    const icon = iconForTool(env.tool);
    const code = (env.error && env.error.code) || 'unknown-error';
    const message = (env.error && env.error.message) || '(no message)';
    const hint = FAILURE_HINTS[code];
    return [
      '<div class="env-card env-failure">',
      '  <div class="env-header">' + icon + ' <strong>' + escapeHtml(env.tool || '?') + '</strong>' +
        ' <span class="env-badge badge-fail">❌ ' + escapeHtml(code) + '</span></div>',
      '  <div class="env-body env-error-message">' + escapeHtml(message) + '</div>',
      hint ? '  <div class="env-hint">Hint: ' + escapeHtml(hint) + '</div>' : '',
      '</div>',
    ].join('\\n');
  }

  function renderEnvelopeSuccessGeneric(env) {
    const icon = iconForTool(env.tool);
    return [
      '<div class="env-card">',
      '  <div class="env-header">' + icon + ' <strong>' + escapeHtml(env.tool || '?') + '</strong>' +
        ' <span class="env-badge badge-ok">ok</span></div>',
      '  <pre class="env-body env-code">' + escapeHtml(JSON.stringify(env.data, null, 2)) + '</pre>',
      '</div>',
    ].join('\\n');
  }

  function renderReadFileEnvelope(env) {
    const icon = iconForTool(env.tool);
    const data = env.data || {};
    const range = env.range || {};
    const size = env.size || {};

    const headerBadges = [];
    if (env.truncated) {
      const moreLines = (size.remainingLines != null) ? size.remainingLines : '?';
      headerBadges.push('<span class="env-badge badge-truncated">truncated · ' + escapeHtml(String(moreLines)) + ' more</span>');
    } else {
      const total = (size.totalLines != null) ? size.totalLines : (size.linesReturned != null ? size.linesReturned : '?');
      headerBadges.push('<span class="env-badge badge-ok">ok · ' + escapeHtml(String(total)) + ' lines</span>');
    }
    if (env.warnings && env.warnings.length > 0) {
      headerBadges.push('<span class="env-badge badge-warn">⚠ warning</span>');
    }

    const startLine = (range.startLine != null) ? range.startLine : 1;
    const lines = String(data.content == null ? '' : data.content).split('\\n');
    const numbered = lines.map((line, i) => {
      const lno = String(startLine + i).padStart(4, ' ');
      return lno + '  ' + escapeHtml(line);
    }).join('\\n');

    const footerParts = [];
    if (env.next && env.next.cursor) {
      footerParts.push(
        '<div class="env-footer">' +
          'Next: read_file(cursor=' + escapeHtml(String(env.next.cursor).slice(0, 8)) + '…)' +
          ' <button class="copy-cursor-btn" data-cursor="' + escapeHtml(env.next.cursor) + '">Copy cursor</button>' +
        '</div>'
      );
    }
    if (env.warnings) {
      for (const w of env.warnings) {
        footerParts.push('<div class="env-warning">⚠ ' + escapeHtml(String(w)) + '</div>');
      }
    }

    return [
      '<div class="env-card">',
      '  <div class="env-header">' + icon + ' <strong>read_file</strong>' +
        ' · <span class="env-key-arg">' + escapeHtml(String(data.path == null ? '?' : data.path)) + '</span> ' +
        headerBadges.join(' ') +
      '</div>',
      '  <pre class="env-body env-code">' + numbered + '</pre>',
      footerParts.join('\\n'),
      '</div>',
    ].join('\\n');
  }
  function renderListFilesEnvelope(env) {
    const icon = iconForTool(env.tool);
    const data = env.data || {};
    const size = env.size || {};
    const entries = Array.isArray(data.entries) ? data.entries : [];

    const headerBadges = [];
    if (env.truncated) {
      const total = (size.totalLines != null) ? size.totalLines : '?';
      headerBadges.push('<span class="env-badge badge-truncated">' + entries.length + ' of ' + escapeHtml(String(total)) + ' entries</span>');
    } else {
      headerBadges.push('<span class="env-badge badge-ok">' + entries.length + ' entries</span>');
    }

    const treeHtml = entries.map((e) => {
      const isDir = e.kind === 'dir';
      const ico = isDir ? '📁' : '📄';
      const name = e.relPath != null ? e.relPath : (e.name != null ? e.name : '?');
      return ico + ' ' + escapeHtml(String(name)) + (isDir ? '/' : '');
    }).join('\\n');

    const footer = (env.next && env.next.cursor)
      ? '<div class="env-footer">Next: list_files(cursor=' + escapeHtml(String(env.next.cursor).slice(0, 8)) + '…) ' +
        '<button class="copy-cursor-btn" data-cursor="' + escapeHtml(env.next.cursor) + '">Copy cursor</button></div>'
      : '';

    return [
      '<div class="env-card">',
      '  <div class="env-header">' + icon + ' <strong>list_files</strong>' +
        ' · <span class="env-key-arg">' + escapeHtml(String(data.path == null ? '?' : data.path)) + '</span> ' +
        headerBadges.join(' ') +
      '</div>',
      '  <pre class="env-body env-tree">' + treeHtml + '</pre>',
      footer,
      '</div>',
    ].join('\\n');
  }

  function renderSearchFilesEnvelope(env) {
    const icon = iconForTool(env.tool);
    const data = env.data || {};
    const matches = Array.isArray(data.matches) ? data.matches : [];

    const headerBadges = [];
    if (env.truncated) {
      const total = (env.size && env.size.totalLines != null) ? env.size.totalLines : '?';
      headerBadges.push('<span class="env-badge badge-truncated">' + matches.length + ' of ' + escapeHtml(String(total)) + ' matches</span>');
    } else {
      headerBadges.push('<span class="env-badge badge-ok">' + matches.length + ' matches</span>');
    }
    if (env.warnings && env.warnings.length > 0) {
      headerBadges.push('<span class="env-badge badge-warn">⚠</span>');
    }

    const query = String(data.pattern == null ? (data.query == null ? '' : data.query) : data.pattern);
    let queryRe = null;
    try {
      if (query) queryRe = new RegExp(escapeRegex(query), 'gi');
    } catch { queryRe = null; }
    const highlight = (text) => {
      const escaped = escapeHtml(text);
      return queryRe ? escaped.replace(queryRe, (m) => '<mark>' + m + '</mark>') : escaped;
    };

    const matchesHtml = matches.map((m) => {
      const lineNo = String(m.line == null ? '?' : m.line).padStart(4, ' ');
      return [
        '<div class="env-match">',
        '  <div class="env-match-path">' + escapeHtml(String(m.path == null ? '?' : m.path)) + ':' + escapeHtml(String(m.line == null ? '?' : m.line)) + '</div>',
        '  <pre class="env-code">' + lineNo + '  ' + highlight(String(m.snippet == null ? '' : m.snippet)) + '</pre>',
        '</div>',
      ].join('\\n');
    }).join('\\n');

    const footer = (env.next && env.next.cursor)
      ? '<div class="env-footer">Next: search_files(cursor=' + escapeHtml(String(env.next.cursor).slice(0, 8)) + '…) ' +
        '<button class="copy-cursor-btn" data-cursor="' + escapeHtml(env.next.cursor) + '">Copy cursor</button></div>'
      : '';

    const warnings = env.warnings
      ? env.warnings.map((w) => '<div class="env-warning">⚠ ' + escapeHtml(String(w)) + '</div>').join('\\n')
      : '';

    return [
      '<div class="env-card">',
      '  <div class="env-header">' + icon + ' <strong>' + escapeHtml(String(env.tool || '?')) + '</strong>' +
        ' · <span class="env-key-arg">"' + escapeHtml(query) + '"</span> ' +
        headerBadges.join(' ') +
      '</div>',
      '  <div class="env-body">' + matchesHtml + '</div>',
      warnings,
      footer,
      '</div>',
    ].join('\\n');
  }

  function renderRunCommandEnvelope(env) {
    const icon = iconForTool(env.tool);
    const data = env.data || {};
    const size = env.size || {};

    const headerBadges = [];
    const exitBadgeCls = (data.exitCode === 0) ? 'badge-ok' : 'badge-fail';
    const dur = ((data.durationMs || 0) / 1000).toFixed(1);
    headerBadges.push('<span class="env-badge ' + exitBadgeCls + '">exit ' + escapeHtml(String(data.exitCode == null ? '?' : data.exitCode)) + ' · ' + dur + 's</span>');
    if (env.truncated) {
      headerBadges.push('<span class="env-badge badge-truncated">truncated</span>');
    }

    const stdoutBytes = size.stdoutBytesReturned || 0;
    const stderrBytes = size.stderrBytesReturned || 0;
    const stdoutSuffix = size.stdoutTruncated ? ' · truncated' : '';
    const stderrSuffix = size.stderrTruncated ? ' · truncated' : '';

    const parts = [
      '<div class="env-card">',
      '  <div class="env-header">' + icon + ' <strong>run_command</strong> ' + headerBadges.join(' ') + '</div>',
      '  <div class="env-body">',
      '    <div class="env-stream-label">STDOUT (' + fmtBytes(stdoutBytes) + ')' + stdoutSuffix + '</div>',
      '    <pre class="env-code env-stream">' + escapeHtml(String(data.stdout == null ? '' : data.stdout)) + '</pre>',
      '    <div class="env-stream-label">STDERR (' + fmtBytes(stderrBytes) + ')' + stderrSuffix + '</div>',
      '    <pre class="env-code env-stream env-stderr">' + escapeHtml(String(data.stderr == null ? '' : data.stderr)) + '</pre>',
      '  </div>',
    ];
    if (env.warnings) {
      for (const w of env.warnings) {
        parts.push('<div class="env-warning">⚠ ' + escapeHtml(String(w)) + '</div>');
      }
    }
    parts.push('</div>');
    return parts.join('\\n');
  }

  function renderToolResultEnvelope(toolResultContent) {
    let env;
    try { env = JSON.parse(toolResultContent); } catch { env = null; }
    if (!isEnvelopeV1(env)) return null;
    if (env.ok === false) return renderEnvelopeFailure(env);
    const renderer = envelopeRenderers()[env.tool];
    return renderer ? renderer(env) : renderEnvelopeSuccessGeneric(env);
  }

  // Delegated click handler for [Copy cursor] buttons (added once at init).
  // Guarded so the JSDOM-free unit test sandbox (which has no document.body.addEventListener)
  // doesn't blow up evaluating the IIFE.
  if (!window.__tierkitEnvelopeClickHandlerInstalled && document.body && typeof document.body.addEventListener === 'function') {
    document.body.addEventListener('click', (ev) => {
      const target = ev.target;
      if (target && target.classList && target.classList.contains('copy-cursor-btn')) {
        const cursor = target.getAttribute('data-cursor') || '';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(cursor).then(() => {
            const old = target.textContent;
            target.textContent = '✓ Copied';
            setTimeout(() => { target.textContent = old; }, 1500);
          }).catch(() => {});
        }
      }
    });
    window.__tierkitEnvelopeClickHandlerInstalled = true;
  }

  // ── Card: Recent activity ──────────────────────────────────────────────────
  async function refreshActivity() {
    try {
      const r = await jget('/v1/usage');
      const records = r.records || [];
      const last = records.slice(-12).reverse();
      const root = $('activity-list');
      if (last.length === 0) {
        root.innerHTML = '<div class="empty">' + escapeHtml(i18n.noActivity) + '</div>';
        return;
      }
      root.innerHTML = '';
      for (const rec of last) {
        const row = document.createElement('div');
        row.className = 'activity-row';
        const statusColor = rec.ok ? 'var(--accent)' : 'var(--err)';
        // v0.14.2: show profileId as primary label; append (model) in dim if model differs
        // (e.g. claudeCode shows "claudeCode (auto)" so it's clear which profile served it)
        const modelSuffix = (rec.model && rec.model !== rec.profileId)
          ? ' <span class="dim">(' + escapeHtml(rec.model) + ')</span>'
          : '';
        const profileSpan = '<span style="color:' + statusColor + '">' + escapeHtml(rec.profileId) + '</span>' + modelSuffix;
        const latency = rec.latencyMs ? rec.latencyMs + 'ms' : '';
        // v0.13: prepend ≈ to token counts when usageSource === "estimated"
        const tokenPrefix = rec.usageSource === 'estimated' ? '≈' : '';
        const tokens = (rec.inputTokens || rec.outputTokens)
          ? tokenPrefix + (rec.inputTokens || 0) + '↑/' + (rec.outputTokens || 0) + '↓'
          : '';
        const cost = rec.costUsd ? fmtCost(rec.costUsd) : (rec.ok ? 'free' : '');
        const meta = [latency, tokens, cost].filter(Boolean).join(' · ');
        // v0.13: model-test badge for test calls; ⚠ degraded chip for stream-degraded records.
        const isModelTest = rec.type === 'model-test';
        const hasWarning = rec.warning === 'stream-degraded-to-non-stream' || rec.tierkitWarning === 'stream-degraded-to-non-stream';
        const modelTestBadgeHtml = isModelTest
          ? ' <span style="font-size:10px;padding:1px 4px;border-radius:3px;background:rgba(100,149,237,0.15);color:cornflowerblue">' + escapeHtml(i18n.modelTestBadge) + '</span>'
          : '';
        const degradedChipHtml = hasWarning
          ? ' <span style="font-size:10px;padding:1px 4px;border-radius:3px;background:rgba(245,176,65,0.12);color:var(--warn)">⚠ ' + escapeHtml(i18n.warningStreamDegraded) + '</span>'
          : '';
        row.innerHTML =
          '<div class="activity-line1">' +
            '<span class="dim">' + escapeHtml(fmtTime(rec.timestamp)) + '</span>' +
            profileSpan +
            (rec.tier ? ' <span class="dim">(' + escapeHtml(rec.tier) + ')</span>' : '') +
            modelTestBadgeHtml +
            degradedChipHtml +
            (rec.ok ? '' : ' <span style="color:var(--err)">✗ ' + escapeHtml(rec.failureCode || 'err') + '</span>') +
          '</div>' +
          (meta ? '<div class="activity-line2">' + escapeHtml(meta) + '</div>' : '');
        root.appendChild(row);
      }
    } catch (e) {
      $('activity-list').innerHTML = '<div class="empty">' + escapeHtml(e.message) + '</div>';
    }
  }

  // v0.23: pretty-print Anthropic ids for the savings breakdown.
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

  // ── Card: routing savings (v0.17) ────────────────────────────────────────
  // Polls GET /v1/savings/today every 5s. When the baseline is not configured
  // or the resolved profile lacks cost data, shows '—' values + the hint row.
  // v0.21.7: this is now Tierkit MCP compression savings, not LLM routing.
  // Reads /v1/tierkit/savings/today which sums today's tierkit.* compression
  // tool calls (compress_command / get_*_digest / build_context_pack) and
  // multiplies savedTokens by the baseline profile's input USD/M to get a
  // real dollar number the user can feel as they chat.
  // Pure DOM update — fed by both the /v1/tierkit/savings/today fetch path
  // and the /v1/tierkit/savings/stream SSE path (Task 6). r is the same
  // shape both routes return (the "today" route inlines the summary fields
  // alongside ok/baselineProfileId/baselineProvider/inputUsdPerMillion).
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

    // v0.21.10: visual before/after bar. Width of "after" bar is proportional
    // to the compression ratio so users see the squish at a glance.
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
    // Per-tool breakdown so the user sees which digest tools Claude actually used.
    const byTool = r.byTool || {};
    const entries = Object.entries(byTool).sort((a, b) => b[1] - a[1]);
    $('m-routing-by-tool').textContent = entries.length
      ? entries.map(([n, c]) => n.replace('tierkit.', '') + ' ×' + c).join(' · ')
      : '';
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
        const keyLabel = escapeHtmlMd(prettyFn(key));
        // overflow-wrap:anywhere on the key cell lets long model/client IDs
        // wrap on character boundaries instead of pushing the row past the
        // sidebar edge. The stats cell stays nowrap so "12.3k tok · 4 calls"
        // never splits across lines.
        html += '<div class="row dense" style="font-size:11px;align-items:flex-start;gap:8px">' +
          '<span title="' + keyLabel + '" style="flex:1;min-width:0;overflow-wrap:anywhere">' +
            keyLabel + '</span>' +
          '<span class="mono dim" style="font-size:10.5px;white-space:nowrap;flex-shrink:0">' +
            fmtTok(v.savedTokens) + ' tok · ' + v.toolCallCount + ' ' + (lang === 'ko' ? '호출' : 'calls') + usd +
          '</span>' +
          '</div>';
      }
      host.innerHTML = html;
    }
    renderBreakdown('m-routing-by-client-rows', byClient, prettyClient);
    renderBreakdown('m-routing-by-model-rows', byModel, prettyModel);

    if (calls === 0) {
      $('m-routing-empty-hint').textContent = lang === 'ko'
        ? '아직 Claude가 Tierkit MCP 도구를 호출하지 않았습니다. Chat에서 메시지를 보내고 Claude가 압축 도구를 사용하면 여기 카운트가 올라갑니다.'
        : 'No tierkit MCP tool calls yet today. Send a chat message; once Claude uses a compression tool, the counts will update here.';
      $('m-routing-empty-hint').hidden = false;
    } else {
      $('m-routing-empty-hint').hidden = true;
    }
  }

  async function refreshSavings() {
    try {
      const r = await jget('/v1/tierkit/savings/today');
      renderSavings(r);
    } catch { /* card stays at last-good state */ }
  }

  // SSE subscription: replaces the 5s polling for the Savings card.
  // transport.stream() proxies via the extension host so VS Code webview CSP
  // doesn't block the loopback EventSource. The proxy yields one chunk per
  // SSE data: line — payload.type === "savings-snapshot" carries the same
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
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  // ── Card: Usage summary ────────────────────────────────────────────────────
  async function refreshUsage() {
    try {
      const r = await jget('/v1/usage');
      const s = r.summary || {};
      $('stat-calls').textContent = String(s.totalCalls || 0);
      $('stat-tokens').textContent = String((s.totalInputTokens || 0) + (s.totalOutputTokens || 0));
      $('stat-cost').textContent = fmtCost(s.totalCostUsd);
      const byp = $('usage-by-profile');
      const entries = Object.entries(s.byProfile || {});
      if (entries.length === 0) {
        byp.innerHTML = '';
      } else {
        // Render inline as wrapping pills. Long profile IDs (e.g. ollama-qooba-
        // qwen3-coder-30b-a3b-instruct-q3-k-m) can exceed the sidebar width, so
        // overflow-wrap:anywhere lets the ID break on character boundaries while
        // the "$0.025" cost stays glued to its label via a nested nowrap span.
        byp.innerHTML = entries
          .map(([id, v]) =>
            '<span class="mono" style="color:var(--accent);margin-right:10px;display:inline-block;max-width:100%;overflow-wrap:anywhere" title="' + escapeHtml(id) + '">' +
              escapeHtml(id) + ' <span class="dim" style="white-space:nowrap">' + fmtCost(v.costUsd) + '</span>' +
            '</span>',
          )
          .join('');
      }
    } catch (e) {
      $('stat-calls').textContent = '—';
      $('stat-tokens').textContent = '—';
      $('stat-cost').textContent = '—';
    }
  }

  function openSetKeyDialog(presetKey) {
    const host = $('profile-add-form');
    const hostHasContent = host.innerHTML.trim() !== '' && !document.getElementById('secret-dialog');
    if (hostHasContent && !safeConfirm(i18n.confirmCloseForm)) return;
    const existing = document.getElementById('secret-dialog');
    if (existing) existing.remove();
    const dlg = document.createElement('div');
    dlg.id = 'secret-dialog';
    dlg.className = 'inline-form';
    dlg.style.marginTop = '8px';
    dlg.innerHTML =
      '<div class="form-grid">' +
        '<label>' + escapeHtml(i18n.apiKeyLabel) + '</label>' +
        '<input id="sk-key" value="' + escapeHtml(presetKey || '') + '" placeholder="ANTHROPIC_API_KEY" />' +
        '<label>' + escapeHtml(i18n.apiKeyValueLabel) + '</label>' +
        '<input id="sk-val" type="password" placeholder="sk-…" />' +
      '</div>' +
      '<div class="actions">' +
        '<button id="sk-cancel">' + escapeHtml(i18n.cancelBtn) + '</button>' +
        '<button id="sk-save" class="primary">' + escapeHtml(i18n.saveBtn) + '</button>' +
      '</div>';
    $('profile-add-form').style.display = 'block';
    $('profile-add-form').innerHTML = '';
    $('profile-add-form').appendChild(dlg);
    $('sk-cancel').onclick = () => { $('profile-add-form').innerHTML = ''; $('profile-add-form').style.display = 'none'; };
    $('sk-save').onclick = async () => {
      const key = ($('sk-key').value || '').trim();
      const value = ($('sk-val').value || '').trim();
      if (!key || !value) { toast(i18n.secretKeyValueRequired || 'key + value required', 'err'); return; }
      const resp = await jpost('/v1/secrets', { key, value });
      if (!resp.ok) { toast((resp.data && resp.data.message) || i18n.failed, 'err'); return; }
      toast(key + ' ✓ ' + i18n.keySaved, 'ok');
      $('profile-add-form').innerHTML = '';
      $('profile-add-form').style.display = 'none';
      await refreshModels();
    };
  }

  // v0.11.2 (Polish 4): consolidate per-profile "API key missing" warnings into a
  // single banner at the top of the Cost routing card. Walks the profile list,
  // collects unique apiKeyEnv names that aren't satisfied, and surfaces an
  // "Add keys" CTA that scrolls to (and opens) the existing API keys section.
  function renderMissingKeysBanner(entries, secretMap) {
    const banner = $('missing-keys-banner');
    if (!banner) return;
    const missing = [];
    const seen = new Set();
    for (const e of (entries || [])) {
      const p = e.profile || {};
      const env = p.apiKeyEnv;
      if (!env) continue;
      if (seen.has(env)) continue;
      const set = !!(secretMap[env] && secretMap[env].set);
      if (!set) { missing.push(env); seen.add(env); }
    }
    if (missing.length === 0) { banner.style.display = 'none'; banner.innerHTML = ''; return; }
    const label = lang === 'ko' ? '누락된 API 키' : 'Missing API keys';
    const addBtn = lang === 'ko' ? '키 추가' : 'Add keys';
    banner.style.display = 'flex';
    banner.innerHTML =
      '<span style="color:var(--warn);font-weight:600">⚠ ' + escapeHtml(label) + ':</span> ' +
      '<span class="mono" style="font-size:11px">' + missing.map(escapeHtml).join(' · ') + '</span>' +
      '<button id="missing-keys-add" class="tiny" style="margin-left:auto">' + escapeHtml(addBtn) + '</button>';
    const addEl = document.getElementById('missing-keys-add');
    if (addEl) {
      addEl.onclick = () => {
        // Scroll the existing "API Keys" subsection into view if it exists.
        const target = document.getElementById('api-keys-section');
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.style.outline = '1px solid var(--accent)';
          setTimeout(() => { target.style.outline = ''; }, 1500);
          // Auto-open the set-key dialog for the first missing one to make the
          // CTA feel immediately useful.
          if (missing[0]) openSetKeyDialog(missing[0]);
        } else if (missing[0]) {
          openSetKeyDialog(missing[0]);
        }
      };
    }
  }

  // v0.12: aggregate "this month per-token spend" row above the profile list.
  // Sums monthlyUsdLimit + costUsd across per-token profiles WITH a USD cap.
  // Only renders when ≥1 such profile exists. No bar color thresholds here —
  // aggregate is informational, individual rows carry the warning signal.
  function renderCostAggregateRow(entries, perProfileBudgets, profileUsage) {
    const host = $('cost-aggregate-row');
    if (!host) return;
    let aggUsed = 0;
    let aggCap = 0;
    for (const e of (entries || [])) {
      const p = (e && e.profile) || {};
      const pm = computeEffectivePaymentModel(p);
      if (pm !== 'per-token') continue;
      const cap = perProfileBudgets[e.id] && perProfileBudgets[e.id].monthlyUsdLimit;
      if (cap === undefined) continue;
      const used = (profileUsage[e.id] && profileUsage[e.id].month && profileUsage[e.id].month.costUsd) || 0;
      aggUsed += used;
      aggCap  += cap;
    }
    if (aggCap <= 0) { host.style.display = 'none'; host.innerHTML = ''; return; }
    const pct = Math.floor((aggUsed / aggCap) * 100);
    const colorClass = budgetBarColorClass(aggUsed / aggCap);
    host.style.display = 'block';
    host.innerHTML =
      '<div class="c12-aggregate">' +
        '<div class="dim" data-i18n="groupPerTokenSpend">' + escapeHtml(i18n.groupPerTokenSpend) + '</div>' +
        '<div class="c12-bar-track"><div class="c12-bar-fill ' + colorClass + '" style="width:' + Math.min(100, pct) + '%"></div></div>' +
        '<div class="c12-bar-text">$' + aggUsed.toFixed(2) + ' / $' + aggCap.toFixed(2) + ' (' + pct + '%)</div>' +
      '</div>';
  }

  // v0.12: render banner when ≥1 capped per-token profile exists AND every
  // capped per-token profile is at ≥100% (USD OR input-token ratio).
  function renderAllCappedPerTokenBlockedBanner(entries, perProfileBudgets, profileUsage) {
    const host = $('all-capped-blocked-banner');
    if (!host) return;
    let anyCapped = false;
    let allBlocked = true;
    for (const e of (entries || [])) {
      const p = (e && e.profile) || {};
      const pm = computeEffectivePaymentModel(p);
      if (pm !== 'per-token') continue;
      const cap = perProfileBudgets[e.id];
      if (!cap || (cap.monthlyUsdLimit === undefined && cap.monthlyInputTokenLimit === undefined)) continue;
      anyCapped = true;
      const u = (profileUsage[e.id] && profileUsage[e.id].month) || { inputTokens: 0, costUsd: 0 };
      const tokenRatio = cap.monthlyInputTokenLimit
        ? (u.inputTokens || 0) / cap.monthlyInputTokenLimit : 0;
      const usdRatio = cap.monthlyUsdLimit
        ? (u.costUsd || 0) / cap.monthlyUsdLimit : 0;
      if (Math.max(tokenRatio, usdRatio) < 1.0) { allBlocked = false; break; }
    }
    if (!anyCapped || !allBlocked) { host.style.display = 'none'; host.innerHTML = ''; return; }
    host.style.display = 'block';
    host.innerHTML =
      '<div class="banner-blocked">🛑 ' +
        '<span data-i18n="warnAllCappedPerTokenBlocked">' + escapeHtml(i18n.warnAllCappedPerTokenBlocked) + '</span>' +
      '</div>';
  }

  function renderApiKeysSection(secretMap) {
    // v0.21.7: this section was a duplicate of the dedicated "API Keys" card
    // (#secrets-card). Two surfaces for the same data confused users. Keep
    // the standalone card; remove this inline injection. If anything left
    // a stale section in the DOM (from a prior render), clear it.
    const stale = document.getElementById('api-keys-section');
    if (stale) stale.innerHTML = '';
    // Quiet no-op so existing call sites don't need to change.
    void secretMap;
    return;
    /* eslint-disable @typescript-eslint/no-unreachable */
    const keys = Object.keys(secretMap).sort();
    let section = document.getElementById('api-keys-section');
    if (!section) {
      const card = $('models-list').parentElement;
      section = document.createElement('div');
      section.id = 'api-keys-section';
      section.className = 'card-divider';
      card.insertBefore(section, $('profile-add-form'));
    }
    if (keys.length === 0) { section.innerHTML = ''; return; }
    let html = '<div class="card-divider-label">' + escapeHtml(i18n.sectionApiKeys) + '</div>';
    for (const k of keys) {
      const e = secretMap[k];
      const status = e.set
        ? '<span class="mono dim">' + escapeHtml(e.masked || 'set') + '</span>'
        : '<span style="color:var(--warn)">⚠ ' + escapeHtml(i18n.keyMissing) + '</span>';
      html +=
        '<div class="row dense">' +
          '<div class="col-grow"><span class="mono">' + escapeHtml(k) + '</span> · ' + status + '</div>' +
          (e.set
            ? '<button class="tiny" data-action="delete-key" data-key="' + escapeHtml(k) + '">' + escapeHtml(i18n.deleteBtn) + '</button>'
            : '<button class="tiny" data-action="setkey" data-key="' + escapeHtml(k) + '">' + escapeHtml(i18n.setKeyBtn) + '</button>') +
        '</div>';
    }
    section.innerHTML = html;
    section.querySelectorAll('button[data-action="setkey"]').forEach((b) => {
      b.onclick = () => openSetKeyDialog(b.getAttribute('data-key'));
    });
    section.querySelectorAll('button[data-action="delete-key"]').forEach((b) => {
      b.onclick = async () => {
        const key = b.getAttribute('data-key');
        if (!safeConfirm(i18n.confirmDeleteProfile.replace('{id}', key))) return;
        b.disabled = true;
        try {
          const resp = await transport.request('/v1/secrets/' + encodeURIComponent(key), { method: 'DELETE' });
          if (!resp.ok) {
            const msg = resp.data && resp.data.code === 'external' ? i18n.keyExternal : (resp.data && resp.data.message) || i18n.failed;
            toast(key + ': ' + msg, 'err');
            return;
          }
          toast(key + ' ✓ ' + i18n.deletedOk, 'ok');
          await refreshModels();
        } finally { b.disabled = false; }
      };
    });
  }

  // ── Card: Models ───────────────────────────────────────────────────────────
  async function refreshAutoCeiling() {
    try {
      const r = await jget('/v1/config');
      const rp = (r.config && r.config.routingPolicy) || {};
      const cur = rp.autoEscalationCeiling || 'public-cloud';
      const sel = $('auto-ceiling-select');
      if (sel) sel.value = cur;
      // Sync the risk threshold inputs in the disclosure too.
      const rt = rp.riskThresholds || {};
      const set = (id, value) => { const el = $(id); if (el && value !== undefined) el.value = String(value); };
      set('rt-local-fast', rt.localFastMax);
      set('rt-local-strong', rt.localStrongMax);
      set('rt-private-remote', rt.privateRemoteMax);
      set('rt-public-cloud', rt.publicCloudReviewMin);
    } catch (e) { /* ignore */ }
  }

  // Preset buttons: POST /v1/config/preset { name }, then re-pull config so the
  // auto-ceiling select + threshold inputs reflect what just got written.
  function wirePresetButtons() {
    document.querySelectorAll('#presets-row button[data-preset]').forEach((b) => {
      b.onclick = async () => {
        const name = b.getAttribute('data-preset');
        b.disabled = true;
        try {
          const resp = await jpost('/v1/config/preset', { name });
          if (!resp.ok) { toast((resp.data && resp.data.message) || i18n.failed, 'err'); return; }
          toast(name + ' ✓ ' + i18n.presetApplied, 'ok');
          await refreshAutoCeiling();
          await refreshModels();
        } finally { b.disabled = false; }
      };
    });
    const saveBtn = $('rt-save');
    if (saveBtn) saveBtn.onclick = async () => {
      const grab = (id) => {
        const el = $(id);
        if (!el || el.value === '') return undefined;
        const n = Number(el.value);
        return Number.isFinite(n) ? n : undefined;
      };
      const riskThresholds = {};
      const fast = grab('rt-local-fast');           if (fast !== undefined) riskThresholds.localFastMax = fast;
      const strong = grab('rt-local-strong');       if (strong !== undefined) riskThresholds.localStrongMax = strong;
      const priv = grab('rt-private-remote');       if (priv !== undefined) riskThresholds.privateRemoteMax = priv;
      const pub = grab('rt-public-cloud');          if (pub !== undefined) riskThresholds.publicCloudReviewMin = pub;
      saveBtn.disabled = true;
      try {
        const resp = await transport.request('/v1/config/routing', { method: 'PATCH', body: { riskThresholds } });
        if (!resp.ok) { toast((resp.data && resp.data.error) || i18n.failed, 'err'); return; }
        const status = $('rt-status');
        if (status) { status.textContent = '✓ ' + i18n.thresholdsSaved; setTimeout(() => { status.textContent = ''; }, 2500); }
        toast(i18n.thresholdsSaved, 'ok');
      } finally { saveBtn.disabled = false; }
    };
  }

  // v0.11.2: heuristic — is a profile id pattern auto-discovered?
  // Discovered Ollama profiles have ids like "ollama-qwen2-5-coder-7b" (provider
  // prefix + flattened model). We prefer the explicit source === "discovered"
  // signal returned by /v1/models when present; this is only used as a fallback
  // for older daemons.
  function isAutoDiscoveredId(id) {
    return /^ollama-[a-z0-9][a-z0-9-]*$/.test(String(id || ''));
  }

  // v0.11.2: render order for tier subheaders.
  const TIER_ORDER = ['local-device', 'private-remote', 'public-cloud'];

  // v0.12: bar-color thresholds — additive to text status. <80% green, 80–94% amber, ≥95% red.
  function budgetBarColorClass(ratio) {
    if (ratio >= 0.95) return 'budget-bar-red';
    if (ratio >= 0.80) return 'budget-bar-amber';
    return 'budget-bar-green';
  }
  function budgetStatusKey(ratio) {
    if (ratio >= 1.0)  return 'labelStatusBlocked';
    if (ratio >= 0.95) return 'labelStatusNearLimit';
    if (ratio >= 0.80) return 'labelStatusWarning';
    return 'labelStatusOk';
  }
  // v0.12.1: render the per-profile budget block. Supports four render paths
  // matching the v0.12 spec §4 table:
  //   • per-token + (USD and/or token cap) → combined USD+token bar with status
  //   • flat-rate + USD cap → "Fixed monthly cost: $X — metadata only" line
  //   • flat-rate + token cap → ALSO a token-only bar (alongside metadata line)
  //   • free + token cap → token-only bar (USD on a free profile has no meaning;
  //     doctor warns about it separately, no bar rendered here)
  // Status text / color for the token-only path is derived from the token ratio.
  function renderTokenOnlyBar(used, limit) {
    const ratio = limit ? used / limit : 0;
    const pct = Math.floor(ratio * 100);
    const statusKey = budgetStatusKey(ratio);
    const colorClass = budgetBarColorClass(ratio);
    const tokenText = formatK(used) + '/' + formatK(limit) + ' input';
    return (
      '<div class="c12-budget-bar">' +
        '<div class="c12-bar-track"><div class="c12-bar-fill ' + colorClass + '" style="width:' + Math.min(100, pct) + '%"></div></div>' +
        '<div class="c12-bar-text">' +
          escapeHtml(tokenText) +
          ' <span class="c12-bar-status" data-i18n="' + statusKey + '">' + escapeHtml(i18n[statusKey]) + '</span>' +
          ' (' + pct + '% input)' +
        '</div>' +
      '</div>'
    );
  }
  function renderProfileBudgetBlock(profileId, profile, budget, usageEntry) {
    const pm = computeEffectivePaymentModel(profile);
    const u = usageEntry || { inputTokens: 0, costUsd: 0 };
    if (pm === 'per-token' && budget && (budget.monthlyUsdLimit !== undefined || budget.monthlyInputTokenLimit !== undefined)) {
      const tokenRatio = budget.monthlyInputTokenLimit
        ? (u.inputTokens || 0) / budget.monthlyInputTokenLimit : 0;
      const usdRatio = budget.monthlyUsdLimit
        ? (u.costUsd || 0) / budget.monthlyUsdLimit : 0;
      const ratio = Math.max(tokenRatio, usdRatio);
      const reasonKey = usdRatio >= tokenRatio ? 'USD' : 'input';
      const pct = Math.floor(ratio * 100);
      const statusKey = budgetStatusKey(ratio);
      const colorClass = budgetBarColorClass(ratio);
      const usdText = budget.monthlyUsdLimit !== undefined
        ? '$' + (u.costUsd || 0).toFixed(2) + '/$' + Number(budget.monthlyUsdLimit).toFixed(2)
        : '';
      const tokenText = budget.monthlyInputTokenLimit !== undefined
        ? formatK(u.inputTokens || 0) + '/' + formatK(budget.monthlyInputTokenLimit) + ' input'
        : '';
      const sep = (usdText && tokenText) ? ' · ' : '';
      return (
        '<div class="c12-budget-bar">' +
          '<div class="c12-bar-track"><div class="c12-bar-fill ' + colorClass + '" style="width:' + Math.min(100, pct) + '%"></div></div>' +
          '<div class="c12-bar-text">' +
            escapeHtml(usdText) + sep + escapeHtml(tokenText) +
            ' <span class="c12-bar-status" data-i18n="' + statusKey + '">' + escapeHtml(i18n[statusKey]) + '</span>' +
            ' (' + pct + '% ' + reasonKey + ')' +
          '</div>' +
        '</div>'
      );
    }
    if (pm === 'flat-rate') {
      let out = '';
      if (budget && budget.monthlyUsdLimit !== undefined) {
        out +=
          '<div class="c12-flat-rate-metadata">' +
            '<span data-i18n="labelFixedMonthlyCost">' + escapeHtml(i18n.labelFixedMonthlyCost) + '</span>: ' +
            '$' + Number(budget.monthlyUsdLimit).toFixed(2) +
            ' <span class="dim" data-i18n="labelMetadataOnly">— ' + escapeHtml(i18n.labelMetadataOnly) + '</span>' +
          '</div>';
      }
      if (budget && budget.monthlyInputTokenLimit !== undefined) {
        out += renderTokenOnlyBar(u.inputTokens || 0, budget.monthlyInputTokenLimit);
      }
      return out;
    }
    if (pm === 'free' && budget && budget.monthlyInputTokenLimit !== undefined) {
      return renderTokenOnlyBar(u.inputTokens || 0, budget.monthlyInputTokenLimit);
    }
    return '';
  }

  // v0.12.3 — defense in depth: even if migration didn't run (older daemon, race
  // condition), never show two rows with the same canonical identity.
  // Priority: workspace > user > bundled > discovered; within same source, more
  // roles (richer metadata) wins.
  function dedupeByCanonicalIdentity(rows) {
    const SOURCE_RANK = { workspace: 0, user: 1, bundled: 2, discovered: 3 };
    const byIdentity = new Map();
    for (const e of rows) {
      const p = e.profile || {};
      const key = (p.provider || '') + '|' + (p.baseUrl || '') + '|' + (p.model || '');
      const existing = byIdentity.get(key);
      if (!existing) { byIdentity.set(key, e); continue; }
      const eRank = SOURCE_RANK[e.source] !== undefined ? SOURCE_RANK[e.source] : 99;
      const exRank = SOURCE_RANK[existing.source] !== undefined ? SOURCE_RANK[existing.source] : 99;
      if (eRank < exRank) { byIdentity.set(key, e); continue; }
      if (eRank === exRank) {
        const eRoles = (e.profile.roles || []).length;
        const exRoles = (existing.profile.roles || []).length;
        if (eRoles > exRoles) byIdentity.set(key, e);
      }
    }
    return Array.from(byIdentity.values());
  }

  async function refreshModels() {
    try {
      const [r, secretsR, configR, usageR] = await Promise.all([
        jget('/v1/models'),
        jget('/v1/secrets').catch(() => ({ entries: [] })),
        // v0.12: needed for budget.perProfile (existing endpoint; no new fetch).
        jget('/v1/config').catch(() => ({ config: {} })),
        // v0.12: profiles aggregate (Task 4) — present on v0.12+ daemons; older
        // daemons return { profiles: undefined } and bars simply render at 0%.
        jget('/v1/usage').catch(() => ({ profiles: {} })),
      ]);
      const entries = r.entries || [];
      // v0.12.3 — defense in depth against duplicate canonical identities
      // surviving in older daemons that haven't run the on-load migration.
      const dedupedEntries = dedupeByCanonicalIdentity(entries);
      const secretMap = {};
      for (const s of (secretsR.entries || [])) secretMap[s.key] = s;
      // v0.12: client-side join — no new endpoint, no FS read.
      const perProfileBudgets = (configR && configR.config && configR.config.budget && configR.config.budget.perProfile) || {};
      const profileUsage = (usageR && usageR.profiles) || {};
      const usageMonthFor = (id) =>
        (profileUsage[id] && profileUsage[id].month) || { inputTokens: 0, costUsd: 0 };

      // v0.13: pinned-no-fallback one-time banner. Show when not yet acknowledged.
      const notices = (configR && configR.config && configR.config.notices) || {};
      (function renderV013PinnedBanner() {
        const bannerEl = $('v013-pinned-banner');
        if (!bannerEl) return;
        if (notices.seenPinnedNoFallbackV013 === true) { bannerEl.style.display = 'none'; return; }
        bannerEl.style.display = 'block';
        bannerEl.innerHTML =
          '<div style="font-weight:700;margin-bottom:4px">' + escapeHtml(i18n.bannerV013PinnedTitle) + '</div>' +
          '<div style="margin-bottom:8px">' + escapeHtml(i18n.bannerV013PinnedBody) + '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button id="v013-banner-gotit" class="tiny primary">' + escapeHtml(i18n.bannerGotIt) + '</button>' +
            '<a id="v013-banner-docs" href="/docs/MODEL_ROUTING.md" style="font-size:11px;color:var(--accent);align-self:center;text-decoration:none">docs/MODEL_ROUTING.md</a>' +
          '</div>';
        function dismissBanner() {
          bannerEl.style.display = 'none';
          jpost('/v1/notices', { seenPinnedNoFallbackV013: true }).catch(() => { /* best-effort */ });
        }
        const gotItBtn = document.getElementById('v013-banner-gotit');
        if (gotItBtn) gotItBtn.onclick = dismissBanner;
        const docsLink = document.getElementById('v013-banner-docs');
        if (docsLink) docsLink.onclick = dismissBanner;
      })();

      const root = $('models-list');
      root.innerHTML = '';
      // v0.12: aggregate row + all-capped-blocked banner. Both render BEFORE
      // the tier subheaders so they're visible without scrolling. Helpers
      // hide their host divs when no relevant data is available.
      renderCostAggregateRow(dedupedEntries, perProfileBudgets, profileUsage);
      renderAllCappedPerTokenBlockedBanner(dedupedEntries, perProfileBudgets, profileUsage);
      if (dedupedEntries.length === 0) {
        root.innerHTML = '<div class="empty">no profiles</div>';
        renderMissingKeysBanner(dedupedEntries, secretMap);
        renderApiKeysSection(secretMap);
        return;
      }
      // v0.11.2: hide the default "workspace" source tag entirely (it's the most
      // common origin and the repetition was visual noise). Only non-default
      // sources get a small dim tag.
      const srcLabel = lang === 'ko'
        ? { bundled: '기본', user: '사용자 설정', workspace: '', discovered: '자동 감지' }
        : { bundled: 'bundled', user: 'user-config', workspace: '', discovered: 'discovered' };

      // Group entries by tier (Polish 2).
      const groups = { 'local-device': [], 'private-remote': [], 'public-cloud': [], 'other': [] };
      for (const e of dedupedEntries) {
        const kind = (e.profile && e.profile.kind) || 'other';
        (groups[kind] || groups.other).push(e);
      }

      // Build a quick lookup so we can demote auto-discovered duplicates of
      // user-named profiles (Polish 3). Key = "<provider>::<model>".
      const namedByProviderModel = new Map();
      for (const e of dedupedEntries) {
        const p = e.profile || {};
        const isDiscovered = e.source === 'discovered' || isAutoDiscoveredId(e.id);
        if (isDiscovered) continue;
        const k = (p.provider || '') + '::' + (p.model || '');
        if (!namedByProviderModel.has(k)) namedByProviderModel.set(k, e.id);
      }

      const tierHeadings = lang === 'ko'
        ? { 'local-device': '로컬 (장비)', 'private-remote': '프라이빗 (원격)', 'public-cloud': '클라우드 (공개)', 'other': '기타' }
        : { 'local-device': 'Local (device)', 'private-remote': 'Private (remote)', 'public-cloud': 'Cloud (public)', 'other': 'Other' };

      const renderTier = (tierKey) => {
        const list = groups[tierKey] || [];
        if (list.length === 0) return;

        // v0.21.8: public-cloud tier is collapsed by default. Most Tierkit
        // users (subscription-based Claude Code) never use raw OpenAI/cloud
        // profiles and the dim "API key 없음" rows are just visual noise. We
        // wrap the section in <details> so users can opt in.
        let container = root;
        if (tierKey === 'public-cloud') {
          const det = document.createElement('details');
          det.style.cssText = 'margin:10px 0 4px';
          const sum = document.createElement('summary');
          sum.style.cssText = 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--fg-dim);cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px';
          sum.innerHTML =
            '<span>▸ ' + escapeHtml(tierHeadings[tierKey] || tierKey) + '</span>' +
            '<span class="dim" style="font-size:10px;font-weight:400;text-transform:none;letter-spacing:0">(' + list.length + ' ' + (lang === 'ko' ? '개 숨김' : 'hidden') + ')</span>' +
            '<span style="flex:1;border-top:1px solid var(--border);opacity:0.6"></span>';
          det.appendChild(sum);
          root.appendChild(det);
          container = det;
        } else {
          const heading = document.createElement('div');
          heading.style.cssText = 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--fg-dim);margin:10px 0 4px;display:flex;align-items:center;gap:6px';
          heading.innerHTML =
            '<span>' + escapeHtml(tierHeadings[tierKey] || tierKey) + '</span>' +
            '<span style="flex:1;border-top:1px solid var(--border);opacity:0.6"></span>';
          root.appendChild(heading);
        }
        for (const e of list) {
          const p = e.profile || {};
          const isDiscovered = e.source === 'discovered' || isAutoDiscoveredId(e.id);
          const dupKey = (p.provider || '') + '::' + (p.model || '');
          const namedDup = isDiscovered ? namedByProviderModel.get(dupKey) : undefined;
          const isDimmedDup = !!(namedDup && namedDup !== e.id);
          const srcTag = srcLabel[e.source];
          const row = document.createElement('div');
          row.className = 'row dense';
          if (isDimmedDup) {
            row.style.cssText = 'opacity:0.55;font-size:10.5px;padding:2px 0';
          }
          // v0.12: per-profile budget bar (per-token w/ cap) or flat-rate metadata
          // line. Suppressed for dimmed duplicates to avoid visual double-counting.
          const budgetHtml = isDimmedDup
            ? ''
            : renderProfileBudgetBlock(e.id, p, perProfileBudgets[e.id], usageMonthFor(e.id));
          // v0.12.3 — Delete is only meaningful for user-editable scopes. Bundled
          // and discovered rows re-create themselves on next load, so the button
          // would appear to do nothing.
          const canDelete = e.source === 'workspace' || e.source === 'user';
          // v0.13: viability badge — green "ready", grey "disabled", amber reason code.
          const isProfileDisabled = p.enabled === false;
          const viability = e.viability || null;
          let viabilityBadgeHtml = '';
          if (!isDimmedDup) {
            if (isProfileDisabled) {
              viabilityBadgeHtml = ' <span style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(128,128,128,0.15);color:var(--fg-dim)">' + escapeHtml(i18n.statusDisabled) + '</span>';
            } else if (viability && viability.ok) {
              viabilityBadgeHtml = ' <span style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(80,200,120,0.15);color:#50c878">' + escapeHtml(i18n.statusReady) + '</span>';
            } else if (viability && !viability.ok && viability.reason) {
              const reasonLabel = {
                'cli-not-found':          i18n.statusCliNotFound,
                'cli-healthcheck-failed': i18n.statusCliHealthcheckFailed,
                'missing-api-key':        i18n.statusMissingApiKey,
                'ollama-unreachable':     i18n.statusOllamaUnreachable,
                'model-not-installed':    i18n.statusModelNotInstalled,
              }[viability.reason] || viability.reason;
              viabilityBadgeHtml = ' <span style="font-size:10px;padding:1px 5px;border-radius:3px;background:rgba(245,176,65,0.12);color:var(--warn)">' + escapeHtml(reasonLabel) + '</span>';
            }
          }
          row.innerHTML =
            '<div class="col-grow">' +
              '<div><span class="mono" style="color:var(--accent)">' + escapeHtml(e.id) + '</span>' +
                (isDimmedDup
                  ? ' <span class="dim" style="font-size:10px">↳ duplicate of ' + escapeHtml(namedDup) + '</span>'
                  : '') +
                viabilityBadgeHtml +
              '</div>' +
              '<div class="dim mono" style="margin-top:2px;font-size:10.5px">' +
                escapeHtml(p.provider || '') + ' · ' + escapeHtml(p.model || '') +
                (srcTag ? ' · <span style="color:var(--fg-dim);font-size:10px">' + escapeHtml(srcTag) + '</span>' : '') +
                (p.requiresApproval ? ' · <span style="color:var(--warn)" title="requires approval">⚠</span>' : '') +
              '</div>' +
              budgetHtml +
            '</div>' +
            '<button class="tiny" data-action="toggle-enabled" data-id="' + escapeHtml(e.id) + '" data-scope="' + escapeHtml(e.source) + '" data-enabled="' + (p.enabled === false ? '0' : '1') + '">' +
              (p.enabled === false ? escapeHtml(i18n.enabledOff) : escapeHtml(i18n.enabledOn)) +
            '</button>' +
            ' <button class="tiny" data-action="test" data-id="' + escapeHtml(e.id) + '" data-disabled="' + (isProfileDisabled ? '1' : '0') + '" data-displayname="' + escapeHtml(e.id) + '">' + escapeHtml(i18n.actionTest) + '</button>' +
            (canDelete
              ? ' <button class="tiny" data-action="delete-profile" data-id="' + escapeHtml(e.id) + '" data-scope="' + escapeHtml(e.source) + '">' + escapeHtml(i18n.deleteBtn) + '</button>'
              : '');
          // v0.21.8: rows of the public-cloud tier go inside the <details>
          // collapse container; other tiers append directly to root.
          container.appendChild(row);
        }
      };
      for (const tierKey of TIER_ORDER) renderTier(tierKey);
      renderTier('other');

      renderMissingKeysBanner(dedupedEntries, secretMap);

      root.querySelectorAll('button[data-action="test"]').forEach((b) => {
        b.onclick = async () => {
          const id = b.getAttribute('data-id');
          const isDisabled = b.getAttribute('data-disabled') === '1';
          const displayName = b.getAttribute('data-displayname') || id;

          // Find or create result panel below the row.
          const rowEl = b.closest('.row');
          let resultPanel = rowEl && rowEl.querySelector('.v013-test-result');
          if (!resultPanel && rowEl) {
            resultPanel = document.createElement('div');
            resultPanel.className = 'v013-test-result';
            resultPanel.style.cssText = 'font-size:11px;margin-top:4px;padding:4px 6px;background:rgba(0,0,0,0.15);border-radius:4px;font-family:var(--mono);color:var(--fg-dim)';
            rowEl.appendChild(resultPanel);
          }

          // v0.13: one-time confirm dialog before first test.
          const needsConfirm = !notices.seenModelTestExplained;
          if (needsConfirm) {
            let confirmMsg = i18n.testConfirmBody.replace('{displayName}', displayName);
            if (isDisabled) confirmMsg += '\\n\\n' + i18n.testDisabledNote;
            if (!safeConfirm(confirmMsg)) return;
            // Mark as seen (best-effort; refresh will pick up on next load).
            jpost('/v1/notices', { seenModelTestExplained: true }).catch(() => { /* ignore */ });
            notices.seenModelTestExplained = true;
          }

          b.disabled = true;
          const origText = b.textContent;
          b.textContent = '…';
          if (resultPanel) resultPanel.textContent = '…';
          try {
            const resp = await jpost('/v1/models/test', { profileId: id, smoke: true, ignoreDisabled: true });
            const d = resp.data || {};
            if (resp.ok) {
              const probe = d.probe || {};
              const smoke = d.smoke || null;
              let html = '<div>Probe: <span style="color:' + (probe.viable !== false ? 'var(--accent)' : 'var(--err)') + '">' + (probe.viable !== false ? 'ok' : 'failed') + '</span>' +
                (probe.latencyMs !== undefined ? ' (' + probe.latencyMs + 'ms)' : '') + '</div>';
              if (smoke) {
                if (smoke.ok !== false) {
                  html += '<div>Smoke chat: <span style="color:var(--accent)">' + escapeHtml(String(smoke.content || '').slice(0, 120)) + '</span>' +
                    (smoke.latencyMs !== undefined ? ' (' + smoke.latencyMs + 'ms)' : '') + '</div>';
                  if (smoke.inputTokens !== undefined || smoke.outputTokens !== undefined) {
                    html += '<div>Usage: ' + (smoke.inputTokens || 0) + ' in / ' + (smoke.outputTokens || 0) + ' out' +
                      (smoke.usageSource ? ' · ' + escapeHtml(smoke.usageSource) : '') + '</div>';
                  }
                } else {
                  const errCode = (smoke.error && smoke.error.code) || (d.error && d.error.type) || 'err';
                  const errMsg = ((smoke.error && smoke.error.message) || '').slice(0, 500);
                  html += '<div>Smoke chat: <span style="color:var(--err)">failed — ' + escapeHtml(errCode) + ': ' + escapeHtml(errMsg) + '</span></div>';
                }
              }
              if (resultPanel) resultPanel.innerHTML = html;
            } else {
              const errCode = (d.error && (d.error.type || d.error.code)) || d.code || 'err';
              const errMsg = (d.error && d.error.message) || d.message || '';
              if (resultPanel) resultPanel.innerHTML = '<span style="color:var(--err)">' + escapeHtml(errCode + (errMsg ? ': ' + errMsg.slice(0, 500) : '')) + '</span>';
            }
          } catch (err) {
            if (resultPanel) resultPanel.innerHTML = '<span style="color:var(--err)">' + escapeHtml(err.message || String(err)) + '</span>';
          } finally {
            b.disabled = false;
            b.textContent = origText;
          }
        };
      });
      root.querySelectorAll('button[data-action="delete-profile"]').forEach((b) => {
        b.onclick = async () => {
          const id = b.getAttribute('data-id');
          const scope = b.getAttribute('data-scope') === 'user' ? 'user' : 'workspace';
          if (!safeConfirm(i18n.confirmDeleteProfile.replace('{id}', id))) return;
          b.disabled = true;
          try {
            const resp = await transport.request('/v1/config/profile/' + encodeURIComponent(id) + '?scope=' + scope, { method: 'DELETE' });
            if (!resp.ok) { toast((resp.data && resp.data.message) || i18n.failed, 'err'); return; }
            toast(id + ' ✓ ' + i18n.deletedOk, 'ok');
            await refreshModels();
          } finally { b.disabled = false; }
        };
      });
      root.querySelectorAll('button[data-action="toggle-enabled"]').forEach((b) => {
        b.onclick = async () => {
          const id = b.getAttribute('data-id');
          const scope = b.getAttribute('data-scope') === 'user' ? 'user' : 'workspace';
          const currentlyEnabled = b.getAttribute('data-enabled') === '1';
          const nextEnabled = !currentlyEnabled;
          b.disabled = true;
          try {
            const resp = await transport.request('/v1/config/profile/' + encodeURIComponent(id), { method: 'PATCH', body: { enabled: nextEnabled, scope } });
            if (!resp.ok) {
              // 404 = old daemon without the PATCH endpoint. Surface this clearly.
              const msg = resp.status === 404
                ? id + ': PATCH endpoint not found — daemon is older than v0.10.1. Reload the VS Code window.'
                : (resp.data && resp.data.message) || i18n.failed;
              toast(msg, 'err');
              return;
            }
            toast(id + ' ✓ ' + (nextEnabled ? i18n.enabledNowOn : i18n.enabledNowOff), 'ok');
            await refreshModels();
          } finally { b.disabled = false; }
        };
      });
      root.querySelectorAll('button[data-action="setkey"]').forEach((b) => {
        b.onclick = () => openSetKeyDialog(b.getAttribute('data-key'));
      });
      renderApiKeysSection(secretMap);
    } catch (e) {
      $('models-list').innerHTML = '<div class="empty">' + escapeHtml(e.message) + '</div>';
      renderApiKeysSection({});
    }
  }

  $('auto-ceiling-select').onchange = async () => {
    const value = $('auto-ceiling-select').value;
    const resp = await transport.request('/v1/config/routing', { method: 'PATCH', body: { autoEscalationCeiling: value } });
    if (!resp.ok) { toast((resp.data && resp.data.error) || i18n.failed, 'err'); return; }
    toast(i18n.autoCeilingSaved, 'ok');
  };

  $('btn-discover-ollama').onclick = async () => {
    const btn = $('btn-discover-ollama');
    btn.disabled = true;
    try {
      const resp = await jpost('/v1/models/discover', {});
      if (!resp.ok) { toast((resp.data && resp.data.error) || i18n.failed, 'err'); return; }
      const count = resp.data && resp.data.count !== undefined ? resp.data.count : 0;
      toast(count + ' ' + i18n.discoverDone, 'ok');
      await refreshModels();
    } finally { btn.disabled = false; }
  };

  $('btn-profile-add').onclick = () => {
    const host = $('profile-add-form');
    host.style.display = 'block';
    const PROVIDERS = {
      anthropic: { kind: 'private-remote', apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrl: '', model: 'claude-sonnet-4-6', idHint: 'claudeCustom', backendProvider: 'anthropic' },
      openai:    { kind: 'public-cloud',   apiKeyEnv: 'OPENAI_API_KEY',    baseUrl: '', model: 'gpt-4o', idHint: 'gptCustom', backendProvider: 'openai' },
      gemini:    { kind: 'public-cloud',   apiKeyEnv: 'GEMINI_API_KEY',    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.0-flash', idHint: 'geminiCustom', backendProvider: 'openai' },
      ollama:    { kind: 'local-device',   apiKeyEnv: '',                  baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:7b', idHint: 'localCustom', backendProvider: 'ollama' },
    };

    function render(provider) {
      const tpl = PROVIDERS[provider];
      const isLocal = tpl.kind === 'local-device';
      host.innerHTML =
        '<div class="inline-form">' +
          '<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">' +
            ['anthropic', 'openai', 'gemini', 'ollama'].map((p) =>
              '<button data-prov="' + p + '" style="' + (p === provider ? 'background:var(--accent);color:#0f1115;border-color:var(--accent)' : '') + '">' + p + '</button>'
            ).join('') +
          '</div>' +
          '<div class="form-grid">' +
            '<label>' + escapeHtml(i18n.idLabel) + '</label>' +
            '<input id="pa-id" value="' + escapeHtml(tpl.idHint) + '" />' +
            '<label>' + escapeHtml(i18n.modelLabel) + '</label>' +
            '<input id="pa-model" value="' + escapeHtml(tpl.model) + '" />' +
            (isLocal
              ? '<label>' + escapeHtml(i18n.baseUrlLabel) + '</label>' +
                '<input id="pa-baseUrl" value="' + escapeHtml(tpl.baseUrl) + '" />'
              : '<label>' + escapeHtml(i18n.apiKeyLabel) + '</label>' +
                '<input id="pa-apiKey" value="' + escapeHtml(tpl.apiKeyEnv) + '" />' +
                '<label>' + escapeHtml(i18n.apiKeyValueLabel) + '</label>' +
                '<input id="pa-apiKeyValue" type="password" placeholder="' + escapeHtml(i18n.apiKeyValuePlaceholder) + '" />' +
                (tpl.baseUrl
                  ? '<label>' + escapeHtml(i18n.baseUrlLabel) + '</label>' +
                    '<input id="pa-baseUrl" value="' + escapeHtml(tpl.baseUrl) + '" />'
                  : '')) +
            '<label>' + escapeHtml(i18n.scopeLabel) + '</label>' +
            '<select id="pa-scope">' +
              '<option value="workspace">' + escapeHtml(i18n.scopeWorkspace) + '</option>' +
              '<option value="user">' + escapeHtml(i18n.scopeUser) + '</option>' +
            '</select>' +
            '<label>' + escapeHtml(i18n.goodAtLabel) + '</label>' +
            '<input id="pa-goodAt" placeholder="' + escapeHtml(i18n.goodAtPlaceholder) + '" />' +
          '</div>' +
          '<div class="actions">' +
            '<button id="pa-cancel">' + escapeHtml(i18n.cancelBtn) + '</button>' +
            '<button id="pa-save" class="primary">' + escapeHtml(i18n.saveBtn) + '</button>' +
          '</div>' +
        '</div>';
      host.querySelectorAll('button[data-prov]').forEach((b) => {
        b.onclick = () => render(b.getAttribute('data-prov'));
      });
      $('pa-cancel').onclick = () => { host.style.display = 'none'; host.innerHTML = ''; };
      $('pa-save').onclick = async () => {
        const id = ($('pa-id').value || '').trim();
        const model = ($('pa-model').value || '').trim();
        const scope = $('pa-scope').value;
        const apiKeyEnv = $('pa-apiKey') ? $('pa-apiKey').value.trim() : '';
        const apiKeyValue = $('pa-apiKeyValue') ? $('pa-apiKeyValue').value.trim() : '';
        const baseUrl = $('pa-baseUrl') ? $('pa-baseUrl').value.trim() : '';
        if (!id || !model) { toast(i18n.idAndModelRequired || 'id + model required', 'err'); return; }
        if (apiKeyValue) {
          if (!apiKeyEnv) { toast(i18n.apiKeyEnvRequired || 'API key env name required when value is set', 'err'); return; }
          const secResp = await jpost('/v1/secrets', { key: apiKeyEnv, value: apiKeyValue });
          if (!secResp.ok) { toast((secResp.data && secResp.data.message) || i18n.failed, 'err'); return; }
        }
        const profile = { kind: tpl.kind, provider: tpl.backendProvider || provider, model, roles: [] };
        if (apiKeyEnv) profile.apiKeyEnv = apiKeyEnv;
        if (baseUrl) profile.baseUrl = baseUrl;
        if (tpl.kind === 'public-cloud') { profile.requiresApproval = true; profile.defaultMode = 'review-only'; }
        const goodAtRaw = $('pa-goodAt') ? $('pa-goodAt').value.trim() : '';
        if (goodAtRaw) {
          profile.goodAt = goodAtRaw.split(',').map((s) => s.trim()).filter(Boolean);
        }
        const resp = await jpost('/v1/config/profile', { id, profile, scope });
        if (!resp.ok) { toast((resp.data && resp.data.message) || i18n.failed, 'err'); return; }
        toast(id + ' ✓ ' + i18n.added, 'ok');
        host.style.display = 'none'; host.innerHTML = '';
        await refreshModels();
      };
    }
    render('anthropic');
  };

  // ── Card: Daemon ───────────────────────────────────────────────────────────
  // The version pill at top of sidebar shows the DAEMON's version (from /v1/health).
  // When the user installs a new vsix but doesn't reload the window, the previous extension
  // is still running and so is its daemon. The GUI source itself comes from THAT old daemon
  // (the new vsix's GUI never gets loaded). So the pill version is the daemon version, full
  // stop. If user sees an unexpected version here, they need to reload the VS Code window.
  //
  // EXPECTED_GUI_VERSION is stamped at build time (the GUI string IS this version). If the
  // daemon reports a different number, the daemon is running stale code — surface a banner.
  const EXPECTED_GUI_VERSION = '${GUI_BUILD_VERSION}';
  // v0.22.6: track the offline→online edge. When the webview is opened before
  // the daemon is ready, the first refreshAll()'s parallel fetches all fail —
  // and only health/activity/usage are on the 5s setInterval, so cards like
  // Tools, Plugins, Models, Settings stay blank until the user clicks the ↻
  // button. We watch the health pulse and refire refreshAll() once when health
  // first becomes reachable, so the dashboard self-recovers without input.
  let _healthWasOffline = false;
  async function refreshHealth() {
    try {
      const h = await jget('/v1/health');
      $('health-pill').textContent = 'v' + h.version;
      $('health-pill').className = 'pill pill-ok';
      $('daemon-info').textContent = h.cwd;
      // Surface mismatch loudly. If the user is talking to a stale daemon, none of the
      // newer endpoints (PATCH /v1/config/profile/:id, /v1/secrets, etc.) will exist —
      // toggles and saves will silently 404. Better to scream.
      if (EXPECTED_GUI_VERSION && EXPECTED_GUI_VERSION !== 'dev' && h.version !== EXPECTED_GUI_VERSION) {
        showVersionMismatchBanner(h.version, EXPECTED_GUI_VERSION);
      } else {
        hideVersionMismatchBanner();
      }
      // Offline→online edge: refire the once-only refreshers so the dashboard
      // catches up. The nested refreshHealth here will see _healthWasOffline=false
      // and skip the recursion. refreshAll() runs in parallel; double-firing
      // health/activity/usage in the same tick is harmless.
      if (_healthWasOffline) {
        _healthWasOffline = false;
        refreshAll();
      }
    } catch (e) {
      $('health-pill').textContent = i18n.offline;
      $('health-pill').className = 'pill pill-err';
      $('daemon-info').textContent = e.message;
      _healthWasOffline = true;
    }
  }

  function showVersionMismatchBanner(daemonV, expectedV) {
    let banner = document.getElementById('version-mismatch-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'version-mismatch-banner';
      banner.style.cssText = 'background:var(--warn);color:#0f1115;padding:8px 12px;font-size:12px;border-radius:6px;margin:8px 0;font-weight:600';
      const host = document.querySelector('.tab-panel[data-tab-panel="chat"], .tab-panel[data-tab-panel="settings"]');
      if (host && host.firstChild) host.insertBefore(banner, host.firstChild);
    }
    banner.textContent = i18n.daemonMismatch
      .replace('{daemon}', daemonV)
      .replace('{expected}', expectedV);
  }

  function hideVersionMismatchBanner() {
    const b = document.getElementById('version-mismatch-banner');
    if (b) b.remove();
  }
  async function refreshFreedom() {
    try {
      const r = await jget('/v1/session');
      const pill = $('freedom-pill');
      pill.textContent = 'freedom: ' + r.freedom;
      pill.className = 'pill pill-' + (r.freedom === 'strict' ? 'err' : r.freedom === 'balanced' ? 'warn' : 'accent');
    } catch {
      $('freedom-pill').textContent = 'freedom: ?';
      $('freedom-pill').className = 'pill pill-warn';
    }
  }

  // ── Host banner (VS Code auto-start failure) ───────────────────────────────
  (function maybeRenderHostBanner() {
    const host = (typeof window !== 'undefined' && window.__TIERKIT_HOST__) || '';
    const errMsg = (typeof window !== 'undefined' && window.__TIERKIT_DAEMON_ERROR__) || '';
    if (host !== 'vscode' || !errMsg) return;
    const banner = $('host-banner');
    if (!banner) return;
    const labels = lang === 'ko'
      ? { title: '데몬 자동 시작 실패', showOutput: '진단 로그 열기', restart: '데몬 재시작' }
      : { title: 'Daemon auto-start failed', showOutput: 'Show output', restart: 'Restart daemon' };
    banner.style.display = 'block';
    banner.innerHTML =
      '<div style="font-weight:600;margin-bottom:4px">' + escapeHtml(labels.title) + '</div>' +
      '<div style="margin-bottom:8px">' + escapeHtml(errMsg) + '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button id="btn-host-output" class="tiny">' + escapeHtml(labels.showOutput) + '</button>' +
        '<button id="btn-host-restart" class="tiny">' + escapeHtml(labels.restart) + '</button>' +
      '</div>';
    function post(type) { if (vsApi) vsApi.postMessage({ type }); }
    $('btn-host-output').onclick = () => post('showOutput');
    $('btn-host-restart').onclick = () => post('restartDaemon');
  })();

  // ── Agent chat panel ───────────────────────────────────────────────────────
  // Subscribes to /v1/agent/run SSE stream, renders the AgentEvent timeline live.
  //   stream_open → status -> running
  //   task_start → user bubble
  //   assistant_text → assistant bubble (appended)
  //   tool_call → tool card inserted
  //   tool_result → tool card updated with result body
  //   task_complete → green completion card; status -> idle
  //   error → red error card; status -> idle
  const agentThread = $('agent-thread');
  const agentInput = $('agent-input');
  const agentSend = $('agent-send');
  const agentStop = $('agent-stop');
  const agentStatus = $('agent-status');
  const agentModeSelect = $('agent-mode-select');
  const agentApprovalSelect = $('agent-approval-select');
  const agentSlashSuggest = $('agent-slash-suggest');
  const agentUsageMeter = $('agent-usage-meter');
  let agentController = null; // AbortController for in-flight run
  // Map call.id → DOM node so tool_result can update the card created by tool_call.
  const toolNodesById = new Map();
  // Map mode name → mode definition (loaded from /v1/plugins).
  const modesByName = new Map();
  // Map command name → command markdown content (loaded from /v1/plugins).
  const commandsByName = new Map();
  // Cumulative token total across the active thread (resets on Clear / new Import).
  let agentSessionTokens = 0;
  // All events seen in this session — used by Export.
  const agentEventLog = [];
  // Tool names the user has whitelisted for this browser session via the "remember for this
  // session" checkbox on the approval prompt. Resets on page reload / explicit Clear.
  const sessionApprovedTools = new Set();
  // Pending image attachments for the next task submission. Each entry is
  // { id, mediaType, base64, thumbnailUrl }. Cleared after a task is sent.
  const pendingAttachments = [];
  let suppressNextTaskStart = false;
  const attachmentsHost = $('agent-attachments');
  const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024; // per image
  const MAX_ATTACHMENTS = 6;
  function renderAttachments() {
    if (pendingAttachments.length === 0) {
      attachmentsHost.style.display = 'none';
      attachmentsHost.innerHTML = '';
      return;
    }
    attachmentsHost.style.display = 'flex';
    attachmentsHost.innerHTML = '';
    for (const att of pendingAttachments) {
      const tile = document.createElement('div');
      tile.style.cssText = 'position:relative;width:64px;height:64px;border:1px solid var(--border);border-radius:4px;overflow:hidden;background:var(--bg-card)';
      const img = document.createElement('img');
      img.src = att.thumbnailUrl;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover';
      img.alt = att.mediaType;
      tile.appendChild(img);
      const rm = document.createElement('button');
      rm.textContent = '×';
      rm.title = lang === 'ko' ? '제거' : 'remove';
      rm.style.cssText = 'position:absolute;top:0;right:0;width:18px;height:18px;line-height:14px;font-size:12px;padding:0;background:rgba(0,0,0,0.6);color:#fff;border:0;cursor:pointer;border-radius:0 4px 0 4px';
      rm.onclick = () => {
        const i = pendingAttachments.findIndex((x) => x.id === att.id);
        if (i >= 0) pendingAttachments.splice(i, 1);
        renderAttachments();
      };
      tile.appendChild(rm);
      attachmentsHost.appendChild(tile);
    }
  }
  async function attachFile(file) {
    if (pendingAttachments.length >= MAX_ATTACHMENTS) {
      toast(lang === 'ko' ? '이미지는 최대 ' + MAX_ATTACHMENTS + '장까지' : 'max ' + MAX_ATTACHMENTS + ' images', 'err');
      return;
    }
    if (!file.type.startsWith('image/')) {
      toast(lang === 'ko' ? '이미지 파일만 지원' : 'only image files supported', 'err');
      return;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast(lang === 'ko' ? '이미지가 너무 큼 (' + Math.round(file.size / 1024 / 1024) + 'MB > 8MB)' : 'image too large (' + Math.round(file.size / 1024 / 1024) + 'MB > 8MB)', 'err');
      return;
    }
    const buf = await file.arrayBuffer();
    // Convert to base64 in chunks to avoid call stack overflow on large images.
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    const base64 = btoa(binary);
    pendingAttachments.push({
      id: 'att_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      mediaType: file.type,
      base64,
      thumbnailUrl: 'data:' + file.type + ';base64,' + base64,
    });
    renderAttachments();
  }
  function updateUsageMeter() {
    if (agentSessionTokens === 0) {
      agentUsageMeter.style.display = 'none';
      return;
    }
    agentUsageMeter.style.display = '';
    const k = agentSessionTokens >= 1000 ? (agentSessionTokens / 1000).toFixed(1) + 'k' : String(agentSessionTokens);
    agentUsageMeter.textContent = k + ' tok';
  }
  function resetAgentSession() {
    agentSessionTokens = 0;
    agentEventLog.length = 0;
    toolNodesById.clear();
    sessionApprovedTools.clear();
    pendingAttachments.length = 0;
    renderAttachments();
    agentThread.innerHTML = '<div class="agent-empty" data-i18n="agentEmpty">' +
      (lang === 'ko'
        ? '아래 입력창에 작업을 입력하면 Tierkit 에이전트가 실행됩니다. 모든 모델 호출은 Tierkit 라우팅·정책 스택을 거칩니다.'
        : 'Type a task below to run the Tierkit agent. Every model call goes through the same routing + policy stack as the rest of Tierkit.') +
      '</div>';
    updateUsageMeter();
  }

  function setAgentRunning(running) {
    if (running) {
      agentStatus.textContent = lang === 'ko' ? '실행 중…' : 'running…';
      agentStatus.className = 'agent-status pill pill-accent';
      agentSend.disabled = true;
      agentStop.style.display = '';
    } else {
      agentStatus.textContent = lang === 'ko' ? '대기' : 'idle';
      agentStatus.className = 'agent-status pill pill-dim';
      agentSend.disabled = false;
      agentStop.style.display = 'none';
    }
  }
  function scrollAgentBottom() {
    requestAnimationFrame(() => { agentThread.scrollTop = agentThread.scrollHeight; });
  }
  function clearAgentEmpty() {
    const empty = agentThread.querySelector('.agent-empty');
    if (empty) empty.remove();
  }
  function appendAgent(node) {
    clearAgentEmpty();
    agentThread.appendChild(node);
    scrollAgentBottom();
  }
  function renderAgentEvent(evt) {
    if (evt.type === 'stream_open') return; // silent
    if (evt.type === 'task_start' && suppressNextTaskStart) {
      // We already rendered the user bubble locally (with any image thumbnails). Skip the
      // server's echo to avoid a duplicate "▸ ..." line in the thread.
      suppressNextTaskStart = false;
      agentEventLog.push(evt);
      return;
    }
    if (evt.type === 'model_usage') {
      agentSessionTokens += evt.usage.totalTokens || ((evt.usage.promptTokens || 0) + (evt.usage.completionTokens || 0));
      updateUsageMeter();
      // Inline meta line so the user can see per-turn cost trickle in.
      const el = document.createElement('div');
      el.className = 'agent-msg-meta';
      el.style.fontSize = '10.5px';
      const profile = evt.profileId ? ' · ' + evt.profileId : '';
      el.textContent = '· turn ' + evt.turn + ': ' + (evt.usage.promptTokens || 0) + ' in / ' + (evt.usage.completionTokens || 0) + ' out tok' + profile;
      appendAgent(el);
      agentEventLog.push(evt);
      return;
    }
    agentEventLog.push(evt);
    if (evt.type === 'task_start') {
      const el = document.createElement('div');
      el.className = 'agent-msg agent-msg-user';
      el.textContent = evt.task;
      appendAgent(el);
      return;
    }
    if (evt.type === 'delta') {
      // Streaming token chunks. Append into the current turn's assistant bubble — create
      // one if needed. We key the bubble by turn so when tool_call events arrive between
      // turns, the next turn starts a fresh bubble.
      const turn = evt.turn ?? 0;
      const existingId = 'agent-delta-bubble-turn-' + String(turn);
      let bubble = document.getElementById(existingId);
      if (!bubble) {
        bubble = document.createElement('div');
        bubble.id = existingId;
        bubble.className = 'agent-msg agent-msg-assistant agent-msg-streaming';
        bubble.textContent = '';
        appendAgent(bubble);
      }
      bubble.textContent += evt.text;
      return;
    }
    if (evt.type === 'assistant_text') {
      // Final cleaned narrative — replaces the streamed bubble for the current turn so
      // raw XML tool tags (which were visible during streaming) are scrubbed from the
      // user's view. If there was no streaming bubble (non-streaming path or zero deltas),
      // we just append a fresh bubble.
      const allDeltaBubbles = Array.from(document.querySelectorAll('[id^="agent-delta-bubble-turn-"]'));
      const last = allDeltaBubbles[allDeltaBubbles.length - 1];
      if (last && last.classList.contains('agent-msg-streaming')) {
        last.textContent = evt.text;
        last.classList.remove('agent-msg-streaming');
        return;
      }
      const el = document.createElement('div');
      el.className = 'agent-msg agent-msg-assistant';
      el.textContent = evt.text;
      appendAgent(el);
      return;
    }
    if (evt.type === 'tool_call') {
      const el = document.createElement('div');
      el.className = 'agent-tool';
      const args = Object.entries(evt.call.args || {})
        .map(([k, v]) => k + '=' + (typeof v === 'string' ? JSON.stringify(v.slice(0, 60)) : JSON.stringify(v)))
        .join(', ');
      // Special-case ask_followup_question: render the question prominently with an
      // explanation that the user's next message becomes the answer.
      const isAskFollowup = evt.call.name === 'ask_followup_question';
      const isAsk_qBody = isAskFollowup
        ? '<div style="padding:6px 0;font-style:italic">❓ ' + escapeHtml(String(evt.call.args?.question || '')) + '</div>' +
          '<div class="dim" style="font-size:11px">' + (lang === 'ko' ? '아래 입력창에 답을 입력하세요. 다음 메시지가 응답으로 전달됩니다.' : 'Type your answer below — your next message will be sent as the response.') + '</div>'
        : '<div class="agent-tool-result" data-pending="1">' + (lang === 'ko' ? '실행 중…' : 'running…') + '</div>';
      el.innerHTML =
        '<div class="agent-tool-head">' +
          '<span class="agent-tool-name">⚙ ' + escapeHtml(evt.call.name) + '</span>' +
          '<span class="agent-tool-args">' + escapeHtml(args) + '</span>' +
        '</div>' +
        isAsk_qBody;
      appendAgent(el);
      toolNodesById.set(evt.call.id, el);
      // VS Code-only: offer a Preview link for write_file / apply_diff so the user can
      // review the proposed change in a real diff editor before approving. The extension
      // host listens for previewDiff postMessage.
      if (vsApi) {
        const head = el.querySelector('.agent-tool-head');
        const a = evt.call.args || {};
        if (evt.call.name === 'write_file' && typeof a.path === 'string' && typeof a.content === 'string') {
          const link = document.createElement('button');
          link.className = 'tiny';
          link.style.marginLeft = '8px';
          link.textContent = lang === 'ko' ? '미리보기' : 'Preview';
          link.onclick = () => vsApi.postMessage({ type: 'previewDiff', path: a.path, proposed: a.content });
          head.appendChild(link);
        }
        if (evt.call.name === 'apply_diff' && typeof a.path === 'string' && typeof a.search === 'string' && typeof a.replace === 'string') {
          const link = document.createElement('button');
          link.className = 'tiny';
          link.style.marginLeft = '8px';
          link.textContent = lang === 'ko' ? '미리보기' : 'Preview';
          link.onclick = async () => {
            // Fetch the current file via read_file proxy? We don't have that; instead just
            // post the path + a placeholder. Real preview needs the proposed-after content,
            // which we can't compute without reading the file. Fall back to opening the
            // file so the user at least sees the target.
            vsApi.postMessage({ type: 'openFile', path: a.path });
          };
          head.appendChild(link);
        }
      }
      return;
    }
    if (evt.type === 'tool_result') {
      const el = toolNodesById.get(evt.call.id);
      if (!el) return;
      el.classList.add(evt.result.ok ? 'ok' : 'err');
      const body = el.querySelector('.agent-tool-result');
      if (!body) return;
      const content = String(evt.result.content || '');
      body.removeAttribute('data-pending');

      // v0.17: if the content is a tool-result-envelope.v1 JSON, render via
      // per-tool dispatch instead of dumping raw JSON. Falls back to the
      // pre-v0.17 truncate-and-toggle path for non-envelope content.
      const envHtml = renderToolResultEnvelope(content);
      if (envHtml) {
        body.innerHTML = envHtml;
      } else {
        const preview = content.length > 800 ? content.slice(0, 800) + '\\n... (' + (content.length - 800) + ' more bytes)' : content;
        body.textContent = preview;
        if (content.length > 800) {
          const toggle = document.createElement('div');
          toggle.className = 'agent-tool-toggle';
          toggle.textContent = lang === 'ko' ? '전체 보기' : 'show full output';
          toggle.onclick = () => {
            body.textContent = content;
            body.classList.add('expanded');
            toggle.remove();
          };
          el.appendChild(toggle);
        }
      }
      scrollAgentBottom();
      return;
    }
    if (evt.type === 'task_complete') {
      const el = document.createElement('div');
      el.className = 'agent-complete';
      el.textContent = '✓ ' + (lang === 'ko' ? '작업 완료' : 'Task complete') + ' · ' + evt.turnCount + ' ' + (lang === 'ko' ? '턴' : 'turns');
      appendAgent(el);
      return;
    }
    if (evt.type === 'turn_end') {
      const el = document.createElement('div');
      el.className = 'agent-msg-meta';
      el.textContent = '— ' + (lang === 'ko' ? '턴 종료' : 'turn ended') + ': ' + evt.reason;
      appendAgent(el);
      return;
    }
    if (evt.type === 'error') {
      const el = document.createElement('div');
      el.className = 'agent-error';
      el.textContent = '[' + evt.code + '] ' + evt.message;
      appendAgent(el);
      return;
    }
    if (evt.type === 'tool_approval_pending') {
      // Session whitelist (resets on page reload / Clear): if the user previously checked
      // "approve this tool for the rest of the session", auto-resolve and skip the prompt.
      if (sessionApprovedTools.has(evt.call.name)) {
        void jpost('/v1/agent/approval', { callId: evt.call.id, approved: true }).catch(() => {});
        // Render a small meta line so the user knows it was auto-approved.
        const meta = document.createElement('div');
        meta.className = 'agent-msg-meta';
        meta.style.fontSize = '10.5px';
        meta.textContent = '· ' + (lang === 'ko' ? '세션 자동 승인' : 'session auto-approved') + ': ' + evt.call.name;
        appendAgent(meta);
        return;
      }
      // Find the tool card created by the preceding tool_call event and replace its
      // pending body with [Approve][Deny] buttons that POST /v1/agent/approval.
      const el = toolNodesById.get(evt.call.id);
      if (!el) return;
      const body = el.querySelector('.agent-tool-result');
      if (!body) return;
      body.removeAttribute('data-pending');
      body.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:flex;gap:6px;align-items:center;padding:4px 0;flex-wrap:wrap';
      const approve = document.createElement('button');
      approve.className = 'primary tiny';
      approve.textContent = lang === 'ko' ? '승인' : 'Approve';
      const deny = document.createElement('button');
      deny.className = 'tiny';
      deny.textContent = lang === 'ko' ? '거부' : 'Deny';
      const persistLabel = document.createElement('label');
      persistLabel.style.cssText = 'font-size:10.5px;color:var(--fg-dim);display:flex;align-items:center;gap:4px';
      const persistCb = document.createElement('input');
      persistCb.type = 'checkbox';
      persistCb.style.margin = '0';
      persistLabel.appendChild(persistCb);
      const persistText = document.createElement('span');
      persistText.textContent = (lang === 'ko' ? '이번 세션 동안 모두 승인' : 'remember for this session') + ' (' + evt.call.name + ')';
      persistLabel.appendChild(persistText);
      const msg = document.createElement('span');
      msg.className = 'dim';
      msg.style.fontSize = '11px';
      msg.style.marginLeft = '6px';
      msg.textContent = lang === 'ko' ? '승인 대기 중…' : 'awaiting approval…';
      wrap.append(approve, deny, persistLabel, msg);
      body.appendChild(wrap);
      async function send(approved) {
        approve.disabled = true; deny.disabled = true; persistCb.disabled = true;
        if (approved && persistCb.checked) sessionApprovedTools.add(evt.call.name);
        try {
          await jpost('/v1/agent/approval', { callId: evt.call.id, approved });
        } catch (e) {
          msg.textContent = '[' + (lang === 'ko' ? '오류' : 'error') + '] ' + e.message;
        }
      }
      approve.onclick = () => void send(true);
      deny.onclick = () => void send(false);
      el.classList.add('pending-approval');
      scrollAgentBottom();
      return;
    }
    if (evt.type === 'tool_approval_resolved') {
      const el = toolNodesById.get(evt.call.id);
      if (!el) return;
      el.classList.remove('pending-approval');
      const body = el.querySelector('.agent-tool-result');
      if (body) {
        body.innerHTML = '';
        body.textContent = evt.approved
          ? (lang === 'ko' ? '✓ 승인됨 — 실행 중…' : '✓ Approved — running…')
          : (lang === 'ko' ? '✗ 거부됨' : '✗ Denied');
      }
      return;
    }
  }

  // ── Mode + slash command loading ────────────────────────────────────────────
  async function loadAgentModesAndCommands() {
    try {
      const r = await jget('/v1/plugins');
      const list = (r.plugins || []).filter((p) => p.enabled);
      modesByName.clear();
      commandsByName.clear();
      for (const p of list) {
        const comps = p.manifest?.components || {};
        for (const m of (comps.modes || [])) {
          modesByName.set(m.id, { ...m, pluginId: p.id });
        }
        for (const c of (comps.commands || [])) {
          commandsByName.set(c.name, { ...c, pluginId: p.id });
        }
      }
      const prev = agentModeSelect.value;
      agentModeSelect.innerHTML = '';
      const allOpt = document.createElement('option');
      allOpt.value = '';
      allOpt.textContent = lang === 'ko' ? '(모든 도구)' : '(all tools)';
      agentModeSelect.appendChild(allOpt);
      for (const m of modesByName.values()) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.name + ' (' + m.pluginId + ')';
        agentModeSelect.appendChild(opt);
      }
      if (prev && modesByName.has(prev)) agentModeSelect.value = prev;
    } catch (e) { /* leave defaults */ }
  }
  function renderSlashSuggest(filter) {
    const inner = agentSlashSuggest.firstElementChild;
    if (!inner) return;
    const matches = [...commandsByName.entries()]
      .filter(([name]) => name.startsWith(filter))
      .slice(0, 8);
    if (matches.length === 0) {
      agentSlashSuggest.style.display = 'none';
      return;
    }
    inner.innerHTML = matches.map(([name, cmd]) =>
      '<div class="slash-item" data-name="' + escapeHtml(name) + '" style="padding:6px 10px;cursor:pointer;border-bottom:1px solid var(--border)">' +
        '<div><b>/' + escapeHtml(name) + '</b> <span class="dim" style="font-size:10px">' + escapeHtml(cmd.pluginId) + '</span></div>' +
        '<div class="dim" style="font-size:10.5px;margin-top:1px">' + escapeHtml(cmd.description || '') + '</div>' +
      '</div>',
    ).join('');
    agentSlashSuggest.style.display = '';
    inner.querySelectorAll('.slash-item').forEach((it) => {
      it.onclick = () => {
        const name = it.getAttribute('data-name');
        // Replace the in-progress slash token with /name + space.
        const v = agentInput.value;
        const tokenEnd = v.indexOf(' ');
        const head = tokenEnd === -1 ? '' : v.slice(tokenEnd);
        agentInput.value = '/' + name + (head.length === 0 ? ' ' : head);
        agentSlashSuggest.style.display = 'none';
        agentInput.focus();
      };
    });
  }
  // Detect the in-progress @token (the @word at the caret).
  function currentAtToken() {
    const v = agentInput.value;
    const caret = agentInput.selectionStart ?? v.length;
    const head = v.slice(0, caret);
    const m = /(?:^|\\s)@([\\w\\-./]*)$/.exec(head);
    return m ? { match: m[1], start: caret - m[1].length - 1 } : null;
  }
  let atSuggestEl = null;
  let atSuggestAbort = null;
  function hideAtSuggest() {
    if (atSuggestEl) { atSuggestEl.remove(); atSuggestEl = null; }
    if (atSuggestAbort) { atSuggestAbort.abort(); atSuggestAbort = null; }
  }
  async function renderAtSuggest(prefix) {
    hideAtSuggest();
    atSuggestAbort = new AbortController();
    let files = [];
    try {
      const r = await transport.request('/v1/workspace/files?prefix=' + encodeURIComponent(prefix) + '&limit=8', { method: 'GET', signal: atSuggestAbort.signal });
      if (!r.ok) return;
      files = r.data.files || [];
    } catch { return; }
    if (files.length === 0) return;
    atSuggestEl = document.createElement('div');
    atSuggestEl.style.cssText = 'position:absolute;left:6px;right:60px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.4);max-height:200px;overflow-y:auto;font-family:var(--mono);font-size:11.5px;z-index:5';
    const inputRect = agentInput.getBoundingClientRect();
    const meta = $('agent-composer-meta');
    const metaRect = meta.getBoundingClientRect();
    atSuggestEl.style.position = 'fixed';
    atSuggestEl.style.left = (inputRect.left + 4) + 'px';
    atSuggestEl.style.top = (metaRect.bottom + 4) + 'px';
    atSuggestEl.style.width = (inputRect.width - 70) + 'px';
    atSuggestEl.innerHTML = files.map((f) =>
      '<div class="at-item" data-path="' + escapeHtml(f) + '" style="padding:6px 10px;cursor:pointer;border-bottom:1px solid var(--border)">' +
        escapeHtml(f) +
      '</div>',
    ).join('');
    document.body.appendChild(atSuggestEl);
    atSuggestEl.querySelectorAll('.at-item').forEach((it) => {
      it.onclick = () => {
        const tok = currentAtToken();
        if (!tok) { hideAtSuggest(); return; }
        const v = agentInput.value;
        const p = it.getAttribute('data-path');
        agentInput.value = v.slice(0, tok.start) + '@' + p + ' ' + v.slice((agentInput.selectionStart ?? v.length));
        hideAtSuggest();
        agentInput.focus();
      };
    });
  }
  agentInput.addEventListener('input', () => {
    const v = agentInput.value;
    if (v.startsWith('/') && !v.includes(' ')) {
      renderSlashSuggest(v.slice(1));
      hideAtSuggest();
      return;
    }
    agentSlashSuggest.style.display = 'none';
    const tok = currentAtToken();
    if (tok && tok.match.length >= 1) void renderAtSuggest(tok.match);
    else hideAtSuggest();
  });
  agentInput.addEventListener('blur', () => setTimeout(hideAtSuggest, 150));

  // ── Drag-and-drop: dropping files into the composer inserts @path tokens for each. ───
  function setDragOver(on) {
    agentInput.style.outline = on ? '2px dashed var(--accent)' : '';
    agentInput.style.outlineOffset = on ? '-2px' : '';
  }
  agentInput.addEventListener('dragover', (e) => { e.preventDefault(); setDragOver(true); });
  agentInput.addEventListener('dragleave', () => setDragOver(false));
  agentInput.addEventListener('drop', (e) => {
    e.preventDefault();
    setDragOver(false);
    const dt = e.dataTransfer;
    if (!dt) return;
    // Image files dropped from the OS (or pasted from VS Code's "Copy image") arrive as
    // File objects on dataTransfer.files. Route those to attachFile so they show up in the
    // attachments preview row instead of being treated as @path text refs.
    if (dt.files && dt.files.length > 0) {
      let consumedImage = false;
      for (const f of dt.files) {
        if (f.type && f.type.startsWith('image/')) {
          void attachFile(f);
          consumedImage = true;
        }
      }
      if (consumedImage) return;
    }
    // Prefer text/uri-list (file:// URIs from the OS file manager / VS Code explorer).
    let paths = [];
    const uriList = dt.getData('text/uri-list');
    if (uriList) {
      for (const raw of uriList.split(/\\r?\\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        try {
          const u = new URL(line);
          if (u.protocol === 'file:') paths.push(decodeURIComponent(u.pathname));
        } catch { /* ignore */ }
      }
    }
    // VS Code's webview-internal drag also sets text/plain to the path.
    if (paths.length === 0) {
      const t = dt.getData('text/plain');
      if (t) paths.push(t);
    }
    if (paths.length === 0) return;
    // Convert absolute paths under the workspace to workspace-relative form. Without the
    // workspace root we just drop the path as-is; the @ token resolver below tolerates that.
    const inserted = paths.map((p) => {
      // Heuristic: anything starting with / is absolute. If the page knows its workspace
      // base URL we could ask the daemon for it, but for now keep it simple.
      const basename = p.split('/').filter(Boolean).slice(-3).join('/');
      return '@' + basename;
    }).join(' ');
    const at = agentInput.selectionStart ?? agentInput.value.length;
    agentInput.value = agentInput.value.slice(0, at) + (at > 0 && !/\\s$/.test(agentInput.value.slice(0, at)) ? ' ' : '') + inserted + ' ' + agentInput.value.slice(at);
    agentInput.focus();
  });

  // Paste images from clipboard (Cmd/Ctrl+V on a screenshot, copied image from VS Code, etc.)
  agentInput.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    let consumed = false;
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f && f.type && f.type.startsWith('image/')) {
          void attachFile(f);
          consumed = true;
        }
      }
    }
    if (consumed) e.preventDefault(); // suppress the default "paste as text" for images
  });

  function appendUserTaskBubble(text, attachments) {
    const el = document.createElement('div');
    el.className = 'agent-msg agent-msg-user';
    if (attachments && attachments.length > 0) {
      const imgsRow = document.createElement('div');
      imgsRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px';
      for (const att of attachments) {
        const im = document.createElement('img');
        im.src = 'data:' + att.mediaType + ';base64,' + att.base64;
        im.style.cssText = 'max-width:120px;max-height:120px;border-radius:4px;border:1px solid var(--border)';
        imgsRow.appendChild(im);
      }
      el.appendChild(imgsRow);
    }
    const textEl = document.createElement('div');
    textEl.textContent = text;
    el.appendChild(textEl);
    appendAgent(el);
  }
  async function submitAgentTask(task) {
    if (!task || !task.trim()) return;
    if (agentController) return; // already running
    agentSlashSuggest.style.display = 'none';
    toolNodesById.clear();
    setAgentRunning(true);
    agentController = new AbortController();
    let aborted = false;
    // Pick up mode + approval mode from composer dropdowns.
    const selectedMode = agentModeSelect.value || undefined;
    const approvalMode = agentApprovalSelect.value === 'interactive' ? 'interactive' : 'auto';
    const forceEdit = !!($('agent-force-edit') && $('agent-force-edit').checked);
    // Expand /cmdname args into a Command preamble + rest as the agent task.
    let finalTask = task;
    const slashMatch = /^\\/([a-z][a-z0-9-]*)(?:\\s+([\\s\\S]*))?$/i.exec(task.trim());
    if (slashMatch && commandsByName.has(slashMatch[1])) {
      const cmd = commandsByName.get(slashMatch[1]);
      const rest = slashMatch[2] || '';
      finalTask =
        '[Plugin command: /' + cmd.name + ' from ' + cmd.pluginId + ' — ' + (cmd.description || '') + ']\\n' +
        (rest ? rest : (lang === 'ko' ? '명령에 추가 인자 없음. 명령의 본래 의도대로 수행해.' : 'No additional args provided. Carry out the command according to its description.'));
    }
    // Collect @path references and surface them so the agent knows the user mentioned them.
    // We don't pre-read the files — the agent's read_file tool exists for that. But by
    // listing the paths up front we save a round-trip on small contexts.
    const atRefs = [];
    finalTask.replace(/(?:^|\\s)@([\\w\\-./]+)/g, (_, p) => { if (p && !atRefs.includes(p)) atRefs.push(p); return _; });
    if (atRefs.length > 0) {
      finalTask = finalTask + '\\n\\n[Files referenced by user: ' + atRefs.join(', ') + '. Read them with the read_file tool if needed.]';
    }
    try {
      const attachmentsForSubmit = pendingAttachments.length > 0
        ? pendingAttachments.map((a) => ({ mediaType: a.mediaType, base64: a.base64 }))
        : undefined;
      // Render the user bubble locally so attachments show up alongside the task text.
      // Then ask renderAgentEvent to swallow the next server-emitted task_start event so
      // we don't duplicate the bubble.
      appendUserTaskBubble(task, attachmentsForSubmit);
      suppressNextTaskStart = true;
      pendingAttachments.length = 0;
      renderAttachments();
      const reqBody = { task: finalTask, mode: selectedMode, approvalMode, ...(attachmentsForSubmit ? { attachments: attachmentsForSubmit } : {}), ...(forceEdit ? { forceEdit: true } : {}) };
      try {
        for await (const ev of transport.stream('/v1/agent/run', { method: 'POST', body: reqBody, signal: agentController.signal })) {
          if (ev.data === '[DONE]') return;
          try { renderAgentEvent(JSON.parse(ev.data)); } catch (e) { /* skip malformed */ }
        }
      } catch (streamErr) {
        if (streamErr.name === 'AbortError' || /aborted/i.test(streamErr.message)) throw streamErr;
        renderAgentEvent({ type: 'error', code: 'stream-error', message: streamErr.message });
        return;
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        aborted = true;
        renderAgentEvent({ type: 'error', code: 'aborted', message: lang === 'ko' ? '사용자가 중단함' : 'aborted by user' });
      } else {
        renderAgentEvent({ type: 'error', code: 'stream-error', message: e.message });
      }
    } finally {
      agentController = null;
      setAgentRunning(false);
      void aborted; // satisfy lint
    }
  }

  agentSend.onclick = () => {
    const text = agentInput.value;
    agentInput.value = '';
    void submitAgentTask(text);
  };
  agentStop.onclick = () => {
    if (agentController) agentController.abort();
  };

  // ── Export / Import / Clear ────────────────────────────────────────────────
  $('btn-agent-clear').onclick = () => {
    if (agentController) {
      toast(lang === 'ko' ? '실행 중에는 비울 수 없음' : 'cannot clear while running', 'err');
      return;
    }
    resetAgentSession();
  };
  $('btn-agent-export').onclick = () => {
    const blob = new Blob(
      [JSON.stringify({ schema: 'tierkit-agent-conversation@1', exportedAt: new Date().toISOString(), events: agentEventLog }, null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tierkit-agent-' + Date.now() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  $('btn-agent-import').onclick = () => {
    if (agentController) {
      toast(lang === 'ko' ? '실행 중에는 불러올 수 없음' : 'cannot import while running', 'err');
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!parsed || parsed.schema !== 'tierkit-agent-conversation@1' || !Array.isArray(parsed.events)) {
          throw new Error('unrecognized conversation file');
        }
        resetAgentSession();
        for (const evt of parsed.events) renderAgentEvent(evt);
        toast(lang === 'ko' ? '대화 복원됨' : 'conversation restored', 'ok');
      } catch (e) {
        toast((lang === 'ko' ? '불러오기 실패: ' : 'import failed: ') + e.message, 'err');
      }
    };
    input.click();
  };
  // v0.21: Enter now sends the message to Claude Code via the streaming chat
  // proxy. Tierkit Chat IS the chat UI — the response renders here, not in
  // Claude Code's sidebar. The 📦 dropdown remains for explicit local digests.
  // Hold Shift+Enter for newline; plain Enter sends.
  //
  // v0.21.2: IME composition guard. While an IME is assembling a candidate
  // (e.g. Korean Hangul, Japanese kana, Chinese pinyin) the user's Enter is
  // meant to COMMIT the candidate, not submit the chat message. Without this
  // guard, the last character gets duplicated because the keydown fires
  // before the IME finishes and we end up sending the message AND letting
  // the IME re-insert the final character. Browsers signal IME composition
  // via e.isComposing (modern) or e.keyCode === 229 (legacy fallback).
  agentInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = agentInput.value.trim();
      if (!text) return;
      agentInput.value = '';
      void streamChat(text);
    }
  });

  // ── v0.18 Context Gateway: Tierkit Tools dropdown in chat composer ─────────
  // The dropdown surfaces the digest pipeline (compress, pack, digest file/diff)
  // without routing through the agent loop. Results render directly in the same
  // agent thread as small "Tierkit" cards — no separate panel, no new tab.
  const tkToolsBtn = $('tk-tools-btn');
  const tkToolsMenu = $('tk-tools-menu');

  function closeTkMenu() { tkToolsMenu.style.display = 'none'; }

  if (tkToolsBtn && tkToolsMenu) {
    tkToolsBtn.onclick = (e) => {
      e.stopPropagation();
      tkToolsMenu.style.display = tkToolsMenu.style.display === 'none' ? '' : 'none';
    };
    document.addEventListener('click', (e) => {
      if (tkToolsMenu.style.display === 'none') return;
      if (!tkToolsMenu.contains(e.target) && e.target !== tkToolsBtn) closeTkMenu();
    });
    tkToolsMenu.querySelectorAll('.tk-tool-item').forEach((btn) => {
      btn.onclick = () => {
        closeTkMenu();
        const tool = btn.getAttribute('data-tk-tool');
        void runTkTool(tool);
      };
    });
  }

  function tkUserBubble(label) {
    const el = document.createElement('div');
    el.className = 'agent-msg agent-msg-user';
    el.style.cssText = 'padding:6px 10px;margin:6px 0;background:var(--bg-input);border-left:3px solid var(--accent);border-radius:4px;font-size:12px';
    el.textContent = '▸ ' + label;
    appendAgent(el);
  }

  function tkCard(title, savedLabel) {
    const el = document.createElement('div');
    el.className = 'agent-msg agent-msg-tool tk-card';
    el.style.cssText = 'margin:8px 0;padding:10px 12px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px';
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:11px';
    const pill = document.createElement('span');
    pill.className = 'pill pill-accent';
    pill.textContent = 'Tierkit';
    header.appendChild(pill);
    const titleEl = document.createElement('span');
    titleEl.style.fontWeight = '600';
    titleEl.textContent = title;
    header.appendChild(titleEl);
    if (savedLabel) {
      const saved = document.createElement('span');
      saved.className = 'dim';
      saved.style.marginLeft = 'auto';
      saved.style.fontFamily = 'var(--mono)';
      saved.textContent = savedLabel;
      header.appendChild(saved);
    }
    el.appendChild(header);
    return el;
  }

  function tkBody(text) {
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:0;padding:8px 10px;background:var(--bg-input);border-radius:4px;font-size:11px;font-family:var(--mono);max-height:320px;overflow:auto;white-space:pre-wrap;word-wrap:break-word';
    pre.textContent = text;
    return pre;
  }

  function tkActions(actions) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;margin-top:6px;flex-wrap:wrap';
    for (const a of actions) {
      const b = document.createElement('button');
      // First action is treated as the "primary" handoff button so the user
      // can spot it without thinking. Subsequent actions stay neutral.
      b.className = a.primary ? 'primary' : 'tiny';
      b.textContent = a.label;
      b.onclick = a.onClick;
      row.appendChild(b);
    }
    return row;
  }

  function tkUncertainty(items) {
    if (!items || items.length === 0) return null;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:6px;padding:6px 8px;background:rgba(245,176,65,0.08);border:1px solid rgba(245,176,65,0.35);border-radius:4px;font-size:10.5px';
    const h = document.createElement('div');
    h.style.fontWeight = '600';
    h.textContent = lang === 'ko' ? '⚠ 검증 필요' : '⚠ Uncertainty';
    wrap.appendChild(h);
    const ul = document.createElement('ul');
    ul.style.cssText = 'margin:4px 0 0 16px;padding:0';
    for (const u of items) {
      const li = document.createElement('li');
      li.textContent = u;
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
    return wrap;
  }

  async function copyTextToClipboard(text) {
    try { await navigator.clipboard.writeText(text); toast(lang === 'ko' ? '복사됨' : 'copied', 'ok'); }
    catch { toast(lang === 'ko' ? '복사 실패' : 'copy failed', 'err'); }
  }

  // v0.19.1: hand the compressed text to Claude Code (the whole point of
  // the gateway). In VS Code we post tk:claude-code to the extension host
  // which then runs the multi-strategy sendToClaudeCode (clipboard +
  // newConversation + focus). In a plain browser session we fall back to
  // copying to clipboard so the user can paste somewhere themselves.
  function sendToClaudeCode(text) {
    if (!text) return;
    if (vsApi && typeof vsApi.postMessage === 'function') {
      vsApi.postMessage({ type: 'tk:claude-code', text });
      toast(lang === 'ko' ? '→ Claude Code' : '→ Claude Code', 'ok');
    } else {
      void copyTextToClipboard(text);
    }
  }

  // v0.20.8: read the auto-forward checkbox. localStorage-persisted so the
  // user's choice survives reloads. Default true (= auto-forward) — the
  // dominant use case is hand-off, not silent compression.
  const TK_AUTOFWD_KEY = 'tk_auto_forward';
  const tkAutoFwdEl = $('tk-auto-forward');
  if (tkAutoFwdEl) {
    const stored = localStorage.getItem(TK_AUTOFWD_KEY);
    // null === never set → default ON; '0' === explicitly OFF; '1' === ON
    tkAutoFwdEl.checked = stored !== '0';
    tkAutoFwdEl.addEventListener('change', () => {
      localStorage.setItem(TK_AUTOFWD_KEY, tkAutoFwdEl.checked ? '1' : '0');
    });
  }
  function autoForwardEnabled() {
    return tkAutoFwdEl ? tkAutoFwdEl.checked : true;
  }
  function maybeAutoForward(text) {
    if (autoForwardEnabled()) sendToClaudeCode(text);
  }

  function savedLabelOf(stats) {
    if (!stats) return '';
    const pct = (stats.savedRatio * 100).toFixed(1);
    return (lang === 'ko' ? '절감 ' : 'saved ') + stats.savedTokens + ' tok (' + pct + '%)';
  }

  function tkError(label, data) {
    const el = tkCard(label + ' — ' + (lang === 'ko' ? '실패' : 'failed'));
    el.style.borderColor = 'var(--err)';
    const msg = document.createElement('div');
    msg.style.cssText = 'font-size:11px;color:var(--err)';
    msg.textContent = (data && (data.message || data.code)) || 'unknown error';
    el.appendChild(msg);
    appendAgent(el);
  }

  function renderCompressedCard(d) {
    const el = tkCard('Compressed task — ' + d.id, savedLabelOf(d.stats));
    el.appendChild(tkBody(d.compressed));
    el.appendChild(tkActions([
      { label: (lang === 'ko' ? '복사 + Claude Code 열기 (⌘V로 붙여넣기)' : 'Copy + open Claude Code (⌘V to paste)'), onClick: () => sendToClaudeCode(d.compressed), primary: true },
      { label: '📋 ' + (lang === 'ko' ? '복사' : 'Copy'), onClick: () => copyTextToClipboard(d.compressed) },
    ]));
    const u = tkUncertainty(d.uncertainty);
    if (u) el.appendChild(u);
    appendAgent(el);
    return el;
  }

  function renderPackCard(p) {
    const el = tkCard('Context Pack — ' + p.id, savedLabelOf(p.stats));
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:10.5px;color:var(--fg-dim);margin-bottom:4px';
    const cached = (p.relevantFileDigests || []).filter((f) => f.cacheHit).length;
    meta.textContent = (lang === 'ko' ? '제목' : 'Title') + ': ' + p.title +
      ' · ' + (p.relevantFileDigests?.length || 0) + ' files' +
      (cached > 0 ? ' (' + cached + ' cached)' : '');
    el.appendChild(meta);
    el.appendChild(tkBody(p.contentMd));
    el.appendChild(tkActions([
      { label: (lang === 'ko' ? '복사 + Claude Code 열기 (⌘V로 붙여넣기)' : 'Copy + open Claude Code (⌘V to paste)'), onClick: () => sendToClaudeCode(p.contentMd), primary: true },
      { label: '📋 ' + (lang === 'ko' ? '전체 복사' : 'Copy pack'), onClick: () => copyTextToClipboard(p.contentMd) },
    ]));
    const u = tkUncertainty(p.uncertainty);
    if (u) el.appendChild(u);
    appendAgent(el);
    return el;
  }

  function renderDigestCard(title, d) {
    const el = tkCard(title + ' — ' + d.id, savedLabelOf(d.stats));
    el.appendChild(tkBody(d.summaryMd));
    el.appendChild(tkActions([
      { label: (lang === 'ko' ? '복사 + Claude Code 열기 (⌘V로 붙여넣기)' : 'Copy + open Claude Code (⌘V to paste)'), onClick: () => sendToClaudeCode(d.summaryMd), primary: true },
      { label: '📋 ' + (lang === 'ko' ? '복사' : 'Copy'), onClick: () => copyTextToClipboard(d.summaryMd) },
    ]));
    const u = tkUncertainty(d.uncertainty);
    if (u) el.appendChild(u);
    appendAgent(el);
    return el;
  }

  // For the 'file' and 'pack' tools we need extra input. Use a small inline prompt rendered
  // as a message bubble in the thread, since VS Code webviews block window.prompt.
  function promptInline(opts) {
    return new Promise((resolve) => {
      const el = document.createElement('div');
      el.className = 'agent-msg agent-msg-tool';
      el.style.cssText = 'margin:8px 0;padding:10px 12px;background:var(--bg-card);border:1px solid var(--accent);border-radius:6px';
      const h = document.createElement('div');
      h.style.cssText = 'font-size:12px;font-weight:600;margin-bottom:6px';
      h.textContent = opts.title;
      el.appendChild(h);
      const fields = {};
      for (const f of opts.fields) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:4px 0';
        const label = document.createElement('label');
        label.style.cssText = 'font-size:11px;min-width:90px;color:var(--fg-dim)';
        label.textContent = f.label;
        row.appendChild(label);
        let input;
        if (f.type === 'checkbox') {
          input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = f.defaultValue === true;
        } else {
          input = document.createElement('input');
          input.type = 'text';
          input.style.cssText = 'flex:1;padding:4px 6px;font-size:11.5px';
          input.placeholder = f.placeholder || '';
          if (f.defaultValue) input.value = f.defaultValue;
        }
        row.appendChild(input);
        el.appendChild(row);
        fields[f.key] = input;
      }
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:6px;margin-top:8px;justify-content:flex-end';
      const cancel = document.createElement('button');
      cancel.className = 'tiny';
      cancel.textContent = lang === 'ko' ? '취소' : 'Cancel';
      cancel.onclick = () => { el.remove(); resolve(null); };
      const run = document.createElement('button');
      run.className = 'primary';
      run.textContent = opts.submitLabel || (lang === 'ko' ? '실행' : 'Run');
      run.onclick = () => {
        const out = {};
        for (const f of opts.fields) {
          const inp = fields[f.key];
          out[f.key] = inp.type === 'checkbox' ? inp.checked : inp.value.trim();
        }
        el.remove();
        resolve(out);
      };
      actions.appendChild(cancel);
      actions.appendChild(run);
      el.appendChild(actions);
      appendAgent(el);
    });
  }

  // v0.21: Tierkit Chat as a streaming proxy for the claude CLI.
  // The webview POSTs the user's message + saved session id; daemon spawns
  // "claude -p" and SSE-forwards stream-json events. We render the user
  // bubble immediately, then a live-updating assistant bubble, plus a small
  // card per tool_use / tool_result so the user sees Claude's MCP activity.
  let tkChatSessionId = null;
  let tkChatAbortCtrl = null;
  // v0.23: one-time hint per chat session when a tool is permission-blocked.
  let tkChatPermHintShown = false;
  function isPermissionDeniedOutput(s) {
    if (!s || typeof s !== 'string') return false;
    return /requires approval|was denied|permission.*denied|denied.*permission|requires.*permission|not allowed|user denied/i.test(s);
  }
  // v0.21.6: cumulative cost across the whole chat session (resets only when
  // the user reloads the webview). Surfaced in the header pill so the user
  // can see in real time how much Claude Code has spent.
  let tkChatTotalCostUsd = 0;
  const tkChatCostMeter = $('tk-chat-cost-meter');
  function updateChatCostMeter() {
    if (!tkChatCostMeter) return;
    if (tkChatTotalCostUsd <= 0) {
      tkChatCostMeter.style.display = 'none';
      return;
    }
    tkChatCostMeter.style.display = '';
    tkChatCostMeter.textContent = '$' + tkChatTotalCostUsd.toFixed(4);
  }

  // v0.21.10: session-cumulative compression savings (Tierkit MCP only).
  // Updated every time Claude calls a tierkit.* digest tool and the result
  // carries a stats.savedTokens field. Tracked separately from chat usage so
  // the user can see both: "I spent X" + "but Tierkit saved me Y".
  let tkChatSavedTokens = 0;
  const tkChatSavedMeter = $('tk-chat-saved-meter');
  function updateSavedMeter() {
    if (!tkChatSavedMeter) return;
    if (tkChatSavedTokens <= 0) {
      tkChatSavedMeter.style.display = 'none';
      return;
    }
    tkChatSavedMeter.style.display = '';
    const k = tkChatSavedTokens >= 1000
      ? (tkChatSavedTokens / 1000).toFixed(1) + 'k'
      : String(tkChatSavedTokens);
    tkChatSavedMeter.textContent = (lang === 'ko' ? '절감 ' : 'saved ') + k + ' tok';
  }

  // v0.21.10: per-session metrics tracking. We bucket all chat traffic by
  // claude's session_id (the one we --resume) so the user can see breakdowns
  // like "this morning's session: 12 turns, 240k in, 8k out, $0.84 spent,
  // 38k tok saved by Tierkit MCP". Stored in localStorage so reloads don't
  // wipe history. Sessions auto-expire after 30 entries (LRU by lastUsedAt).
  const TK_SESSIONS_LS_KEY = 'tk_chat_sessions';
  const TK_SESSIONS_MAX = 30;
  function loadSessions() {
    try {
      const raw = localStorage.getItem(TK_SESSIONS_LS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  }
  function saveSessions(map) {
    try {
      // LRU prune to keep storage bounded.
      const entries = Object.entries(map);
      if (entries.length > TK_SESSIONS_MAX) {
        entries.sort((a, b) => (b[1].lastUsedAt || 0) - (a[1].lastUsedAt || 0));
        const keep = {};
        for (const [k, v] of entries.slice(0, TK_SESSIONS_MAX)) keep[k] = v;
        map = keep;
      }
      localStorage.setItem(TK_SESSIONS_LS_KEY, JSON.stringify(map));
    } catch { /* quota or disabled */ }
  }
  function recordSessionEvent(sessionId, patch) {
    if (!sessionId) return;
    const map = loadSessions();
    const now = Date.now();
    const cur = map[sessionId] || {
      sessionId,
      startedAt: now,
      lastUsedAt: now,
      turns: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      savedTokens: 0,
    };
    cur.lastUsedAt = now;
    if (patch.turn) cur.turns += 1;
    if (patch.tokensIn) cur.tokensIn += patch.tokensIn;
    if (patch.tokensOut) cur.tokensOut += patch.tokensOut;
    if (patch.costUsd) cur.costUsd += patch.costUsd;
    if (patch.savedTokens) cur.savedTokens += patch.savedTokens;
    map[sessionId] = cur;
    saveSessions(map);
    loadChatSessions();
  }
  /**
   * v0.22: chat-tab sidebar. Fetches the session index from the daemon and
   * joins on the localStorage metrics map so each row shows id, preview,
   * mtime, and (if we've seen it before in Tierkit Chat) token + cost stats.
   * Highlights tkChatSessionId so the user always sees which session the
   * active thread belongs to.
   */
  async function loadChatSessions() {
    const host = $('tk-chat-session-list');
    if (!host) return;
    let sessions;
    try {
      const r = await jget('/v1/claude-code/sessions');
      sessions = r.sessions || [];
    } catch (e) {
      host.innerHTML = '<div class="empty dim">' + escapeHtml(lang === 'ko' ? '세션 불러오기 실패' : 'Failed to load sessions') +
        ' · <button class="tiny" id="tk-chat-sessions-retry">' + escapeHtml(lang === 'ko' ? '재시도' : 'Retry') + '</button></div>';
      const retry = $('tk-chat-sessions-retry');
      if (retry) retry.onclick = () => loadChatSessions();
      return;
    }
    if (sessions.length === 0) {
      host.innerHTML = '<div class="empty dim">' + escapeHtml(lang === 'ko' ? '아직 채팅 세션 없음' : 'No chat sessions yet') + '</div>';
      return;
    }
    const meta = loadSessions(); // existing helper for tk_chat_sessions localStorage
    host.innerHTML = '';
    for (const s of sessions) {
      const row = document.createElement('div');
      row.className = 'chat-session-row';
      if (s.id === tkChatSessionId) row.classList.add('selected');
      row.dataset.sessionId = s.id;
      const m = meta[s.id];
      const tokens = m ? ((m.tokensIn || 0) + (m.tokensOut || 0)) : 0;
      const cost = m ? (m.costUsd || 0) : 0;
      const tokensShort = tokens >= 1000 ? (tokens / 1000).toFixed(1) + 'k' : String(tokens);
      const when = (() => {
        try {
          const d = new Date(s.mtime);
          return d.toLocaleString(lang === 'ko' ? 'ko-KR' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        } catch { return ''; }
      })();
      row.innerHTML =
        '<div class="session-preview">' + escapeHtml(s.preview || s.id.slice(0, 8) + '…') + '</div>' +
        '<div class="session-meta">' + escapeHtml(s.id.slice(0, 8)) + ' · ' + escapeHtml(when) + ' · ' + escapeHtml(String(s.messageCount)) + ' msg' +
        (tokens ? ' · ' + tokensShort + ' tok' : '') +
        (cost > 0 ? ' · $' + cost.toFixed(4) : '') +
        '</div>';
      row.onclick = () => loadChatSessionMessages(s.id);
      host.appendChild(row);
    }
  }

  /**
   * Click a session row → fetch its message thread → render into agent-thread
   * using the same bubble factories the live chat uses. Sets tkChatSessionId
   * so the next composer send continues that session via claude --resume.
   */
  async function loadChatSessionMessages(id) {
    let data;
    try {
      data = await jget('/v1/claude-code/sessions/' + encodeURIComponent(id));
    } catch (e) {
      // jget throws on non-2xx. Map 404 to a friendly "session vanished" toast.
      const msg = /HTTP 404/.test(String(e.message))
        ? (lang === 'ko' ? '이 세션은 사라졌습니다 — 다른 세션을 선택해주세요' : 'Session no longer exists — pick another')
        : String(e.message);
      toast(msg, 'err');
      loadChatSessions(); // sync the sidebar with reality
      closeSessionsDropdown();
      return;
    }

    tkChatSessionId = id;
    const thread = $('agent-thread');
    if (!thread) return;
    thread.innerHTML = '';

    // Walk messages and synthesize bubbles. We reuse the live chat factories
    // so historical view and in-flight view look the same.
    // Note: chatUserBubble() is the existing helper that renders user messages
    // (appends to agentThread via appendAgent). No separate appendUserBubble needed.
    // Bubble grouping: one bubble per user turn. We reset currentAssistantBubble
    // only on "user" role, so an assistant-emitted sequence (text -> tool_use ->
    // tool_result -> more text) collapses into a single bubble -- matching how
    // the live streamChat() renders one chat turn. Consecutive assistant
    // events with no intervening user (rare sub-agent flows) currently merge;
    // acceptable trade-off for matching live rendering.
    let currentAssistantBubble = null;
    for (const m of (data.messages || [])) {
      if (m.role === 'user') {
        currentAssistantBubble = null;
        chatUserBubble(m.text || '');
      } else if (m.role === 'assistant') {
        if (m.text) {
          if (!currentAssistantBubble) currentAssistantBubble = chatAssistantBubble();
          currentAssistantBubble.appendText(m.text);
        } else if (m.toolUse) {
          if (!currentAssistantBubble) currentAssistantBubble = chatAssistantBubble();
          currentAssistantBubble.addToolUse(m.toolUse);
        }
      } else if (m.role === 'tool') {
        if (currentAssistantBubble) {
          currentAssistantBubble.addToolResult({ toolUseId: m.toolResultFor, output: m.text, isError: false });
        }
      }
    }
    if (currentAssistantBubble) currentAssistantBubble.finalize({});
    loadChatSessions(); // refresh highlight
    closeSessionsDropdown();
  }

  // Extract { savedTokens, savedRatio, beforeTokens, afterTokens } from a
  // tool_result output. The output may be a stringified JSON envelope
  // (from MCP) or an object — handle both. Returns null if no stats are
  // present (e.g. the tool is one of the non-digest ones like Bash).
  function extractDigestStats(output) {
    let parsed = output;
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { return null; }
    }
    if (!parsed || typeof parsed !== 'object') return null;
    // The envelope shape is { ok: true, data: { stats: {...} } }; the digest
    // itself may also surface stats at the top level.
    const stats = parsed?.data?.stats ?? parsed?.stats ?? null;
    if (!stats || typeof stats !== 'object') return null;
    const saved = Number(stats.savedTokens);
    if (!Number.isFinite(saved) || saved <= 0) return null;
    return {
      savedTokens: saved,
      savedRatio: Number(stats.savedRatio) || 0,
      beforeTokens: Number(stats.beforeTokens) || 0,
      afterTokens: Number(stats.afterTokens) || 0,
    };
  }

  // v0.21.3: permission mode picker (Settings card + chat composer).
  // localStorage-persisted so the user's choice survives reloads.
  const TK_PERM_LS_KEY = 'tk_perm_mode';
  const tkPermSel = $('tk-perm-mode');
  if (tkPermSel) {
    const stored = localStorage.getItem(TK_PERM_LS_KEY);
    const valid = ['acceptEdits', 'bypassPermissions', 'default', 'plan'];
    tkPermSel.value = valid.indexOf(stored) >= 0 ? stored : 'acceptEdits';
    tkPermSel.addEventListener('change', () => {
      localStorage.setItem(TK_PERM_LS_KEY, tkPermSel.value);
    });
  }
  function currentPermMode() {
    if (tkPermSel) return tkPermSel.value || 'acceptEdits';
    return localStorage.getItem(TK_PERM_LS_KEY) || 'acceptEdits';
  }

  // v0.21.3: Stop button that aborts the in-flight chat turn. Shown only
  // while streamChat is running; hidden again on completion / error.
  const tkChatStopBtn = $('tk-chat-stop');
  function showStopButton(show) {
    if (!tkChatStopBtn) return;
    tkChatStopBtn.style.display = show ? '' : 'none';
  }
  if (tkChatStopBtn) {
    tkChatStopBtn.onclick = () => {
      if (tkChatAbortCtrl) {
        try { tkChatAbortCtrl.abort(); } catch (_) { /* */ }
        toast(lang === 'ko' ? '중단됨' : 'stopped', 'ok');
      }
    };
  }

  // v0.21.10: layout toggle button — switches the user to the main editor
  // panel view (mobile-friendly). Sends a postMessage that extension.ts
  // routes to vscode.commands.executeCommand('tierkit.openInPanel').
  const tkOpenPanelBtn = $('tk-open-panel');
  if (tkOpenPanelBtn) {
    tkOpenPanelBtn.onclick = () => {
      if (vsApi && typeof vsApi.postMessage === 'function') {
        vsApi.postMessage({ type: 'tk:open-panel' });
      } else {
        toast(lang === 'ko' ? 'VS Code 내부에서만 동작' : 'VS Code only', 'err');
      }
    };
  }

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

  function newChatSession() {
    tkChatSessionId = null;
    tkChatPermHintShown = false;
    const thread = $('agent-thread');
    if (thread) {
      thread.innerHTML = '';
      // Restore the original empty placeholder (matches the static HTML's <div class="agent-empty"> child).
      const empty = document.createElement('div');
      empty.className = 'agent-empty';
      empty.style.lineHeight = '1.6';
      empty.innerHTML = i18n.agentEmpty || TK_INITIAL_AGENT_EMPTY_HTML;
      thread.appendChild(empty);
    }
    loadChatSessions();
  }

  function escapeHtmlMd(s) {
    return String(s).replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  }

  function chatUserBubble(text) {
    const el = document.createElement('div');
    el.className = 'agent-msg agent-msg-user';
    el.style.cssText = 'padding:10px 14px;margin:14px 0 6px;background:var(--bg-input);border-left:3px solid var(--accent);border-radius:4px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word';
    el.textContent = text;
    appendAgent(el);
  }

  // v0.21.5: lightweight Markdown renderer for assistant text.
  // Handles only the patterns Claude actually emits often:
  //   - fenced code blocks (triple-backtick lang ... triple-backtick)
  //   - inline code (single-backtick x single-backtick)
  //   - bold (asterisk-asterisk x asterisk-asterisk)
  //   - headings (## x, ### x)
  //   - bullets (- x)
  // Everything else stays as preserved whitespace. We never use innerHTML on
  // unsanitized content — every interpolation goes through escapeHtmlMd().
  function renderMarkdown(src) {
    if (!src) return '';
    const parts = [];
    let i = 0;
    while (i < src.length) {
      // Fenced code block.
      if (src.startsWith('\`\`\`', i)) {
        const close = src.indexOf('\`\`\`', i + 3);
        if (close >= 0) {
          const inside = src.slice(i + 3, close);
          // Drop optional language hint on the first line.
          const nl = inside.indexOf('\\n');
          const body = nl >= 0 ? inside.slice(nl + 1) : inside;
          parts.push('<pre style="margin:8px 0;padding:8px 10px;background:var(--bg-input);border-radius:4px;font-size:11.5px;font-family:var(--mono);overflow-x:auto;white-space:pre">' + escapeHtmlMd(body) + '</pre>');
          i = close + 3;
          continue;
        }
      }
      // End of line — find next significant marker.
      const nextLine = src.indexOf('\\n', i);
      const lineEnd = nextLine < 0 ? src.length : nextLine;
      let line = src.slice(i, lineEnd);
      // Headings.
      const headingMatch = /^(#{2,4})\\s+(.+)$/.exec(line);
      if (headingMatch) {
        const lvl = Math.min(headingMatch[1].length, 4);
        const size = lvl === 2 ? '14px' : lvl === 3 ? '13px' : '12.5px';
        parts.push('<div style="font-weight:700;font-size:' + size + ';margin:10px 0 4px">' + escapeHtmlMd(headingMatch[2]) + '</div>');
      } else if (/^\\s*[-*]\\s+/.test(line)) {
        const inner = line.replace(/^\\s*[-*]\\s+/, '');
        parts.push('<div style="margin-left:14px;text-indent:-12px">• ' + inlineMarkdown(inner) + '</div>');
      } else if (line.length > 0) {
        parts.push('<div>' + inlineMarkdown(line) + '</div>');
      } else {
        parts.push('<div style="height:6px"></div>');
      }
      i = lineEnd + 1;
    }
    return parts.join('');
  }
  function inlineMarkdown(s) {
    // Order matters: process code (longest), then bold.
    let out = '';
    let i = 0;
    while (i < s.length) {
      // Inline code.
      if (s[i] === '\`') {
        const close = s.indexOf('\`', i + 1);
        if (close > i) {
          out += '<code style="padding:1px 5px;background:var(--bg-input);border-radius:3px;font-family:var(--mono);font-size:11px">' + escapeHtmlMd(s.slice(i + 1, close)) + '</code>';
          i = close + 1;
          continue;
        }
      }
      // Bold (**...**)
      if (s[i] === '*' && s[i + 1] === '*') {
        const close = s.indexOf('**', i + 2);
        if (close > i + 1) {
          out += '<b>' + escapeHtmlMd(s.slice(i + 2, close)) + '</b>';
          i = close + 2;
          continue;
        }
      }
      out += escapeHtmlMd(s[i]);
      i += 1;
    }
    return out;
  }

  // Pick a concise one-line summary of a tool_use input. Different tools have
  // different "main" fields — we surface the most useful one as the header so
  // the user can tell at a glance what Claude is doing without expanding.
  function summarizeToolInput(name, input) {
    if (!input || typeof input !== 'object') return '';
    const o = input;
    if (name === 'Bash' && typeof o.command === 'string') {
      return o.command.length > 80 ? o.command.slice(0, 80) + '…' : o.command;
    }
    if ((name === 'Read' || name === 'Write' || name === 'Edit') && typeof o.file_path === 'string') {
      return o.file_path;
    }
    if (name === 'Grep' && typeof o.pattern === 'string') {
      return o.pattern + (o.path ? ' in ' + o.path : '');
    }
    if (name === 'Glob' && typeof o.pattern === 'string') {
      return o.pattern;
    }
    // MCP tools (tierkit.*) often have a small primary field — try a few.
    if (typeof o.path === 'string') return o.path;
    if (typeof o.command === 'string') return o.command.slice(0, 80);
    if (typeof o.query === 'string') return o.query.slice(0, 80);
    if (typeof o.message === 'string') return o.message.slice(0, 80);
    // Fall back to compact JSON.
    try { const s = JSON.stringify(o); return s.length > 80 ? s.slice(0, 80) + '…' : s; } catch { return ''; }
  }

  /**
   * v0.22: render Anthropic's built-in AskUserQuestion tool_use as an
   * interactive form (radio for single-select, checkbox for multi-select,
   * plus a free-form "Other" input per question). On submit, format the
   * answer as Markdown and pipe through streamChat() so Claude continues
   * via --resume.
   *
   * Why this exists: claude -p closes stdin after the initial prompt, so
   * AskUserQuestion's tool_use cannot receive a tool_result inline. The
   * agent's turn ends with the tool failing. Re-sending the answer as a
   * NEW message via --resume is the only honest path to bidirectional
   * comms without rewriting chatWithClaude to interactive mode.
   *
   * @param {{ id?: string, input?: { questions?: Array<{ question: string, header?: string, multiSelect?: boolean, options?: Array<{ label: string, description?: string }> }> } }} d
   * @param {HTMLElement} bodyEl — the agent-thread node to append into
   */
  function renderAskUserQuestion(d, bodyEl) {
    const questions = (d && d.input && Array.isArray(d.input.questions)) ? d.input.questions : [];
    if (questions.length === 0) return false; // caller falls back to generic card
    const card = document.createElement('div');
    card.className = 'tk-aqq-card';
    card.dataset.toolId = d.id || '';
    // Restrict to a safe alphanumeric subset for use in HTML attribute values and
    // CSS-style name attributes; Anthropic's tool_use ids match this pattern today
    // (toulu_<base64-ish>), but a future change or malformed input shouldn't be
    // able to inject attribute content.
    const rawId = d.id || 'aqq-' + Math.random().toString(36).slice(2, 10);
    const toolId = String(rawId).replace(/[^a-zA-Z0-9_-]/g, '');
    const titleLabel = lang === 'ko' ? '🤔 Claude가 묻습니다' : '🤔 Claude is asking';
    const otherLabel = lang === 'ko' ? '기타:' : 'Other:';
    const submitLabel = lang === 'ko' ? '답변 제출' : 'Submit answer';
    const emptyAnswerLabel = lang === 'ko' ? '최소 하나는 선택하거나 기타에 입력해주세요.' : 'Pick at least one option or type in Other.';
    const sentLabel = lang === 'ko' ? '✓ 전송됨' : '✓ Sent';
    const multiBadge = lang === 'ko' ? '[복수 선택]' : '[multi-select]';
    const noAnswerLabel = lang === 'ko' ? '(답변 없음)' : '(no answer)';

    let html = '<div class="tk-aqq-title"><span>' + escapeHtmlMd(titleLabel) + '</span></div>';
    for (let qi = 0; qi < questions.length; qi++) {
      const q = questions[qi];
      const qText = q && typeof q.question === 'string' ? q.question : '';
      const header = q && typeof q.header === 'string' ? q.header : '';
      const multi = !!(q && q.multiSelect);
      const options = (q && Array.isArray(q.options)) ? q.options : [];
      const inputType = multi ? 'checkbox' : 'radio';
      const groupName = 'tk-aqq-' + toolId + '-' + qi;

      html += '<div class="tk-aqq-q" data-q-index="' + qi + '">';
      if (header) html += '<span class="tk-aqq-q-header">' + escapeHtmlMd(header) + '</span>';
      html += '<div class="tk-aqq-q-text">' + escapeHtmlMd(qText) + (multi ? ' <span class="dim" style="font-weight:normal;font-size:10px">' + escapeHtmlMd(multiBadge) + '</span>' : '') + '</div>';
      for (let oi = 0; oi < options.length; oi++) {
        const opt = options[oi] || {};
        const optLabel = typeof opt.label === 'string' ? opt.label : '';
        const optDesc = typeof opt.description === 'string' ? opt.description : '';
        html += '<label class="tk-aqq-option">';
        html += '<input type="' + inputType + '" name="' + escapeHtmlMd(groupName) + '" value="' + escapeHtmlMd(String(oi)) + '">';
        html += '<span class="tk-aqq-option-text">' + escapeHtmlMd(optLabel);
        if (optDesc) html += '<span class="tk-aqq-option-desc">' + escapeHtmlMd(optDesc) + '</span>';
        html += '</span>';
        html += '</label>';
      }
      // Always-present "Other" free-form input.
      html += '<div class="tk-aqq-other"><span class="dim" style="font-size:11px">' + escapeHtmlMd(otherLabel) + '</span>';
      html += '<input type="text" data-q-other="' + qi + '" placeholder="…">';
      html += '</div>';
      html += '</div>';
    }
    html += '<div class="tk-aqq-actions">';
    html += '<button class="tiny primary" data-aqq-submit>' + escapeHtmlMd(submitLabel) + '</button>';
    html += '</div>';

    card.innerHTML = html;
    bodyEl.appendChild(card);

    const submitBtn = card.querySelector('[data-aqq-submit]');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => {
        // Collect answers per question.
        const parts = [];
        let totalSelected = 0;
        for (let qi = 0; qi < questions.length; qi++) {
          const q = questions[qi];
          const qText = q && typeof q.question === 'string' ? q.question : '';
          const multi = !!(q && q.multiSelect);
          const options = (q && Array.isArray(q.options)) ? q.options : [];
          const groupName = 'tk-aqq-' + toolId + '-' + qi;
          const checked = card.querySelectorAll('input[name="' + groupName + '"]:checked');
          const selectedLabels = [];
          checked.forEach((node) => {
            const idx = parseInt(node.value, 10);
            const opt = options[idx];
            if (opt && typeof opt.label === 'string') selectedLabels.push(opt.label);
          });
          const otherInput = card.querySelector('input[data-q-other="' + qi + '"]');
          const otherText = otherInput && typeof otherInput.value === 'string' ? otherInput.value.trim() : '';
          if (otherText.length > 0) selectedLabels.push(otherText);
          if (selectedLabels.length > 0) totalSelected += 1;
          parts.push({ qText, selected: selectedLabels, multi });
        }
        if (totalSelected === 0) {
          toast(emptyAnswerLabel, 'err');
          return;
        }
        // Format as Markdown user message.
        const lines = [];
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          lines.push('**Q' + (i + 1) + ': ' + p.qText + '**');
          if (p.selected.length === 0) {
            lines.push('- ' + noAnswerLabel);
          } else {
            for (const s of p.selected) lines.push('- ' + s);
          }
          lines.push('');
        }
        const formatted = lines.join('\\n').trim();

        // Disable the form and show "sent" state.
        card.querySelectorAll('input, button').forEach((el) => { el.disabled = true; });
        const actions = card.querySelector('.tk-aqq-actions');
        if (actions) {
          actions.innerHTML = '<span class="tk-aqq-submitted">' + escapeHtmlMd(sentLabel) + '</span>';
        }

        // Send via existing streamChat → /v1/claude-code/chat with current sessionId.
        void streamChat(formatted);
      });
    }
    scrollAgentBottom();
    return true;
  }

  function chatAssistantBubble() {
    const el = document.createElement('div');
    el.className = 'agent-msg agent-msg-assistant';
    el.style.cssText = 'margin:6px 0 14px;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;font-size:13px;line-height:1.55;word-wrap:break-word';
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:10.5px;color:var(--fg-dim)';
    const pill = document.createElement('span');
    pill.className = 'pill pill-accent';
    pill.textContent = 'Claude';
    pill.style.fontSize = '10px';
    header.appendChild(pill);
    const meta = document.createElement('span');
    meta.className = 'tk-chat-meta';
    meta.textContent = lang === 'ko' ? '응답 생성 중…' : 'thinking…';
    header.appendChild(meta);
    el.appendChild(header);
    const body = document.createElement('div');
    body.className = 'tk-chat-body';
    el.appendChild(body);
    appendAgent(el);

    // Accumulate raw assistant text so we can re-render the whole buffer with
    // markdown on each delta (cheaper + simpler than diffing).
    let textBuffer = '';
    let textNode = null;

    function ensureTextNode() {
      if (!textNode) {
        textNode = document.createElement('div');
        textNode.className = 'tk-chat-text';
        body.appendChild(textNode);
      }
      return textNode;
    }

    return {
      el,
      appendText(t) {
        textBuffer += (t || '');
        const node = ensureTextNode();
        // Re-render the whole buffer each chunk. Cheap because Claude turns
        // are usually < 50 KB and JS string rendering is fast.
        node.innerHTML = renderMarkdown(textBuffer);
        scrollAgentBottom();
      },
      addToolUse(d) {
        // Force a new text node next time so tool cards appear AFTER current text.
        textNode = null;
        textBuffer = '';

        // v0.22: Anthropic's built-in AskUserQuestion → interactive form.
        // Falls through to the generic tool_use card if the input is malformed.
        if (d && d.name === 'AskUserQuestion' && d.input && Array.isArray(d.input.questions)) {
          if (renderAskUserQuestion(d, body)) return;
        }

        const card = document.createElement('details');
        card.style.cssText = 'margin:6px 0;border:1px solid var(--border);border-radius:4px;background:var(--bg-input);font-size:11.5px';
        card.dataset.toolId = d.id || '';
        const summary = document.createElement('summary');
        summary.style.cssText = 'padding:6px 10px;cursor:pointer;list-style:none;display:flex;gap:6px;align-items:baseline';
        const summaryText = summarizeToolInput(d.name, d.input);
        summary.innerHTML = '<span>🔧</span><b>' + escapeHtmlMd(d.name) + '</b><span class="dim" style="font-family:var(--mono);font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">' + escapeHtmlMd(summaryText) + '</span>';
        card.appendChild(summary);
        // Full input + result detail (hidden until <details> is opened).
        const detail = document.createElement('div');
        detail.style.cssText = 'padding:6px 10px;border-top:1px solid var(--border);font-family:var(--mono);font-size:10.5px;color:var(--fg-dim);white-space:pre-wrap;word-wrap:break-word';
        try {
          detail.textContent = 'input: ' + JSON.stringify(d.input, null, 2);
        } catch {
          detail.textContent = 'input: <unserializable>';
        }
        card.appendChild(detail);
        body.appendChild(card);
        scrollAgentBottom();
      },
      addToolResult(d) {
        const matching = body.querySelector('[data-tool-id="' + (d.toolUseId || '').replace(/"/g, '') + '"]');
        // v0.22: when the matched card is the interactive AskUserQuestion form,
        // suppress the standard error append. The "Answer questions?" failure is
        // expected — claude -p closed stdin so the tool can't return a result —
        // and the form itself is the recovery path. Showing the raw error inside
        // the form confuses the user (looks like submission failed).
        if (matching && matching.classList && matching.classList.contains('tk-aqq-card')) {
          return;
        }
        const outStr = typeof d.output === 'string' ? d.output : (() => { try { return JSON.stringify(d.output); } catch { return ''; } })();
        // v0.23: permission-denial detection. When claude -p denies a tool call
        // (Bash, run_command, MCP tool) because the current permissionMode
        // doesn't auto-approve it, the user sees only "✗" with no guidance.
        // Surface a one-time inline hint per chat session pointing them at
        // the perm dropdown.
        if (d.isError && isPermissionDeniedOutput(outStr) && !tkChatPermHintShown) {
          tkChatPermHintShown = true;
          const hint = document.createElement('div');
          hint.style.cssText = 'margin:6px 0;padding:8px 10px;background:rgba(245,176,65,0.08);border:1px solid rgba(245,176,65,0.45);border-radius:4px;font-size:11px;color:var(--fg);line-height:1.4';
          hint.textContent = i18n.permDeniedHint || 'Bash or an MCP tool was permission-blocked. Switch the "perm:" dropdown below to "Accept all tools" and retry.';
          body.appendChild(hint);
        }
        const firstLine = outStr.split(/\\r?\\n/)[0] || '';
        const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + '…' : firstLine;

        // v0.21.10: pull compression stats out of the tool envelope. When
        // present (digest tools), we surface a green "절감 X tok (Y%)" badge
        // and accumulate into the session-cumulative saved counter +
        // localStorage per-session record.
        const stats = d.isError ? null : extractDigestStats(d.output);
        if (stats) {
          tkChatSavedTokens += stats.savedTokens;
          updateSavedMeter();
          recordSessionEvent(tkChatSessionId, { savedTokens: stats.savedTokens });
        }

        if (matching) {
          // Update summary line with a small result indicator + savings badge.
          const sum = matching.querySelector('summary');
          if (sum) {
            if (stats) {
              // Green compression badge BEFORE the generic preview tag.
              const pct = (stats.savedRatio * 100).toFixed(0);
              const savedShort = stats.savedTokens >= 1000
                ? (stats.savedTokens / 1000).toFixed(1) + 'k'
                : String(stats.savedTokens);
              const badge = document.createElement('span');
              badge.style.cssText = 'margin-left:auto;font-size:10px;padding:1px 6px;background:rgba(74,222,128,0.15);border:1px solid rgba(74,222,128,0.4);color:rgb(74,222,128);border-radius:8px;font-family:var(--mono)';
              badge.textContent = (lang === 'ko' ? '절감 ' : 'saved ') + savedShort + ' tok (' + pct + '%)';
              badge.title = 'before ' + stats.beforeTokens + ' tok → after ' + stats.afterTokens + ' tok';
              sum.appendChild(badge);
            } else {
              const tag = document.createElement('span');
              tag.style.cssText = 'margin-left:auto;font-size:10px;color:' + (d.isError ? 'var(--err)' : 'var(--fg-dim)');
              tag.textContent = d.isError ? '✗' : (preview ? '↳ ' + preview : '↳ ok');
              sum.appendChild(tag);
            }
          }
          // Add full output to the detail body.
          const detail = matching.querySelector('div');
          if (detail) {
            const out = document.createElement('div');
            out.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px dashed var(--border);color:' + (d.isError ? 'var(--err)' : 'var(--fg-dim)');
            out.textContent = (d.isError ? 'error: ' : 'output: ') + outStr;
            detail.appendChild(out);
          }
        } else {
          // Orphan result (no matching tool_use card) — render as a standalone line.
          const card = document.createElement('div');
          card.style.cssText = 'margin:4px 0;padding:4px 10px;font-size:10.5px;color:var(--fg-dim);font-family:var(--mono)';
          card.textContent = '↳ ' + preview;
          body.appendChild(card);
        }
        // Re-enable text streaming into a new node after the tool block.
        textNode = null;
        textBuffer = '';
        scrollAgentBottom();
      },
      finalize(d) {
        meta.textContent = '';
        const parts = [];
        if (typeof d.costUsd === 'number') parts.push('$' + d.costUsd.toFixed(4));
        if (d.usage && typeof d.usage.input_tokens === 'number') {
          parts.push(d.usage.input_tokens + ' in / ' + (d.usage.output_tokens || 0) + ' out tok');
        }
        meta.textContent = parts.join(' · ');
        if (d.text && body.textContent === '') {
          // Fallback: if we never received any assistant-message events,
          // render the final result text as the body.
          ensureTextNode().innerHTML = renderMarkdown(d.text);
        }
      },
      markError(e) {
        meta.textContent = (lang === 'ko' ? '오류: ' : 'error: ') + (e?.code || '') + ' ' + (e?.message || '');
        meta.style.color = 'var(--err)';
        el.style.borderColor = 'var(--err)';
      },
    };
  }

  async function streamChat(message) {
    if (tkChatAbortCtrl) {
      // A previous turn is still in-flight; cancel it before sending a new one.
      try { tkChatAbortCtrl.abort(); } catch { /* */ }
    }
    chatUserBubble(message);
    const bubble = chatAssistantBubble();
    const ac = new AbortController();
    tkChatAbortCtrl = ac;
    showStopButton(true);
    // v0.21.6: update the chat header pill so the user sees "running…" with
    // accent color while Claude is streaming.
    setAgentRunning(true);

    const body = { message, permissionMode: currentPermMode() };
    if (tkChatSessionId) body.sessionId = tkChatSessionId;

    // v0.21.1: use transport.stream() instead of raw fetch — VS Code webviews
    // are CSP-blocked from direct fetch, but the message router proxies via
    // the extension host. The proxy strips SSE event names and only yields
    // data payloads, so we dispatch by payload.type (which the daemon always
    // includes inside the JSON).
    try {
      for await (const chunk of transport.stream('/v1/claude-code/chat', {
        method: 'POST',
        body,
        signal: ac.signal,
      })) {
        if (!chunk || !chunk.data) continue;
        let payload;
        try { payload = JSON.parse(chunk.data); } catch { continue; }
        if (!payload || typeof payload.type !== 'string') continue;
        handleChatEvent(payload.type, payload, bubble);
      }
    } catch (err) {
      if (!(err && err.name === 'AbortError')) {
        bubble.markError({ code: 'stream-error', message: String(err && err.message || err) });
      } else {
        // Aborted: annotate the assistant bubble so the user sees it was stopped.
        bubble.markError({ code: 'aborted', message: lang === 'ko' ? '사용자가 중단함' : 'stopped by user' });
      }
    } finally {
      tkChatAbortCtrl = null;
      showStopButton(false);
      setAgentRunning(false);
    }
  }

  function handleChatEvent(event, data, bubble) {
    switch (event) {
      case 'session':
        if (data.sessionId) tkChatSessionId = data.sessionId;
        return;
      case 'assistant-message':
        bubble.appendText(data.text || '');
        return;
      case 'delta':
        bubble.appendText(data.text || '');
        return;
      case 'tool-use':
        bubble.addToolUse(data);
        return;
      case 'tool-result':
        bubble.addToolResult(data);
        return;
      case 'result':
        if (data.sessionId) tkChatSessionId = data.sessionId;
        // v0.21.6: accumulate session-level token + cost so the header pill
        // shows real-time usage. The bubble itself still shows this turn's
        // numbers via finalize().
        {
          const inT = (data.usage && Number(data.usage.input_tokens)) || 0;
          const outT = (data.usage && Number(data.usage.output_tokens)) || 0;
          const cost = typeof data.costUsd === 'number' ? data.costUsd : 0;
          if (inT || outT) {
            agentSessionTokens += inT + outT;
            updateUsageMeter();
          }
          if (cost > 0) {
            tkChatTotalCostUsd += cost;
            updateChatCostMeter();
          }
          // v0.21.10: persist per-session metrics. Saved tokens get folded in
          // separately via the tool_result path (extractDigestStats) — we just
          // re-emit a recordSessionEvent so this turn shows up even if no MCP
          // compression tool was called.
          recordSessionEvent(data.sessionId || tkChatSessionId, {
            turn: true,
            tokensIn: inT,
            tokensOut: outT,
            costUsd: cost,
          });
        }
        bubble.finalize(data);
        return;
      case 'error':
        bubble.markError(data);
        return;
      case 'done':
        return;
    }
  }

  async function runTkTool(tool) {
    switch (tool) {
      case 'compress': {
        const text = agentInput.value.trim();
        if (!text) {
          toast(lang === 'ko' ? '입력창에 작업을 적어주세요' : 'type a task in the input first', 'err');
          return;
        }
        tkUserBubble((lang === 'ko' ? '압축: ' : 'compress: ') + text);
        agentInput.value = '';
        const body = { command: text };
        const refineId = (localStorage.getItem('tk_refine_profile_id') || '').trim();
        if (refineId) body.refine = { profileId: refineId };
        try {
          const r = await jpost('/v1/digest/command', body);
          if (!r.ok) { tkError('Compress', r.data); return; }
          renderCompressedCard(r.data.digest);
          // v0.20.8: auto-forward when the toggle is ON (default).
          maybeAutoForward(r.data.digest.compressed);
        } catch (e) { tkError('Compress', { message: e.message }); }
        return;
      }
      case 'file': {
        const out = await promptInline({
          title: lang === 'ko' ? '파일 digest 생성' : 'Digest a workspace file',
          fields: [
            { key: 'path', label: 'path', type: 'text', placeholder: 'src/components/Foo.tsx' },
            { key: 'force', label: 'force refresh', type: 'checkbox' },
          ],
          submitLabel: lang === 'ko' ? '생성' : 'Digest',
        });
        if (!out || !out.path) return;
        tkUserBubble((lang === 'ko' ? '파일 digest: ' : 'digest file: ') + out.path);
        try {
          const r = await jpost('/v1/digest/file', { path: out.path, forceRefresh: out.force });
          if (!r.ok) { tkError('Digest file', r.data); return; }
          renderDigestCard(lang === 'ko' ? '파일 digest' : 'File digest', r.data.digest);
          maybeAutoForward(r.data.digest.summaryMd);
        } catch (e) { tkError('Digest file', { message: e.message }); }
        return;
      }
      case 'diff':
      case 'diff-staged': {
        const staged = tool === 'diff-staged';
        tkUserBubble(staged ? (lang === 'ko' ? 'staged diff 요약' : 'staged diff summary') : (lang === 'ko' ? 'diff 요약' : 'diff summary'));
        try {
          const r = await jpost('/v1/digest/diff', { staged });
          if (!r.ok) { tkError(staged ? 'Staged diff' : 'Diff', r.data); return; }
          renderDigestCard(staged ? (lang === 'ko' ? 'Staged diff' : 'Staged diff') : (lang === 'ko' ? 'Diff 요약' : 'Diff summary'), r.data.digest);
          maybeAutoForward(r.data.digest.summaryMd);
        } catch (e) { tkError('Diff', { message: e.message }); }
        return;
      }
      case 'pack': {
        const cmdFromInput = agentInput.value.trim();
        const out = await promptInline({
          title: lang === 'ko' ? 'Context Pack 생성' : 'Build Context Pack',
          fields: [
            { key: 'command', label: lang === 'ko' ? '작업 설명' : 'command', type: 'text', defaultValue: cmdFromInput, placeholder: lang === 'ko' ? '예: 관리자 메뉴 CRUD 추가' : 'e.g. Add CRUD for AdminMenuForm' },
            { key: 'files', label: lang === 'ko' ? '파일 (쉼표)' : 'files (csv)', type: 'text', placeholder: 'src/a.ts, src/b.ts' },
            { key: 'includeDiff', label: 'include diff', type: 'checkbox', defaultValue: true },
            { key: 'stagedDiff', label: 'staged only', type: 'checkbox' },
          ],
          submitLabel: lang === 'ko' ? '생성' : 'Build',
        });
        if (!out) return;
        const files = out.files ? out.files.split(',').map((s) => s.trim()).filter(Boolean) : [];
        tkUserBubble(lang === 'ko' ? 'Context Pack 생성' : 'build Context Pack');
        if (cmdFromInput && out.command === cmdFromInput) agentInput.value = '';
        try {
          const r = await jpost('/v1/context/pack', {
            command: out.command || undefined,
            files: files.length > 0 ? files : undefined,
            includeDiff: out.includeDiff === true,
            stagedDiff: out.stagedDiff === true,
          });
          if (!r.ok) { tkError('Context Pack', r.data); return; }
          renderPackCard(r.data.pack);
          maybeAutoForward(r.data.pack.contentMd);
        } catch (e) { tkError('Context Pack', { message: e.message }); }
        return;
      }
    }
  }

  // ── v0.18 Context Gateway Settings card: refine picker + cache stats ──────
  const TK_REFINE_LS_KEY = 'tk_refine_profile_id';
  const tkRefineSelect = $('tk-refine-profile');
  const tkRefineClear = $('tk-refine-clear');
  const tkCacheStats = $('tk-cache-stats');
  const tkCacheRefresh = $('tk-cache-refresh');
  const tkCacheClear = $('tk-cache-clear');

  function humanBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  async function refreshTkRefineProfiles() {
    if (!tkRefineSelect) return;
    let entries = [];
    try {
      const r = await jget('/v1/models');
      entries = Array.isArray(r.entries) ? r.entries : [];
    } catch { /* keep empty */ }
    // v0.21.9: show ALL local-device profiles, not just viable+enabled ones,
    // so the user sees what's available + can tell why each one is unselectable.
    // Public-cloud is still excluded — refine should never silently spend money.
    const local = entries
      .filter((e) => e && e.profile && e.profile.kind === 'local-device')
      .map((e) => ({
        id: e.id,
        model: e.profile.model || '',
        viable: e.viability?.ok !== false,
        viableReason: e.viability?.reason || '',
        // ModelProfile.enabled is an optional boolean. Treat explicit false as disabled.
        enabled: e.profile.enabled !== false,
      }));
    // Viable + enabled candidates are the only ones we'll auto-select.
    const usable = local.filter((m) => m.viable && m.enabled);

    const saved = (localStorage.getItem(TK_REFINE_LS_KEY) || '').trim();
    tkRefineSelect.innerHTML = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = lang === 'ko' ? '(룰만 — LLM 사용 안 함)' : '(rule-only — no LLM)';
    tkRefineSelect.appendChild(none);
    for (const m of local) {
      const opt = document.createElement('option');
      opt.value = m.id;
      let label = m.id + (m.model ? ' — ' + m.model : '');
      if (!m.enabled) label += ' · ' + (lang === 'ko' ? '비활성' : 'disabled');
      else if (!m.viable) label += ' · ' + (m.viableReason || (lang === 'ko' ? '실행 불가' : 'unreachable'));
      opt.textContent = label;
      if (!m.enabled || !m.viable) {
        opt.disabled = true;
        opt.style.color = 'var(--fg-dim)';
      }
      tkRefineSelect.appendChild(opt);
    }

    // Resolve selection priority:
    //   1. saved (if still usable) — respects user choice
    //   2. first usable profile — auto-pick so refine works out of the box
    //   3. rule-only fallback
    if (saved && usable.find((m) => m.id === saved)) {
      tkRefineSelect.value = saved;
    } else if (saved && !usable.find((m) => m.id === saved)) {
      // Saved profile no longer exists or became unusable — clear the stale value.
      localStorage.removeItem(TK_REFINE_LS_KEY);
      // Fall through to auto-select.
    }
    if (!tkRefineSelect.value && usable.length > 0) {
      // Auto-pick the first usable profile and persist it so the next reload
      // doesn't ask the user to choose again.
      tkRefineSelect.value = usable[0].id;
      localStorage.setItem(TK_REFINE_LS_KEY, usable[0].id);
    }

    // Hint area below the picker so the user knows WHY no profile is selected
    // when the list is empty or all profiles are disabled/unviable.
    const hintEl = document.getElementById('tk-refine-hint');
    if (hintEl) {
      if (local.length === 0) {
        hintEl.textContent = lang === 'ko'
          ? '로컬 모델이 발견되지 않았습니다. Ollama를 설치하고 모델을 받은 뒤 (예: ollama pull qwen2.5-coder:3b) 데몬을 재시작하세요.'
          : 'No local-device profiles found. Install Ollama + pull a model (e.g. ollama pull qwen2.5-coder:3b), then restart the daemon.';
        hintEl.style.color = 'var(--warn)';
      } else if (usable.length === 0) {
        hintEl.textContent = lang === 'ko'
          ? '로컬 모델은 있지만 모두 비활성/실행 불가 상태입니다. 모델 목록에서 활성화하거나 ollama serve를 실행하세요.'
          : 'Local profiles exist but are all disabled or unreachable. Enable one in the Models card or run "ollama serve".';
        hintEl.style.color = 'var(--warn)';
      } else {
        hintEl.textContent = '';
      }
    }
  }

  async function refreshTkCacheStats() {
    if (!tkCacheStats) return;
    try {
      const r = await jget('/v1/digest/cache');
      const s = r.stats || {};
      if (s.empty) {
        tkCacheStats.textContent = lang === 'ko' ? '캐시 비어 있음 (' + s.relativePath + ')' : 'empty (' + s.relativePath + ')';
      } else {
        tkCacheStats.textContent = s.count + ' digests · ' + humanBytes(s.totalBytes) + ' · ' + s.relativePath;
      }
    } catch (e) {
      tkCacheStats.textContent = (lang === 'ko' ? '오류: ' : 'error: ') + e.message;
    }
  }

  if (tkRefineSelect) {
    tkRefineSelect.onchange = () => {
      const v = tkRefineSelect.value || '';
      if (v) localStorage.setItem(TK_REFINE_LS_KEY, v);
      else localStorage.removeItem(TK_REFINE_LS_KEY);
    };
  }
  if (tkRefineClear) {
    tkRefineClear.onclick = () => {
      localStorage.removeItem(TK_REFINE_LS_KEY);
      if (tkRefineSelect) tkRefineSelect.value = '';
      toast(lang === 'ko' ? '룰만 사용으로 초기화' : 'reset to rule-only', 'ok');
    };
  }
  if (tkCacheRefresh) {
    tkCacheRefresh.onclick = () => { void refreshTkCacheStats(); };
  }
  if (tkCacheClear) {
    tkCacheClear.onclick = async () => {
      try {
        const r = await jpost('/v1/digest/cache/clear', {});
        if (!r.ok) {
          toast((lang === 'ko' ? '캐시 비우기 실패: ' : 'clear failed: ') + (r.data?.message || r.status), 'err');
          return;
        }
        toast((lang === 'ko' ? '' : '') + r.data.removedCount + (lang === 'ko' ? '개 삭제됨' : ' digests cleared'), 'ok');
        await refreshTkCacheStats();
      } catch (e) {
        toast((lang === 'ko' ? '캐시 비우기 실패: ' : 'clear failed: ') + e.message, 'err');
      }
    };
  }

  // ── v0.20: Claude Code auto-wire controls ─────────────────────────────────
  const tkClaudeStatus = $('tk-claude-status');
  const tkClaudeConnectWs = $('tk-claude-connect-ws');
  const tkClaudeConnectGlobal = $('tk-claude-connect-global');
  const tkClaudeDisconnect = $('tk-claude-disconnect');

  async function refreshTkClaudeStatus() {
    if (!tkClaudeStatus) return;
    const tkClaudePaths = $('tk-claude-paths');
    const tkClaudeVerify = $('tk-claude-verify');
    try {
      const r = await jget('/v1/claude-code/status');
      const s = r.status || {};
      const parts = [];
      parts.push((lang === 'ko' ? '워크스페이스: ' : 'workspace: ') + (s.connectedWorkspace ? '✓' : '✗'));
      parts.push((lang === 'ko' ? '전역: ' : 'global: ') + (s.connectedGlobal ? '✓' : '✗'));
      parts.push('CLAUDE.md: ' + (s.instructionsInClaudeMd ? '✓' : '✗'));
      tkClaudeStatus.textContent = parts.join(' · ');

      // Show clickable file paths only when at least one scope is connected.
      // The user can verify the actual JSON we wrote by clicking the path.
      const isConnected = s.connectedGlobal || s.connectedWorkspace || s.instructionsInClaudeMd;
      if (tkClaudePaths) {
        if (isConnected) {
          tkClaudePaths.style.display = '';
          tkClaudePaths.innerHTML = '';
          const rows = [];
          if (s.connectedGlobal) rows.push({ label: 'global MCP:    ', path: s.globalMcpConfigPath });
          if (s.connectedWorkspace) rows.push({ label: 'workspace MCP: ', path: s.workspaceMcpConfigPath });
          if (s.instructionsInClaudeMd) rows.push({ label: 'CLAUDE.md:     ', path: s.claudeMdPath });
          for (const row of rows) {
            const line = document.createElement('div');
            line.style.cssText = 'font-family:var(--mono);color:var(--fg-dim);margin:2px 0';
            const label = document.createElement('span');
            label.textContent = row.label;
            line.appendChild(label);
            const link = document.createElement('a');
            link.href = '#';
            link.textContent = row.path;
            link.style.cssText = 'color:var(--accent);text-decoration:underline;cursor:pointer';
            link.onclick = (e) => {
              e.preventDefault();
              if (vsApi && typeof vsApi.postMessage === 'function') {
                vsApi.postMessage({ type: 'tk:open-path', path: row.path });
              }
            };
            line.appendChild(link);
            tkClaudePaths.appendChild(line);
          }
        } else {
          tkClaudePaths.style.display = 'none';
          tkClaudePaths.innerHTML = '';
        }
      }
      if (tkClaudeVerify) {
        tkClaudeVerify.style.display = isConnected ? '' : 'none';
      }
    } catch (e) {
      tkClaudeStatus.textContent = (lang === 'ko' ? '상태 조회 실패: ' : 'status check failed: ') + e.message;
    }
  }

  async function doConnect(scope) {
    try {
      const r = await jpost('/v1/claude-code/connect', { scope, instructionsLevel: 'light' });
      if (!r.ok) {
        toast((lang === 'ko' ? '연결 실패: ' : 'connect failed: ') + (r.data?.message || r.status), 'err');
        return;
      }
      const res = r.data.result || {};
      await refreshTkClaudeStatus();

      // v0.20.4: surface verification result. If the file wasn't actually
      // written, the entry isn't in the file, or the tierkit binary isn't
      // launchable, Claude Code will show "Failed" in /mcp. Tell the user
      // BEFORE they reload so they don't get a misleading "Failed" later.
      const v = res.verification;
      if (v && (!v.fileWritten || !v.fileContainsEntry || !v.binaryLaunchable)) {
        const lines = [];
        lines.push(lang === 'ko' ? '⚠ 검증 실패 — Claude Code가 /mcp에서 "Failed"로 표시할 가능성:' : '⚠ Verification failed — Claude Code will likely show "Failed" in /mcp:');
        if (!v.fileWritten) lines.push('  • ' + (lang === 'ko' ? '설정 파일을 쓸 수 없음' : 'config file could not be written'));
        else if (!v.fileContainsEntry) lines.push('  • ' + (lang === 'ko' ? '파일은 썼지만 entry가 들어가지 않음 (디스크 문제?)' : 'file written but entry not found in it (disk issue?)'));
        if (!v.binaryLaunchable) {
          lines.push('  • ' + (lang === 'ko' ? '바이너리 실행 불가' : 'binary not launchable') + ': ' + (v.binaryError || 'unknown'));
        }
        // Append into the agent thread so it's persistent (toast disappears).
        const el = tkCard(lang === 'ko' ? 'Claude Code 연결 진단' : 'Claude Code connect diagnostics');
        el.style.borderColor = 'var(--err)';
        const body = document.createElement('pre');
        body.style.cssText = 'margin:0;padding:8px 10px;background:var(--bg-input);border-radius:4px;font-size:11px;font-family:var(--mono);white-space:pre-wrap';
        body.textContent = lines.join('\\n') + '\\n\\n' + (lang === 'ko' ? '해결 후 다시 Connect를 눌러주세요.' : 'Resolve the issue, then click Connect again.');
        el.appendChild(body);
        appendAgent(el);
        toast(lang === 'ko' ? '연결 검증 실패 — Chat 탭의 진단 카드를 확인하세요' : 'verification failed — see diagnostics in Chat tab', 'err');
        return;
      }

      if (res.alreadyConnected) {
        toast(lang === 'ko' ? '이미 연결됨 (' + scope + ')' : 'already connected (' + scope + ')', 'ok');
        return;
      }
      toast(lang === 'ko' ? '✓ Claude Code 연결됨 + 검증 통과 (' + scope + ')' : '✓ Claude Code connected + verified (' + scope + ')', 'ok');

      if (vsApi && typeof vsApi.postMessage === 'function') {
        vsApi.postMessage({
          type: 'tk:reload-vscode',
          reason: (lang === 'ko'
            ? 'Claude Code MCP 서버로 tierkit 등록 + 검증 완료 (' + scope + ').'
            : 'Tierkit registered + verified as a Claude Code MCP server (' + scope + ').'),
        });
      }
    } catch (e) {
      toast((lang === 'ko' ? '연결 실패: ' : 'connect failed: ') + e.message, 'err');
    }
  }

  async function doDisconnect() {
    // Disconnect both scopes since we can't easily tell which the user wants
    // to undo from a single button. Each scope is a separate file edit.
    try {
      await jpost('/v1/claude-code/disconnect', { scope: 'workspace' });
      const r = await jpost('/v1/claude-code/disconnect', { scope: 'global' });
      if (!r.ok) {
        toast((lang === 'ko' ? '해제 실패: ' : 'disconnect failed: ') + (r.data?.message || r.status), 'err');
        return;
      }
      toast(lang === 'ko' ? '✓ Claude Code 연결 해제됨' : '✓ Claude Code disconnected', 'ok');
      await refreshTkClaudeStatus();
    } catch (e) {
      toast((lang === 'ko' ? '해제 실패: ' : 'disconnect failed: ') + e.message, 'err');
    }
  }

  if (tkClaudeConnectWs) tkClaudeConnectWs.onclick = () => doConnect('workspace');
  if (tkClaudeConnectGlobal) tkClaudeConnectGlobal.onclick = () => doConnect('global');
  if (tkClaudeDisconnect) tkClaudeDisconnect.onclick = doDisconnect;

  // ── Settings panel: read-only view of the resolved Tierkit config + source map. ───
  async function refreshSettings() {
    const host = $('settings-view');
    try {
      const r = await jget('/v1/config');
      // v0.11.2: removed redundant profile table — Cost routing card already
      // shows the same data. Keep only the config paths + found status here.
      const cfgPath = r.configPath || (lang === 'ko' ? '없음' : 'none');
      const userPath = r.userConfigPath || (lang === 'ko' ? '없음' : 'none');
      host.innerHTML =
        '<div style="font-family:var(--mono);font-size:11px">' +
          '<div>workspace: <span class="dim">' + escapeHtml(cfgPath) + '</span></div>' +
          '<div>user: <span class="dim">' + escapeHtml(userPath) + '</span></div>' +
          '<div>found: <span class="dim">' + (r.found ? 'yes' : 'no (using bundled defaults)') + '</span></div>' +
        '</div>';
    } catch (e) {
      host.innerHTML = '<div class="empty">' + escapeHtml(e.message) + '</div>';
    }
  }
  $('btn-settings-reload').onclick = refreshSettings;

  // ───────────────── v0.12.2 validation card ─────────────────

  let c122CurrentArtifactId = null;     // session-only — no localStorage

  async function c122RefreshRecent() {
    let data;
    try { data = await jget('/v1/context/recent'); }
    catch { return; }                   // daemon offline — leave as-is
    const sel = $('c122-recent-select');
    const hint = $('c122-recent-hint');
    if (!data.recent || data.recent.length === 0) {
      sel.innerHTML = '';
      sel.hidden = true;
      hint.hidden = false;
      hint.textContent = i18n.hintNoRecentContexts;
      return;
    }
    sel.hidden = false;
    sel.innerHTML = data.recent.map((r) => {
      const pct = r.estimatedBaselineInputTokens > 0
        ? Math.round((1 - r.estimatedCompressedInputTokens / r.estimatedBaselineInputTokens) * 100)
        : 0;
      const status = !r.hasCompare ? '(no compare)'
                   : r.hasVerdict ? '(verdict saved)'
                   : '(' + pct + '% est, no verdict)';
      const taskShort = r.task.length > 60 ? r.task.slice(0, 57) + '…' : r.task;
      return '<option value="' + r.id + '">' + r.id + ' — ' + escapeHtml(taskShort) + '  ' + status + '</option>';
    }).join('');
    if (data.totalCount > data.recent.length) {
      hint.hidden = false;
      hint.textContent = i18n.hintShowingOfTotal.replace('{total}', String(data.totalCount));
    } else {
      hint.hidden = true;
    }
    // Default selection: most recent (first) — unless session already chose one
    if (!c122CurrentArtifactId) {
      c122CurrentArtifactId = data.recent[0].id;
      sel.value = c122CurrentArtifactId;
      await c122LoadArtifact(c122CurrentArtifactId);
    } else {
      sel.value = c122CurrentArtifactId;
    }
  }

  async function c122LoadArtifact(id) {
    c122ResetUI();
    let data;
    try { data = await jget('/v1/context/' + id); }
    catch (err) {
      c122ShowError('build', i18n.errContextNotFound);
      return;
    }
    c122RenderArtifact(data.artifact, data.verdict);
  }

  function c122RenderArtifact(artifact, verdict) {
    $('c122-built-block').hidden = false;
    $('c122-artifact-id').textContent = artifact.id;
    $('c122-baseline-est').textContent = artifact.estimatedBaselineInputTokens.toLocaleString();
    $('c122-compressed-est').textContent = artifact.estimatedCompressedInputTokens.toLocaleString();
    const pct = artifact.estimatedBaselineInputTokens > 0
      ? Math.round((1 - artifact.estimatedCompressedInputTokens / artifact.estimatedBaselineInputTokens) * 100)
      : 0;
    $('c122-savings-est').textContent = pct + '%';
    $('c122-files-list').innerHTML = artifact.candidates
      .map((c) => '<li>' + escapeHtml(c.path) + '</li>')
      .join('');
    const promptPath = '.tierkit/runtime/context-artifacts/' + artifact.id + '/prompt.md';
    $('c122-prompt-path').textContent = promptPath;
    $('c122-copy-path-btn').onclick = () => navigator.clipboard.writeText(promptPath);

    // Compare block
    const cmpBlock = $('c122-compare-block');
    if (!artifact.compare) {
      // State D — profile picker + Compare button
      cmpBlock.innerHTML =
        '<hr/>' +
        '<div class="c122-state-row">' +
          '<label data-i18n="labelProfile">Profile:</label>' +
          '<select id="c122-profile-select"></select>' +
        '</div>' +
        '<div class="c122-api-key-hint" data-i18n="labelApiKeyHint">' + i18n.labelApiKeyHint + '</div>' +
        '<button id="c122-compare-btn" data-i18n="labelCompareButton">Compare baseline vs compressed</button>' +
        '<div class="c122-cancelled-note" id="c122-cancelled-note" hidden></div>';
      c122PopulateProfileSelect();
      $('c122-compare-btn').onclick = () => c122StartCompare(artifact.id);
      $('c122-result-block').innerHTML = '';
      $('c122-verdict-block').innerHTML = '';
    } else {
      // State F or G — render result + verdict block
      cmpBlock.innerHTML = '';
      c122RenderCompareDone(artifact, artifact.compare);
      if (verdict) c122RenderSavedVerdict(artifact.id, verdict);
    }
  }

  async function c122PopulateProfileSelect() {
    let models = [];
    try { models = await jget('/v1/models'); } catch { return; }
    const sel = $('c122-profile-select');
    if (!sel) return;
    sel.innerHTML = (models.profiles || []).map((p) =>
      '<option value="' + p.id + '">' + p.id + ' (' + p.provider + '/' + p.model + ')</option>'
    ).join('');
    if (sel.options.length === 0) {
      $('c122-compare-btn').disabled = true;
      sel.innerHTML = '<option value="">(no profiles configured)</option>';
    }
  }

  let c122CompareAbort = null;

  async function c122StartCompare(artifactId) {
    const sel = $('c122-profile-select');
    const profileId = sel ? sel.value : null;
    if (!profileId) return;
    const cancelledNote = $('c122-cancelled-note');
    if (cancelledNote) cancelledNote.hidden = true;
    const btn = $('c122-compare-btn');
    btn.disabled = true;
    try {
      // Preflight: expect 412 with estimated payload
      const pre = await fetch('/v1/context/' + artifactId + '/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileId, mode: 'execute' }),
      });
      if (pre.status === 412) {
        const body = await pre.json();
        c122ShowModal(body.estimated, () => c122RunCompare(artifactId, profileId), () => { btn.disabled = false; });
        return;
      }
      if (pre.status === 409) {
        c122ShowError('build', i18n.errCompareAlreadyRunning);
        btn.disabled = false;
        return;
      }
      if (!pre.ok) {
        const err = await pre.json().catch(() => ({ code: 'http-' + pre.status, message: pre.statusText }));
        c122ShowError('build', i18n.errCompareFailed + ': ' + err.code + ' — ' + err.message);
        btn.disabled = false;
        return;
      }
    } catch {
      c122ShowError('build', i18n.errDaemonOffline);
      btn.disabled = false;
    }
  }

  function c122ShowModal(estimated, onRun, onCancel) {
    $('c122-modal-profile').textContent = estimated.profileId;
    $('c122-modal-baseline-tokens').textContent = estimated.baselineInputTokens.toLocaleString();
    $('c122-modal-compressed-tokens').textContent = estimated.compressedInputTokens.toLocaleString();
    $('c122-modal-baseline-cost').textContent =
      estimated.baselineInputCostUsd !== null
        ? '$' + estimated.baselineInputCostUsd.toFixed(3)
        : 'unknown';
    $('c122-modal-compressed-cost').textContent =
      estimated.compressedInputCostUsd !== null
        ? '$' + estimated.compressedInputCostUsd.toFixed(3)
        : 'unknown';
    $('c122-modal-backdrop').hidden = false;
    const cancelBtn = $('c122-modal-cancel');
    const runBtn = $('c122-modal-run');
    cancelBtn.focus();
    const close = () => { $('c122-modal-backdrop').hidden = true; document.removeEventListener('keydown', escHandler); };
    const escHandler = (e) => { if (e.key === 'Escape') { close(); onCancel(); } };
    document.addEventListener('keydown', escHandler);
    cancelBtn.onclick = () => { close(); onCancel(); };
    runBtn.onclick = () => { close(); onRun(); };
  }

  async function c122RunCompare(artifactId, profileId) {
    // Transition to State E
    const resultBlock = $('c122-result-block');
    resultBlock.innerHTML =
      '<hr/>' +
      '<div class="c122-progress" id="c122-compare-progress">baseline pending…</div>' +
      '<div class="c122-response-cols">' +
        '<div class="c122-response-col" id="c122-resp-baseline"></div>' +
        '<div class="c122-response-col" id="c122-resp-compressed"></div>' +
      '</div>' +
      '<button id="c122-cancel-compare-btn">Cancel</button>';

    c122CompareAbort = new AbortController();
    $('c122-cancel-compare-btn').onclick = () => c122CompareAbort && c122CompareAbort.abort();

    let baselineText = '', compressedText = '';
    let gotCompareDone = false;
    let gotError = null;

    await streamSsePost('/v1/context/' + artifactId + '/compare',
      { profileId, mode: 'execute', confirm: true },
      {
        onPhase: ({ phase }) => {
          $('c122-compare-progress').textContent = phase;
        },
        onDelta: ({ side, text }) => {
          if (side === 'baseline') {
            baselineText += text;
            $('c122-resp-baseline').textContent = baselineText;
          } else {
            compressedText += text;
            $('c122-resp-compressed').textContent = compressedText;
          }
        },
        onSideResult: () => { /* aggregated into compare-done */ },
        onCompareDone: (data) => {
          gotCompareDone = true;
          c122RenderCompareDone(data.artifact, data.compare);
        },
        onError: (err) => {
          gotError = err;
        },
      },
      c122CompareAbort.signal,
    );

    if (gotError) {
      c122RenderCompareFailed(artifactId, baselineText, compressedText, gotError);
    } else if (!gotCompareDone) {
      // Cancelled — show cancelled note
      const note = $('c122-cancelled-note');
      if (note) {
        note.hidden = false;
        note.textContent = i18n.hintCompareCancelled;
      }
      // Re-enable Compare
      const cmpBtn = $('c122-compare-btn');
      if (cmpBtn) cmpBtn.disabled = false;
      resultBlock.innerHTML = '';
    }
  }

  function c122RenderCompareDone(artifact, compare) {
    const resultBlock = $('c122-result-block');
    const fmt = (n) => n === undefined ? '—' : n.toLocaleString();
    const fmtCostCmp = (n) => n === undefined ? '—' : '$' + n.toFixed(3);
    const fmtPct = (saved, base) => (base === 0 || saved === undefined) ? '—' : (Math.round((saved / base) * 1000) / 10) + '%';
    resultBlock.innerHTML =
      '<hr/>' +
      '<table class="c122-compare-summary">' +
        '<tr><th>' + i18n.labelCompareMetric + '</th><th>' + i18n.labelCompareBaseline + '</th><th>' + i18n.labelCompareCompressed + '</th><th>' + i18n.labelCompareSavings + '</th></tr>' +
        '<tr><td>' + i18n.labelMetricInput + '</td><td>' + fmt(compare.baseline.actualInputTokens) + '</td><td>' + fmt(compare.compressed.actualInputTokens) + '</td><td>' + (compare.savedInputTokensActual !== undefined ? fmt(compare.savedInputTokensActual) + ' (' + fmtPct(compare.savedInputTokensActual, compare.baseline.actualInputTokens) + ')' : '—') + '</td></tr>' +
        '<tr><td>' + i18n.labelMetricOutput + '</td><td>' + fmt(compare.baseline.actualOutputTokens) + '</td><td>' + fmt(compare.compressed.actualOutputTokens) + '</td><td>—</td></tr>' +
        '<tr><td>' + i18n.labelMetricCost + '</td><td>' + fmtCostCmp(compare.baseline.actualCostUsd) + '</td><td>' + fmtCostCmp(compare.compressed.actualCostUsd) + '</td><td>' + (compare.savedCostUsdActual !== undefined ? fmtCostCmp(compare.savedCostUsdActual) : '—') + '</td></tr>' +
        '<tr><td>' + i18n.labelMetricLatency + '</td><td>' + fmt(compare.baseline.latencyMs) + 'ms</td><td>' + fmt(compare.compressed.latencyMs) + 'ms</td><td>—</td></tr>' +
      '</table>';
    c122RenderVerdictForm(artifact.id, null);  // null = no saved verdict yet
  }

  function c122RenderVerdictForm(artifactId, existing) {
    const block = $('c122-verdict-block');
    const sel = (v) => existing && existing.qualityVerdict === v ? 'checked' : '';
    const missingChecked = existing && existing.missingContext ? 'checked' : '';
    const notesVal = existing && existing.notes ? existing.notes : '';
    block.innerHTML =
      '<hr/>' +
      '<div><strong data-i18n="labelVerdictHeader">Quality verdict:</strong></div>' +
      '<div class="c122-verdict-row">' +
        '<label><input type="radio" name="c122-qv" value="same" '       + sel('same')     + '> ' + i18n.labelVerdictSame + '</label>' +
        '<label><input type="radio" name="c122-qv" value="better" '     + sel('better')   + '> ' + i18n.labelVerdictBetter + '</label>' +
        '<label><input type="radio" name="c122-qv" value="worse" '      + sel('worse')    + '> ' + i18n.labelVerdictWorse + '</label>' +
        '<label><input type="radio" name="c122-qv" value="unusable" '   + sel('unusable') + '> ' + i18n.labelVerdictUnusable + '</label>' +
      '</div>' +
      '<label><input type="checkbox" id="c122-qv-missing" ' + missingChecked + '> ' + i18n.labelVerdictMissingContext + '</label>' +
      '<div><label data-i18n="labelVerdictNotes">Notes:</label></div>' +
      '<textarea id="c122-qv-notes" rows="3">' + escapeHtml(notesVal) + '</textarea>' +
      '<div class="c122-notes-counter" id="c122-qv-counter">' + i18n.hintNotesCounter.replace('{count}', String(notesVal.length)) + '</div>' +
      '<button id="c122-save-verdict-btn" data-i18n="labelVerdictSaveButton">Save verdict</button>';

    // Disable Save until a radio is chosen
    const saveBtn = $('c122-save-verdict-btn');
    const radios = document.getElementsByName('c122-qv');
    const updateSaveState = () => {
      const anyChecked = Array.from(radios).some((r) => r.checked);
      const notesLen = $('c122-qv-notes').value.length;
      const tooLong = notesLen > 2000;
      saveBtn.disabled = !anyChecked || tooLong;
      const counter = $('c122-qv-counter');
      counter.textContent = i18n.hintNotesCounter.replace('{count}', String(notesLen));
      counter.classList.toggle('over', tooLong);
    };
    for (const r of radios) r.onchange = updateSaveState;
    $('c122-qv-notes').oninput = updateSaveState;
    updateSaveState();

    saveBtn.onclick = () => c122SaveVerdict(artifactId);
  }

  async function c122SaveVerdict(artifactId) {
    const radios = document.getElementsByName('c122-qv');
    let qv = null;
    for (const r of radios) if (r.checked) qv = r.value;
    if (!qv) return;
    const missingContext = $('c122-qv-missing').checked;
    const notes = $('c122-qv-notes').value;
    const saveBtn = $('c122-save-verdict-btn');
    saveBtn.disabled = true;
    try {
      const res = await fetch('/v1/context/' + artifactId + '/verdict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qualityVerdict: qv, missingContext, notes: notes || undefined }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ code: 'http-' + res.status, message: res.statusText }));
        alert(err.code + ': ' + err.message);
        saveBtn.disabled = false;
        return;
      }
      const data = await res.json();
      c122RenderSavedVerdict(artifactId, data.verdict);
    } catch {
      alert(i18n.errDaemonOffline);
      saveBtn.disabled = false;
    }
  }

  function c122RenderSavedVerdict(artifactId, verdict) {
    const block = $('c122-verdict-block');
    const when = new Date(verdict.reviewedAt).toLocaleString();
    block.innerHTML =
      '<hr/>' +
      '<div class="c122-saved-verdict">' +
        i18n.labelVerdictSaved + ': <strong>' + verdict.qualityVerdict + '</strong> · ' + escapeHtml(when) +
        (verdict.missingContext ? ' · ' + i18n.labelVerdictMissingContext : '') +
      '</div>' +
      (verdict.notes ? '<div class="dim" style="white-space:pre-wrap;font-size:11px;margin-top:4px">' + escapeHtml(verdict.notes) + '</div>' : '') +
      '<button id="c122-edit-verdict-btn" data-i18n="labelVerdictEditButton">' + i18n.labelVerdictEditButton + '</button>';
    $('c122-edit-verdict-btn').onclick = () => c122RenderVerdictForm(artifactId, verdict);
  }

  function c122RenderCompareFailed(artifactId, baselineText, compressedText, err) {
    const resultBlock = $('c122-result-block');
    resultBlock.innerHTML =
      '<hr/>' +
      '<div class="c122-error-banner">' + escapeHtml(i18n.errCompareFailed + ': ' + err.code + ' — ' + err.message) + '</div>' +
      '<div class="c122-response-cols">' +
        '<div class="c122-response-col">' + escapeHtml(baselineText) + '</div>' +
        '<div class="c122-response-col">' + escapeHtml(compressedText) + '</div>' +
      '</div>' +
      '<div class="dim">' + i18n.hintCompareFailedPartial + '</div>' +
      '<button id="c122-retry-compare-btn" data-i18n="labelRetryCompareButton">' + i18n.labelRetryCompareButton + '</button>';
    $('c122-retry-compare-btn').onclick = () => c122LoadArtifact(artifactId);
    // No verdict block in state H.
  }

  function c122ResetUI() {
    $('c122-built-block').hidden = true;
    $('c122-build-error').hidden = true;
    $('c122-build-status').hidden = true;
  }

  function c122ShowError(kind, msg) {
    const el = $('c122-' + kind + '-error');
    if (el) { el.textContent = msg; el.hidden = false; }
  }

  async function c122Build() {
    const taskEl = $('c122-task');
    const task = taskEl.value.trim();
    if (!task) return;
    const btn = $('c122-build-btn');
    btn.disabled = true;
    $('c122-build-status').hidden = false;
    $('c122-build-status').textContent = i18n.statusBuilding;
    $('c122-build-error').hidden = true;
    try {
      const r = await jpost('/v1/context/build', { task });
      if (!r.ok) {
        const err = r.data || { code: 'http-' + r.status, message: 'request failed' };
        c122ShowError('build', i18n.errBuildFailed + ': ' + (err.code || r.status) + ' — ' + (err.message || ''));
        return;
      }
      const data = r.data;
      c122CurrentArtifactId = data.artifact.id;
      await c122RefreshRecent();           // re-pull so dropdown includes the new entry
      c122RenderArtifact(data.artifact, null);
    } catch (err) {
      c122ShowError('build', i18n.errDaemonOffline);
    } finally {
      btn.disabled = false;
      $('c122-build-status').hidden = true;
    }
  }

  // Wiring (call once during init)
  function c122Init() {
    $('c122-build-btn').onclick = c122Build;
    $('c122-new-btn').onclick = () => {
      c122CurrentArtifactId = null;
      $('c122-task').value = '';
      $('c122-task').focus();
      c122ResetUI();
    };
    $('c122-recent-select').onchange = (e) => {
      c122CurrentArtifactId = e.target.value;
      c122LoadArtifact(c122CurrentArtifactId);
    };
    c122RefreshRecent();
  }

  // ── Wire-up ────────────────────────────────────────────────────────────────
  async function refreshAll() {
    wirePresetButtons();
    await Promise.all([refreshHealth(), refreshFreedom(), refreshTools(), refreshPlugins(), refreshActivity(), refreshUsage(), refreshSavings(), refreshModels(), refreshAutoCeiling(), loadAgentModesAndCommands(), refreshSettings(), refreshTkRefineProfiles(), refreshTkCacheStats(), refreshTkClaudeStatus()]);
  }
  $('btn-refresh').onclick = refreshAll;

  c122Init();

  // ── v0.14: Onboarding card ────────────────────────────────────────────────
  let _envCache = null;
  let _taskTypes = [];
  async function getEnvData() {
    if (_envCache) return _envCache;
    try { _envCache = await jget('/v1/environment'); _taskTypes = _envCache.taskTypes || []; } catch { _envCache = {}; }
    return _envCache;
  }

  async function renderOnboardingCard() {
    try {
      const configR = await jget('/v1/config').catch(() => ({ config: {} }));
      const notices = (configR && configR.config && configR.config.notices) || {};
      const card = $('onboarding-card');
      if (!card) return;
      if (notices.seenOnboarding === true) { card.style.display = 'none'; return; }
      card.style.display = 'block';

      // v0.14: force chat tab on first activation when onboarding not yet seen
      if (!loadActiveTab() || loadActiveTab() === 'settings') {
        setActiveTab('chat');
      }

      const env = await getEnvData();
      const profiles = (configR && configR.config && configR.config.modelProfiles) || {};
      const disabledIds = (configR && configR.config && configR.config.disabledProfileIds) || [];
      const connectionsR = await jget('/v1/connections').catch(() => ({ connections: [] }));
      const connections = connectionsR.connections || [];

      const list = $('onboarding-list');
      list.innerHTML = '';

      function mkRow(icon, label, actionHtml) {
        const li = document.createElement('li');
        li.innerHTML =
          '<span class="ob-icon">' + escapeHtml(icon) + '</span>' +
          '<span class="ob-label">' + escapeHtml(label) + '</span>' +
          (actionHtml ? '<span class="ob-action">' + actionHtml + '</span>' : '');
        list.appendChild(li);
        return li;
      }

      // Ollama
      const ollamaRunning = env.ollama && env.ollama.running;
      mkRow(ollamaRunning ? '✅' : '◯', i18n.onboardingDetectOllama + (ollamaRunning ? ' (' + (env.ollama.modelCount || 0) + ' models)' : ''), '');

      // claude CLI
      const claudeOnPath = env.claudeCli && env.claudeCli.onPath;
      mkRow(claudeOnPath ? '✅' : '◯', i18n.onboardingDetectClaude, '');

      // claudeCode enabled
      const claudeEnabled = !disabledIds.includes('claudeCode');
      const claudeRow = mkRow(claudeEnabled ? '✅' : '⚠️', i18n.onboardingDetectClaudeProfile,
        !claudeEnabled
          ? '<button class="tiny" id="ob-enable-claude">' + escapeHtml(i18n.onboardingActionEnable) + '</button>'
          : '');
      if (!claudeEnabled) {
        const btn = claudeRow.querySelector('#ob-enable-claude');
        if (btn) btn.onclick = async () => {
          btn.disabled = true;
          try {
            const scope = profiles.claudeCode ? (profiles.claudeCode._source || 'workspace') : 'workspace';
            await transport.request('/v1/config/profile/claudeCode', { method: 'PATCH', body: { enabled: true, scope } });
            await renderOnboardingCard();
          } finally { btn.disabled = false; }
        };
      }

      // ANTHROPIC_API_KEY
      const anthropicPresent = env.envVars && env.envVars.ANTHROPIC_API_KEY && env.envVars.ANTHROPIC_API_KEY.present;
      const anthropicRow = mkRow(anthropicPresent ? '✅' : '⚠️', 'ANTHROPIC_API_KEY',
        !anthropicPresent
          ? '<button class="tiny" id="ob-add-anthropic">' + escapeHtml(i18n.onboardingActionAddKey) + '</button>'
          : '');
      if (!anthropicPresent) {
        const btn = anthropicRow.querySelector('#ob-add-anthropic');
        if (btn) btn.onclick = () => openSecretsAddForm('ANTHROPIC_API_KEY');
      }

      // OPENAI_API_KEY
      const openaiPresent = env.envVars && env.envVars.OPENAI_API_KEY && env.envVars.OPENAI_API_KEY.present;
      mkRow(openaiPresent ? '✅' : '◯', 'OPENAI_API_KEY', '');

      // Connected tools (Roo / Cline / Continue)
      const connectedTools = connections.filter((c) => c.connected).map((c) => c.tool);
      mkRow(connectedTools.length > 0 ? '✅' : '◯', (connectedTools.length > 0 ? connectedTools.join(', ') : 'Roo / Cline / Continue') + ' connected', '');

      // Check if all items are green for the "Setup looks good" toast
      const allGreen = ollamaRunning && claudeOnPath && claudeEnabled && anthropicPresent && connectedTools.length > 0;
      if (allGreen) {
        const trace = $('onboarding-trace');
        if (trace && trace.style.display === 'none') {
          // Show "all green" suggestion
          const toastEl = document.createElement('div');
          toastEl.style.cssText = 'font-size:11px;margin-top:6px;color:var(--accent)';
          toastEl.textContent = 'Setup looks good — try the Chat tab';
          const chatBtn = document.createElement('button');
          chatBtn.className = 'tiny';
          chatBtn.textContent = 'Chat';
          chatBtn.style.marginLeft = '8px';
          chatBtn.onclick = () => setActiveTab('chat');
          toastEl.appendChild(chatBtn);
          card.appendChild(toastEl);
        }
      }

      // Quick test button
      const testBtn = $('onboarding-test');
      if (testBtn) {
        testBtn.onclick = async () => {
          testBtn.disabled = true;
          const trace = $('onboarding-trace');
          if (trace) { trace.style.display = 'block'; trace.textContent = i18n.onboardingTracePrefix + ' …'; }
          try {
            const r = await jpost('/v1/route/explain', { task: '프로젝트 전반을 보고 리뷰해줘' });
            if (trace) {
              const candidates = Array.isArray(r.candidates) ? r.candidates : [];
              const winner = candidates.find((c) => c && c.selected);
              const winnerId = winner ? (winner.id || '?') : '?';
              // Render the chain with the selected one bolded and unviable ones dimmed.
              const chainHtml = candidates.map((c) => {
                const id = escapeHtml(c.id || '?');
                if (c.selected) return '<strong>' + id + '</strong>';
                if (!c.viable) return '<span style="opacity:0.5">' + id + '</span>';
                return id;
              }).join(' → ');
              const isGood = !!winner && winner.viable;
              const tail = winner
                ? (winner.viable
                    ? ' <span style="color:var(--accent)">✓</span>'
                    : ' <span style="color:var(--warn)">⚠ ' + escapeHtml(winner.viabilityReason || 'not viable') + '</span>')
                : ' <span style="color:var(--warn)">⚠ no viable candidate</span>';
              trace.innerHTML =
                escapeHtml(i18n.onboardingTracePrefix) + ' ' +
                (chainHtml || escapeHtml(winnerId)) +
                tail;
              void isGood;
            }
          } catch (err) {
            if (trace) trace.textContent = i18n.onboardingTracePrefix + ' ' + (err.message || String(err));
          } finally { testBtn.disabled = false; }
        };
      }

      // Dismiss button
      const dismissBtn = $('onboarding-dismiss');
      if (dismissBtn) {
        dismissBtn.onclick = async () => {
          await jpost('/v1/notices', { seenOnboarding: true }).catch(() => { /* best-effort */ });
          if (card) card.style.display = 'none';
        };
      }
    } catch (e) { /* ignore — non-critical */ }
  }

  // ── v0.14: Profile inline editor ─────────────────────────────────────────
  let _knownTaskTypes = [];

  function makeChipInput(containerEl, initialValues, validValues, allowFreeText) {
    let values = [...(initialValues || [])];
    let suggestEl = null;
    let inputEl = null;

    function renderChips() {
      containerEl.innerHTML = '';
      for (const v of values) {
        const isValid = allowFreeText || !validValues.length || validValues.includes(v);
        const chip = document.createElement('span');
        chip.className = 'chip' + (isValid ? '' : ' chip-invalid');
        const txt = document.createElement('span');
        txt.textContent = v;
        const x = document.createElement('span');
        x.className = 'chip-x';
        x.textContent = '×';
        x.onclick = () => { values = values.filter((vv) => vv !== v); renderChips(); };
        chip.appendChild(txt);
        chip.appendChild(x);
        containerEl.appendChild(chip);
      }
      // Add button
      const addBtn = document.createElement('button');
      addBtn.className = 'chip-add-btn';
      addBtn.textContent = '+';
      addBtn.type = 'button';
      addBtn.onclick = (e) => { e.stopPropagation(); showInput(); };
      containerEl.appendChild(addBtn);
    }

    function showInput() {
      if (inputEl) return;
      const wrap = document.createElement('span');
      wrap.style.position = 'relative';
      inputEl = document.createElement('input');
      inputEl.type = 'text';
      inputEl.className = 'chip-input-field';
      inputEl.placeholder = i18n.profileChipAddPlaceholder;
      wrap.appendChild(inputEl);
      containerEl.appendChild(wrap);
      inputEl.focus();

      inputEl.oninput = () => {
        const q = inputEl.value.toLowerCase();
        if (!validValues.length) { hideSuggest(); return; }
        const matches = validValues.filter((v) => v.toLowerCase().startsWith(q) && !values.includes(v));
        if (matches.length === 0) { hideSuggest(); return; }
        showSuggest(matches, wrap);
      };

      inputEl.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          const v = inputEl.value.trim().replace(/,$/, '');
          if (v) { values.push(v); }
          hideSuggest();
          inputEl = null;
          renderChips();
        } else if (e.key === 'Escape') {
          hideSuggest();
          inputEl = null;
          renderChips();
        }
      };

      inputEl.onblur = () => {
        setTimeout(() => {
          const v = inputEl ? inputEl.value.trim() : '';
          if (v) { values.push(v); }
          hideSuggest();
          inputEl = null;
          renderChips();
        }, 200);
      };
    }

    function showSuggest(matches, anchor) {
      hideSuggest();
      suggestEl = document.createElement('div');
      suggestEl.className = 'chip-suggest';
      suggestEl.style.top = '100%';
      suggestEl.style.left = '0';
      for (const m of matches.slice(0, 12)) {
        const d = document.createElement('div');
        d.textContent = m;
        d.onmousedown = (e) => {
          e.preventDefault();
          values.push(m);
          hideSuggest();
          if (inputEl) inputEl.value = '';
          inputEl = null;
          renderChips();
        };
        suggestEl.appendChild(d);
      }
      anchor.appendChild(suggestEl);
    }

    function hideSuggest() {
      if (suggestEl) { suggestEl.remove(); suggestEl = null; }
    }

    renderChips();
    return { getValues: () => [...values] };
  }

  function openProfileEditor(rowEl, entry, configR) {
    // Close any other open editor
    document.querySelectorAll('.profile-editor').forEach((el) => el.remove());
    const existing = rowEl.querySelector('.profile-editor');
    if (existing) { existing.remove(); return; } // toggle

    const p = entry.profile || {};
    const id = entry.id;
    const isBundled = entry.source === 'bundled';
    const isWorkspace = entry.source === 'workspace';

    const editor = document.createElement('div');
    editor.className = 'profile-editor';

    const kindLine = document.createElement('label');
    kindLine.innerHTML = 'kind: <span class="profile-kind">' + escapeHtml(p.kind || '?') + '</span>';
    editor.appendChild(kindLine);

    // roles
    const rolesLabel = document.createElement('label');
    rolesLabel.textContent = i18n.profileFieldRoles;
    editor.appendChild(rolesLabel);
    const rolesWrap = document.createElement('div');
    rolesWrap.className = 'chip-input';
    editor.appendChild(rolesWrap);
    const rolesCtrl = makeChipInput(rolesWrap, p.roles || [], [], true);

    // goodAt
    const goodAtLabel = document.createElement('label');
    goodAtLabel.textContent = i18n.profileFieldGoodAt;
    editor.appendChild(goodAtLabel);
    const goodAtWrap = document.createElement('div');
    goodAtWrap.className = 'chip-input';
    editor.appendChild(goodAtWrap);
    const goodAtCtrl = makeChipInput(goodAtWrap, p.goodAt || [], _knownTaskTypes, false);

    // notGoodAt
    const notGoodAtLabel = document.createElement('label');
    notGoodAtLabel.textContent = i18n.profileFieldNotGoodAt;
    editor.appendChild(notGoodAtLabel);
    const notGoodAtWrap = document.createElement('div');
    notGoodAtWrap.className = 'chip-input';
    editor.appendChild(notGoodAtWrap);
    const notGoodAtCtrl = makeChipInput(notGoodAtWrap, p.notGoodAt || [], _knownTaskTypes, false);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'profile-editor-actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'tiny primary';
    saveBtn.textContent = i18n.profileSaveBtn;
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      try {
        const scope = isWorkspace ? 'workspace' : 'user';
        const resp = await transport.request('/v1/config/profile/' + encodeURIComponent(id), {
          method: 'PATCH',
          body: { roles: rolesCtrl.getValues(), goodAt: goodAtCtrl.getValues(), notGoodAt: notGoodAtCtrl.getValues(), scope },
        });
        if (!resp.ok) { toast((resp.data && resp.data.message) || i18n.failed, 'err'); return; }
        toast(id + ' ✓ ' + i18n.profileSaveBtn, 'ok');
        editor.remove();
        await refreshModels();
      } finally { saveBtn.disabled = false; }
    };
    actions.appendChild(saveBtn);

    if (isBundled || isWorkspace) {
      const resetBtn = document.createElement('button');
      resetBtn.className = 'tiny';
      resetBtn.textContent = i18n.profileResetBundled;
      resetBtn.onclick = async () => {
        if (!safeConfirm(i18n.profileResetConfirm.replace('\${id}', id))) return;
        resetBtn.disabled = true;
        try {
          const resp = await transport.request('/v1/config/profile/' + encodeURIComponent(id) + '?scope=workspace', { method: 'DELETE' });
          if (!resp.ok) { toast((resp.data && resp.data.message) || i18n.failed, 'err'); return; }
          toast(id + ' ✓ ' + i18n.profileResetBundled, 'ok');
          editor.remove();
          await refreshModels();
        } finally { resetBtn.disabled = false; }
      };
      actions.appendChild(resetBtn);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'tiny';
    delBtn.textContent = i18n.profileDeleteBtn;
    delBtn.onclick = async () => {
      if (!safeConfirm(i18n.profileDeleteConfirm.replace('\${id}', id))) return;
      delBtn.disabled = true;
      try {
        const scope = isWorkspace ? 'workspace' : 'user';
        const resp = await transport.request('/v1/config/profile/' + encodeURIComponent(id) + '?scope=' + scope, { method: 'DELETE' });
        if (!resp.ok) { toast((resp.data && resp.data.message) || i18n.failed, 'err'); return; }
        toast(id + ' ✓ ' + i18n.deletedOk, 'ok');
        editor.remove();
        await refreshModels();
      } finally { delBtn.disabled = false; }
    };
    actions.appendChild(delBtn);

    editor.appendChild(actions);
    rowEl.appendChild(editor);
  }

  // ── v0.14: Secrets card ───────────────────────────────────────────────────
  const DEFAULT_SECRET_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];

  function openSecretsAddForm(prefillKey) {
    const form = $('secrets-add-form');
    if (!form) return;
    form.style.display = 'block';
    form.innerHTML =
      '<div class="secret-inline-form">' +
        '<input type="text" id="secrets-add-name" placeholder="KEY_NAME" style="font-family:var(--mono);font-size:12px;background:var(--bg-input);border:1px solid var(--border);color:var(--fg);padding:3px 6px;border-radius:4px;flex:1 1 140px;min-width:0;box-sizing:border-box" value="' + escapeHtml(prefillKey || '') + '">' +
        '<input type="password" id="secrets-add-value" placeholder="sk-… value" style="font-family:var(--mono);font-size:12px;flex:1 1 100px;min-width:0;background:var(--bg-input);border:1px solid var(--border);color:var(--fg);padding:3px 6px;border-radius:4px;box-sizing:border-box">' +
        '<button class="tiny primary" id="secrets-add-save">' + escapeHtml(i18n.secretSave) + '</button>' +
        '<button class="tiny" id="secrets-add-cancel">' + escapeHtml(i18n.secretCancel) + '</button>' +
      '</div>';
    const nameInput = document.getElementById('secrets-add-name');
    const valInput = document.getElementById('secrets-add-value');
    if (prefillKey) { if (valInput) valInput.focus(); } else { if (nameInput) nameInput.focus(); }
    const saveBtn = document.getElementById('secrets-add-save');
    const cancelBtn = document.getElementById('secrets-add-cancel');
    if (cancelBtn) cancelBtn.onclick = () => { form.style.display = 'none'; form.innerHTML = ''; };
    if (saveBtn) saveBtn.onclick = async () => {
      const name = (nameInput && nameInput.value.trim()) || '';
      const value = (valInput && valInput.value.trim()) || '';
      if (!name) { toast(i18n.keyNameRequired || 'key name required', 'err'); return; }
      saveBtn.disabled = true;
      try {
        const resp = await jpost('/v1/secrets', { key: name, value });
        if (!resp.ok) { toast((resp.data && resp.data.message) || i18n.failed, 'err'); return; }
        toast(name + ' ✓ ' + i18n.secretSave, 'ok');
        form.style.display = 'none'; form.innerHTML = '';
        await refreshSecretsCard();
        _envCache = null; // bust env cache so onboarding re-checks
        await renderOnboardingCard();
      } finally { saveBtn.disabled = false; }
    };
  }

  async function refreshSecretsCard() {
    const listEl = $('secrets-list');
    if (!listEl) return;
    try {
      const [secretsR, configR] = await Promise.all([
        jget('/v1/secrets').catch(() => ({ entries: [] })),
        jget('/v1/config').catch(() => ({ config: {} })),
      ]);
      const profiles = (configR && configR.config && configR.config.modelProfiles) || {};
      const wantedKeys = new Set(DEFAULT_SECRET_KEYS);
      for (const p of Object.values(profiles)) {
        const k = p && (p).apiKeyEnv;
        if (typeof k === 'string' && k) wantedKeys.add(k);
      }
      const secretMap = {};
      for (const e of (secretsR.entries || [])) secretMap[e.key] = e;
      // Ensure default keys appear even if not in the secrets list
      for (const k of wantedKeys) {
        if (!secretMap[k]) secretMap[k] = { key: k, set: false, masked: '' };
      }
      const sortedKeys = Array.from(wantedKeys).concat(
        Object.keys(secretMap).filter((k) => !wantedKeys.has(k)),
      );
      listEl.innerHTML = '';
      for (const k of sortedKeys) {
        const e = secretMap[k] || { key: k, set: false, masked: '' };
        const row = document.createElement('div');
        row.className = 'secret-row';
        row.dataset.key = k;
        const keyEl = document.createElement('span');
        keyEl.className = 'secret-key';
        keyEl.textContent = k;
        row.appendChild(keyEl);
        const valEl = document.createElement('span');
        valEl.className = e.set ? 'secret-val' : 'secret-notset';
        valEl.textContent = e.set ? (e.masked || '••••') : i18n.secretNotSet;
        row.appendChild(valEl);
        const btnWrap = document.createElement('span');
        btnWrap.style.marginLeft = 'auto';
        btnWrap.style.display = 'flex';
        btnWrap.style.gap = '4px';
        const editBtn = document.createElement('button');
        editBtn.className = 'tiny';
        editBtn.textContent = i18n.secretEditBtn;
        editBtn.onclick = () => openSecretEditRow(row, k);
        btnWrap.appendChild(editBtn);
        if (e.set) {
          const removeBtn = document.createElement('button');
          removeBtn.className = 'tiny';
          removeBtn.textContent = i18n.secretRemoveBtn;
          removeBtn.onclick = async () => {
            if (!safeConfirm(k + '?')) return;
            removeBtn.disabled = true;
            try {
              const resp = await transport.request('/v1/secrets/' + encodeURIComponent(k), { method: 'DELETE' });
              if (!resp.ok) {
                const msg = resp.data && resp.data.code === 'external' ? i18n.keyExternal : (resp.data && resp.data.message) || i18n.failed;
                toast(k + ': ' + msg, 'err'); return;
              }
              toast(k + ' ✓ ' + i18n.secretRemoveBtn, 'ok');
              _envCache = null;
              await refreshSecretsCard();
              await renderOnboardingCard();
            } finally { removeBtn.disabled = false; }
          };
          btnWrap.appendChild(removeBtn);
        }
        row.appendChild(btnWrap);
        listEl.appendChild(row);
      }
    } catch (e) {
      listEl.innerHTML = '<div class="empty">' + escapeHtml(e.message) + '</div>';
    }
  }

  function openSecretEditRow(rowEl, key) {
    // Replace the row content with an inline edit form
    const existingForm = rowEl.querySelector('.secret-inline-form');
    if (existingForm) { existingForm.remove(); return; } // toggle
    const form = document.createElement('div');
    form.className = 'secret-inline-form';
    const inp = document.createElement('input');
    inp.type = 'password';
    inp.placeholder = 'new value…';
    inp.style.cssText = 'font-family:var(--mono);font-size:12px;flex:1;min-width:120px;background:var(--bg-input);border:1px solid var(--border);color:var(--fg);padding:3px 6px;border-radius:4px';
    form.appendChild(inp);
    const saveBtn = document.createElement('button');
    saveBtn.className = 'tiny primary';
    saveBtn.textContent = i18n.secretSave;
    form.appendChild(saveBtn);
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'tiny';
    cancelBtn.textContent = i18n.secretCancel;
    cancelBtn.onclick = () => form.remove();
    form.appendChild(cancelBtn);
    saveBtn.onclick = async () => {
      const v = inp.value.trim();
      if (!v) { toast(i18n.valueRequired || 'value required', 'err'); return; }
      saveBtn.disabled = true;
      try {
        const resp = await jpost('/v1/secrets', { key, value: v });
        if (!resp.ok) { toast((resp.data && resp.data.message) || i18n.failed, 'err'); return; }
        toast(key + ' ✓ ' + i18n.secretSave, 'ok');
        _envCache = null;
        await refreshSecretsCard();
        await renderOnboardingCard();
      } finally { saveBtn.disabled = false; }
    };
    rowEl.appendChild(form);
    inp.focus();
  }

  // Wire add-secret button
  const addSecretBtn = $('btn-add-secret');
  if (addSecretBtn) addSecretBtn.onclick = () => openSecretsAddForm('');

  // ── v0.14: hook into refreshModels to add edit buttons to each profile row ──
  const _origRefreshModels = refreshModels;
  refreshModels = async function() {
    await _origRefreshModels.apply(this, arguments);
    // After refreshModels populates the list, add [Edit] buttons to each row
    const modelsListEl = $('models-list');
    if (!modelsListEl) return;
    const configR = await jget('/v1/config').catch(() => ({ config: {}, profileSources: {} }));
    const profileSources = configR.profileSources || {};

    modelsListEl.querySelectorAll('.row.dense').forEach((rowEl) => {
      // find the id from the delete or toggle button's data-id
      let id = null;
      const anyBtn = rowEl.querySelector('button[data-id]');
      if (anyBtn) id = anyBtn.getAttribute('data-id');
      if (!id) return;
      // avoid duplicate edit buttons
      if (rowEl.querySelector('.profile-edit-btn')) return;
      const editBtn = document.createElement('button');
      editBtn.className = 'tiny profile-edit-btn';
      editBtn.textContent = '⋯';
      editBtn.title = i18n.profileEditBtn;
      editBtn.onclick = async () => {
        const r = await jget('/v1/models').catch(() => ({ entries: [] }));
        const entry = (r.entries || []).find((e) => e.id === id);
        if (!entry) return;
        openProfileEditor(rowEl, entry, configR);
      };
      // Insert after the last button in the row
      rowEl.appendChild(editBtn);
    });
    // Also refresh secrets card and onboarding
    await refreshSecretsCard();
    await renderOnboardingCard();
    // Update taskTypes cache from env
    const envD = await getEnvData();
    if (envD.taskTypes) _knownTaskTypes = envD.taskTypes;
  };

  // ── v0.15 MCP Bridge: snippet buttons + pending patches panel ──────────
  const showSnippetBtn = $('btn-mcp-show-snippet');
  const copySnippetBtn = $('btn-mcp-copy-snippet');
  const snippetOutput = $('mcp-snippet-output');
  if (showSnippetBtn) {
    showSnippetBtn.onclick = async () => {
      try {
        const json = await jget('/v1/mcp/config');
        snippetOutput.style.display = 'block';
        snippetOutput.textContent = JSON.stringify(json, null, 2);
        copySnippetBtn.style.display = 'inline-block';
      } catch (err) {
        snippetOutput.style.display = 'block';
        snippetOutput.textContent = 'Error: ' + String(err && err.message || err);
      }
    };
  }
  if (copySnippetBtn) {
    copySnippetBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(snippetOutput.textContent);
        copySnippetBtn.textContent = '✓ Copied';
        setTimeout(() => { copySnippetBtn.textContent = i18n.mcpCopySnippet; }, 1500);
      } catch { /* ignore */ }
    };
  }

  async function renderMcpPatches() {
    const wrap = $('mcp-patches-list');
    if (!wrap) return;
    try {
      const r = await jget('/v1/mcp/patches');
      const patches = (r.patches || []).filter((p) => p.status === 'proposed' || p.status === 'awaiting_approval');
      if (patches.length === 0) {
        wrap.innerHTML = '<div class="dim">' + escapeHtml(i18n.mcpPatchNoneYet) + '</div>';
        return;
      }
      wrap.innerHTML = patches.map((p) =>
        '<div class="mcp-patch-row">' +
          '<span class="mcp-patch-id">' + escapeHtml(p.patchId) + '</span>' +
          '<span class="mcp-patch-risk risk-' + (['high', 'medium', 'low'].includes(p.risk.level) ? p.risk.level : 'unknown') + '">' + escapeHtml(p.risk.level === 'high' ? i18n.mcpPatchRiskHigh : i18n.mcpPatchRiskMedium) + '</span>' +
          '<span class="mcp-patch-files">' + escapeHtml(p.files.map((f) => f.path).join(', ')) + '</span>' +
          '<button data-action="approve" data-id="' + escapeHtml(p.patchId) + '">' + escapeHtml(i18n.mcpPatchApprove) + '</button>' +
          '<button data-action="reject"  data-id="' + escapeHtml(p.patchId) + '">' + escapeHtml(i18n.mcpPatchReject) + '</button>' +
        '</div>'
      ).join('');
      wrap.querySelectorAll('button[data-action]').forEach((btn) => {
        btn.onclick = async () => {
          const id = btn.getAttribute('data-id');
          const action = btn.getAttribute('data-action');
          await jpost('/v1/mcp/patches/' + id + '/' + action, {});
          renderMcpPatches();
        };
      });
    } catch (err) {
      wrap.innerHTML = '<div class="err">' + escapeHtml(String(err)) + '</div>';
    }
  }
  renderMcpPatches();
  setInterval(renderMcpPatches, 5000);

  // ── Anthropic Gateway Phase 1 toggle card ────────────────────────────
  // postTierkitCommand: sends a tk:cmd to the extension host (VS Code only).
  // In browser context, acquireVsCodeApi is not available — the toggle is disabled.
  function postTierkitCommand(commandName) {
    if (typeof acquireVsCodeApi === 'function') {
      const api = (window.__tierkitVsApi || (window.__tierkitVsApi = acquireVsCodeApi()));
      api.postMessage({ type: 'tk:cmd', command: commandName });
      return true;
    }
    return false;
  }

  const tkGatewayToggle = $('tk-gateway-toggle');
  const tkGatewayToggleLabel = $('tk-gateway-toggle-label');
  const tkGatewayBrowserNote = $('tk-gateway-browser-note');

  async function refreshGatewayToggle() {
    if (!tkGatewayToggle) return;
    // Check if we're in VS Code context; if not, disable with a note.
    if (typeof acquireVsCodeApi !== 'function') {
      tkGatewayToggle.disabled = true;
      if (tkGatewayBrowserNote) tkGatewayBrowserNote.style.display = '';
      if (tkGatewayToggleLabel) tkGatewayToggleLabel.textContent = 'Gateway (disabled in browser)';
      return;
    }
    try {
      const r = await transport.request('/v1/gateway/status', { method: 'GET' });
      if (r.ok && r.data && typeof r.data.gatewayMode === 'string') {
        tkGatewayToggle.checked = r.data.gatewayMode === 'on';
        tkGatewayToggle.disabled = false;
        if (tkGatewayToggleLabel) {
          tkGatewayToggleLabel.textContent = r.data.gatewayMode === 'on' ? 'On' : 'Off';
        }
      } else {
        tkGatewayToggle.disabled = true;
        if (tkGatewayToggleLabel) tkGatewayToggleLabel.textContent = 'Unavailable';
      }
    } catch (_) {
      tkGatewayToggle.disabled = true;
      if (tkGatewayToggleLabel) tkGatewayToggleLabel.textContent = 'Unavailable';
    }
  }

  if (tkGatewayToggle) {
    tkGatewayToggle.addEventListener('change', () => {
      // Dispatch the toggle command via the extension host (VS Code only).
      // In browser context postTierkitCommand returns false — the toggle
      // is disabled above so this path is unreachable in practice.
      postTierkitCommand('tierkit.toggleGatewayMode');
      // Optimistically flip the label; actual state will update on next refresh.
      if (tkGatewayToggleLabel) {
        tkGatewayToggleLabel.textContent = tkGatewayToggle.checked ? 'On' : 'Off';
      }
    });
    void refreshGatewayToggle();
  }

  refreshAll();
  void subscribeSavings();
  // Auto-refresh activity + usage + health every 5s. Savings is handled by
  // the SSE stream above and is intentionally absent here.
  setInterval(() => { refreshActivity(); refreshUsage(); refreshHealth(); }, 5_000);
})();
</script>

<!-- v0.12.2 — Compare cost-preview modal (populated by JS) -->
<div id="c122-modal-backdrop" class="c122-modal-backdrop" hidden>
  <div class="c122-modal" role="dialog" aria-labelledby="c122-modal-title">
    <h3 id="c122-modal-title" data-i18n="modalCompareTitle">Compare baseline vs compressed</h3>
    <p>
      <span data-i18n="modalCompareDescription">This runs 2 paid model calls on </span>
      <code id="c122-modal-profile">claudeSonnet</code>:
    </p>
    <table>
      <tr>
        <td data-i18n="labelCompareBaseline">Baseline</td>
        <td><span id="c122-modal-baseline-tokens">—</span> input tokens</td>
        <td>est cost <span id="c122-modal-baseline-cost">—</span></td>
      </tr>
      <tr>
        <td data-i18n="labelCompareCompressed">Compressed</td>
        <td><span id="c122-modal-compressed-tokens">—</span> input tokens</td>
        <td>est cost <span id="c122-modal-compressed-cost">—</span></td>
      </tr>
    </table>
    <p class="dim" data-i18n="modalCompareCostCaveat">
      Estimated input cost only — output cost not included. If you cancel after a call has started, tokens may still be billed.
    </p>
    <div class="c122-modal-actions">
      <button id="c122-modal-cancel" data-i18n="labelCancelButton">Cancel</button>
      <button id="c122-modal-run" class="primary" data-i18n="labelRunCompareButton">Run compare</button>
    </div>
  </div>
</div>

</body>
</html>`;
