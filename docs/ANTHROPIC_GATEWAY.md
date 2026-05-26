# Anthropic Gateway

Tierkit can run as a transparent gateway in front of Anthropic's Messages API.
Point Claude Code at the Tierkit daemon and your requests flow through Tierkit
on their way to `api.anthropic.com`. The gateway routes traffic through the
local daemon without modifying message content.

## Enable

1. Open the Tierkit sidebar.
2. Toggle **Route Claude Code through Tierkit**. This sets
   `runtime.gatewayMode: "on"` in `tierkit.config.json`.
3. Click **Launch Claude Code through Tierkit**. A new integrated terminal opens
   with `ANTHROPIC_BASE_URL` pointing at the daemon for that terminal only —
   your shell profile is never modified and your `ANTHROPIC_API_KEY` (if set)
   is preserved verbatim.

## Verify

```bash
tierkit doctor gateway
```

You should see `OK` for `runtime.gatewayMode`, `daemon @ ...`, `routes`,
`safe gateway log`, and (if Claude Code is installed) `claude (Claude Code CLI)`.

## Per-request log

When the gateway is on, the daemon writes a per-request log to
`.tierkit/runtime/anthropic-gateway.jsonl`. Each record contains: timestamp,
path, stream flag, upstream status, duration, and an `auth` block with the
Authorization classification (`Bearer`, `Other`, or `null` when no
Authorization header was present), an `apiKeyPresent` boolean for the
`x-api-key` channel, and a 12-character fingerprint for each credential
channel that was present. The schema enforces that a fingerprint is present
exactly when its channel is present — there are no records with a fingerprint
for an absent channel. The log never contains the request body, the response
body, the raw `Authorization` or `x-api-key` value, the `system` prompt, the
`messages[]` array, or `tool_result` content. The file rotates at 5 MB or
7 days, whichever comes first.

For streaming requests, the recorded `status` is the HTTP status the client
actually observed (typically 200), even when the upstream stream aborts
mid-flight. A separate stream-abort outcome field is planned for a later phase.

## Local-only control surface

`GET /v1/gateway/status`, `GET /v1/doctor/gateway`, and
`PATCH /v1/config/runtime` reject any non-loopback caller with HTTP 403.

For these control endpoints to be reachable, run the daemon on a loopback or
wildcard bind address: `127.0.0.1`, `::1`, `0.0.0.0`, or `::`. A daemon bound
only to a specific LAN interface (for example `192.168.1.50`) is not supported
by the Phase 1 local-control flow.

## Direct fallback

If the daemon is unreachable when you click **Launch Claude Code through Tierkit**,
the extension first tries to restart it. If that fails, a dialog offers a
one-click **Launch direct** terminal that bypasses the gateway entirely.
The direct terminal explicitly removes `ANTHROPIC_BASE_URL` so it is truly
direct even when the VS Code process inherited the variable.

Additional context-processing and policy features are planned for a later phase.
