# Anthropic Gateway Phase 1

Phase 1 productized the Anthropic Gateway as a passthrough connection feature.
It routes Claude Code traffic through the local Tierkit daemon when
`runtime.gatewayMode` is `"on"`, without modifying request or response content.

Canonical Phase 1 references:

- `docs/RFC-anthropic-gateway.md`
- `docs/ARCHITECTURE-anthropic-gateway.md`
- `docs/ANTHROPIC_GATEWAY.md`
- `packages/vscode-tierkit/test/MANUAL_gateway_flows.md`

## Phase 1 Invariants

- `GET /v1/gateway/status`, `PATCH /v1/config/runtime`, and
  `GET /v1/doctor/gateway` are loopback-only.
- `POST /v1/messages` and `POST /v1/messages/count_tokens` are gated by
  `runtime.gatewayMode === "on"`.
- Safe gateway logs never include request bodies, response bodies, raw
  credentials, `system`, `messages[]`, or `tool_result` content.
- VS Code fallback writes are allowed only before a daemon PATCH is attempted.
- Shell profiles and global environment variables are not modified.

## Phase 2 v1 Additive Status

Branch `worktree-anthropic-gateway-phase2` adds experimental request
transformations behind `runtime.gatewayTransformations`. The default mode is
`off`; `runtime.gatewayMode` remains routing-only.

Phase 2 v1 implementation does not satisfy the operational activation gate by
itself. Production activation remains blocked pending real dogfood evidence:
one week of use, zero trailing 7-day 5xx gateway log records, one clean Direct
fallback recovery, and healthy `tierkit doctor gateway` output.

## Measured Compact Reorientation

Branch `worktree-anthropic-gateway-measured-compact` reorients the next compact
context direction toward MCP-first measured compact context:

- MCP compact tools produce recoverable compact context with provenance.
- Gateway native rewrite remains legacy experimental and default-off.
- `observe` and dedupe are not part of the new stable measured compact feature.
- `runtime.measuredCompact` defaults to `off`.
- Official Anthropic Token Counting API measurement remains blocked until MCP
  and Gateway can share raw-equivalent baseline content through memory only.
- Existing digest `savedTokens` values are local estimates and are not promoted
  to official measured input-token deltas.
