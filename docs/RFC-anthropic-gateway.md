# RFC: Anthropic Gateway

Status: **Experimental spike branch — validated, ready for Phase 1 promotion**
Target release if promoted: **v0.23.0**
Phase 1 recommendation: **GO — full scope (Subscription + BYOK × Tool Search on/off)**

## Executive Summary

Tierkit can intercept Claude Code's Anthropic Messages API calls via
`ANTHROPIC_BASE_URL` with **high** confidence. All three open questions
from the 2026-05-26 design discussion resolved positively in live
testing against Claude Code v2.1.150 (Claude Max subscription, Mac):

| Question | Outcome | Implication for Phase 1 |
|---|---|---|
| **A.** Subscription OAuth credential survives gateway redirection | ✅ Works | Phase 1 supports both subscription users AND BYOK users — no detect-and-warn needed |
| **B-1.** MCP coexistence in default fallback (`ENABLE_TOOL_SEARCH` unset) | ✅ Works — 14 tools loaded, `tierkit.get_file_digest` called end-to-end, recorded in `usage.jsonl` with `savedTokens: 101` | No mitigation needed; gateway and MCP coexist in preload mode out of the box |
| **B-2.** ENABLE_TOOL_SEARCH=true through proxy | ✅ Works — Claude Code shows tools as "Deferred (need ToolSearch to load schemas)", deferred-tool resolution succeeds, `mcp__tierkit__tierkit_codebase_search` invokable | Phase 1 can expose an optional `ENABLE_TOOL_SEARCH` toggle without protocol concerns |
| **C.** Protocol-semantic streaming fidelity for multi-turn tool_use | ✅ Works — sequential `Glob → Read × 3 → text` flow completed cleanly under proxy, no hang, no orphan tool_use | No streaming bugs to fix before Phase 1 |

## Recommendation

**Proceed to Phase 1.** Build the UI toggle ("Route Claude Code through Tierkit"), auto-wire `ANTHROPIC_BASE_URL` via the same host-info mechanism that 0.22.5 used for `.mcp.json`, and start collecting gateway-side usage records behind the existing safe-logging guardrails (`observeAuthHeaders`-style fingerprints only). The spike code (`packages/core/src/runtime/anthropicGateway.ts`, the two routes in `Server.ts`, 17 tests) is production-ready as a passthrough — Phase 1 layers UX and per-request safe logging on top of it.

## Validation log (raw)

### A. Subscription OAuth (Claude Max subscription, no API key set)

```bash
unset ANTHROPIC_API_KEY
env | grep -i anthropic
# ANTHROPIC_BASE_URL=http://127.0.0.1:4101
claude
# REPL: "Explain Promise.all in 2 sentences"
# Result: normal answer, ~3s, no auth error
```

**Outcome:** Subscription credential is included in the gateway-bound request, forwarded verbatim by Tierkit, and Anthropic accepts it.

### B-1. MCP coexistence + tool invocation end-to-end

```
REPL → /mcp
  → Project MCPs (/Users/siwal/code/vueTest/vue-pos/.mcp.json)
    ❯ tierkit · ✔ connected · 14 tools

REPL → Use tierkit's get_file_digest tool to read package.json …
  → Permission prompt rendered correctly
  → Tool executed; ts=2026-05-26T05:47:53.408Z (KST 14:47)
  → outputSummary: { beforeTokens: 124, afterTokens: 23, savedTokens: 101 }
  → clientName: "claude-code"
```

**Outcome:** MCP server loads through gateway; tool calls execute and write to `usage.jsonl` (also triggering the 0.22.4 SSE savings card update). The 0.22.4 local-TZ window correctly admits the entry.

### B-2. ENABLE_TOOL_SEARCH=true

```bash
export ENABLE_TOOL_SEARCH=true
claude
# REPL: "What tools do you have available that can search through files in this project?"
# Claude response listed tierkit tools as "Deferred (need ToolSearch to load schemas)"
# REPL: "Use the tierkit codebase_search tool to find anywhere Pinia is used"
# → Permission prompt for mcp__tierkit__tierkit_codebase_search rendered correctly
```

**Outcome:** Tool Search activation visible in Claude's own framing ("Deferred"). Deferred-tool resolution flows through the proxy without `tool_reference`-related errors. Permission prompt schema preserved end-to-end.

### C. Multi-turn tool_use fidelity

```
REPL → "List the files in src/ directory, then briefly describe what 3 of them do."
  Turn 1: Glob (Searched for 1 pattern) → file tree
  Turn 2: Read × 3 → structured summary
  Final: text response with file descriptions
  No hang, no orphan tool_use, session terminated cleanly
```

**Outcome:** Multi-turn `tool_use` → `tool_result` → next-turn loop closes correctly through the proxy. Streaming preserved (visible mid-response `esc to interrupt` prompt).

## Auth observation (safety record)

Per the spike's hard rule, no verbatim Authorization or x-api-key value was logged or persisted. Subscription mode showed `ANTHROPIC_API_KEY` absent at the env layer; the Authorization header sent by Claude Code was not captured (no daemon log line exposes it in the spike build, and the user-side observation script was not invoked). The fact that A succeeded confirms a credential WAS sent and forwarded — characterizing its exact shape is left to a Phase 1 task that wires `observeAuthHeaders` behind `TIERKIT_ANTHROPIC_SPIKE_DIAGNOSTICS=1`.

## Phase 1 scope sketch (separate plan to follow)

Not in this RFC's scope, but recorded for planning:

1. VS Code extension: optional `tierkit.gatewayMode` setting that, when enabled, sets `ANTHROPIC_BASE_URL` for shells launched from the integrated terminal AND wires `claude` config so the user doesn't have to `export` manually.
2. Sidebar card: "Claude Code routing — Direct / Gateway" with one-click toggle. When gateway is on, show recent gateway request count + latest savings.
3. Per-request safe log (`.tierkit/runtime/anthropic-gateway.jsonl`) with the diagnostic shape from `observeAuthHeaders` plus request path / stream / status / ts. Strict allowlist — no body, no tool_result contents.
4. `auto-heal` for `ANTHROPIC_BASE_URL` analogous to 0.22.5's MCP path auto-heal: when extension auto-updates, re-export the env hint into Claude Code's environment so the user doesn't manually re-export every release.
5. Onboarding card: "You're a Claude Max user — route through Tierkit to get token savings + local policy" with a single Enable button (driven by A's positive result).
6. Documentation: README "Gateway mode" section, with the three pre-flight checks (infra, BYOK, subscription) folded into a single doctor script.
7. Phase 2 entry gate: only after Phase 1 ships, layer in tool_result dedupe + secret redaction at the gateway request transformation hook.

## Out of scope for both spike and Phase 1

- Provider routing to local LLMs (Phase 3)
- Anthropic API surface beyond `/v1/messages` and `/v1/messages/count_tokens` (e.g. `/v1/models` discovery — gated by `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, default off)
- OAuth admin endpoints (`/api/oauth/*`, `/v1/sessions/*`) — hardcoded to api.anthropic.com by Claude Code, not affected by `ANTHROPIC_BASE_URL`

## References

- Plan: `docs/superpowers/plans/2026-05-26-anthropic-gateway-spike.md`
- Code: `packages/core/src/runtime/anthropicGateway.ts` (4 exports + observeAuthHeaders)
- Tests: `packages/core/test/anthropicGateway.test.ts` (14 unit) + `packages/core/test/Server.anthropicGateway.test.ts` (3 integration)
- Smoke script: `scripts/spike-anthropic-gateway.sh`
- Branch: `worktree-anthropic-gateway-spike` (13 commits)
- vsix used for live validation: `tierkit-vscode-0.23.0-spike.0.vsix` (Claude Code v2.1.150, Mac, Claude Max)
