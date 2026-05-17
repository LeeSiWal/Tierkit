/**
 * Single-file browser UI for the Tierkit runtime daemon — Mission Control.
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
  /* ── Layout / cards ──────────────────────────────────────────────────────── */
  main {
    max-width: 880px;
    margin: 0 auto;
    padding: 14px 12px;
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
  }
  @media (min-width: 720px) {
    main { grid-template-columns: 1fr 1fr; }
    .card.full { grid-column: 1 / -1; }
  }
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px;
  }
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
  .row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); }
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
  .inline-form .form-grid { display: grid; grid-template-columns: auto 1fr; gap: 6px 8px; align-items: center; font-size: 12px; }
  .inline-form label { font-size: 11px; color: var(--fg-dim); }
  .inline-form input, .inline-form select { width: 100%; padding: 4px 6px; }
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
  }
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
  .tab-panel.active { display: block; flex: 1; min-height: 0; overflow-y: auto; }
  /* Chat tab: full-height layout. Thread expands to fill, composer stays pinned just
     below via natural flex flow (NOT sticky — sticky needs a scroll-root that webview
     iframes don't provide, which is what broke 0.8.2). */
  .tab-panel.active[data-tab-panel="chat"] {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

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
      <span data-i18n="cardAgent">Agent</span>
      <span id="agent-status" class="agent-status pill pill-dim">idle</span>
      <span id="agent-usage-meter" class="pill pill-dim" style="font-size:10px;font-family:var(--mono);display:none">0 tok</span>
      <span class="h2-actions">
        <button id="btn-agent-export" class="tiny" title="export conversation" data-i18n="exportBtn">Export</button>
        <button id="btn-agent-import" class="tiny" title="import conversation" data-i18n="importBtn">Import</button>
        <button id="btn-agent-clear" class="tiny" title="clear thread" data-i18n="clearBtn">Clear</button>
      </span>
    </h2>
    <div id="agent-thread" class="agent-thread">
      <div class="agent-empty" data-i18n="agentEmpty">Type a task below to run the Tierkit agent. Every model call goes through the same routing + policy stack as the rest of Tierkit.</div>
    </div>
    <div class="agent-composer">
      <textarea id="agent-input" rows="2" data-i18n-placeholder="agentPlaceholder" placeholder="Describe what you want done. e.g. 'list files in src/ and explain the structure'"></textarea>
      <button id="agent-send" class="primary" title="send (Enter)">→</button>
      <button id="agent-stop" title="stop" style="display:none">■</button>
    </div>
    <div id="agent-composer-meta" style="display:flex;gap:8px;align-items:center;margin-top:6px;font-size:11px;color:var(--fg-dim);flex-wrap:wrap">
      <span data-i18n="modeLabel">mode:</span>
      <select id="agent-mode-select" style="padding:2px 6px;font-size:11px"></select>
      <span data-i18n="approvalLabel">approval:</span>
      <select id="agent-approval-select" style="padding:2px 6px;font-size:11px">
        <option value="auto" data-i18n="approvalAuto">auto</option>
        <option value="interactive" data-i18n="approvalInteractive">ask each</option>
      </select>
      <span class="spacer" style="flex:1"></span>
      <span><span class="kbd" style="font-family:var(--mono);background:var(--bg-input);padding:1px 5px;border-radius:3px;font-size:10px">/</span> <span data-i18n="forSlash">for plugin commands</span></span>
    </div>
    <div id="agent-slash-suggest" style="display:none;position:relative">
      <div style="position:absolute;left:0;right:60px;bottom:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,0.4);max-height:180px;overflow-y:auto;font-family:var(--mono);font-size:11.5px;z-index:5"></div>
    </div>
    <div id="agent-attachments" style="display:none;flex-wrap:wrap;gap:6px;margin-top:6px"></div>
  </div>
</div>
</div><!-- /tab-panel:chat -->

<main class="tab-panel" data-tab-panel="settings">

  <!-- ── TODAY hero ─────────────────────────────────────────────────── -->
  <div class="usage-hero">
    <div class="hero-stat"><span class="label" data-i18n="calls">calls</span><span class="value" id="stat-calls">—</span></div>
    <div class="hero-stat"><span class="label" data-i18n="tokens">tokens</span><span class="value" id="stat-tokens">—</span></div>
    <div class="hero-stat"><span class="label" data-i18n="cost">cost</span><span class="value hero-cost" id="stat-cost">—</span></div>
    <span class="spacer" style="flex:1"></span>
    <div id="usage-by-profile" style="font-size:10.5px;color:var(--fg-dim)"></div>
  </div>

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

  <section class="card">
    <h2>
      <span data-i18n="cardPlugins">Active plugins</span>
      <span class="h2-actions">
        <button id="btn-plugin-install" class="tiny" data-i18n="pluginInstall">+ Install</button>
        <button id="btn-plugin-new" class="tiny" data-i18n="pluginNew">+ New</button>
      </span>
    </h2>
    <div id="plugins-list"><div class="empty" data-i18n="loading">loading…</div></div>
    <div id="plugin-install-form" style="display:none"></div>
    <div id="plugin-new-form" style="display:none"></div>
  </section>

  <!-- ── CONFIGURATION ──────────────────────────────────────────────── -->
  <h3 class="settings-group" data-i18n="groupConfiguration">Configuration</h3>

  <section class="card">
    <h2>
      <span data-i18n="cardModels">Model profiles</span>
      <span class="h2-actions">
        <button id="btn-profile-add" class="tiny" data-i18n="profileAdd">+ Add</button>
      </span>
    </h2>
    <div id="models-list"><div class="empty" data-i18n="loading">loading…</div></div>
    <div id="profile-add-form" style="display:none"></div>
  </section>

  <section class="card">
    <h2>
      <span data-i18n="cardConfigDaemon">Config / Daemon</span>
      <span class="h2-actions">
        <button id="btn-settings-reload" class="tiny" data-i18n="reloadBtn">Reload</button>
      </span>
    </h2>
    <div id="settings-view" class="row mono dim" data-i18n="loading">loading…</div>
    <div class="card-divider">
      <div class="card-divider-label" data-i18n="cardDaemon">Daemon</div>
      <div id="daemon-info" class="row mono dim" data-i18n="loading">loading…</div>
    </div>
  </section>

  <!-- ── ACTIVITY ───────────────────────────────────────────────────── -->
  <h3 class="settings-group" data-i18n="groupActivity">Activity</h3>

  <section class="card full">
    <h2>
      <span data-i18n="cardActivity">Recent activity</span>
      <span id="activity-dot" class="pill pill-dim" style="font-size:10px">●</span>
    </h2>
    <div id="activity-list"><div class="empty" data-i18n="loading">loading…</div></div>
  </section>

</main>

<script>
(function () {
  // ── Localization tables ────────────────────────────────────────────────────
  const LOCALES = {
    ko: {
      cardTools: '연결된 도구', cardPlugins: '활성 플러그인', cardActivity: '최근 활동',
      cardUsage: '오늘 사용량', cardModels: '모델 프로파일', cardDaemon: '데몬',
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
      groupIntegrations: '통합',
      groupConfiguration: '설정',
      groupActivity: '활동',
    },
  };
  const lang = (navigator.language || 'en').toLowerCase().startsWith('ko') ? 'ko' : 'en';
  if (lang !== 'en' && LOCALES[lang]) {
    const t = LOCALES[lang];
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const k = el.getAttribute('data-i18n');
      if (t[k]) el.textContent = t[k];
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
  setActiveTab(loadActiveTab() || 'chat');

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
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmtCost(n) { return '$' + (Number(n) || 0).toFixed(4); }
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
    if (!r.ok && r.status !== 400) throw new Error(r.data?.error || r.data?.message || ('HTTP ' + r.status));
    return { ok: r.ok, status: r.status, data: r.data };
  }

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
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
          // Plain confirm() works in both VS Code webviews and browser mode.
          if (!confirm((lang === 'ko' ? '플러그인을 삭제할까요? ' : 'Remove plugin? ') + id)) return;
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
        const profileSpan = '<span style="color:' + statusColor + '">' + escapeHtml(rec.profileId) + '</span>';
        const latency = rec.latencyMs ? rec.latencyMs + 'ms' : '';
        const tokens = (rec.inputTokens || rec.outputTokens)
          ? (rec.inputTokens || 0) + '↑/' + (rec.outputTokens || 0) + '↓'
          : '';
        const cost = rec.costUsd ? fmtCost(rec.costUsd) : (rec.ok ? 'free' : '');
        const meta = [latency, tokens, cost].filter(Boolean).join(' · ');
        row.innerHTML =
          '<div class="activity-line1">' +
            '<span class="dim">' + escapeHtml(fmtTime(rec.timestamp)) + '</span>' +
            profileSpan +
            (rec.tier ? ' <span class="dim">(' + escapeHtml(rec.tier) + ')</span>' : '') +
            (rec.ok ? '' : ' <span style="color:var(--err)">✗ ' + escapeHtml(rec.failureCode || 'err') + '</span>') +
          '</div>' +
          (meta ? '<div class="activity-line2">' + escapeHtml(meta) + '</div>' : '');
        root.appendChild(row);
      }
    } catch (e) {
      $('activity-list').innerHTML = '<div class="empty">' + escapeHtml(e.message) + '</div>';
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
        // Render inline so it fits next to the hero stats (single line, wraps on overflow).
        byp.innerHTML = entries
          .map(([id, v]) =>
            '<span class="mono" style="color:var(--accent);margin-right:10px;white-space:nowrap">' +
              escapeHtml(id) + ' <span class="dim">' + fmtCost(v.costUsd) + '</span>' +
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

  // ── Card: Models ───────────────────────────────────────────────────────────
  async function refreshModels() {
    try {
      const r = await jget('/v1/models');
      const entries = r.entries || [];
      const root = $('models-list');
      root.innerHTML = '';
      if (entries.length === 0) {
        root.innerHTML = '<div class="empty">no profiles</div>';
        return;
      }
      const srcLabel = lang === 'ko'
        ? { bundled: '기본', user: '사용자', workspace: '워크스페이스' }
        : { bundled: 'bundled', user: 'user', workspace: 'workspace' };
      for (const e of entries) {
        const p = e.profile || {};
        const row = document.createElement('div');
        row.className = 'row dense';
        row.innerHTML =
          '<div class="col-grow">' +
            '<div><span class="mono" style="color:var(--accent)">' + escapeHtml(e.id) + '</span>' +
              ' <span class="dim">(' + escapeHtml(p.kind || '?') + ')</span></div>' +
            '<div class="dim mono" style="margin-top:2px;font-size:10.5px">' +
              escapeHtml(p.provider || '') + ' · ' + escapeHtml(p.model || '') +
              ' · <span style="color:var(--fg-dim)">' + escapeHtml(srcLabel[e.source] || e.source) + '</span>' +
              (p.requiresApproval ? ' · <span style="color:var(--warn)">⚠</span>' : '') +
            '</div>' +
          '</div>' +
          '<button class="tiny" data-action="test" data-id="' + escapeHtml(e.id) + '">test</button>';
        root.appendChild(row);
      }
      root.querySelectorAll('button[data-action="test"]').forEach((b) => {
        b.onclick = async () => {
          const id = b.getAttribute('data-id'); b.disabled = true; b.textContent = '...';
          try {
            const resp = await jpost('/v1/models/test', { profileId: id });
            const d = resp.data || {};
            if (resp.ok) toast(id + ' ✓ ' + (d.modelAvailable === false ? 'reachable, model missing' : 'reachable'), d.modelAvailable === false ? 'err' : 'ok');
            else toast(id + ': ' + (d.code || 'err'), 'err');
          } finally { b.disabled = false; b.textContent = 'test'; }
        };
      });
    } catch (e) {
      $('models-list').innerHTML = '<div class="empty">' + escapeHtml(e.message) + '</div>';
    }
  }

  $('btn-profile-add').onclick = () => {
    const host = $('profile-add-form');
    host.style.display = 'block';
    const PROVIDERS = {
      anthropic: { kind: 'private-remote', apiKeyEnv: 'ANTHROPIC_API_KEY', baseUrl: '', model: 'claude-sonnet-4-6', idHint: 'claudeCustom' },
      openai:    { kind: 'public-cloud',   apiKeyEnv: 'OPENAI_API_KEY',    baseUrl: '', model: 'gpt-4o', idHint: 'gptCustom' },
      ollama:    { kind: 'local-device',   apiKeyEnv: '',                  baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5-coder:7b', idHint: 'localCustom' },
    };

    function render(provider) {
      const tpl = PROVIDERS[provider];
      const isLocal = tpl.kind === 'local-device';
      host.innerHTML =
        '<div class="inline-form">' +
          '<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap">' +
            ['anthropic', 'openai', 'ollama'].map((p) =>
              '<button data-prov="' + p + '" style="' + (p === provider ? 'background:var(--accent);color:#0f1115;border-color:var(--accent)' : '') + '">' + p + '</button>'
            ).join('') +
          '</div>' +
          '<div class="form-grid">' +
            '<label>' + escapeHtml(i18n.idLabel) + '</label>' +
            '<input id="pa-id" placeholder="' + escapeHtml(tpl.idHint) + '" />' +
            '<label>' + escapeHtml(i18n.modelLabel) + '</label>' +
            '<input id="pa-model" value="' + escapeHtml(tpl.model) + '" />' +
            (isLocal
              ? '<label>' + escapeHtml(i18n.baseUrlLabel) + '</label>' +
                '<input id="pa-baseUrl" value="' + escapeHtml(tpl.baseUrl) + '" />'
              : '<label>' + escapeHtml(i18n.apiKeyLabel) + '</label>' +
                '<input id="pa-apiKey" value="' + escapeHtml(tpl.apiKeyEnv) + '" />') +
            '<label>' + escapeHtml(i18n.scopeLabel) + '</label>' +
            '<select id="pa-scope">' +
              '<option value="workspace">' + escapeHtml(i18n.scopeWorkspace) + '</option>' +
              '<option value="user">' + escapeHtml(i18n.scopeUser) + '</option>' +
            '</select>' +
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
        const apiKey = $('pa-apiKey') ? $('pa-apiKey').value.trim() : '';
        const baseUrl = $('pa-baseUrl') ? $('pa-baseUrl').value.trim() : '';
        if (!id || !model) { toast('id + model required', 'err'); return; }
        const profile = { kind: tpl.kind, provider, model, roles: [] };
        if (apiKey) profile.apiKeyEnv = apiKey;
        if (baseUrl) profile.baseUrl = baseUrl;
        if (tpl.kind === 'public-cloud') { profile.requiresApproval = true; profile.defaultMode = 'review-only'; }
        const resp = await jpost('/v1/config/profile', { id, profile, scope });
        if (!resp.ok) { toast(resp.data?.message || i18n.failed, 'err'); return; }
        toast(id + ' ✓ ' + i18n.added, 'ok');
        host.style.display = 'none'; host.innerHTML = '';
        await refreshModels();
      };
    }
    render('anthropic');
  };

  // ── Card: Daemon ───────────────────────────────────────────────────────────
  async function refreshHealth() {
    try {
      const h = await jget('/v1/health');
      $('health-pill').textContent = 'v' + h.version;
      $('health-pill').className = 'pill pill-ok';
      $('daemon-info').textContent = h.cwd;
    } catch (e) {
      $('health-pill').textContent = i18n.offline;
      $('health-pill').className = 'pill pill-err';
      $('daemon-info').textContent = e.message;
    }
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
    if (evt.type === 'assistant_text') {
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
      const preview = content.length > 800 ? content.slice(0, 800) + '\\n... (' + (content.length - 800) + ' more bytes)' : content;
      body.removeAttribute('data-pending');
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
      const reqBody = { task: finalTask, mode: selectedMode, approvalMode, ...(attachmentsForSubmit ? { attachments: attachmentsForSubmit } : {}) };
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
  agentInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = agentInput.value;
      agentInput.value = '';
      void submitAgentTask(text);
    }
  });

  // ── Settings panel: read-only view of the resolved Tierkit config + source map. ───
  async function refreshSettings() {
    const host = $('settings-view');
    try {
      const r = await jget('/v1/config');
      const profileEntries = Object.entries(r.config?.modelProfiles || {});
      const sources = r.profileSources || {};
      const rows = profileEntries.map(([id, p]) => {
        const src = sources[id] || 'unknown';
        const tier = p.tier ? '<span class="pill pill-accent" style="font-size:9px">' + escapeHtml(p.tier) + '</span>' : '';
        return '<tr>' +
          '<td><b>' + escapeHtml(id) + '</b> ' + tier + '</td>' +
          '<td>' + escapeHtml(p.provider || '') + '</td>' +
          '<td>' + escapeHtml(p.model || '') + '</td>' +
          '<td><span class="pill pill-dim" style="font-size:9px">' + escapeHtml(src) + '</span></td>' +
          '</tr>';
      }).join('');
      const cfgPath = r.configPath || (lang === 'ko' ? '없음' : 'none');
      const userPath = r.userConfigPath || (lang === 'ko' ? '없음' : 'none');
      host.innerHTML =
        '<div style="margin-bottom:8px;font-family:var(--mono);font-size:11px">' +
          '<div>workspace: <span class="dim">' + escapeHtml(cfgPath) + '</span></div>' +
          '<div>user: <span class="dim">' + escapeHtml(userPath) + '</span></div>' +
          '<div>found: <span class="dim">' + (r.found ? 'yes' : 'no (using bundled defaults)') + '</span></div>' +
        '</div>' +
        '<table style="width:100%;border-collapse:collapse;font-size:11px;font-family:var(--mono)">' +
        '<thead><tr style="text-align:left;border-bottom:1px solid var(--border)">' +
          '<th>profile</th><th>provider</th><th>model</th><th>source</th></tr></thead>' +
        '<tbody>' + (rows || '<tr><td colspan="4" class="dim">no profiles</td></tr>') + '</tbody></table>';
    } catch (e) {
      host.innerHTML = '<div class="empty">' + escapeHtml(e.message) + '</div>';
    }
  }
  $('btn-settings-reload').onclick = refreshSettings;

  // ── Wire-up ────────────────────────────────────────────────────────────────
  async function refreshAll() {
    await Promise.all([refreshHealth(), refreshFreedom(), refreshTools(), refreshPlugins(), refreshActivity(), refreshUsage(), refreshModels(), loadAgentModesAndCommands(), refreshSettings()]);
  }
  $('btn-refresh').onclick = refreshAll;

  refreshAll();
  // Auto-refresh activity + usage every 5s — the user wants to see Roo's calls appear live.
  setInterval(() => { refreshActivity(); refreshUsage(); refreshHealth(); }, 5_000);
})();
</script>

</body>
</html>`;
