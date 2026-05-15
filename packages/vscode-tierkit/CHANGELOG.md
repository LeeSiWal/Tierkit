# Changelog

## 0.1.0 — 2026-05-15

Initial v1.3 scaffold release. Sideload-ready `.vsix`; not yet on the VS Code Marketplace.

### Features
- Status bar item polling `GET /v1/health` every 30s.
- Command palette entries (six total):
  - `Tierkit: Check runtime health`
  - `Tierkit: Explain route for current task`
  - `Tierkit: Run task through Tierkit (streamed)`
  - `Tierkit: Classify a shell command`
  - `Tierkit: Show usage summary`
  - `Tierkit: Show workflow session status` (CLI-only — placeholder)
- Configuration: `tierkit.baseUrl`, `tierkit.statusBar`.

### Known limitations
- `routeRun` requires an explicit profile id (auto-route via `/v1/route` + `/v1/llm-call` composition is a v1.x follow-up).
- `sessionStatus` points the user to the CLI until a `/v1/session` HTTP endpoint ships.
- Live SSE streaming UI isn't wired — the daemon currently returns a single JSON response after the upstream stream completes.
