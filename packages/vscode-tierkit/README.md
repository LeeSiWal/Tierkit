# Tierkit

Talk to a running [Tierkit](https://example.com/tierkit) runtime from inside VS Code.

Tierkit is a local-first hybrid model routing toolkit for AI coding agents. It runs an HTTP daemon that handles model routing, secret redaction, dangerous-command classification, budget enforcement, and workflow session gating. This extension is the VS Code companion — it talks to that daemon via the typed `@tierkit/client` SDK.

> **Status: v0.1 sideload release.** The extension compiles and ships as a `.vsix` you install with `code --install-extension`. A Marketplace listing follows once the runtime's `/v1/session` endpoint lands and the integration tests are in place.

## What you get

| Command palette entry | What it does |
|---|---|
| `Tierkit: Check runtime health` | `GET /v1/health` — shows version + project root. |
| `Tierkit: Explain route for current task` | Prompt for a task → pipes through `POST /v1/route` → prints decision (chosen tier, profile, score, reasons) in an output channel. |
| `Tierkit: Run task through Tierkit (streamed)` | Prompt for task + profile id → `POST /v1/llm-call` → streams the response into an output channel. |
| `Tierkit: Classify a shell command` | Prompt for a command → shows the danger classifier verdict (`block` / `warn` / `ok`) with matched rule ids. |
| `Tierkit: Show usage summary` | `GET /v1/usage` — per-profile call/token/cost totals. |
| `Tierkit: Show workflow session status` | Reminds you that `tierkit session status` (in a terminal) is the source of truth until `/v1/session` ships. |

A status bar item shows whether the daemon is reachable. Click it to re-check health.

## Setup

1. Install and start the Tierkit runtime in your project (CLI):
   ```sh
   tierkit init
   tierkit runtime start
   ```
2. Install this extension (sideload):
   ```sh
   code --install-extension tierkit-vscode-0.1.0.vsix
   ```
3. (Optional) Override the daemon URL in `.vscode/settings.json`:
   ```jsonc
   {
     "tierkit.baseUrl": "http://127.0.0.1:4101",
     "tierkit.statusBar": true
   }
   ```

## Architecture

This extension is intentionally thin. It does **not** patch or shim other extensions (Roo, Cline, Continue, …). Instead, every command calls the same Tierkit daemon over HTTP, using the [`@tierkit/client`](https://example.com/tierkit) SDK that any extension can adopt.

```
  Roo, Cline, Continue, …        VS Code               other tools
              │                       │                       │
              │  uses                 │  uses                 │  uses
              ▼                       ▼                       ▼
                 ── @tierkit/client (typed HTTP) ──
                                  │
                                  ▼
                       tierkit runtime daemon
                        (127.0.0.1:4101)
```

Any tool that routes its model calls through the daemon inherits Tierkit's policy uniformly: routing decisions, secret redaction, command-gate, budget enforcement, usage log, and the workflow session gate.

## Privacy and security

- The extension only talks to a daemon you start locally (default `127.0.0.1:4101`). No outbound traffic to any other host.
- The daemon's secret redaction rules apply before any request goes to a remote model tier (private-remote or public-cloud).
- No telemetry. No analytics. No phone-home.

## Limitations of this scaffold (0.1.0)

- The `Run task` command requires an explicit profile id (no auto-routing through the daemon yet).
- The `Run task` UI does not stream tokens chunk-by-chunk — the daemon currently returns a single JSON response after the upstream provider finishes; the extension renders it as one delta + a usage line + an end line.
- Session status is CLI-only. Run `tierkit session status` in a terminal.

These are all small follow-ups; the command palette surface is stable.

## License

MIT
