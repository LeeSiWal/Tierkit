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

## Experimental request transformations

Phase 2 v1 adds an experimental request-side transformation hook. It is off by
default and remains separate from `runtime.gatewayMode`.

```json
{
  "runtime": {
    "gatewayMode": "on",
    "gatewayTransformations": {
      "mode": "off",
      "toolResultEnvelope": {
        "allowlistedToolNames": [],
        "minInputUtf8Bytes": 4096,
        "preservedHeadUtf8Bytes": 1024,
        "preservedTailUtf8Bytes": 1024
      }
    }
  }
}
```

Modes:

- `off`: Phase 1 passthrough. No inspection or rewrite.
- `observe`: counts eligible `tool_result` candidates and payload bytes, but
  forwards the original request body.
- `envelope`: rewrites only plain-text `tool_result` blocks whose tool name can
  be correlated to a prior assistant `tool_use`, is explicitly allowlisted, and
  meets the configured byte threshold.

The default allowlist is empty, so enabling the gateway never enables request
rewrites by itself. The envelope is deterministic and extractive: it preserves
bounded head/tail excerpts in memory and adds a SHA-256 digest, but never writes
the original tool result to disk.

The gateway log may include an optional `transformation` object with payload
byte fields such as `inputUtf8BytesBefore`, `inputUtf8BytesAfter`, and
`reducedUtf8Bytes`. These are engineering payload metrics only. They are not
Anthropic token counts and must not be interpreted as billing or quota impact.

To roll back immediately, set `runtime.gatewayTransformations.mode` to `"off"`
or remove the `gatewayTransformations` block.

Production activation of Phase 2 behavior is blocked until one week of dogfood,
zero trailing 7-day 5xx records, one clean Direct fallback recovery, and healthy
`tierkit doctor gateway` evidence are available.

## Measured Compact Context direction

Tierkit's next stable compact-context direction is MCP-first, not Gateway native
rewrite. MCP tools such as `tierkit.get_file_digest` produce semantic compact
context with provenance and a retrieve-more path. The Gateway remains a
passthrough delivery layer and may later measure compact requests against
raw-equivalent counterfactual requests.

The new config namespace is present but disabled by default:

```json
{
  "runtime": {
    "measuredCompact": {
      "mode": "off",
      "eligibleSources": { "tierkitMcpCompactTools": [] },
      "officialTokenMeasurement": {
        "mode": "off",
        "consentAcknowledged": false
      },
      "privacy": {
        "rawBaselineStorage": "memory_only",
        "rawBaselineTtlMs": 60000,
        "maxRawBaselineBytes": 1048576
      },
      "reporting": {
        "requestLevelMetrics": true,
        "sessionAggregation": false
      }
    }
  }
}
```

Official measurement is not active in this bounded implementation. Request-level
counterfactual measurement is blocked because Tierkit's MCP server and Gateway
daemon do not currently share a memory-only raw-baseline registry. Existing
digest `savedTokens` values are local estimates, not Anthropic Token Counting
API measurements.

If official measurement is implemented later, enabling it must explicitly
acknowledge that source context omitted from the generated request may still be
sent to Anthropic's Token Counting API for token counting only. Token counts are
pre-send estimates from Anthropic's Token Counting API and may differ slightly
from tokens used during message creation.

`tierkit.get_file_digest` now advertises a compact context contract in its MCP
tool-result envelope. It is recoverable through `tierkit.read_file`, and no
measurement ticket is issued until a safe memory-only bridge exists.
