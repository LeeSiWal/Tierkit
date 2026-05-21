# Tierkit MCP Bridge

Tierkit exposes its gated tools (file read/write, codebase search, command
execution) to Claude Code, Claude Desktop, and any MCP-aware client via the
Model Context Protocol.

## Prerequisites

- Tierkit ≥ 0.17.0 installed (either the VS Code extension or `npm i -g tierkit`)
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

## Tool result envelope (v0.16+)

Every long-output tool returns a structured JSON envelope versioned as
`tool-result-envelope.v1`. The envelope lives inside `content[0].text` and
must be parsed by the client:

```json
{
  "ok": true,
  "tool": "tierkit.read_file",
  "version": "tool-result-envelope.v1",
  "data": { "path": "src/foo.ts", "content": "..." },
  "truncated": false,
  "range": { "startLine": 1, "endLine": 56 },
  "size": { "linesReturned": 56, "totalLines": 56, "remainingLines": 0 }
}
```

When `truncated: true`, the envelope carries a `next.cursor` opaque token plus
a `suggestedCall` payload so the client can continue seamlessly:

```json
{
  "ok": true,
  "tool": "tierkit.read_file",
  "version": "tool-result-envelope.v1",
  "data": { "path": "src/foo.ts", "content": "...first 300 lines..." },
  "truncated": true,
  "range": { "startLine": 1, "endLine": 300 },
  "size": { "linesReturned": 300, "totalLines": 900, "remainingLines": 600 },
  "next": {
    "cursor": "<opaque base64url>",
    "suggestedCall": { "tool": "tierkit.read_file", "args": { "cursor": "<same>" } }
  }
}
```

Failure envelopes use the same envelope shape with `ok: false` and an
`error.{code,message}` block:

```json
{
  "ok": false,
  "tool": "tierkit.read_file",
  "version": "tool-result-envelope.v1",
  "error": { "code": "stale-cursor", "message": "file fileHash changed since cursor was issued" }
}
```

## Per-tool examples

### tierkit.read_file
```json
{ "path": "src/foo.ts", "startLine": 1, "maxLines": 300 }
```
Returns `data: { path, content }`. Use `next.cursor` to continue past
`truncated: true`. v0.17: if the file behind a cursor was deleted between
issue and reuse, returns `stale-cursor` (not `not-found`) so the caller knows
to re-read from the beginning rather than treating the path as missing.

### tierkit.list_files
```json
{ "path": ".", "recursive": true, "maxEntries": 200 }
```
Returns `data: { path, entries: [{ name, relPath, kind }] }`. `kind` is
`"file"` or `"dir"`. `relPath` is relative to the workspace root.

### tierkit.codebase_search
```json
{ "query": "pattern", "path": ".", "maxMatches": 50, "contextLines": 2 }
```
Returns `data: { pattern, path, matches: [{ path, line, snippet, before, after }] }`.

### tierkit.run_command
```json
{ "command": "ls -la", "workspaceRoot": "/path", "timeoutMs": 60000 }
```
Returns `data: { exitCode, stdout, stderr, durationMs }`. When `truncated:
true`, `size.{stdoutTruncated, stderrTruncated}` plus a warning describe what
was clipped; there is no `next.cursor` for commands (re-running is not
idempotent in general).

Approval-required commands (the classifier verdict between `safe` and
`block`) do NOT execute through MCP in v0.17 — they return `approval-required`
and the user is expected to run the command in their own shell. This is
unchanged since v0.15.0.

## Error codes (v0.17)

| Code | Tools | Meaning |
|---|---|---|
| `outside-workspace` | propose_patch, apply_patch, read_file, list_files, codebase_search | Path resolved outside workspace |
| `ignored-path` | read_file, propose_patch | Path is denylisted or ignored |
| `not-found` | read_file, list_files, apply_patch | Path or patchId does not exist |
| `not-a-file` | read_file | Path is not a regular file |
| `not-a-directory` | list_files | Path is not a directory |
| `invalid-args` | all | Missing or malformed required argument |
| `invalid-query` | codebase_search | Empty pattern or regex compile error |
| `cursor-invalid` | read_file, list_files, codebase_search | Cursor malformed or shape mismatch |
| `stale-cursor` | read_file | File fileHash differs from cursor OR file was deleted |
| `delete-not-supported` | propose_patch | v0.15+ does not allow file deletion |
| `invalid-status` | apply_patch | Patch ticket in invalid transition state |
| `expired-patch` | apply_patch | Ticket older than 24h |
| `stale-patch` | apply_patch | File changed after propose |
| `approval-required` | apply_patch, run_command | Caller must approve; run_command does NOT execute approval-required commands |
| `approval-rejected` | apply_patch | Patch ticket was rejected |
| `payload-missing` | apply_patch | Sidecar payload file absent |
| `payload-corrupt` | apply_patch | Sidecar payload sha256 mismatch |
| `command-blocked` | run_command | Hard-blocked by dangerous-command classifier |
| `command-timeout` | run_command | Command exceeded `timeoutMs` |
| `spawn-failed` | run_command | Node failed to spawn the child process |

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
  are NOT executed in v0.17 — run them yourself in your shell.
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

## Migration from v0.15

Pre-v0.16 MCP results were ad-hoc objects like `{ ok: true, content: "..." }`.
v0.16 introduced `tool-result-envelope.v1` which moves the payload into
`data` and adds `truncated` / `range` / `size` / `next` / `warnings` siblings.

If your MCP client depended on the v0.15 shape:

1. Parse the JSON inside `content[0].text`.
2. Check `version === "tool-result-envelope.v1"`.
3. Read `data.content` (read_file), `data.entries` (list_files),
   `data.matches` (codebase_search), `data.stdout` / `data.stderr` (run_command).
4. Handle `next.cursor` for continuation.

## What's outside Tierkit's policy boundary

- File deletion (not supported in v0.15+)
- Git operations (use your client's git tools; outside Tierkit's gate)
- The prompt text typed directly into Claude Code (Tierkit cannot intercept
  prompt content; redaction applies at the tool boundary)

For more, see the design spec at
`docs/superpowers/specs/2026-05-21-v0.15-tierkit-mcp-bridge-design.md` (v0.15
foundation) and `docs/superpowers/specs/2026-05-22-v0.17-completion-and-hardening-design.md`
(v0.17 envelope cleanups + stale-cursor refinement).
