# Anthropic Gateway Phase 2 v1 Implementation Plan

Date: 2026-05-26
Branch: `worktree-anthropic-gateway-phase2`
Base branch: `worktree-anthropic-gateway-phase1`
Base commit: `91ba82749cc3b00d23c0ea44bd5689fa60379e9f`

## Repository Diagnosis

| Check | Result |
|---|---|
| Starting worktree | `/Users/siwal/code/Tierkit/.claude/worktrees/anthropic-gateway-phase2` |
| Root worktree state | `/Users/siwal/code/Tierkit` is dirty on `main`; left untouched |
| Phase 1 branch | `worktree-anthropic-gateway-phase1` at `91ba827` |
| Phase 2 branch | Created from Phase 1 as `worktree-anthropic-gateway-phase2` |
| Required doc: `docs/ANTHROPIC-GATEWAY-PHASE1.md` | Missing in Phase 1 HEAD |
| Gateway runtime | `packages/core/src/runtime/anthropicGateway.ts` is still Phase 0 passthrough substrate |
| Config schema | `runtime.gatewayMode` lives in `packages/core/src/config/TierkitConfig.ts` |
| Gateway log | `packages/core/src/runtime/gatewayLog.ts`, strict allowlist JSONL with rotation |
| Status / doctor | `gatewayStatus.ts`, `doctorGateway.ts`, CLI command, GUI card already exist |
| Baseline tests before install | Failed because `node_modules` was missing |
| Baseline core tests after build | `pnpm --filter @tierkit/core build` PASS; `pnpm --filter @tierkit/core test -- --run` PASS, 160 files / 997 tests |

## Document / Code Differences

| Prompt expectation | Actual Phase 1 HEAD | Impact |
|---|---|---|
| `docs/ANTHROPIC-GATEWAY-PHASE1.md` exists | File is absent | Add Phase 2 note only if file exists; do not fabricate Phase 1 historical doc under that name |
| Phase 1 PR #2 already altered `anthropicGateway.ts` | Architecture doc says Phase 1 left it untouched; code confirms Phase 0 passthrough | Phase 2 hook can be localized to this file and `Server.ts` |
| Existing context compression helpers may be reusable | Helpers write context artifacts under `.tierkit/runtime/context-artifacts` | Do not reuse for gateway body transformation; implement memory-only deterministic envelope |

## Goal

Implement Phase 2 v1 code behind explicit experimental configuration:

- request-side transformation hook before upstream `/v1/messages`
- `tool_result` envelope transformation
- config schema, status, doctor, GUI diagnostic surface
- safe per-request payload metrics in the existing gateway JSONL
- automated and manual test coverage

This plan does not claim the Phase 2 activation gate is satisfied.

## Implementation vs Activation Gate

Implementation complete means the code exists, defaults to `off`, and is tested.

Production activation remains blocked until all operational evidence exists:

- at least one week of real workstation dogfood
- trailing 7-day `.tierkit/runtime/anthropic-gateway.jsonl` has zero 5xx
- Direct fallback was triggered at least once and recovered cleanly
- `tierkit doctor gateway` remains healthy

## Scope

Included:

- `runtime.gatewayTransformations` config with `mode: off | observe | envelope`
- pure request transformer module
- deterministic, extractive `TIERKIT_TOOL_RESULT_ENVELOPE_V1`
- fail-open server integration
- safe payload metrics only
- status / doctor / GUI diagnostic extensions
- docs and manual verification cases

Excluded:

- response body transformation
- SSE event transformation
- cursor pagination
- multi-turn dedupe
- local LLM routing, cost-aware routing, model switching
- `/v1/models` discovery
- shell profile mutation
- public token or cost claims

## Config Schema

`runtime.gatewayMode` remains routing-only. Transformations use:

```json
{
  "runtime": {
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

Defaults are off and empty allowlist. Bounds reject negative values and cap excerpt budgets.

## Request Lifecycle

1. `Server.ts` receives `POST /v1/messages`.
2. It reads the raw request body exactly as Phase 1 does.
3. It determines stream mode from the raw top-level JSON.
4. It applies the transformation hook before any upstream fetch.
5. `off` and `observe` pass the original bytes upstream.
6. `envelope` rewrites only eligible allowlisted `tool_result` content.
7. Upstream response JSON and SSE bytes are passed through unchanged.

`POST /v1/messages/count_tokens` remains Phase 1 passthrough and does not trigger extra token-count requests.

## Fail-Open Policy

Any transformation pipeline exception logs only a safe `bypassed_error` metric and sends the original raw request upstream. Malformed request behavior otherwise follows Phase 1.

## Metric Schema

Existing gateway log lines receive an optional `transformation` object:

```ts
{
  mode: "off" | "observe" | "envelope";
  outcome: "disabled" | "observed" | "transformed" | "bypassed_ineligible" | "bypassed_error";
  ruleId: "tool_result_envelope_v1" | null;
  eligibleToolResultCount: number;
  transformedToolResultCount: number;
  inputUtf8BytesBefore: number | null;
  inputUtf8BytesAfter: number | null;
  reducedUtf8Bytes: number | null;
}
```

No request body, response body, excerpt, tool output, raw tool name list, raw credential, system prompt, or `messages[]` is logged.

## Status / Doctor / GUI

`GET /v1/gateway/status` adds:

```json
{
  "transformations": {
    "mode": "off",
    "toolResultEnvelopeConfigured": false,
    "allowlistedToolCount": 0
  }
}
```

Doctor adds a config/status check that treats `off` as normal. GUI adds read-only diagnostic text. Mutation UI is deferred to avoid expanding PATCH ambiguity risk.

## Test Plan

- config defaults and validation
- pure transformer eligibility, UTF-8 preservation, deterministic output
- server integration off/observe/envelope/fail-open/streaming
- safe log schema and redaction invariants
- status and doctor additive behavior
- GUI copy absence checks for token/cost claims
- existing Phase 1 gateway tests remain green

## Rollback

Set:

```json
{
  "runtime": {
    "gatewayTransformations": {
      "mode": "off"
    }
  }
}
```

or remove `runtime.gatewayTransformations`. This returns `/v1/messages` to Phase 1 passthrough behavior while leaving `runtime.gatewayMode` unchanged.

## Dogfood Activation Checklist

- Enable `observe` first and confirm body passthrough.
- Enable `envelope` only with explicit synthetic/known tool allowlist and conservative thresholds.
- Run `tierkit doctor gateway`.
- Inspect 5xx count in the gateway log.
- Aggregate transformation outcomes and payload byte before/after fields.
- Trigger Direct fallback manually and confirm recovery.
- After one week, review evidence before considering default changes or any user-facing claims.
