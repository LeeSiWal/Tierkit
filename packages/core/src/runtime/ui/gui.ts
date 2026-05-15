/**
 * Single-file browser UI for the Tierkit runtime daemon.
 *
 * Inlined as a TypeScript string so the runtime ships as one self-contained build artifact —
 * no asset bundling, no path resolution, no template engine. The page uses vanilla JS via
 * `fetch` against the same `/v1/*` endpoints the CLI and `@tierkit/client` SDK use.
 *
 * Deliberately minimal: a single column with cards for health / task / session / usage /
 * models. No framework, no build step, no fonts. The whole point of a GUI here is *quick
 * visibility*, not a polished product surface.
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
  body {
    margin: 0;
    padding: 16px;
    background: var(--bg);
    color: var(--fg);
    font: 14px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif;
    max-width: 1100px;
    margin: 0 auto;
  }
  h1 { font-size: 18px; margin: 8px 0 16px; display: flex; align-items: center; gap: 12px; }
  h2 { font-size: 14px; margin: 0 0 12px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--fg-dim); }
  .grid { display: grid; gap: 12px; grid-template-columns: 1fr; }
  @media (min-width: 800px) { .grid-2 { grid-template-columns: 2fr 1fr; } }
  .card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
  }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .pill-ok { background: rgba(158, 206, 106, 0.12); color: var(--ok); }
  .pill-warn { background: rgba(224, 175, 104, 0.12); color: var(--warn); }
  .pill-err { background: rgba(247, 118, 142, 0.12); color: var(--err); }
  .pill-accent { background: rgba(122, 162, 247, 0.12); color: var(--accent); }
  label { display: block; font-size: 12px; color: var(--fg-dim); margin-bottom: 4px; }
  input, textarea, select, button {
    font: inherit;
    color: var(--fg);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    width: 100%;
  }
  textarea { resize: vertical; min-height: 90px; font-family: var(--mono); }
  button {
    cursor: pointer;
    width: auto;
    font-weight: 500;
  }
  button:hover { background: var(--bg-hover); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #0f1115; }
  button.primary:hover { filter: brightness(1.1); }
  button.danger { color: var(--err); border-color: rgba(247, 118, 142, 0.4); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  pre {
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px;
    overflow-x: auto;
    font-family: var(--mono);
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 500px;
    overflow-y: auto;
  }
  .row { display: flex; gap: 8px; align-items: end; flex-wrap: wrap; }
  .row > * { flex: 1 1 0; min-width: 0; }
  .row > button { flex: 0 0 auto; }
  .mono { font-family: var(--mono); font-size: 12px; }
  .dim { color: var(--fg-dim); }
  .small { font-size: 11px; color: var(--fg-dim); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  th { color: var(--fg-dim); font-weight: 500; }
  .stat-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 12px; }
  .stat { background: var(--bg-input); padding: 10px; border-radius: 6px; }
  .stat-label { font-size: 11px; color: var(--fg-dim); text-transform: uppercase; }
  .stat-value { font-size: 18px; font-weight: 600; font-family: var(--mono); }
  .session-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
  .session-actions button { flex: 0 1 auto; font-size: 12px; padding: 6px 10px; }
  .history-list { font-size: 11px; font-family: var(--mono); max-height: 140px; overflow-y: auto; padding: 8px; background: var(--bg-input); border-radius: 4px; }
  .history-list div { padding: 2px 0; }
  .empty { color: var(--fg-dim); font-style: italic; }
  .err-banner { background: rgba(247, 118, 142, 0.12); color: var(--err); padding: 10px 12px; border-radius: 6px; margin-bottom: 12px; font-family: var(--mono); font-size: 12px; }
</style>
</head>
<body>

<h1>
  <span>Tierkit</span>
  <span id="health-pill" class="pill pill-warn">…</span>
  <span id="freedom-pill" class="pill pill-accent">freedom: …</span>
  <span style="flex:1"></span>
  <button id="btn-refresh" title="Reload all panels">↻</button>
</h1>

<div id="err-banner" class="err-banner" style="display:none"></div>

<div class="grid grid-2">

  <!-- LEFT COLUMN -->
  <div class="grid">

    <div class="card">
      <h2>Run a task</h2>
      <label for="t-task">Task</label>
      <textarea id="t-task" placeholder="Summarize this project's plugin format."></textarea>
      <div style="height:8px"></div>
      <div class="row">
        <div>
          <label for="t-profile">Profile</label>
          <select id="t-profile"></select>
        </div>
        <div>
          <label for="t-mode">Mode</label>
          <select id="t-mode">
            <option value="execute" selected>execute</option>
            <option value="plan">plan</option>
            <option value="review">review</option>
          </select>
        </div>
        <button id="btn-run" class="primary">Run</button>
      </div>
      <div style="height:12px"></div>
      <div id="run-meta" class="small"></div>
      <pre id="run-output" class="empty">(output appears here)</pre>
    </div>

    <div class="card">
      <h2>Usage</h2>
      <div class="stat-row">
        <div class="stat"><div class="stat-label">Calls</div><div class="stat-value" id="u-calls">—</div></div>
        <div class="stat"><div class="stat-label">Tokens (in/out)</div><div class="stat-value" id="u-tokens">—</div></div>
        <div class="stat"><div class="stat-label">Cost</div><div class="stat-value" id="u-cost">—</div></div>
      </div>
      <div id="u-by-profile" class="small dim">Per-profile breakdown loads…</div>
    </div>

    <div class="card">
      <h2>Models</h2>
      <div id="m-list"><span class="empty">loading…</span></div>
    </div>

  </div>

  <!-- RIGHT COLUMN -->
  <div class="grid">

    <div class="card">
      <h2>Session</h2>
      <div id="s-status"><span class="empty">no current session</span></div>
      <div class="session-actions" id="s-actions">
        <input id="s-new-task" placeholder="task for a new session…" style="flex:1 1 200px" />
        <button id="btn-session-start">Start</button>
      </div>
    </div>

    <div class="card">
      <h2>Daemon</h2>
      <div id="d-info" class="mono dim">loading…</div>
    </div>

  </div>

</div>

<script>
(function () {
  const $ = (id) => document.getElementById(id);
  const banner = $('err-banner');

  function showError(msg) {
    banner.textContent = msg;
    banner.style.display = 'block';
  }
  function clearError() { banner.style.display = 'none'; }

  async function jget(path) {
    const res = await fetch(path);
    const body = await res.json();
    if (!res.ok && res.status !== 400) throw new Error(body?.error || body?.message || res.status);
    return body;
  }
  async function jpost(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok && res.status !== 400) throw new Error(data?.error || data?.message || res.status);
    return { ok: res.ok, status: res.status, data };
  }

  async function refreshHealth() {
    try {
      const h = await jget('/v1/health');
      $('health-pill').textContent = 'v' + h.version;
      $('health-pill').className = 'pill pill-ok';
      $('d-info').textContent = h.cwd;
    } catch (e) {
      $('health-pill').textContent = 'offline';
      $('health-pill').className = 'pill pill-err';
      showError('Daemon unreachable: ' + e.message);
    }
  }

  async function refreshSession() {
    try {
      const r = await jget('/v1/session');
      $('freedom-pill').textContent = 'freedom: ' + r.freedom;
      $('freedom-pill').className = 'pill pill-' + (r.freedom === 'strict' ? 'err' : r.freedom === 'balanced' ? 'warn' : 'accent');
      renderSession(r.session);
    } catch (e) {
      $('s-status').innerHTML = '<span class="empty">session error: ' + e.message + '</span>';
    }
  }

  function renderSession(s) {
    const status = $('s-status');
    const actions = $('s-actions');
    if (!s) {
      status.innerHTML = '<span class="empty">no current session — start one below</span>';
      actions.innerHTML = '<input id="s-new-task" placeholder="task for a new session…" style="flex:1 1 200px" />' +
        '<button id="btn-session-start">Start</button>';
      $('btn-session-start').onclick = startSession;
      return;
    }
    const state = s.state;
    const stateClass = state === 'done' ? 'ok' : state === 'abandoned' ? 'err' : 'accent';
    status.innerHTML =
      '<div style="display:flex;gap:8px;align-items:baseline;margin-bottom:8px"><span class="pill pill-' + stateClass + '">' + state + '</span>' +
      (s.planApproved ? '<span class="pill pill-ok">plan ✓</span>' : '<span class="pill pill-warn">plan pending</span>') +
      '</div>' +
      '<div class="small dim">id ' + s.id.slice(0, 8) + ' · started ' + s.createdAt.replace('T', ' ').slice(0, 19) + '</div>' +
      '<div class="mono" style="margin:8px 0;font-weight:500;font-size:13px">' + escapeHtml(s.task) + '</div>' +
      '<div class="small dim" style="margin-bottom:4px">History (' + s.history.length + ' events)</div>' +
      '<div class="history-list">' + s.history.map(h =>
        '<div><span class="dim">' + h.timestamp.slice(11, 19) + '</span> ' +
        (h.from ? escapeHtml(h.from) + ' → ' : '') + '<b>' + escapeHtml(h.to) + '</b>' +
        (h.reason ? ' <span class="dim">(' + escapeHtml(h.reason) + ')</span>' : '') + '</div>'
      ).join('') + '</div>';

    // Build the action buttons appropriate for current state.
    const buttons = [];
    if (state === 'planning' && !s.planApproved) buttons.push(['Approve plan', () => post('/v1/session/approve-plan')]);
    if (state === 'planning') buttons.push(['→ implementing', () => post('/v1/session/advance', { toState: 'implementing' })]);
    if (state === 'implementing') buttons.push(['→ reviewing', () => post('/v1/session/advance', { toState: 'reviewing' })]);
    if (state === 'reviewing') buttons.push(['→ done', () => post('/v1/session/advance', { toState: 'done' })]);
    if (state !== 'done' && state !== 'abandoned') buttons.push(['Abandon', () => post('/v1/session/abandon'), 'danger']);

    actions.innerHTML = '';
    for (const [label, fn, cls] of buttons) {
      const btn = document.createElement('button');
      btn.textContent = label;
      if (cls) btn.className = cls;
      btn.onclick = async () => { btn.disabled = true; await fn(); };
      actions.appendChild(btn);
    }
  }

  async function post(path, body) {
    clearError();
    try {
      const r = await jpost(path, body);
      if (r.status === 400) showError(r.data.code + ': ' + r.data.message);
      await refreshSession();
    } catch (e) {
      showError(e.message);
    }
  }

  async function startSession() {
    const task = ($('s-new-task').value || '').trim();
    if (!task) return showError('enter a task first');
    clearError();
    try {
      await jpost('/v1/session/start', { task });
      $('s-new-task').value = '';
      await refreshSession();
    } catch (e) {
      showError(e.message);
    }
  }

  async function refreshModels() {
    try {
      const r = await jget('/v1/models');
      const sel = $('t-profile');
      const cur = sel.value;
      sel.innerHTML = '<option value="">(auto-route)</option>' + r.entries.map(e =>
        '<option value="' + e.id + '">' + e.id + ' — ' + e.profile.kind + '/' + e.profile.provider + '/' + e.profile.model + '</option>'
      ).join('');
      if (cur) sel.value = cur;

      $('m-list').innerHTML = r.entries.length === 0
        ? '<span class="empty">no profiles in tierkit.config.json — add modelProfiles</span>'
        : '<table><thead><tr><th>id</th><th>tier</th><th>provider</th><th>model</th><th>cost</th><th>approval</th></tr></thead><tbody>' +
          r.entries.map(e => '<tr><td class="mono">' + escapeHtml(e.id) + '</td><td><span class="pill pill-' +
            (e.profile.kind === 'public-cloud' ? 'err' : e.profile.kind === 'private-remote' ? 'warn' : 'ok') +
            '">' + e.profile.kind + '</span></td><td>' + escapeHtml(e.profile.provider) + '</td><td class="mono">' +
            escapeHtml(e.profile.model) + '</td><td>' + fmtCost(e.profile.cost) + '</td><td>' +
            (e.profile.requiresApproval ? 'yes' : 'no') + '</td></tr>').join('') + '</tbody></table>';
    } catch (e) {
      $('m-list').innerHTML = '<span class="empty">models error: ' + e.message + '</span>';
    }
  }
  function fmtCost(c) {
    if (!c) return '<span class="dim">—</span>';
    if (c.type === 'free') return 'free';
    if (c.type === 'flat') return '$' + c.monthlyUsd + '/mo';
    return '$' + c.inputUsdPerMillion + '/M in';
  }

  async function refreshUsage() {
    try {
      const r = await jget('/v1/usage');
      $('u-calls').textContent = r.summary.totalCalls + ' (' + r.summary.successfulCalls + ' ok, ' + r.summary.failedCalls + ' fail)';
      $('u-tokens').textContent = r.summary.totalInputTokens + ' / ' + r.summary.totalOutputTokens;
      $('u-cost').textContent = '$' + r.summary.totalCostUsd.toFixed(4);
      const byProfile = r.summary.byProfile || {};
      const keys = Object.keys(byProfile);
      $('u-by-profile').innerHTML = keys.length === 0
        ? '(no calls yet — run a task above)'
        : keys.map(k => k + ': ' + byProfile[k].calls + ' calls, $' + byProfile[k].costUsd.toFixed(4)).join(' · ');
    } catch (e) {
      $('u-by-profile').innerHTML = '<span class="empty">usage error: ' + e.message + '</span>';
    }
  }

  $('btn-run').onclick = async () => {
    const task = ($('t-task').value || '').trim();
    if (!task) return showError('enter a task first');
    const profileId = $('t-profile').value;
    const mode = $('t-mode').value;
    if (!profileId) return showError('select a profile (auto-route via daemon is a v1.x follow-up)');

    clearError();
    $('btn-run').disabled = true;
    $('run-output').textContent = '';
    $('run-output').classList.remove('empty');
    $('run-meta').textContent = 'sending…';
    const start = Date.now();
    try {
      // Compose minimal system prompt locally so the UI is self-contained; the daemon's
      // route-run pipeline is currently only exposed via the CLI. /v1/llm-call accepts our
      // assembled messages directly.
      const messages = [
        { role: 'user', content: (mode === 'plan' ? '(plan mode) ' : mode === 'review' ? '(review mode) ' : '') + task },
      ];
      const r = await jpost('/v1/llm-call', { profileId, messages });
      const ms = Date.now() - start;
      if (r.data.ok) {
        $('run-output').textContent = r.data.text;
        $('run-meta').innerHTML = '<span class="pill pill-ok">ok</span> ' +
          r.data.inputTokens + ' in / ' + r.data.outputTokens + ' out · ' + r.data.latencyMs + 'ms · $' + r.data.costUsd.toFixed(6) +
          (r.data.budget?.status === 'warn' ? ' <span class="pill pill-warn">budget warn</span>' : '');
      } else {
        $('run-output').textContent = '';
        $('run-meta').innerHTML = '<span class="pill pill-err">' + r.data.code + '</span> ' + escapeHtml(r.data.message);
      }
      await refreshUsage();
      await refreshSession();
    } catch (e) {
      $('run-meta').innerHTML = '<span class="pill pill-err">network</span> ' + e.message;
    } finally {
      $('btn-run').disabled = false;
    }
  };

  $('btn-session-start').onclick = startSession;
  $('btn-refresh').onclick = refreshAll;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  async function refreshAll() {
    await Promise.all([refreshHealth(), refreshSession(), refreshModels(), refreshUsage()]);
  }
  refreshAll();
  // Soft heartbeat: re-poll health/usage every 30s. Don't auto-refresh session — the user
  // is in control of state transitions and surprise refreshes would lose UI state.
  setInterval(() => { refreshHealth(); refreshUsage(); }, 30_000);
})();
</script>

</body>
</html>`;
