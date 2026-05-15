# Changelog

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
