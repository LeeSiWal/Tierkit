# Changelog

## 0.1.2 — 2026-05-15

Diagnostics for the "Daemon unreachable: Failed to fetch" case (especially on Windows).

### Features

**Diagnostic Output channel**
- New "Tierkit" Output channel logs every step of `maybeStartDaemon`: VS Code version, Node version, workspace folders, configured baseUrl, existing-daemon probe, port-binding attempts, fallback to port 0, and the full stack of any failure.
- New command **`Tierkit: Show diagnostic output`** opens it from anywhere.
- When auto-start fails, the warning toast now has an **Open output** button.

**Restart daemon command**
- New command **`Tierkit: Restart daemon`** closes the in-process server (if any) and re-runs auto-start. Useful after opening a folder, changing `tierkit.config.json`, or unblocking a port.

**In-sidebar daemon banner**
- When the host (VS Code) flags an auto-start failure, the sidebar shows a clearly worded banner at the top with two buttons: **진단 로그 열기 / Show output** and **데몬 재시작 / Restart daemon**. No more hunting through 5 separate "Failed to fetch" messages.

### Why this matters
The sidebar previously gave 5 identical "Failed to fetch" errors when the daemon didn't start, with no clue why. On Windows in particular, common silent-failure modes are: no workspace folder open, port 4101 inside Hyper-V's reserved port range, AV blocking `node:http.listen`, or a missing `tierkit.config.json`. The new Output channel surfaces the exact failure so it can actually be fixed.

## 0.1.1 — 2026-05-15

Zero-config first run + Korean localization.

### Features

**Auto-start daemon**
- On extension activation the runtime daemon now starts **in-process** at the configured `tierkit.baseUrl` (default `http://127.0.0.1:4101`). No more `Daemon unreachable: Failed to fetch` on first install.
- If something else already owns port 4101, Tierkit transparently falls back to an OS-chosen port and the sidebar uses that base URL automatically.
- If a Tierkit daemon is already running (e.g., you ran `tierkit runtime start` in a terminal), the extension reuses it instead of starting a second one.
- Opt out with `tierkit.autoStartDaemon: false` if you prefer to manage the daemon yourself.

**Korean localization (한글화)**
- Command palette titles, configuration descriptions, and runtime messages are now translated via VS Code's standard `package.nls.*.json` + `l10n/bundle.l10n.*.json` mechanism — VS Code picks the locale automatically.
- The embedded sidebar dashboard (and the GUI served at `http://127.0.0.1:4101/`) localizes labels, placeholders, tooltips, and inline status text based on `navigator.language`. Browsers/VS Code instances set to `ko*` get Korean; everything else stays English.

### Configuration

```jsonc
// .vscode/settings.json
{
  "tierkit.baseUrl":         "http://127.0.0.1:4101",
  "tierkit.statusBar":       true,
  "tierkit.autoStartDaemon": true
}
```

## 0.1.0 — 2026-05-15

Initial sideload release. Not yet on the VS Code Marketplace.

### Features

**Sidebar dashboard** (the main reason to install this extension)
- Activity bar entry **Tierkit** with a three-stacked-tiers icon.
- A webview view (`tierkit.sidebar`) that embeds the same GUI the daemon serves at `http://127.0.0.1:4101/` — no separate browser tab needed.
- Reloads when `tierkit.baseUrl` changes; preserves state when you flip to another sidebar.

What you can do in the sidebar:
- See daemon health + effective freedom at a glance.
- Run a task — pick profile, choose `execute` / `plan` / `review` mode, see the response inline.
- Drive a workflow session (start / approve plan / advance / abandon) with the appropriate buttons for the current state.
- **Security check** card with three tabs:
  - **Redact** — paste text, see which secret patterns hit and the redacted output.
  - **Command** — classify a shell command (`block` / `warn` / `ok`) with matched-rule details.
  - **Path** — check if a file path matches the sensitive-file blocklist.
- **Models** table with a `Test` button per row — probes the provider for reachability + model availability without paying for tokens.
- Usage summary (calls / tokens / cost), per-profile breakdown.

**Status bar + command palette** (unchanged)
- Status bar item polls `GET /v1/health` every 30s.
- Command palette: health, route explain, route run, classify command, usage, session status (now points to the sidebar), and `Tierkit: Focus dashboard sidebar` to open the dashboard from anywhere.

### Configuration

```jsonc
// .vscode/settings.json
{
  "tierkit.baseUrl": "http://127.0.0.1:4101",
  "tierkit.statusBar": true
}
```

### Known limitations
- `routeRun` palette command still requires an explicit profile id (sidebar already routes through `/v1/llm-call`, so use the sidebar Run panel for the smoothest path).
- The Run panel renders the response in one chunk because `/v1/llm-call` currently returns a single JSON after the upstream stream completes. A future `/v1/llm-call/stream` endpoint will give live token-by-token output without changing the sidebar UI.
- No `.vsix` integration tests against the VS Code Extension Development Host yet.
