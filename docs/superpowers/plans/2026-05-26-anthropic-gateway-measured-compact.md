# Anthropic Gateway Measured Compact Context Plan

## Repository Diagnosis

| Assumption | Actual repository finding | Impact |
|---|---|---|
| Phase 1 Gateway exists | Present on `origin/main` at `7aa53354`: `/v1/messages`, `/v1/messages/count_tokens`, scoped VS Code launch, safe gateway log, status, doctor. | Stable passthrough must remain unchanged. |
| Existing Phase 2 envelope exists | Present as `runtime.gatewayTransformations.mode: "off" | "observe" | "envelope"`, default `off`, allowlist default empty. | Treat as legacy experimental native rewrite. Do not expand it. |
| MCP compact tools exist | `tierkit.get_file_digest`, `tierkit.build_context_pack`, `tierkit.get_diff_summary`, `tierkit.get_error_digest`, `tierkit.get_test_digest`, `tierkit.get_json_digest`, `tierkit.compress_command`. | Use `tierkit.get_file_digest` as the first compact contract target. |
| Existing savedTokens is verified / estimated / unknown | Existing digest `stats.savedTokens` comes from `chars/4` in `packages/core/src/digest/stats.ts`; context artifacts use local estimates. | Legacy `savedTokens` is `local_tokenizer_estimate`, not official Anthropic count-token measurement. |
| MCP and Gateway share runtime state | MCP server runs in `packages/mcp-server` as a spawned child process using `@tierkit/core`; Gateway runs in the runtime daemon. They only share disk logs/config today. | Request-level memory-only raw-baseline ticket registry is not safely possible without a new in-memory bridge. Official request-level measurement is BLOCKED. |
| Existing token-count forwarding route exists | Gateway forwards `/v1/messages/count_tokens` transparently when `gatewayMode` is on. | Official API shape is supported as passthrough, but not enough for raw-baseline pairing. |

Baseline verification:

| Gate | Command | Result | Evidence / Notes |
|---|---|---|---|
| Baseline before changes | `pnpm install --frozen-lockfile && pnpm test` | FAIL | Fresh worktree lacked built `@tierkit/core` dist; import resolution failed in 17 suites. |
| Baseline after build | `pnpm build && pnpm test` | PASS | 161 core files / 1018 core tests; full workspace tests passed. |

## Architecture Decision

Tierkit's stable compact direction is MCP-first measured compact context:

- MCP creates semantic compact context with provenance and a recoverability contract.
- Gateway remains the delivery and measurement layer.
- Existing Gateway native `tool_result` envelope rewriting remains legacy experimental and default-off.
- `observe` is not added to the new product surface.
- Same-request and cross-request dedupe are deferred until measured frequency justifies them.
- Official Anthropic Token Counting API measurement requires explicit user opt-in because raw-equivalent source context may need to be sent to Anthropic for token counting only.
- Raw baseline content must be memory-only and must not be written to logs, diagnostics, or artifacts.
- Token-count results are pre-send API comparisons and may differ slightly from actual message creation input tokens.

Official documentation check:

- Anthropic's Token Counting API accepts Messages-style structured inputs including `system`, `tools`, images, and PDFs.
- It returns `input_tokens`.
- Anthropic documents the count as an estimate; actual message creation input tokens may differ slightly.
- Token counting has separate rate limits from message creation and is eligible for Zero Data Retention where the organization has that arrangement.

Source: https://platform.claude.com/docs/en/build-with-claude/token-counting

## Measurement Feasibility Decision

### Option A — Request-Level Counterfactual Measurement

Status: **BLOCKED in the current architecture**.

Reason: the MCP compact tool can see raw file content while generating `tierkit.get_file_digest`, but that happens in the MCP server child process. The Gateway later sees only the Claude Code outgoing request in the daemon process. The only existing shared channels are config/log/artifact files, and storing raw baseline content there is forbidden.

### Option B — MCP-Result-Level Measurement

Status: **NOT IMPLEMENTED in this bounded pass**.

Reason: result-level official token count would still require opt-in and Anthropic credentials in the MCP process. It would not be request-level and could easily be confused with request-level delta. The safer first step is contract/provenance and diagnostics.

### Option C — Block Official Metric

Status: **IMPLEMENTED AS SAFETY POSTURE**.

This pass adds measured compact config, status, doctor diagnostics, and MCP compact contract metadata. It does not fabricate token reduction numbers and does not reuse legacy `savedTokens` as official measurement.

## Config Design

New namespace:

```ts
runtime.measuredCompact = {
  mode: "off" | "measured_compact",
  eligibleSources: { tierkitMcpCompactTools: string[] },
  officialTokenMeasurement: {
    mode: "off" | "anthropic_count_tokens_opt_in",
    consentAcknowledged: boolean
  },
  privacy: {
    rawBaselineStorage: "memory_only",
    rawBaselineTtlMs: number,
    maxRawBaselineBytes: number
  },
  reporting: {
    requestLevelMetrics: boolean,
    sessionAggregation: boolean
  }
}
```

Defaults keep all official measurement disabled and prevent raw baseline transmission.

## Legacy Envelope Conflict Policy

`measuredCompact.mode === "measured_compact"` and `gatewayTransformations.mode === "envelope"` are invalid together. Silent double-transform would corrupt measurement provenance.

## MCP Compact Contract

Initial target: `tierkit.get_file_digest`.

The MCP response keeps the existing `tool-result-envelope.v1` shape and adds top-level `compactContext` metadata:

```ts
{
  version: "tierkit-compact-context.v1",
  contextId: digest.id,
  contentDigest: digest.hash,
  sourceKind: "file_digest",
  recoverable: true,
  retrieveMoreTool: "tierkit.read_file",
  measurementTicket: null
}
```

`measurementTicket` remains `null` until a safe memory-only bridge exists. It is never raw content.

## Safe Metric Logging

Request-level official metrics are blocked, so this pass does not write measured token telemetry. A future implementation should use a separate strict JSONL file such as `.tierkit/runtime/anthropic-gateway-measured-compact.jsonl` with no bodies, excerpts, credentials, or ticket contents.

## Rollback

- Set `runtime.measuredCompact.mode` to `"off"` or remove the `measuredCompact` block.
- Keep `runtime.gatewayTransformations.mode` at `"off"` unless explicitly dogfooding the legacy experimental rewrite.

## Deferred Roadmap

- MC-2: create a daemon-owned MCP execution or secure in-memory handoff so Gateway can construct raw-equivalent request baselines without disk persistence.
- MC-3: add request-level Anthropic Token Counting API comparisons only after explicit consent UX and raw-baseline memory ownership are proven.
- MC-4: session-level evaluation only with stable session identity and quality/retrieve-more metrics.
