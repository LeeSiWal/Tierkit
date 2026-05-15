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
  html, body { margin: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font: 13px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif;
    padding-bottom: 24px;
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

<div id="host-banner" class="err-banner" style="display:none"></div>

<main>

  <section class="card full">
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
        <button id="btn-plugin-new" class="tiny" data-i18n="pluginNew">+ New</button>
      </span>
    </h2>
    <div id="plugins-list"><div class="empty" data-i18n="loading">loading…</div></div>
    <div id="plugin-new-form" style="display:none"></div>
  </section>

  <section class="card">
    <h2>
      <span data-i18n="cardActivity">Recent activity</span>
      <span id="activity-dot" class="pill pill-dim" style="font-size:10px">●</span>
    </h2>
    <div id="activity-list"><div class="empty" data-i18n="loading">loading…</div></div>
  </section>

  <section class="card">
    <h2><span data-i18n="cardUsage">Today's usage</span></h2>
    <div class="stats">
      <div class="stat"><div class="stat-label" data-i18n="calls">calls</div><div class="stat-value" id="stat-calls">—</div></div>
      <div class="stat"><div class="stat-label" data-i18n="tokens">tokens</div><div class="stat-value" id="stat-tokens">—</div></div>
      <div class="stat"><div class="stat-label" data-i18n="cost">cost</div><div class="stat-value" id="stat-cost">—</div></div>
    </div>
    <div id="usage-by-profile" style="margin-top:10px"></div>
  </section>

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
    <h2><span data-i18n="cardDaemon">Daemon</span></h2>
    <div id="daemon-info" class="row mono dim" data-i18n="loading">loading…</div>
  </section>

</main>

<script>
(function () {
  // ── Localization tables ────────────────────────────────────────────────────
  const LOCALES = {
    ko: {
      cardTools: '연결된 도구', cardPlugins: '활성 플러그인', cardActivity: '최근 활동',
      cardUsage: '오늘 사용량', cardModels: '모델 프로파일', cardDaemon: '데몬',
      sync: '플러그인 동기화', pluginNew: '+ 새 플러그인', profileAdd: '+ 추가',
      calls: '호출', tokens: '토큰', cost: '비용',
      loading: '불러오는 중…',
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
    },
  };
  const i18n = RUNTIME[lang] || RUNTIME.en;

  // ── State + helpers ────────────────────────────────────────────────────────
  const BASE = (typeof window !== 'undefined' && window.__TIERKIT_BASE_URL__) || '';
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
  async function jget(p) { const r = await fetch(BASE + p); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }
  async function jpost(p, b) {
    const r = await fetch(BASE + p, { method: 'POST', headers: {'content-type':'application/json'}, body: b !== undefined ? JSON.stringify(b) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok && r.status !== 400) throw new Error(d?.error || d?.message || ('HTTP ' + r.status));
    return { ok: r.ok, status: r.status, data: d };
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
  async function refreshPlugins() {
    try {
      const r = await jget('/v1/plugins');
      const list = r.plugins || [];
      const root = $('plugins-list');
      root.innerHTML = '';
      if (list.length === 0) {
        root.innerHTML = '<div class="empty">' + escapeHtml(i18n.noPlugins) + '</div>';
        return;
      }
      for (const p of list) {
        const row = document.createElement('div');
        row.className = 'row dense';
        const statusPill = p.enabled
          ? '<span class="pill pill-ok" style="font-size:10px">' + escapeHtml(i18n.enabled) + '</span>'
          : '<span class="pill pill-dim" style="font-size:10px">' + escapeHtml(i18n.disabled) + '</span>';
        row.innerHTML =
          '<div class="col-grow"><div><b>' + escapeHtml(p.id) + '</b> ' + statusPill +
            (p.manifest?.freedom?.level ? ' <span class="pill pill-accent" style="font-size:10px">' + escapeHtml(p.manifest.freedom.level) + '</span>' : '') +
            '</div>' +
            (p.manifest?.description ? '<div class="dim" style="margin-top:2px">' + escapeHtml(p.manifest.description) + '</div>' : '') +
          '</div>' +
          (p.enabled
            ? '<button class="tiny" data-action="disable" data-id="' + escapeHtml(p.id) + '">' + escapeHtml(i18n.disable) + '</button>'
            : '<button class="tiny primary" data-action="enable" data-id="' + escapeHtml(p.id) + '">' + escapeHtml(i18n.enable) + '</button>');
        root.appendChild(row);
      }
      root.querySelectorAll('button[data-action="enable"]').forEach((b) => {
        b.onclick = async () => {
          const id = b.getAttribute('data-id'); b.disabled = true;
          try {
            const resp = await jpost('/v1/plugins/enable', { pluginId: id });
            if (!resp.ok) { toast(resp.data?.message || i18n.failed, 'err'); return; }
            toast(id + ' ✓ ' + i18n.enabled, 'ok');
            await Promise.all([refreshPlugins(), refreshTools()]);
          } finally { b.disabled = false; }
        };
      });
      root.querySelectorAll('button[data-action="disable"]').forEach((b) => {
        b.onclick = async () => {
          const id = b.getAttribute('data-id'); b.disabled = true;
          try {
            const resp = await jpost('/v1/plugins/disable', { pluginId: id });
            if (!resp.ok) { toast(resp.data?.message || i18n.failed, 'err'); return; }
            toast(id + ' ✓ ' + i18n.disabled, 'ok');
            await refreshPlugins();
          } finally { b.disabled = false; }
        };
      });
    } catch (e) {
      $('plugins-list').innerHTML = '<div class="empty">' + escapeHtml(e.message) + '</div>';
    }
  }

  $('btn-plugin-new').onclick = () => {
    const host = $('plugin-new-form');
    host.style.display = 'block';
    host.innerHTML =
      '<div class="inline-form">' +
        '<div class="form-grid">' +
          '<label>' + escapeHtml(i18n.pluginIdLabel) + '</label>' +
          '<input id="pn-id" placeholder="my-team-rules" />' +
        '</div>' +
        '<div class="actions">' +
          '<button id="pn-cancel">' + escapeHtml(i18n.cancelBtn) + '</button>' +
          '<button id="pn-save" class="primary">' + escapeHtml(i18n.saveBtn) + '</button>' +
        '</div>' +
      '</div>';
    $('pn-cancel').onclick = () => { host.style.display = 'none'; host.innerHTML = ''; };
    $('pn-save').onclick = async () => {
      const id = ($('pn-id').value || '').trim();
      if (!id) return;
      const resp = await jpost('/v1/plugins/new', { id });
      if (!resp.ok) { toast(resp.data?.message || i18n.failed, 'err'); return; }
      toast(id + ' ✓ ' + i18n.newCreated, 'ok');
      host.style.display = 'none'; host.innerHTML = '';
      await refreshPlugins();
    };
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
        byp.innerHTML = '<div class="empty" style="font-size:11px">' + escapeHtml(i18n.runTaskHint) + '</div>';
      } else {
        byp.innerHTML = entries.map(([id, v]) =>
          '<div class="row dense" style="font-size:11px"><div class="col-grow"><span class="mono" style="color:var(--accent)">' + escapeHtml(id) + '</span></div>' +
          '<span class="nowrap dim">' + (v.calls || 0) + ' calls · ' + fmtCost(v.costUsd) + '</span></div>',
        ).join('');
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
    const acquire = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi : null;
    const vsApi = acquire ? acquire() : null;
    function post(type) { if (vsApi) vsApi.postMessage({ type }); }
    $('btn-host-output').onclick = () => post('showOutput');
    $('btn-host-restart').onclick = () => post('restartDaemon');
  })();

  // ── Wire-up ────────────────────────────────────────────────────────────────
  async function refreshAll() {
    await Promise.all([refreshHealth(), refreshFreedom(), refreshTools(), refreshPlugins(), refreshActivity(), refreshUsage(), refreshModels()]);
  }
  $('btn-refresh').onclick = refreshAll;

  refreshAll();
  // Auto-refresh activity + usage every 5s — the user wants to see Roo's calls appear live.
  setInterval(() => { refreshActivity(); refreshUsage(); refreshHealth(); }, 5_000);
})();
</script>

</body>
</html>`;
