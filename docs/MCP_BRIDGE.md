# Tierkit MCP Bridge

Tierkit exposes its gated tools (file read/write, codebase search, command
execution) to Claude Code, Claude Desktop, and any MCP-aware client via the
Model Context Protocol.

## Prerequisites

- Tierkit ≥ 0.15.0 installed (either the VS Code extension or `npm i -g tierkit`)
- Claude Code (or any MCP-aware client) installed and authenticated

## Setup

1. Open the Tierkit sidebar in VS Code. In the Setup card, click
   **"Connect Claude Code (MCP) → Show config snippet"**.
2. Copy the JSON to your clipboard.
3. Open Claude Code's `~/.claude/settings.json` (or your client's MCP config).
4. Merge the snippet into the `mcpServers` field. Example:

   ```json
   {
     "mcpServers": {
       "tierkit": {
         "type": "stdio",
         "command": "tierkit",
         "args": ["mcp", "serve", "--workspace", "/Users/.../project"]
       }
     }
   }
   ```

5. Restart Claude Code (Cmd+Q / re-open). Run `/mcp` in Claude Code to verify
   the `tierkit` server is connected.

## Available tools

- `tierkit.list_files` — list workspace files, respecting ignore globs and a
  bundled denylist (.env, *.pem, etc.)
- `tierkit.read_file` — read a file with content redaction; denylisted paths
  are refused entirely
- `tierkit.codebase_search` — find occurrences across the workspace; results
  inside denylisted paths are dropped, snippets are redacted
- `tierkit.propose_patch` — propose a file edit (or new file). Returns a
  `patchId` + diff preview + risk metadata. Does not mutate files.
- `tierkit.apply_patch` — apply a previously proposed patch by `patchId`.
  May return `approval-required` if risk ≥ medium; approve via Tierkit GUI
  or `tierkit mcp patch approve <patchId> --workspace <path>`. Returns
  `payload-corrupt` if the on-disk payload sidecar no longer matches the
  hash captured at propose time.
- `tierkit.run_command` — run a shell command in the workspace, gated by
  Tierkit's command classifier. Safe commands execute. Dangerous commands
  are refused. Non-safe non-blocked commands return `approval-required` and
  are NOT executed in v0.15.0 (deferred to v0.15.1) — run them yourself in
  your shell.
- `tierkit.get_policy_status` — snapshot of current policy state.

## Approval flow

Risky operations (file mutations, non-safe commands) require approval. There
are two equivalent channels:

- **CLI** (works offline): `tierkit mcp patch approve <patchId> --workspace <path>`
- **GUI** (when the Tierkit daemon is running): `POST /v1/mcp/patches/:id/approve`
  via the sidebar's pending-patches panel.

Both channels update the same on-disk ticket. Once approved, the next
`apply_patch({patchId})` from Claude Code succeeds.

## Ignore source precedence

Highest priority first:

1. **Bundled denylist** — always-on, includes `.env*`, `*.pem`, `*.key`,
   `id_rsa*`, `secrets.json`, `.tierkit/runtime/`.
2. **`.tierkit/ignore`** — workspace-scoped, gitignore syntax. The canonical
   place to add custom ignores.
3. **`.tierkit-ignore`** — legacy fallback, supported for backward compat only.
4. **`.gitignore`** — project's standard ignore.

## What's outside Tierkit's policy boundary

- File deletion (not supported in v0.15)
- Git operations (use your client's git tools; outside Tierkit's gate)
- The prompt text typed directly into Claude Code (Tierkit cannot intercept
  prompt content; redaction applies at the tool boundary)

For more, see the design spec at
`docs/superpowers/specs/2026-05-21-v0.15-tierkit-mcp-bridge-design.md`.
