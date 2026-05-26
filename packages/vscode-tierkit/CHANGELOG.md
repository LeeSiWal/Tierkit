# Changelog

## 0.24.1 — 2026-05-26

### Release Copy Alignment

- Updated release-facing VS Code README copy to match the Anthropic Gateway release positioning.
- Anthropic Gateway remains the stable release feature.
- Experimental request transformation remains disabled by default and requires explicit opt-in.

### 릴리즈 문구 정리

- VS Code 공개 README 문구를 Anthropic Gateway 릴리즈 정체성에 맞게 정리했습니다.
- Anthropic Gateway는 stable 릴리즈 기능입니다.
- 실험적 request transformation은 기본 비활성이며 명시적 opt-in이 필요합니다.

## 0.24.0 — 2026-05-26

### Anthropic Gateway Connection

Added:

- Route Claude Code through Tierkit using the local Anthropic Gateway.
- Gateway status, diagnostics, `tierkit doctor gateway`, and Direct fallback support.
- Scoped terminal launch for Claude Code without permanently modifying shell profiles.
- Safe local gateway request logging.
- Experimental request transformation infrastructure, disabled by default.

Notes:

- Experimental request transformation requires explicit opt-in.
- Existing passthrough behavior remains the default unless transformations are explicitly enabled.
- This release does not present experimental transformations as a token or cost feature.
- Phase 2 request rewriting default activation remains blocked pending operational gate evidence.

### Anthropic Gateway 연결

추가:

- 로컬 Anthropic Gateway를 통해 Claude Code를 Tierkit으로 라우팅합니다.
- Gateway 상태, 진단, `tierkit doctor gateway`, Direct fallback을 제공합니다.
- shell profile을 영구 수정하지 않는 scoped terminal 방식으로 Claude Code를 실행합니다.
- 안전한 로컬 Gateway 요청 로그를 제공합니다.
- 실험적 request transformation 인프라를 포함하지만 기본값은 비활성입니다.

참고:

- 실험적 request transformation은 명시적 opt-in이 필요합니다.
- transformation을 명시적으로 켜지 않으면 기존 passthrough 동작이 기본값입니다.
- 이 릴리즈는 실험적 transformation을 토큰 또는 비용 관련 기능으로 표시하지 않습니다.
- Phase 2 request rewriting 기본 활성화는 운영 gate 증빙 전까지 차단됩니다.

## 0.22.6 — 2026-05-26

**Sidebar auto-recovers when the daemon comes up after the tab opens.**

Cold-start race: the user opens VS Code, the Tierkit sidebar resolves and runs `refreshAll()` immediately — but the daemon's HTTP server isn't accepting connections yet, so every parallel fetch fails. The 5-second `setInterval` only re-polls activity / usage / health, so once-only cards (Tools, Plugins, Models, Settings, Tk*) stay blank until the user clicks the ↻ refresh button.

`refreshHealth` now tracks the offline→online edge and refires `refreshAll()` exactly once when health becomes reachable, so the dashboard self-recovers without user input.

- fix(gui): `refreshHealth` flips `_healthWasOffline` on the offline→online transition and refires `refreshAll()` once
- test(core): regression assertion in `guiHtml.test.ts` so future refactors can't quietly remove the recovery hook

## 0.22.5 — 2026-05-26

**Auto-heal stale MCP cliPath after extension updates.**

When VS Code auto-updates the extension (e.g. 0.22.4 → 0.22.5), `context.extensionPath` changes to point at the new versioned folder, but any existing `.mcp.json` / `~/.claude.json` `tierkit` entry still references the OLD folder. Once VS Code GCs the old extension directory, Claude Code can no longer spawn the MCP server and silently produces 0 tool calls — surfacing as "the Savings card is stuck at 0" without any obvious error.

The daemon's `POST /v1/claude-code/host-info` endpoint (fired on every extension activation) now detects stale `cliPath` references in BOTH the workspace and global MCP configs and rewrites them in place. The new `onlyIfAlreadyConnected: true` flag on `connectClaudeCode` guarantees we never opt a user in who didn't already wire up MCP — the auto-heal only updates entries that already exist.

- feat(core): `connectClaudeCode` honors `onlyIfAlreadyConnected: true` (skips when no entry, rewrites when present)
- feat(core): `/v1/claude-code/host-info` runs auto-heal for both scopes on every call, returns `autoHealed: { workspace, global }` so the extension can log it
- test(core): 3 new connectClaudeCode tests for the flag + 3 new Server.hostInfoAutoHeal integration tests (975 total tests pass)

## 0.22.4 — 2026-05-26

**Savings "today" window now uses local midnight + sidebar overflow fix + recommended-spec docs.**

The Savings card was computing "today" with `setUTCHours(0,0,0,0)`, which meant KST users saw the card reset every day at 09:00 local time (when UTC rolled over). Activity made earlier in the local day but after UTC midnight was excluded from the window. Fixed by switching to `setHours(0,0,0,0)` — the daemon runs as a loopback process on the user's machine, so "today" should mean their local day.

- fix(core): `computeTierkitMcpSavings` window aligns to local midnight, not UTC midnight
- test(core): new `tierkitSavings.timezone.test.ts` covers KST scenario (forces `TZ=Asia/Seoul`)
- fix(gui): long profile / model IDs (e.g. `ollama-qooba-qwen3-coder-30b-a3b-instruct-q3-k-m`) no longer push the per-profile cost row past the sidebar edge; ID wraps on character boundaries, cost stays glued via nested `white-space:nowrap`
- fix(gui): same overflow fix applied to the byClient / byModel breakdown rows
- docs(vscode): new "System requirements" section in README with gateway-only vs local-LLM tiers (qwen2.5-coder 7b / 14b / qwen3-coder 30b)

## 0.22.3 — 2026-05-24

**Push-based Savings card via Server-Sent Events.**

The Savings card now updates within ~500 ms of any MCP compression tool call, instead of waiting up to 5 s for the next poll. Implemented as a new `GET /v1/tierkit/savings/stream` SSE endpoint, a `savingsBroadcaster` hub with subscriber set + 30 s heartbeat, and a webview-side `subscribeSavings()` reconnecter that handles daemon restarts with a 3 s backoff.

- feat(core): `activityLog.setActivityListener` post-append hook (async-safe)
- feat(core): `savingsBroadcaster` hub for SSE push
- feat(core): `GET /v1/tierkit/savings/stream` SSE endpoint
- feat(gui): subscribe to the stream; drop `refreshSavings` from the 5 s polling tuple
- refactor(core): extract `resolveSavingsBaseline` + `renderSavings(summary)` helpers

## 0.22.2 — 2026-05-24

**Fix: GUI Usage breakdown crashed on mixed-shape `usage.jsonl` rows.**

`readUsage` was throwing on MCP-tool entries that lack `timestamp`/`profileId` fields when the By-client / By-model panels tried to aggregate them. Those entries are intentional co-residents in the log (see `trimUsageLog` docstring); the reader now skips entries missing required LLM-call fields instead of crashing.

- fix(core): `readUsage` drops mcp-tool entries that lack `timestamp`/`profileId`
- test(core): two regression tests for mixed-shape usage.jsonl files

## 0.22.1 — 2026-05-23

**Savings card breakdown + full Korean i18n coverage.**

The Savings card now shows per-client and per-model collapsible sections, attributed via a new `attributeModelFromJsonls` helper that scans Claude session files. `McpActivityInput.clientName` threads client identity from the MCP server through to the activity log so the breakdown can group by tool caller.

- feat(core): `McpActivityInput.clientName` + `attributeModelFromJsonls`
- feat(core): `tierkitSavings` `byClient` + `byModel` aggregation
- feat(mcp-server): capture `clientInfo.name` into activity log
- feat(ui): savings card collapsible byClient + byModel sections
- feat(ui): clearer permission labels + inline denial hint
- i18n(ui): Korean for Connect Claude Code buttons, Settings, Chat, and all JS-emitted toasts

## 0.22.0 — 2026-05-23

**Chat sessions sidebar + interactive AskUserQuestion form.**

The Chat tab gains a hamburger (☰) dropdown anchored to the agent card with `+ New session`, `Clear thread`, and the session list. Selecting an entry replays the session into the thread via `loadChatSessionMessages`. Sessions are sourced from a new `GET /v1/claude-code/sessions[/:id]` HTTP endpoint backed by `listClaudeSessions` / `readClaudeSession` usecases. Separately, Anthropic's built-in `AskUserQuestion` tool now renders as an inline form (radio/checkbox/Other input) inside the chat bubble; submitting pipes the answer through `streamChat()` to resume the same Claude Code session.

- feat(core): `listClaudeSessions` + `readClaudeSession` usecases
- feat(http): `GET /v1/claude-code/sessions[/:id]` endpoints
- feat(ui): chat-tab hamburger dropdown (+ New, Clear, session list)
- feat(ui): interactive `AskUserQuestion` form with radio/checkbox/Other
- fix(daemon): Ollama-discovery cache (positive + negative TTL) + in-flight probe coalescing
- fix(core): migration `.tmp` files now use PID/timestamp suffix to prevent concurrent-write races

## 0.17.0 — 2026-05-22

**Telemetry completion + routing-based Savings card + GUI per-tool envelope rendering + Windows hardening.**

### Track A — Telemetry completion

Streaming `claude` calls (`/v1/openai/chat/completions` with `stream: true`) now write a `UsageRecord` to `usage.jsonl` on stream end. This was the root cause of `claudeCode` never appearing in the activity panel. Aborted streams write `ok: false, failureCode: "stream-aborted"`.

The Savings card is rebuilt on top of the routing baseline: today's local-device calls × baseline-profile cost = "Cloud tokens saved" / "Estimated cost saved", polled every 5 s. Baseline is configurable via the optional `routingBaseline` key in `tierkit.config.json` (default `"claudeCode"`). `usage.jsonl` auto-trims at 10 MB → 5 MB in place.

### Track B — GUI per-tool envelope rendering

Raw JSON tool dumps replaced with per-tool views: line-numbered code blocks for `read_file`, icon-tree for `list_files`, highlighted-match snippets for `search_files`/`codebase_search`, terminal-style output for `run_command`. Generic failure card with 16-entry hint table. `[Copy cursor]` button on truncated results.

### Track C — Windows hardening + cross-OS CI

- `runChild()` `quoteForWindowsShell()` helper for paths with spaces
- Junction-point fixture for workspace-boundary escape tests (Windows-only)
- `tierkit doctor` warns when a subscription-CLI profile's `transport.command` contains spaces
- GitHub Actions CI matrix: ubuntu, macOS, windows

### Track D — Tidy

- MCP server advertises `TIERKIT_VERSION` instead of literal `"0.15.0"`
- `read_file` returns `stale-cursor` (not `not-found`) when the file behind a cursor was deleted

## 0.16.0 — 2026-05-22

**Tool Result Envelope + Windows unlock + subscription-CLI timeout policy.**

**BREAKING for direct MCP/tool-result consumers:** Long-output tools now return a structured `tool-result-envelope.v1` JSON object instead of ad-hoc payloads. Agents must inspect `truncated` and `next.suggestedCall` to paginate past truncation. Affected: Agent `read_file`, `list_files`, `search_files`, `execute_command`; MCP `tierkit.read_file`, `tierkit.list_files`, `tierkit.codebase_search`, `tierkit.run_command`.

Envelope adds `cursor`-based pagination for `read_file` and `list_files` (default 300 lines / 200 entries per page, hard-capped at 1000). `run_command` surfaces `warnings` and stream-prefixed size fields instead of a cursor. `search_files` warns on overly-broad patterns.

**Windows:** subscription CLI + viability probe now resolve `.cmd` shims via `runChild()` helper (`shell: true` on win32). Caller env is propagated to child processes via `mergeEnv()`.

**Timeout policy:** `claudeCode.timeoutMs` default bumped 180 000 → 300 000 ms (5 min) to cover Windows first-call auth latency. `tierkit doctor` surfaces a hint when recent `cli-timeout` entries appear in `usage.jsonl`.

## 0.15.0 — 2026-05-21

**Tierkit MCP Bridge — Claude Code and any MCP client can now use Tierkit tools natively.**

New `@tierkit/mcp-server` package and `tierkit mcp serve --workspace <path>` CLI command. Claude Code / Claude Desktop configure it as a standard `mcpServers` stdio entry. Ships 7 gated tools:

| Tool | Description |
|---|---|
| `tierkit.read_file` | Line-paginated read with path denylist + secret redaction |
| `tierkit.list_files` | Workspace-bounded listing with ignore-source precedence |
| `tierkit.codebase_search` | Keyword search with snippet redaction + denylist drop |
| `tierkit.propose_patch` | Risk-scored ephemeral patch ticket (never mutates files) |
| `tierkit.apply_patch` | Freshness + approval gated; sha256-verifies payload before writing |
| `tierkit.run_command` | Sandbox + classifier + redaction + timeout |
| `tierkit.get_policy_status` | Snapshot of workspace policy state |

- Ephemeral patch ticket model: `propose_patch` writes a 24h TTL ticket; `apply_patch` accepts only `patchId` — raw write_file / raw-diff paths not exposed
- `tierkit mcp patch {list,approve,reject}` CLI commands work without a running daemon
- MCP activity log appended to `.tierkit/runtime/usage.jsonl` per tool call
- GUI: "Connect Claude Code (MCP)" onboarding card + suggested `mcpServers` JSON snippet; "Pending MCP patches" card with approve/reject buttons
- `GET /v1/mcp/config` returns suggested `mcpServers` JSON; `POST /v1/mcp/patches/:id/{approve,reject}` convenience endpoints

## 0.14.2 — 2026-05-21

**Fix: agent loop no longer hangs when `claudeCode` returns XML narrative.**

When the active profile uses a subprocess transport, the `AgentLoop` now enters single-shot mode: it skips XML tool-call parsing, emits the raw text response with a `SINGLE_SHOT_FOOTER`, then completes on turn 1. A `cli-timeout` in single-shot mode surfaces as an explicit `subscription-cli-timeout` error with an actionable message — no silent fallback. `claudeCode.timeoutMs` default bumped 120 000 → 180 000 ms.

- fix(agent): single-shot mode for subprocess providers; infinite-loop eliminated
- fix(agent): CLI timeout surfaces as explicit error in single-shot mode
- fix(ui): activity log shows model suffix in parentheses when it differs from profile id

## 0.14.0 — 2026-05-21

**Zero-CLI onboarding + native `claude` streaming.**

The GUI's first-activation flow now shows an onboarding checklist card (dismissable after `seenOnboarding` is set) with an inline Quick check trace, a profile inline editor with chip UI for `roles`/`goodAt`/`notGoodAt`, a secrets card with masked display and add-custom form, and the chat tab opens by default until onboarding is dismissed.

`ClaudeCodeProvider` gains a true `streamArgs()` path (`--output-format stream-json --verbose`) with `parseStreamLine()` handling both `assistant-message` and `content_block_delta` shapes. This removes the `⚠ stream-degraded` warning chip for `claude` users and eliminates the extra round-trip latency.

- feat(http): `GET /v1/environment` endpoint (Ollama probe, claude CLI viability, envVars, taskTypes)
- feat(core): `PATCH /v1/config/profile/:id` extended to patch `roles`/`goodAt`/`notGoodAt`
- feat(providers): native stream-json parsing for `ClaudeCodeProvider`; NDJSON fallback for base-class

Also includes 0.14.1 fix: onboarding Quick check now correctly reads the `/v1/route/explain` response shape (`candidates[]` with `selected: boolean`) introduced in 0.13.2.

## 0.13.2 — 2026-05-21

**Routing escalation hardening — local 7B models no longer win code-review and plan tasks.**

Four related fixes stemming from a user-test incident where `claudeCode` never won the candidate chain for review-style requests:

1. `inferCapabilities` — generic 7B–13B Ollama models (gemma, mistral 7b, llama3 8b, command-r) now declare `notGoodAt: [code-generation, refactor, code-review, plan]` and `goodAt: [summarize, translate]`.
2. `migrateAddMissingRouterMetaFields` — on every config load, backfills missing `notGoodAt`/`goodAt`/`displayName` on workspace profiles that share provider+model with a bundled default. Existing v0.12 `tierkit.config.json` files upgrade automatically; user-set values are never overwritten.
3. `claudeCode.kind` corrected to `public-cloud` (data flows to Anthropic's cloud). Adds `defaultMode: "review-only"`.
4. `POST /v1/route/explain` HTTP endpoint mirrors the CLI `tierkit route explain` command. Returns `{ taskType, score, reasons, tier, ceiling, candidates[] }` with per-candidate viability so users can diagnose routing from the GUI without the CLI installed.

## 0.13.1 — 2026-05-21

**Fix: local 7B models no longer hijack code-review tasks.**

`notGoodAt: [code-review, plan, refactor]` added to `localCoder` (qwen2.5-coder:7b); `RiskScorer.scoreRisk` now accepts an optional `taskType` and adds +20 for `code-review`, +15 for `plan`/`refactor`. For Roo's "review this project" style requests, the router now escalates to `claudeCode` (when available) or returns a clear empty-chain error instead of silently delivering a weak local-model review.

## 0.13.0 — 2026-05-21

**Subscription CLI Provider (Claude Code) — flat-rate before per-token.**

**BREAKING:** Pinned profiles (`model: "claude-code"`, etc.) now fail loud with 4xx/502/504 + structured error body on viability failure — no silent fallback. `model: "auto"` keeps the full escalation chain. Upgrade the `tierkit.config.json` `pinned` flag or switch to `auto` if you relied on implicit fallback.

The router ordering is now `free → flat-rate → per-token` within each tier. A bundled `claudeCode` profile is seeded as `defaultDisabled: true`; enable it via the GUI or `disabledProfileIds` config after verifying `claude` is on PATH.

- feat(providers): `SubscriptionCliProvider` abstract base + `ClaudeCodeProvider` with permissive JSON parser
- feat(viability): subprocess probe (`cli-not-found` / `cli-healthcheck-failed`)
- feat(router): `paymentModel` as primary sort key within tier
- feat(http): SSE stream degrade for subprocess providers (single-delta + `tierkit.warning` envelope field)
- feat(gui): per-row viability badge, Test button with first-time confirm + result panel, BREAKING banner
- feat(gui): `model-test` badge in Recent Activity; `≈` for estimated tokens; `⚠` for stream-degraded calls
- feat(tooling): `pnpm bump <version>` syncs all package.json files; tsup hard-fails on core↔extension version mismatch

## 0.12.3 — 2026-05-20

**Fix: chronic Models UI bugs — toggle, delete, and duplicate profiles now work correctly.**

Three parallel mechanisms expressing "profile is disabled" (`profile.enabled` field, `disabledProfileIds` array, `modelProfiles[id]: null` suppression) caused prior fixes to regress. v0.12.3 unifies state into a single source of truth.

- New helper `isProfileDisabled(cfg, id)` — reads only `disabledProfileIds`; all callers updated
- New helper `canonicalIdentity(profile)` — `(provider|baseUrl|model)` triple for dedup
- `migrateLegacyEnabledField` — strips `enabled: false/true`, folds `false` into `disabledProfileIds` (runs on every `loadConfig`, idempotent, atomic)
- `migrateCanonicalDuplicates` — writes `null` suppression for duplicate profiles sharing the same canonical identity
- Ollama auto-discovery skips models already covered by an explicit config with the same canonical identity
- `DELETE /v1/config/profile/:id` returns `400 cannot-delete-non-editable` for bundled/discovered profiles
- GUI: Delete button hidden for bundled + discovered rows; `dedupeByCanonicalIdentity()` as defense-in-depth

## 0.12.2 — 2026-05-20

**UI Validation Flow — run the context-compression measurement loop from the sidebar.**

A new "Current project — validation" card in the Cost Control sidebar makes the `build → compare → verdict` loop runnable with zero terminal. Sessions stay in-memory; verdicts persist to a sidecar `verdict.json` next to each `artifact.json` for later aggregation.

Five new HTTP endpoints:

| Endpoint | Description |
|---|---|
| `POST /v1/context/build` | Build a compressed context artifact |
| `GET /v1/context/:id` | Read artifact + verdict |
| `GET /v1/context/recent` | Last 20 artifacts sorted by date |
| `POST /v1/context/:id/compare` | SSE stream — baseline vs compressed two-call compare |
| `POST /v1/context/:id/verdict` | Save `same \| better \| worse \| unusable` verdict + notes |

The compare SSE stream emits `phase`, `delta`, `side-result`, `compare-done`, and `error` events. A cost-confirmation modal requires explicit acknowledgment before the two paid calls fire. The verdict form is disabled until a quality rating is chosen and notes are under 2 000 characters.

## 0.12.1 — 2026-05-19

**Three small post-0.12.0 fixes; no feature changes.**

- fix(ui): token bar now renders for `free`/`flat-rate` profiles that have `monthlyInputTokenLimit` set (was only shown for `per-token`)
- fix(cli): `--version` flag now reads `TIERKIT_VERSION` from package barrel; future bumps propagate automatically
- fix(core): Case A budget-exceeded message softened to "No eligible profile remained after per-profile budget policy checks."

## 0.12.0 — 2026-05-19

**Cost-aware routing v2 — payment model dimension + per-profile budget caps.**

Adds a `paymentModel` dimension (`"free" | "flat-rate" | "per-token"`) to model profiles and enforces per-profile USD + input-token budget caps before each call. Per-profile gate runs first in the candidate chain; exhausted candidates fall back; exhausted global cap is a hard stop.

- `PerProfileBudget`: `dailyUsdLimit?`, `monthlyUsdLimit?`, `dailyInputTokenLimit?`, `monthlyInputTokenLimit?` — keyed under `BudgetPolicy.perProfile`
- `/v1/usage` gains additive `profiles` field (`today` + `month` per profile)
- `tierkit usage --by-profile` table with Status column (OK / Warning / Near limit / Blocked)
- `tierkit doctor` 3 new checks: free/flat-rate USD-limit warning, near-threshold, blocked
- `tierkit route run` differentiates Case A (per-profile fallback exhausted) vs Case B (global cap)
- GUI Cost routing card: per-profile budget bars (per-token only), flat-rate metadata row, aggregate spending row, all-capped banner

## 0.11.1 — 2026-05-19

**Repositioning: Tierkit reframed as a local-first runtime.**

Docs, copy, and UI information architecture updated to lead with cost reduction rather than plugin runtime. Zero runtime behavior change; all CLI commands, HTTP endpoints, and `tierkit.config.json` schema unchanged.

- GUI sidebar groups renamed: Savings / Current project / Cost routing / Integrations / Advanced
- CLI `--help` categories: Savings / Cost routing / Integrations / Diagnostics / Advanced
- README leads with `tierkit context build` / `compare`
- All package descriptions updated to runtime framing
- VS Code marketplace listing (`package.nls.json`) updated

## 0.11.0 — 2026-05-19

**Context compression — 4 CLI commands for LLM-free workspace compression.**

Deterministic (no LLM required) context compression pipeline. Extracts keywords, collects candidates via ripgrep, ranks by term hit score + path bonus + recency, builds a file skeleton (regex per language) + hotspot excerpts, writes a `prompt.md` + `artifact.json` to `.tierkit/runtime/context-artifacts/<id>/`.

- `tierkit context build "<task>"` — build compressed prompt from workspace
- `tierkit context show <id> [--json]` — inspect artifact summary or raw JSON
- `tierkit context send <id> --profile <p>` — send compressed prompt through `runRoute`
- `tierkit context compare <id> --profile <p> [--yes]` — two paid calls (baseline raw vs compressed), prints side-by-side savings table
- `contextCompression` optional config section in `tierkit.config.json`
- Auto-creates `.tierkit/.gitignore` with `*` on first artifact write

## 0.10.1 — 2026-05-18

**Per-profile ON/OFF toggle + persistent delete + Ollama re-discover button.**

- Per-profile enable toggle: new `PATCH /v1/config/profile/:id` endpoint + `TierkitConfig.disabledProfileIds[]` field. `ModelRouter` filters `enabled: false` from the candidate chain.
- Fix: deleted profiles no longer reappear after daemon restart. Auto-discovered Ollama profiles now respect `null` suppression markers in config.
- Fix: `+ Add` form pre-fills the profile id field so Save doesn't silently fail when users treat the placeholder as the value.
- Discover button: on-demand Ollama re-probe via new `POST /v1/models/discover` endpoint (busts the 30 s discovery cache).

## 0.10.0 — 2026-05-18

**Version unification across the monorepo. Includes all features shipped since 0.9.6.**

Bumps the VS Code extension and all 9 npm packages from 0.9.x / 0.1.0 to a shared `0.10.0` baseline.

### Phase 1 — Model management UI
- Add/delete model profiles from the sidebar; paste API keys inline; Gemini preset (OpenAI-compatible endpoint)
- `auto-ceiling` dropdown + `goodAt[]` input on the profile form

### Phase 2 — Cross-tier auto-fallback + routing
- Task classifier (English + Korean rule-based)
- `ResponseQualityEvaluator` (empty / refusal / truncated / repetition detection)
- `goodAt[]` field on `ModelProfile`; `autoEscalationCeiling`, `budgetAwareDowngrade`, `responseQualityCheck` config
- Auto-resolver: classify → route → downgrade → viability; used by `executeLlmCall` for `model: "auto"`
- `PATCH /v1/config/routing` — update auto-routing policy
- `tierkit route explain` exposes `taskType` + escalation chain

### Phase 3 — LLM-generated plugins
- `POST /v1/plugins/generate` + `POST /v1/plugins/generate/install` endpoints
- GUI "Describe & generate" flow: describe the plugin in natural language → preview manifest → install
- `generatePlugin` usecase with one-retry on validation failure

## 0.9.6 — 2026-05-17

**Fix: only one of the four superpowers samples actually installed after upgrading.**

### Symptom
After installing 0.9.5 with the expectation of four samples (only guided enabled), users who had already started Tierkit on this workspace under an earlier 0.9.x — when bootstrap installed just `superpowers-guided` — still saw only one row in Active plugins.

### Root cause
0.9.5's bootstrap had a single gate:

```ts
if (registry.plugins.length > 0) return; // skip — user has touched plugins before
```

For a fresh workspace this is correct, but if any 0.9.3/0.9.4 daemon had ever run, `plugins.json` already contained `superpowers-guided`. The gate then skipped the entire 4-sample install, so the new array form (`bootstrapPlugins[]`) never made a difference. Confirmed via the daemon's `/v1/plugins` showing one entry whose `installedAt` predates 0.9.5.

### Fix
Bootstrap is now **per-item idempotent**:

- Remove the `registry.plugins.length > 0` gate.
- Try each `bootstrapPlugins[i]` independently. If `installPlugin` throws "already installed", treat it as success (the end state matches what we want) and still queue the plugin for `enablePlugin` if `autoEnable: true`.
- `enablePlugin` is already idempotent (adding an already-active id to `activePlugins` is a no-op).
- Each install/enable lives in its own try/catch so one malformed sample dir doesn't take the rest down.

**Trade-off**: a sample the user `[✕]`-removed will be re-installed on the next daemon restart. The intended way to silence a sample is the ON/OFF toggle (0.9.3), not uninstall. If you truly don't want a sample, leave it installed-and-toggled-off — uninstall is for plugins the bootstrap doesn't ship.

### Result for users on this upgrade
- Existing workspaces with only `superpowers-guided`: reload window → bootstrap installs `superpowers-free`, `superpowers-balanced`, `superpowers-strict` (all disabled). Guided stays enabled.
- Fresh workspaces: same as 0.9.5 — all four installed, only guided enabled.

### Apply
1. Install `tierkit-vscode-0.9.6.vsix`.
2. Reload window (Cmd-Shift-P → Developer: Reload Window).
3. Confirm Active plugins now shows four rows; only superpowers-guided's toggle is ON.

Bumps tierkit-vscode 0.9.5 → 0.9.6.

## 0.9.5 — 2026-05-17

### All four superpowers presets install on first run; only guided is auto-enabled
- `startServer` opt `bootstrapPlugin` (singular) → **`bootstrapPlugins[]`** (array) with per-item `autoEnable` flag.
- The extension now passes every bundled sample with `autoEnable: true` set only on `superpowers-guided`. Outcome on first run:

  ```
  Active plugins
   ●━━○  superpowers-guided    guided    ✕   ← enabled
   ○━━●  superpowers-free      free      ✕   ← installed, disabled
   ○━━●  superpowers-balanced  balanced  ✕   ← installed, disabled
   ○━━●  superpowers-strict    strict    ✕   ← installed, disabled
  ```

  Flip any of the others on with the toggle whenever. Bootstrap still respects the "registry is empty" gate — once any plugin is touched, the daemon never re-installs on subsequent starts.

- Bootstrap is robust per-item now: each install / each enable runs inside its own try/catch, so a single malformed sample dir won't take down the whole bootstrap.

### Settings tab no longer clips in narrow sidebars
Cards and rows were widening to fit non-wrapping mono content (long file paths in the Config card, profile pill list in the Today hero) — CSS grid items default to `min-width: auto`, so the column was sized to its widest atom and the right edge got cut off in 280–360px sidebars.

Fix is layered min-width + word-break:

```css
main, main > *, .card { min-width: 0; }
.card { overflow-wrap: anywhere; word-break: break-word; }
.usage-hero { min-width: 0; }
#usage-by-profile { min-width: 0; flex: 1 1 auto; }
```

Per-profile pills inside the hero keep `white-space: nowrap` per pill (so "claude $0.025" stays one token), but the row itself now wraps cleanly thanks to the parent's `flex-wrap: wrap` + the pill's `display: inline-block`.

### How to apply
1. Install `tierkit-vscode-0.9.5.vsix`.
2. **Reload the VS Code window** (Cmd-Shift-P → Developer: Reload Window).
3. In a workspace with no prior `.tierkit/plugins.json`, four superpowers samples install and `superpowers-guided` activates. Settings tab fits in narrow sidebars.

### Verification
- `unzip` of the .vsix shows all four `extension/samples/superpowers-*` directories.
- 259/259 core tests pass.

Bumps tierkit-vscode 0.9.4 → 0.9.5.

## 0.9.4 — 2026-05-17

**Fixes 0.9.3 auto-bootstrap silently doing nothing in the published .vsix.**

### Root cause
0.9.3 introduced `bootstrapPlugin` (auto-install + auto-enable a default sample on first run), driven by `loadBundledSamples()` which resolved `@tierkit/plugin-superpowers/plugins/` via `createRequire`. That worked in dev mode (monorepo workspace symlink), but the **published .vsix has no `node_modules/`** — `vsce package --no-dependencies` strips them and tsup can't bundle a directory of `.md` data files into JS.

Result: in an installed extension, `createRequire.resolve("@tierkit/plugin-superpowers/package.json")` threw, `loadBundledSamples()` swallowed the error and returned `[]`, `pickBootstrapSample()` was undefined, the `bootstrapPlugin` option never reached `startServer`, and the GUI's Install dropdown stayed empty. The Active plugins card showed "활성 플러그인 없음" exactly as if 0.9.3 never shipped.

Confirmed by `unzip`-ing the 0.9.3 .vsix: only `dist/`, `media/`, `l10n/`, `package.json` — no `plugin-superpowers` anywhere.

### Fix
The build now physically copies the samples into the extension folder so they land inside the .vsix:

```
packages/vscode-tierkit/
├── dist/
│   └── extension.js        (bundled code, no data files)
└── samples/                ← NEW, copied from ../plugin-superpowers/plugins/
    ├── superpowers-balanced/
    ├── superpowers-free/
    ├── superpowers-guided/
    └── superpowers-strict/
```

Changes:
- **New `scripts/copy-samples.mjs`** — uses Node's `fs.cp` to mirror `../plugin-superpowers/plugins/` into `samples/`. Logs each sample id + freedom level so packaging output proves they're in.
- **`package.json`**: `build` now runs `tsup && node scripts/copy-samples.mjs`. `clean` removes `samples/` too.
- **`.vscodeignore`**: whitelists `!samples/**` so vsce includes them.
- **`loadBundledSamples()`** tries two paths in order:
  1. `<extensionRoot>/samples/` — present in the published .vsix.
  2. `@tierkit/plugin-superpowers/plugins/` via `createRequire` — dev-mode fallback.

Verified the new .vsix contains `extension/samples/superpowers-guided/tierkit.plugin.json` (and the others).

### How to apply
1. Reinstall `tierkit-vscode-0.9.4.vsix`.
2. **Reload the VS Code window** (Command Palette → "Developer: Reload Window") — without this the extension host keeps running the old 0.9.3 code and the in-process daemon never restarts with the new bootstrap option.
3. Open the Tierkit sidebar in any workspace that has never been initialized (no `.tierkit/plugins.json`). `superpowers-guided` should install + enable automatically. Existing workspaces with prior plugin state are untouched.

### Verification
- `unzip` of the new .vsix shows `extension/samples/superpowers-*` directories with manifests.
- 259/259 core tests pass.

Bumps tierkit-vscode 0.9.3 → 0.9.4.

## 0.9.3 — 2026-05-17

**Superpowers ships preinstalled. ON/OFF toggle switch on every plugin row.**

### Auto-bootstrap on first run
`startServer` gains a `bootstrapPlugin?: { path; autoEnable? }` option. When set, the daemon checks the registry at startup; if `plugins.json` is empty or missing (= clean first run) it:
1. `installPlugin` the bundled sample into `.tierkit/plugins/<id>/`
2. If `autoEnable !== false` and `tierkit.config.json` doesn't exist yet, runs `initProject` to create it (idempotent — only writes default when missing)
3. `enablePlugin` so the plugin is active and synced

The extension picks `superpowers-guided` from the bundled samples and passes it as the bootstrap. Result: open the sidebar for the first time in a workspace, and superpowers is already active. **No clicks needed.**

Subsequent starts skip bootstrap because the registry has entries — the user's choices (uninstall, disable, swap to a different sample) are preserved across daemon restarts.

CLI users (no `bootstrapPlugin` opt) are unaffected — bootstrap is opt-in.

Errors during bootstrap are logged-but-swallowed: the daemon still comes up even if install fails. The GUI's empty-state install rows remain as a manual fallback.

### Toggle switch
Plugin rows replaced their Enable/Disable text buttons with a single 36×18 ON/OFF switch (visual + `role="switch"` + `aria-checked` for a11y). The knob slides + the track colors when toggled. The Remove `[✕]` button is unchanged.

```
Before:
  superpowers-guided  enabled  guided   [Disable]  [✕]
  superpowers-free    disabled free     [Enable]   [✕]

After:
  superpowers-guided  guided                 ●━━○   [✕]
  superpowers-free    free                   ○━━●   [✕]
```

Click anywhere on the switch → toggles via the same `safeEnable` (auto-init+retry on no-config) or `/v1/plugins/disable` paths. Single click. No mode switch.

### Implementation notes
- The extension now `await`s `loadBundledSamples()` inside `maybeStartDaemon` BEFORE `startServer`, so the bootstrap option carries an actual path (previously the samples loaded asynchronously after the daemon was already up).
- After daemon start, `sidebarRef?.render()` runs once so the webview HTML carries the updated `__TIERKIT_SAMPLES__`.

### Verification
- 259/259 core tests pass.
- `node --check` on inline script: clean parse.
- Workspace builds cleanly.

Bumps tierkit-vscode 0.9.2 → 0.9.3.

## 0.9.2 — 2026-05-17

**Empty Active plugins card now shows the bundled samples inline + one-click "Install + Enable" that auto-initializes config.**

### Why
0.9.0 added install/uninstall to the GUI, but two friction points remained:
1. When no plugins were installed, the card just said "no plugins active. + New ..." — users had to find the `+ Install` dropdown to discover the bundled samples.
2. Even after install, clicking Enable failed with `no-config` if the workspace had no `tierkit.config.json`. The CLI tells you to run `tierkit init`; the GUI just bubbled the error.

### Fix
Empty state now lists the bundled samples directly as install rows. Each row has one `[Install + Enable]` button:

```
ACTIVE PLUGINS                          [+ Install] [+ New]
┌──────────────────────────────────────────────────────────┐
│ No plugins active. Click below to install + enable a    │
│ bundled sample (one click — auto-initializes the project│
│ config if needed).                                       │
│                                                          │
│ superpowers-balanced  balanced  + review step  [+ Install│
│ superpowers-free      free      minimal — m…    + Enable]│
│ superpowers-guided    guided    recommended …            │
│ superpowers-strict    strict    enforced plan/approve    │
└──────────────────────────────────────────────────────────┘
```

Two helpers added in the GUI script:
- `safeEnable(pluginId)` — calls `POST /v1/plugins/enable`. If the response code is `no-config` (or message contains it), it `POST /v1/config/init` once and retries. Init is idempotent.
- `installAndEnable(pluginPath)` — installs at the given path, then `safeEnable`s the returned plugin id. Used by the empty-state rows and by both branches of the `+ Install` dropdown (bundled + from-path).

Individual `Enable` buttons on already-installed plugins also use `safeEnable`, so the no-config trap is closed everywhere.

### What stays the same
- All endpoints unchanged; this is pure GUI orchestration.
- Browser mode (no extension) sees an empty `__TIERKIT_SAMPLES__` and falls back to the old "no plugins active" text — no degradation there.

### Verification
- 259/259 core tests pass.
- `node --check` on the inline script: clean parse.

Bumps tierkit-vscode 0.9.1 → 0.9.2.

## 0.9.1 — 2026-05-17

**Fix: chat and sidebar dead in VS Code webviews — `acquireVsCodeApi` called twice in 0.9.0.**

Same class of regression as 0.8.4 (IIFE init failure → no handlers register → sidebar entirely unresponsive), but this time at runtime in webviews specifically.

### Root cause
The VS Code webview API permits exactly **one** call to `acquireVsCodeApi()` per page; the second call throws `"An instance of the VS Code API has already been acquired"`.

0.9.0 hoisted `vsApi` from the inner `maybeRenderHostBanner` IIFE to the outer IIFE for reuse across panels:

```js
const transport = ... ? createVsCodeTransport() : createHttpTransport(BASE);
                          //    ↑ 1st acquireVsCodeApi() inside transport.ts
const vsApi = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
                          //    ↑ 2nd call — throws in webview mode
```

The throw killed the outer IIFE → no chat/composer/button handlers got registered → identical-looking symptom to 0.8.4 even though the cause is completely different.

### Why stub-DOM smoke didn't catch it
The previous smoke test stubbed `acquireVsCodeApi = undefined`, so both call sites took the null-path. The new regression test in `test/guiHtml.test.ts` provides a webview-shaped stub: a counter that throws on call #2, exactly matching the real contract. The test fails on 0.9.0 code, passes on 0.9.1.

### Fix
`createVsCodeTransport` already calls `acquireVsCodeApi` once — it now exposes the resulting handle on `transport.vsApi`. `gui.ts` reads from there instead of re-acquiring. `createHttpTransport` returns `vsApi: null` for shape parity in browser mode.

```diff
-  const vsApi = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
+  const vsApi = transport.vsApi;
```

### Verification
- New regression test `does not call acquireVsCodeApi more than once` — fails on 0.9.0, passes here.
- 259/259 core tests pass.
- `node --check` on extracted inline script: clean parse.
- Full workspace rebuild succeeds.

## 0.9.0 — 2026-05-17

**Plugin install / uninstall / scaffold — all from the sidebar. No more CLI required.**

### New GUI flows
- **`+ Install` button** in the Active plugins card opens a dropdown with two sections:
  - **Bundled samples** — 1-click install of `superpowers-free` / `guided` / `balanced` / `strict` (description + freedom-level badge inline). The VS Code extension discovers `@tierkit/plugin-superpowers/plugins/*` at activation and injects the absolute paths via `window.__TIERKIT_SAMPLES__`.
  - **From path** — install any plugin directory by typing an absolute path.
- **Remove button (✕)** on every installed plugin row. Confirms before calling `POST /v1/plugins/remove`, which deletes the on-disk plugin dir and drops it from `plugins.json` + `activePlugins`.
- **`+ New` form expanded** — was just `id` before. Now includes `name`, `description`, freedom level (free/guided/balanced/strict dropdown), and optional `first command` name. After Generate, an **`Open in editor`** button pops up that calls back into the extension host to open the new plugin's `tierkit.plugin.json` in VS Code.

### Server (2 new + 1 extended HTTP routes)

| Method | Path | Body | Wraps |
|---|---|---|---|
| POST | `/v1/plugins/install` | `{ pluginPath, force? }` | `installPlugin` usecase |
| POST | `/v1/plugins/remove`  | `{ pluginId }`           | `removePlugin` usecase |
| POST | `/v1/plugins/new`     | `+ freedomLevel, firstCommand` (existing endpoint, two new optional fields) | `pluginNew` usecase |

### Side fixes
- **`/v1/plugins` response now includes `enabled: boolean`** per plugin. Enable state lives in `tierkit.config.json`'s `activePlugins` array — previously the GUI's Active plugins card always showed every plugin as "disabled" because `RegistryEntry` has no `enabled` field. `listPlugins` now joins both sources so the Enable/Disable button reflects truth.
- **`vsApi` hoisted to outer IIFE scope.** It was buried inside `maybeRenderHostBanner`, so every other reference (image preview button, openFile postMessage in the agent card) was a `ReferenceError`. Those branches silently failed before; now they work.

### How it looks

```
ACTIVE PLUGINS                              [+ Install] [+ New]
┌──────────────────────────────────────────────────────────────┐
│  superpowers-guided  enabled  guided      [Disable]  [✕]    │
│  superpowers-free    disabled free        [Enable]   [✕]    │
└──────────────────────────────────────────────────────────────┘

[+ Install]  ▼
┌── Bundled samples ─────────────────────────────────────────┐
│  superpowers-free      free        minimal, model decides… │
│  superpowers-guided    guided      recommended starting…   │  [Install]
│  superpowers-balanced  balanced    + review step           │  [Install]
│  superpowers-strict    strict      enforced plan/approve   │  [Install]
├── From path ───────────────────────────────────────────────┤
│  [_/absolute/path/to/plugin____________________]  [Install]│
└────────────────────────────────────────────────────────────┘

[+ New]  ▼
  id          [my-plugin]
  name        [My Plugin]
  description [...]
  freedom     [guided ▾]
  first cmd   [hello-world]
              [Cancel]  [Generate →]
  Created: .tierkit/plugins/my-plugin   [Open in editor]
```

### Bundled samples path resolution
`vscode-tierkit/package.json` adds `@tierkit/plugin-superpowers: workspace:*`. The extension's `loadBundledSamples()` does `createRequire(import.meta.url).resolve("@tierkit/plugin-superpowers/package.json")` at activation, reads each child manifest under `plugins/`, and exposes them via `window.__TIERKIT_SAMPLES__`. Browser-mode (no extension) sees an empty samples array and only the "From path" input — graceful degradation.

### Verification
- 258/258 core tests pass (including the IIFE-parses regression test from 0.8.4).
- `node --check` on the inline script: clean parse.
- Stub-DOM smoke: IIFE executes without throwing.

## 0.8.5 — 2026-05-16

**Chat tab fills the sidebar. Settings tab regrouped from 7 cards into 3 sections.**

### Chat tab — full-height layout
The thread now expands to fill all available viewport height; the composer stays
pinned at the bottom via natural flex flow (no `position: sticky` — that's what
broke 0.8.2). Scrolling happens inside the thread, not the body. Works equally
in VS Code Desktop, code-server, and on phones.

Implementation: `body { height: 100vh; display: flex; flex-direction: column }`,
`.tab-panel.active[data-tab-panel="chat"]` overrides to `display: flex` so its
descendants (`.agent-shell` → `.agent-card` → `.agent-thread`) chain `flex: 1 +
min-height: 0` all the way down. `.agent-thread`'s old `max-height: 360px` cap
is gone. `.tab-panel.active[data-tab-panel="settings"]` keeps `overflow-y:
auto` so the settings page gets its own scroll container instead of fighting
the chat layout.

### Settings tab — 3 grouped sections + Today hero

```
┌─ TODAY · 24 calls · 12.3k tok · $0.04 · claude $0.025 ollama $0.000 ─┐  ← hero
└──────────────────────────────────────────────────────────────────────┘

INTEGRATIONS                                                              ← group header
┌─ Connected tools ──┐  ┌─ Active plugins ──┐
└────────────────────┘  └───────────────────┘

CONFIGURATION
┌─ Model profiles ───┐  ┌─ Config / Daemon ─────────┐
│ ollama  light      │  │ workspace: ...            │
│ claude  heavy      │  │ user: ~/.tierkit/...      │
│ [+ Add]            │  │ ─── Daemon ──────         │
│                    │  │ 127.0.0.1:4101            │
└────────────────────┘  └───────────────────────────┘

ACTIVITY
┌─ Recent activity (full width) ──────────────────────┐
│ 14:21  claude  in 1.2k  out 0.4k  $0.012            │
│ ...                                                  │
└──────────────────────────────────────────────────────┘
```

Changes:
- **Today's usage** promoted from a card to a thin gradient hero strip at the
  top: 3 inline stats + per-profile breakdown as inline pills (no separate
  card, no vertical real-estate cost).
- **Group headers** (`INTEGRATIONS` / `CONFIGURATION` / `ACTIVITY`) — small
  uppercase labels span the full grid via `grid-column: 1 / -1`.
- **Daemon card merged** into the Config card under a labeled subdivider. The
  Daemon endpoint info (one line) no longer eats a whole card.
- **Card label collision resolved** — `Settings (config view)` card inside the
  `Settings` tab was confusing. Now `Config / Daemon`.
- **Activity moved to the tail** (it's reference data, not actionable — belongs
  at the bottom).
- **Element IDs preserved** — every refresh function continues to work without
  JS changes (apart from `usage-by-profile` rendering as inline pills).

### Cards still in place
Element IDs (`tools-list`, `plugins-list`, `models-list`, `activity-list`,
`settings-view`, `daemon-info`, `stat-calls/tokens/cost`, `usage-by-profile`)
are unchanged so all existing handlers, refresh functions, and the daemon-side
endpoints keep working untouched.

### Tests
258/258 core tests pass (including the IIFE-parses regression test from 0.8.4).
Stub-DOM smoke executes the IIFE without throwing.

## 0.8.4 — 2026-05-16

**Fixes sidebar being entirely unresponsive — every click/tap was a no-op.**

The sidebar GUI ships as a single TypeScript template literal that emits the page HTML + an inline `<script>` IIFE. Several pieces of code inside that IIFE used single-backslash escapes — regex `\s` / `\w` / `\-` and JS string `\n` — which the **outer** TS template literal silently processed (per JS spec: untagged template literals drop unknown escapes and translate known ones like `\n` to a raw newline). The resulting `<script>` body was invalid JavaScript:
- `'\n'` became a literal newline inside a single-quoted string → `SyntaxError: Invalid or unexpected token`
- `/(?:^|\s)@([\w\-./]*)$/` became `/(?:^|s)@([w-./]*)$/` → `SyntaxError: Range out of order in character class`

The IIFE threw on parse, so **no event handlers were registered**. Every button, input, tab, dropdown, and approval prompt in the sidebar was dead. Reported on every environment (VS Code Desktop, code-server, phone, desktop mouse) — consistent with "no JS at all is running."

### Fix
All offending escapes now double-backslashed at source (`'\\n'`, `/\\s/`, `[\\w\\-./]`, etc.) so the inlined script gets the literal characters it needs. Regression test (`test/guiHtml.test.ts`) extracts the inline script and:
1. Parses it via `new Function(...)` — fails on syntax error.
2. Asserts that `\s`, `\w`, `\n`, `\r` appear in the emitted code (catches "the backslash got eaten" silently).

This category of bug would have shipped in 0.8.0 with the messageRouter rework — it was introduced when several JS regex and string-literal lines were added inside the template without realizing the outer scope eats single backslashes.

## 0.8.3 — 2026-05-16

- Mobile sidebar rework. Fixes 0.8.2 regressions:
  - Touch unresponsiveness — added `touch-action: manipulation` and `-webkit-tap-highlight-color: transparent` on all interactive controls, removing iOS 300ms tap delay and webview gesture pipeline interference.
  - Reverted `position: sticky` composer + `safe-area-inset-bottom` — they broke scrolling in code-server's sidebar webview (no scroll-root for sticky to anchor to).
  - Trigger breakpoint moved 480px → 600px so phone *sidebar* viewports (~280–360px) actually match, not just phone full-screen.
  - Tighter density at narrow widths: 13px body, 11px dim/mono, smaller cards, hidden "mode:"/"approval:" labels, compacted topbar (brand hidden, kept pills).
  - Empty `agent-slash-suggest` container no longer captures touches.

## 0.8.2 — 2026-05-16

- Mobile-friendly GUI tweaks for code-server access from phones/tablets. At viewports ≤ 480px: larger touch targets (tab nav 44px, .tiny buttons 36px, send/stop 44×44), 14px body font (12.5px on desktop), iOS Safari zoom prevention on inputs (16px), composer sticky-to-bottom with safe-area-inset for notched devices, code blocks no longer break the viewport, attachment thumbnails 80px. Desktop and sidebar viewports are unchanged.

## 0.8.1 — 2026-05-16

- Split sidebar GUI into **Chat** and **Settings** tabs. The agent shell lives in the Chat tab; tools / plugins / activity / usage / models / daemon / settings cards live in the Settings tab. Reduces scrolling in the narrow sidebar and lets you stay focused on the conversation. Last active tab is remembered across reloads (per session in VS Code webviews; persistent in browser mode).

## 0.8.0 — 2026-05-16

- code-server compatible chat UI. The sidebar webview now talks to the
  extension host via postMessage instead of direct fetch through
  portMapping; the host proxies all daemon calls. Works in VS Code
  Desktop and code-server (and any future host that supports the
  standard webview API).
- Removed `portMapping` and `connect-src` CSP entries (no longer needed).

## 0.7.0 — 2026-05-16

**Vision input.** Drop, paste, or attach images directly in the agent composer — the daemon forwards them to vision-capable providers (Claude 3+, GPT-4V / GPT-4o, etc.) in their native format. Models without vision drop attachments silently; pair this with a vision-capable profile to actually use it.

### Composer UX
- **Paste from clipboard**: Cmd/Ctrl+V on an image (screenshot, copied from VS Code, etc.) attaches it as a thumbnail.
- **Drag-drop image files**: dragging image files into the composer attaches them. Non-image files still fall back to the @path token behavior from 0.6.0.
- **Thumbnail preview row** below the composer with × buttons to remove individual attachments before send.
- **Limits**: up to 6 images per task, 8 MB per image. Daemon enforces a 20 MB hard cap on combined attachment size as a safety net.
- After send, thumbnails are rendered inline in the user bubble so the conversation thread carries the visual context. Pending attachments clear so the next task doesn't accidentally reuse them.

### Pipeline (UI → daemon → provider)

```
GUI: pendingAttachments[]            (mediaType + base64)
  │
  ▼ POST /v1/agent/run { attachments }
  │
@tierkit/agent serverExtension:      validates each (image/*, ≤20MB total)
  │
  ▼ runAgent({ ..., attachments })
  │
AgentLoop:                           images attached to the initial user message
  │
  ▼ toWireMessage → OpenAI content-parts array: [image_url, ..., text]
  │
  ▼ POST /v1/openai/chat/completions
  │
core/runtime/openaiCompat:           flattenContent extracts data: URLs + raw base64
                                     image blocks; lands on ChatMessage.images
  │
  ▼ provider client
  │
Anthropic:                           type: "image" + source { type: base64, media_type, data }
OpenAI:                              content parts with type: "image_url"
Ollama:                              silently dropped (text-only by default)
```

### Schema changes
- `ChatMessage` gains optional `images?: ImageAttachment[]` (provider clients only honor it on `user` turns).
- New `ImageAttachment` type: `{ mediaType: string; base64: string }`.
- `AgentRunInput` gains optional `attachments?: ImageAttachment[]` — the daemon route copies validated attachments here.
- `AgentMessage` gains optional `images` for the initial user turn.

### Security
- HTTP(S) image URLs are intentionally NOT fetched server-side — only base64-inlined images go through. This avoids opening an SSRF surface from the loopback daemon.
- Each attachment's MIME type must match `image/*`; non-image dropdowns are rejected.

### Tests
- New `agentLoop` test verifies user message wire format: image_url part first, text part last, `data:image/png;base64,...` URL preserved verbatim.
- 28/28 agent tests + 243/243 core tests pass.

### Still skipped to future (0.8.x?)
- **Voice input** (Whisper API integration)
- **Semantic codebase_search** (embeddings provider + .tierkit/embeddings/ index)
- **browser_action** (Playwright runtime)

## 0.6.0 — 2026-05-16

**Daily-driver polish.** 0.4.3 → 0.6.0 in one release (the smaller versions were planned increments — they all ship together here). Adds observability, file-aware composer, two new tools, history compression, git checkpoints, drag-drop, settings panel, and per-session approval whitelisting.

### Composer / agent panel
- **Token meter** in the panel header shows cumulative session tokens. Per-turn breakdown (`X in / Y out tok · profile`) renders inline as a meta line.
- **Export / Import / Clear** buttons next to the panel header — conversations round-trip as `tierkit-agent-*.json` (schema `tierkit-agent-conversation@1`).
- **@filename autocomplete** — typing `@` in the composer queries `/v1/workspace/files?prefix=` and shows up to 8 matches in a floating dropdown. Picking one inserts `@path/to/file ` into the input; on submit, `[Files referenced by user: ...]` is appended to the task so the agent knows which files the user pointed at.
- **/cmd autocomplete** and **mode picker** (carried over from 0.4.2) refined.
- **Drag-drop**: drag files from the VS Code Explorer or your OS file manager into the composer to insert `@path` tokens for each.

### Approval flow
- **Session whitelist**: the Approve prompt now has a `remember for this session (tool_name)` checkbox. Once checked + approved, further calls of the same tool auto-resolve for the lifetime of the page; clearing the thread resets the whitelist.
- **Native VS Code diff preview**: write_file tool cards in the agent panel get a `Preview` button that opens a side-by-side diff against the existing workspace file using `vscode.diff`. apply_diff cards get an `Open` button that focuses the target file in the editor.
- **Stop button now kills running shell commands**: the SSE abort fires an `AbortSignal` plumbed through `AgentContext` into `execute_command`, which SIGTERMs the child and reports `aborted` as the tool result.

### New tools
- **search_and_replace** — regex-based replace-all in a single file. Requires approval. Use this when apply_diff would need multiple identical edits.
- **codebase_search** — natural-language query → BM25-ish keyword + locality ranking → top 20 file:line snippets. No embedding store required. Use this when you don't know exact symbol names. For exact substring matches, prefer `search_files`.

### Reliability
- **History compression**: after 40 messages, older tool-result messages get elided to a 1-line summary (`first line\n[…N bytes elided by history compression…]`). System + initial user message + the latest 16 messages are always kept verbatim. Keeps context budget sane on long sessions.
- **Git checkpoints**: before any destructive tool runs (`write_file`, `apply_diff`, `search_and_replace`), the agent calls `git stash create` and stores the resulting commit under `refs/tierkit-checkpoints/<id>`. The ref name surfaces in the panel so you can restore with `git checkout refs/tierkit-checkpoints/<id> -- <path>`. Best-effort: non-git workspaces silently skip.

### Settings panel
- New **Settings** card in Mission Control shows the resolved config: workspace + user config paths, `found: yes/no`, and a table of model profiles with their source (`bundled` / `user` / `workspace` / `discovered`). API keys are redacted server-side.

### Daemon endpoints added
- `GET /v1/config` — sanitized config snapshot (API keys redacted)
- `GET /v1/workspace/files?prefix=&limit=` — workspace file listing for `@` autocomplete

### Webview ↔ extension host messages
- `previewDiff { path, proposed }` — open vscode.diff against `tierkit-preview:` virtual doc
- `openFile { path }` — open file in editor

### Tests
- 5 new tool tests (search_and_replace, codebase_search). 27/27 agent + 243/243 core pass.

### Skipped to 0.7.0 (need external runtime/provider work)
- `browser_action` — needs Playwright integration
- semantic `codebase_search` — needs embeddings provider
- image input — needs multimodal provider passthrough
- voice input — needs Whisper or similar STT

## 0.4.2 — 2026-05-16

**Interactive approval, slash commands, mode picker, new tools.** 0.4.1 shipped the sidebar agent chat but auto-approved every dangerous tool call. 0.4.2 closes that gap and adds the polish needed for daily use.

### What's new

- **Interactive approval** — Below the input you now have an `approval:` dropdown with **auto** (default; old behaviour) and **ask each**. In ask-each mode, `write_file` / `execute_command` / `apply_diff` tool calls pause and render `[Approve] [Deny]` buttons inline on the tool card. Stop button auto-denies pending approvals. 5-minute server-side timeout also auto-denies.
- **Slash commands** — Type `/` in the input and an autocomplete dropdown appears with the active plugins' commands (name + description + plugin id). Pick one and `/cmdname` is inserted. On send, the slash command expands to a `[Plugin command: /name ...]` preamble + your free-form args, so the agent sees the command intent + plugin attribution.
- **Mode picker** — A `mode:` dropdown next to approval lists every mode from active plugins (`name (plugin-id)`). Selecting one is sent as `mode` in the run request and threaded into the agent's system prompt so the model knows which role it's playing.
- **Two new tools**:
  - `apply_diff` — targeted edit by searching for a unique substring and replacing it. Lower-risk than rewriting the whole file with `write_file`. Refuses if the search anchor appears 0 or >1 times. Requires approval.
  - `ask_followup_question` — the agent can pause and ask the user a clarifying question. The tool card renders the question in italics with a hint that the next user message will become the answer. Read-only — never gated by approval.

### Approval flow (UI ↔ server)

```
agent loop → tool_call(name=write_file)
           → tool_approval_pending  ── UI replaces "running…" with [Approve][Deny]
                                        user clicks → POST /v1/agent/approval {callId, approved}
           ← tool_approval_resolved
           → tool_result (or skipped if denied)
```

If the client disconnects mid-approval (Stop button / closed sidebar), the server auto-denies every pending approval for that run so the agent loop unblocks.

### Composer layout

```
┌──────────────────────────────────────────────────┐
│ │ Type a task...                          [→] [■]│
│ mode: [(all tools) ▾]  approval: [auto ▾]    / for plugin commands │
└──────────────────────────────────────────────────┘
```

## 0.4.1 — 2026-05-16

**Sidebar agent chat UI.** 0.4.0 shipped the agent infrastructure (HTTP only). 0.4.1 wires it into the Tierkit sidebar so users can run agent tasks from the Mission Control view without leaving VS Code.

### Layout
The sidebar now has an **Agent panel above the Mission Control cards**:

```
┌──────────────────────────────────┐
│ Tierkit  v0.1  guided  ↻          │
├──────────────────────────────────┤
│ ╔══════════════════════════════╗ │
│ ║ AGENT             idle       ║ │
│ ║                              ║ │
│ ║  (thread renders here)        ║ │
│ ║  ▸ list files in src         ║ │
│ ║  ⚙ list_files path=src       ║ │
│ ║     src/main.ts              ║ │
│ ║     src/utils/...            ║ │
│ ║  ✓ Task complete · 2 turns   ║ │
│ ║                              ║ │
│ ║ ┌──────────────────────────┐ ║ │
│ ║ │ Type a task...        [→]│ ║ │
│ ║ └──────────────────────────┘ ║ │
│ ╚══════════════════════════════╝ │
├──────────────────────────────────┤
│ Mission Control cards (unchanged)│
└──────────────────────────────────┘
```

### Event rendering
The panel subscribes to the `POST /v1/agent/run` SSE stream and renders each `AgentEvent`:

| Event | Visual |
|---|---|
| `task_start` | User-style line with `▸` prefix |
| `assistant_text` | Plain text line in fg color |
| `tool_call` | Inline card with `⚙ tool_name args=...` + "running…" placeholder |
| `tool_result` | The same card updates with the result body; success/fail border color; expandable when output > 800 chars |
| `task_complete` | Green panel with turn count |
| `turn_end` | Dim meta line with reason |
| `error` | Red panel |
| `tool_approval_pending/resolved` | Hint line (UI prompts come in 0.4.2) |

### Controls
- **Enter** submits, **Shift+Enter** adds a newline
- **Stop button** (■) appears while running — aborts the SSE connection via AbortController
- Status pill in the header flips between `idle` ↔ `running…`
- Auto-scrolls to bottom on every event; manual scroll respected

### Compatibility
- Mission Control cards unchanged — connected tools / plugins / activity / usage / models / daemon panels all still work
- Agent panel uses the same Tierkit daemon endpoint that powers Roo/Cline integration — every model call goes through the routing + viability + shim + plugin-rule stack
- Auto-approve for destructive tools (write_file, execute_command) in 0.4.1; UI approval prompts ship in 0.4.2

### Tests
371 unchanged (no test changes — UI is verified by smoke test). New smoke confirms:
- `class="agent-shell"` present
- `id="agent-thread"` present
- `/v1/agent/run` reference in JS
- AbortController plumbing (`agentController`) wired
- Mission Control `class="card full"` still renders

## 0.4.0 — 2026-05-16

**Tierkit gets its own agent.** New `@tierkit/agent` package + `POST /v1/agent/run` endpoint = Tierkit can now drive end-to-end coding tasks itself, without needing Roo / Cline / Continue.

### Background
Through 0.3.x the only way to get real coding done with Tierkit was to use it as a layer behind Roo Code (or similar). That works but has friction — Roo's system prompts conflict with Tierkit's plugin-rule injection and tool-shim. The agent-style detection mitigation was in the 0.3.5 plan, but a bigger pivot is cleaner: build Tierkit's own minimal but capable coding agent that natively understands Tierkit's plugin format, routes through Tierkit's full policy stack, and works with weak local models out of the box.

This is the first milestone of that pivot. 0.4.0 ships the agent infrastructure (loop, tools, daemon endpoint). 0.4.x will add the sidebar chat UI, native plugin-command-as-slash-command integration, more tools, and approval UI.

### `@tierkit/agent`

New workspace package. Headline pieces:

- **Cline-style XML tool calling.** Tools are described in the system prompt with one example each; the agent parses `<tool_name>...</tool_name>` from the model's text response. Works reliably with weaker models (qwen2.5-coder:7b, llama3, mistral-nemo) where OpenAI structured `tool_calls` aren't dependable.
- **5 core tools** with Tierkit policy gates pre-wired:
  - `read_file` — line-numbered output; sensitive-file blocklist enforced
  - `list_files` — recursive option; skips noisy dirs (node_modules, .git, etc.)
  - `search_files` — regex grep with optional glob filter; capped at 200 matches
  - `write_file` — atomic write via tmp+rename; sensitive-file blocklist; approval required
  - `execute_command` — `dangerous-command` classifier gate; 30s timeout; output truncation; approval required
- **Agent loop** (`runAgent`) — async generator yielding `AgentEvent`s (`task_start`, `assistant_text`, `tool_call`, `tool_approval_pending`, `tool_result`, `task_complete`, etc.). Streams cleanly to SSE or UI.
- **`<task_complete>` sentinel** — the model declares completion explicitly; the loop terminates with a summary instead of running forever.
- **Per-tool approval** — destructive tools (`write_file`, `execute_command`) call back to `input.approve(toolCall)` before running. Daemon-side wiring auto-approves for now; UI prompt comes in 0.4.x.
- **Routes through Tierkit daemon** — every model call hits `/v1/openai/chat/completions`, so all Tierkit policy applies (routing, viability, secret redaction, command-gate, budget, sessions, plugin-rule injection, tool-shim).

### `POST /v1/agent/run`

New daemon endpoint. Streams `text/event-stream` with one `AgentEvent` per chunk, terminating with `data: [DONE]`. Request body:

```json
{
  "task": "Find all TODOs in src/ and list them",
  "modelId": "auto",
  "mode": "planner",
  "maxTurns": 25
}
```

Plugged in via the new `routeExtensions` option on `startServer` — `@tierkit/core` doesn't depend on the agent package, the VS Code extension wires them together at runtime.

### `routeExtensions` in `startServer`

New `ServerOptions.routeExtensions` array. Each entry's `handle(req, res, ctx)` is called before built-in routes; returning `true` claims the request. Keeps the core dependency-free while letting higher-level packages plug in new endpoints.

### Tests
371 pass (22 new agent tests covering parser, system prompt, agent loop with mocked model, SSE endpoint round-trip).

### What's not in 0.4.0
- Sidebar chat UI (deferred to 0.4.x) — for now agent is HTTP-only via `/v1/agent/run`
- UI-driven approval (auto-approve in 0.4.0)
- Diff preview for `write_file`
- Plugin-command-as-slash-command native integration (deferred)
- Additional tools (browser, MCP, follow-up question, apply-diff)

### Coexistence with Roo / Cline / Continue
Existing OpenAI-compatible integration is unchanged. You can still configure Roo to route through `/v1/openai/chat/completions` and get all of Tierkit's policy benefits. The agent is an additional capability, not a replacement.

## 0.3.4 — 2026-05-16

**Ollama model auto-discovery — whatever you have pulled, Tierkit uses it.**

### Problem
Bundled defaults pointed at specific model names (`qwen2.5-coder:7b`, `llama3.2:3b`). Users who had completely different Ollama models pulled — gemma, mistral-nemo, deepseek-coder, etc. — got zero viable local profiles out of the box and had to either pull the bundled-default models OR manually configure profiles. Friction wall for first-run.

### Fix
`loadConfig()` now probes Ollama's `/api/tags` (cached for 30s) and synthesizes a profile per chat-capable installed model. Generated profile ids look like `ollama-qwen2-5-coder-7b` (model name sanitized to alphanumeric+hyphen). Source is reported as `"discovered"` so the sidebar can label them differently from bundled/user/workspace.

### Filter rules
- Embedding-only models (name contains `embed`, starts with `nomic-embed`, `bge-`, `snowflake-arctic-embed`) are filtered out — they can't serve `/api/chat`, so including them would just create fallback noise.
- Role tags inferred from name: `code` for `coder`/`code` substrings, `vision` for vision models, `chat` as default.

### Precedence
- Workspace > User > Bundled > **Discovered**
- If a user/workspace/bundled profile has the same id (`ollama-X`) as a discovered one, the explicit profile wins. Discovered profiles only fill gaps.

### Config
`runtime.discoverOllamaModels`: `true` (default) | `false`. Set false if you want a tightly-controlled profile list.
`TIERKIT_NO_DISCOVERY=1` env var for test isolation (test setup uses this).

### Caching
30-second TTL avoids hammering Ollama on every `loadConfig()` call (which happens on every `/v1/llm-call`, route-explain, etc.). Cache invalidates if `baseUrl` changes; `force: true` bypasses for explicit re-probes.

### Tests
349 pass (243 core + 28 client + adapter/cli unchanged). 9 new tests cover: chat-capable discovery, embed filtering, env-var opt-out, network failure → empty, caching, force re-probe, integration with loadConfig source tagging, workspace override, runtime flag disabling.

### Real-world effect
The user from issue threads who had `gemma4:e2b`, `gemma4-26b-fast`, and `qwen2.5:7b-instruct` (none of them in the bundled defaults) now sees three discovered local profiles immediately and Roo Code's `auto` routing picks one without any config.

## 0.3.3 — 2026-05-16

**Tool-shim: weak local models can now drive Roo / Cline / Continue.** Tierkit transparently bridges OpenAI structured tool calling to text-format tool calls (XML tags or JSON-in-content) for models that don't reliably emit `tool_calls`.

### The problem
Coding agents (Roo, Cline, Continue) send OpenAI-format `tools` array and expect `tool_calls` back. But most local Ollama models — even `qwen2.5-coder:7b` — emit the call as TEXT in `content` rather than as a structured `tool_calls` field:

```json
{
  "role": "assistant",
  "content": "{\n  \"name\": \"ask_followup_question\",\n  \"arguments\": {\n    \"question\": \"What's the goal?\"\n  }\n}"
  // ← tool_calls is missing
}
```

Result: caller sees `tool_calls: undefined` and reports "model didn't use any tool". The agent loop breaks.

### The fix
Tierkit now does exactly what Cline / Roo themselves do internally — XML-tag tool calling in the system prompt:

1. **Inbound**: Convert OpenAI `tools` array → XML-tag instructions appended as a system prompt with examples
2. **Outbound to provider**: Strip `tools` from the wire request — the model sees only the natural-language prompt
3. **Inbound from provider**: Parse the model's text response for matching patterns
4. **Outbound to caller**: Return as OpenAI-shape `tool_calls`

Patterns the parser recognizes (whichever the model emits, Tierkit handles):
- XML tags: `<read_file><path>src/foo.ts</path></read_file>`
- Code-fenced JSON: ` ```json {"name": "...", "arguments": {...}} ``` `
- Bare JSON consuming whole content: `{"name": "X", "arguments": {...}}`
- Multiple tool calls in one response (each translated independently)
- JSON-typed XML param values (arrays, numbers, bools) parsed as JSON

### Config
`runtime.toolShim`:
- `"auto"` (default) — apply for local-device profiles only; Anthropic/OpenAI use their native structured tool calling
- `"on"` — force shim for every profile
- `"off"` — never shim, pass `tools` through unmodified

### Compatibility
Caller doesn't see the shim. Roo / Cline / Continue / curl / any OpenAI-compatible client gets a uniform structured response regardless of which path the model took. The original `tools` array stays in `request.tools` for parser bounds checking but isn't sent on the wire when the shim is active.

### Tests
340 pass (234 core + 28 client + adapter/cli unchanged). 9 new tests cover:
- XML extraction with single + multiple tags
- JSON-typed XML param values
- Unknown tool names ignored
- Pure JSON-in-content (the qwen2.5-coder pattern)
- Code-fenced JSON in mixed content
- Arguments emitted as JSON string vs object
- Malformed input ignored
- End-to-end through `/v1/openai/chat/completions` with weak-model simulation

### Result
A user with `qwen2.5-coder:7b` and `superpowers-balanced` plugin enabled can now run real coding tasks through Roo Code with all of Tierkit's policy gates (routing, redaction, command-gate, budget, sessions, plugin rules) applied — entirely on-machine, no API key needed.

## 0.3.2 — 2026-05-16

**Plugin rules now actually influence the model — system-prompt injection on every `/v1/llm-call`.**

### What was missing
Tierkit plugins (`superpowers-balanced`, `-strict`, …) ship with `rules/*.md` files like `plan-approval-gate.md`, `tests-first.md`, `local-first.md`. Before 0.3.2, those rules only made it to the model through **per-tool export** — when you ran `tierkit export roo`, the rules landed in `.roomodes` / `.roo/rules/` and Roo Code used them when building its system prompt.

But the Tierkit daemon's own `/v1/openai/chat/completions` path **didn't inject the rules**. So callers that hit Tierkit directly (Roo via the OpenAI-compatible endpoint, Cline via the same, raw curl, the sidebar) sent plain messages to the model with no Tierkit-defined guidance. Result: weaker tool-use behavior, plugins that "do nothing visible" until you ran an explicit export.

### What changed
Whenever `executeLlmCall` runs, the daemon now:

1. Reads `activePlugins` from `tierkit.config.json`
2. Loads each plugin's manifest + `rules/*.md` files via `PluginLoader`
3. Concatenates the rule contents with section headers per plugin
4. Prepends as a `system` message before any caller-supplied messages

So when you enable `superpowers-balanced`, **every model call** — whether triggered from Roo, Cline, Continue, or curl — gets the balanced workflow rules in its system prompt. Small models (qwen2.5:7b-instruct etc.) follow tool-use guidance much more reliably with the rules present.

### Behavior
- Caller's own `system` messages are **preserved** — Tierkit's plugin rules go first, caller's system messages second, then the conversation.
- Disable per-workspace with `runtime.injectPluginRules: false` (default true).
- No-op when no plugins are active: zero overhead, plain pass-through.

### Tests
331 pass (222 core + 27 client + adapter/cli unchanged). 4 new tests pin: rules prepended; caller system preserved; off-switch works; no-plugins is no-op.

### Why this matters
This is the missing link that makes "one Tierkit plugin = consistent behavior across all your tools" real end-to-end, not just at export time. The combination with 0.3.1 viability pre-flighting and 0.3.0 tool calling means:
- Tierkit picks a viable profile
- Forwards the model's tools
- AND seeds the system prompt with whatever your active plugin tells it to do

Small local models like `qwen2.5-coder:7b` go from "ignores tools, chats" to "follows the plugin's rules, calls tools" with no per-call configuration.

## 0.3.1 — 2026-05-16

**Auto-route now pre-flights candidates — skips Ollama profiles whose model isn't pulled, skips remote profiles whose API key isn't set.**

### What changed
Auto-route in 0.3.0 walked the candidate list and tried each until one succeeded. That worked, but it burned a full HTTP round-trip per non-viable candidate before the fallback kicked in. The common case was painful: bundled defaults `localCoder` (qwen2.5-coder:7b) and `localFast` (llama3.2:3b) both fail with 404 on a fresh Ollama install — three retries before reaching a user-added profile that actually works.

0.3.1 adds a **cheap viability probe** that runs before the fallback chain:
- **Ollama**: hit `{baseUrl}/api/tags` once, check if the profile's model is in the installed list (matches exact OR prefix with `:tag`)
- **Anthropic / OpenAI / public-cloud**: check the `apiKeyEnv` env var is set

The probes run in parallel and time out at 1.5s. Then auto-route filters: **if any candidate is viable, drop the non-viable ones entirely**. If none are viable (e.g., Ollama is down), keep them all so the user still sees the informative provider error.

### Real-world effect
On a Mac with only `qwen2.5:7b-instruct` installed and a user-added profile pointing at it:

```
Before 0.3.1:                    After 0.3.1:
auto → localCoder (qwen2.5-coder:7b)  auto → viability probe (one /api/tags call)
       → 404 (~80ms)                         → finds: ghostCoder ✗, ghostFast ✗, myCoder ✓
auto → localFast (llama3.2:3b)             → use myCoder directly
       → 404 (~80ms)
auto → myCoder (qwen2.5:7b-instruct)
       → success
       
Total: ~250ms of wasted retries      Total: ~50ms probe, no wasted retries
```

### Internals
- New `model/profileViability.ts`: `checkProfileViability(profile, env)` + `partitionByViability(candidates, resolveProfile, env)`
- 7 unit tests (mocked fetch) covering: env-var presence, /api/tags exact + prefix match, unreachable Ollama, model-not-installed
- 1 integration test via the HTTP daemon: confirms an unviable Ollama profile is silently skipped and a viable mock profile is chosen

### Build
327 tests pass (218 core + 27 client + adapter/cli totals unchanged).

## 0.3.0 — 2026-05-16

**Tool calling. Roo Code, Cline, Continue, and other agentic clients now actually work through Tierkit.**

This is the last big missing piece. Earlier versions could proxy plain chat messages, but the moment a coding agent sent a `tools` array (which they all do — they need read_file / edit_file / shell_exec etc. to function as agents), Tierkit dropped it and returned plain text. The agent would then complain "model didn't use any tool" and fail.

0.3.0 adds full tool-call passthrough in both directions, end-to-end.

### What it does

**Inbound** (from Roo / Cline / Continue → Tierkit):
- `tools` array on the request — forwarded to the underlying provider
- `tool_choice` (`auto` / `none` / `required` / `{type:"function", function:{name}}`) — forwarded
- Multi-turn conversations with `assistant` messages carrying `tool_calls` and `tool` messages carrying `tool_call_id` — accepted and forwarded

**Outbound** (Tierkit → caller):
- When the model requests tool invocations, Tierkit surfaces them as OpenAI-shape `tool_calls` on the assistant message
- `finish_reason: "tool_calls"` set appropriately
- `content` is `null` when the model only emitted tool_calls (per OpenAI's contract); a plain string otherwise

### Provider support
- **Ollama** (0.4+) — uses native `tools` parameter on `/api/chat`; OpenAI-format tool_calls returned. Models like `qwen2.5-coder:7b`, `llama3.2`, `mistral-nemo`, etc. work out of the box.
- **OpenAI / OpenAI-compatible** — passthrough, including SSE streaming with tool-call delta reassembly.
- **Anthropic** — full conversion in both directions:
  - OpenAI `tools` → Anthropic `tools` (renaming `parameters` → `input_schema`)
  - Anthropic `tool_use` blocks → OpenAI `tool_calls` 
  - OpenAI `role: "tool"` messages → Anthropic `user` messages with `tool_result` content blocks
  - Streaming `tool_use` events accumulated via `input_json_delta` then emitted as complete `tool_call`s

### Result
- Roo Code can now read your code, edit files, run commands — all through Tierkit's policy stack (routing, redaction, command-gate, budget, sessions).
- Same for Cline, Continue, aider, or any OpenAI-compatible client.
- 5 new round-trip tests (319 total).

### Verified
With Mac terminal + the daemon running, the exact request shape Roo sends:
```json
{
  "model": "auto",
  "messages": [{"role":"user","content":[{"type":"text","text":"list files in src"}]}],
  "tools": [{"type":"function","function":{"name":"read_file",...}}]
}
```
returns:
```json
{
  "choices": [{
    "message": { "role": "assistant", "content": null, "tool_calls": [{"id":"...", "type":"function", "function":{"name":"read_file","arguments":"{}"}}] },
    "finish_reason": "tool_calls"
  }]
}
```
which is exactly what Roo expects to drive its agent loop.

## 0.2.3 — 2026-05-16

**Fix: Roo Code (and any OpenAI-compatible client using the multimodal message format) now works.**

### What broke
Roo Code 3.x sends `message.content` as an array of content parts:
```json
{ "role": "user", "content": [{ "type": "text", "text": "hi" }] }
```
This is OpenAI's newer multimodal format (used so clients can mix text, images, tool results, etc. in a single message). Tierkit's `/v1/openai/chat/completions` handler was checking `typeof content !== "string"` and rejecting any non-string with `400: each message.content must be a string`. So every Roo Code call failed before reaching the model.

### Fix
The handler now flattens array content into a plain string:
- Text parts (`{ type: "text", text }`) — concatenated with newlines
- Tool result parts (`{ type: "tool_result", content }`) — included as text
- Image / audio / tool_use parts — silently dropped (Tierkit's underlying providers don't all support multimodal; safe default is "ignore unknown parts so the text portion still gets through")

Plain string content still works (full backward compatibility).

### Verified end-to-end
Three scenarios pass on Mac with Ollama + auto-route:
1. Array content (Roo format) → ✓ response
2. Mixed array (text + image_url dropped) → ✓ response with image portion ignored
3. Plain string (legacy) → ✓ response

After upgrading, Roo Code on either Windows or Mac should send a task and get a real answer, with the call appearing in Tierkit's "Recent activity" card.

## 0.2.2 — 2026-05-16

**Auto-route now falls back to the next-best profile on transient failures.**

### What changed

Previously, `model: "auto"` (or unspecified, which Roo/Cline/Continue send by default) picked exactly one profile and gave up if that profile couldn't be used right now. So if a user had Tierkit's default `localCoder` profile pointing at `qwen2.5-coder:7b` but hadn't pulled that model yet, every `auto` call failed with `bad-status` (Ollama's 404 for "model not found"), even when other usable profiles existed in the same tier.

Now `auto` walks the ordered candidate list for the chosen tier and tries each in sequence on **transient** failures:
- `unreachable` — provider isn't reachable (Ollama not running, OpenAI 500, etc.)
- `bad-status` — provider responded with a non-2xx (model not pulled, deprecated model id)
- `missing-api-key` — this profile's env var isn't set; another profile's might be
- `not-implemented` / `network-error` / `timeout` — same idea

**Policy failures are never fallback-able** — those are intentional refusals, not transient problems:
- `dangerous-command-blocked`, `plan-not-approved` (workflow gate)
- `budget-exceeded` (budget gate)
- `unknown-profile` (config issue — retry won't help)

The response's `tierkit.fallback` field surfaces what was attempted before success:

```json
{
  "tierkit": {
    "profileId": "workingLocal",
    "fallback": {
      "attempts": [{ "profileId": "fakeFirst", "code": "bad-status" }],
      "chosen": "workingLocal"
    }
  }
}
```

When all candidates fail, the error includes the full trail:
```
"ollama responded with 404 Not Found (tried 3: localCoder=bad-status, localFast=bad-status, last=bad-status)"
```

### Why
First-run users see this exact scenario constantly: bundled defaults expect certain Ollama models that may not be pulled, certain env vars that may not be set. Hard failure on the first try defeated the "zero-config first-run" promise from 0.1.6. Now the user gets a real answer from whichever profile happens to be usable right now.

### Scope
- Non-streaming path (`POST /v1/openai/chat/completions` without `stream: true`) — full fallback.
- Streaming path — only tries the primary pick (mid-stream switching is hairy; future improvement).
- Explicit `model: "claudeSonnet"` (non-auto) — no fallback (you asked for a specific profile, you get that profile or its error).

## 0.2.1 — 2026-05-16

**Sidebar redesign: Mission Control.** No more chat input — Tierkit is a routing/policy layer that sits behind Roo Code / Cline / Continue, not an agent itself. The sidebar now reflects that identity.

### What's new

The sidebar is a 5-card dashboard:

1. **Connected tools** — Roo, Cline, Continue with status (`detected` / `routed to Tierkit`). One-click [Connect] button per tool runs the equivalent of `tierkit connect <tool>` and writes the config file.
2. **Active plugins** — toggle Enable / Disable inline. Each toggle auto-runs `tierkit plugin sync` so the change propagates to every connected tool. **+ New** scaffolds a plugin in the workspace.
3. **Recent activity** — auto-refreshing every 5s, showing the last ~12 model calls Tierkit handled. You see Roo's calls appear in real time as you use Roo.
4. **Today's usage** — call / token / cost totals + per-profile breakdown.
5. **Model profiles** — every profile with source (bundled / user / workspace) + inline [test] button. **+ Add** opens an inline form.

Plus a **Sync plugins** button in the Connected-tools card and global ↻ in the top bar.

### Why
Earlier versions had a chat input in the sidebar which conflated Tierkit (policy layer) with the agent's job (chat + tool use). Real coding happens in Roo / Cline / Continue / etc. — Tierkit's sidebar should be a control panel for monitoring + configuration, like a server admin UI. Mission Control is that.

### Daemon
- New `GET /v1/connections` — reports each tool's detection + Tierkit-routing status.
- New `POST /v1/plugins/enable` + `POST /v1/plugins/disable` — sidebar toggles use these; both auto-trigger sync.
- `@tierkit/client` SDK gains `connections()`, `pluginEnable()`, `pluginDisable()`.

### Migration
Slash commands (`/connect`, `/profile add`, etc.) are no longer in the sidebar — they're replaced by inline buttons. The CLI mirrors (`tierkit connect roo`, `tierkit plugin enable …`) still work the same. If you scripted against the chat input, switch to the CLI or the HTTP endpoints.

## 0.2.0 — 2026-05-16

**Connect any agent. Author your own plugins. One plugin → every tool.**

This is the milestone that delivers the original Tierkit promise: one plugin format runs everywhere — Tierkit itself (via the sidebar), Roo Code, Cline, Continue, or anything else that speaks OpenAI-compatible.

### New: OpenAI-compatible endpoint

`POST /v1/openai/chat/completions` and `POST /v1/chat/completions` accept standard OpenAI Chat Completions requests. The `model` field is your Tierkit profile id (`localCoder` / `claudeSonnet` / etc.) or the magic value `auto` for risk-based auto-routing.

This means **any tool that supports OpenAI-compatible custom endpoints can route through Tierkit** and inherit:
- Tier-based routing (local / private-remote / public-cloud)
- Secret redaction before remote calls
- Dangerous-command classifier
- Budget enforcement
- Workflow session gate (plan-approval / freedom levels)
- Usage log

Streaming (`stream: true`) returns SSE chunks in OpenAI's `chat.completion.chunk` format.

### New: `tierkit connect <tool>`

One command wires an existing agent to route through Tierkit:
- `tierkit connect roo` — writes `.vscode/settings.json` so Roo Code uses Tierkit as its OpenAI-compatible endpoint
- `tierkit connect cline` — same for Cline
- `tierkit connect continue` — writes a Tierkit-routed model entry to `.continue/config.yaml`

Idempotent (safe to re-run), preserves any other settings already in those files.

### New: `tierkit plugin sync`

Re-exports active Tierkit plugins to every detected tool. Runs **automatically on `plugin enable/disable`** so plugin activation propagates without an explicit step. Detection is filesystem-based: `.roomodes` / `.roo` → Roo; `.clinerules/` → Cline; `.continue/` → Continue.

### New: `tierkit plugin new <id>`

Scaffolds a complete plugin directory with manifest + sample command + sample mode + sample rule. Ready to install + enable + sync.

```sh
tierkit plugin new my-team-rules
tierkit plugin install ./my-team-rules
tierkit plugin enable my-team-rules    # auto-syncs to all connected tools
```

### New sidebar slash commands

- `/connect roo` · `/connect cline` · `/connect continue`
- `/plugin sync`
- `/plugin new <id>`

Plus the regular `/init`, `/models`, `/profile add`, etc. from 0.1.6.

### Daemon endpoints (new)

- `POST /v1/openai/chat/completions` · `POST /v1/chat/completions` — OpenAI-compatible chat
- `POST /v1/connect` — wire an external tool to route through Tierkit
- `POST /v1/plugins/sync` — re-export plugins to detected tools
- `POST /v1/plugins/new` — scaffold a new plugin

### `@tierkit/client` SDK

New methods: `connectTool`, `pluginsSync`, `pluginNew`.

### Tests

314 tests pass (211 core + 21 client + 15+15+19 adapters + 31 CLI + 0 vscode). 16 new tests for connect / sync / plugin-new / OpenAI-compatible endpoint.

## 0.1.8 — 2026-05-16

Fix: model responses now actually render in the chat thread.

### What broke in 0.1.6 – 0.1.7
The chat UI read `d.content` and `d.usage.inputTokens` from the `/v1/llm-call` response. The daemon's actual response shape is flat — `{ ok, text, inputTokens, outputTokens, costUsd, latencyMs, ... }`. So calls succeeded (latency + routing card showed up), but the assistant text rendered empty and the token counts were missing from the meta line.

### Fix
GUI now reads `d.text` and the flat token/cost fields. The chat thread renders the actual model output.

## 0.1.7 — 2026-05-16

Fix: bundled default profiles now usable without a workspace `tierkit.config.json`.

### What broke in 0.1.6
After 0.1.6 shipped 6 bundled default profiles, sending a task to one (e.g., `claudeSonnet`) in a folder with no `tierkit.config.json` returned `no-config: no tierkit.config.json found; run \`tierkit init\` first`. That error predated the 3-tier config layering — it required a workspace config file to exist before any model call would proceed. With bundled defaults that requirement is wrong.

### Fix
Removed the `cfg.found` precondition from `executeLlmCall`, `runRoute`, and `testModel`. The canonical error is now `unknown-profile` when a profile id has no match across any of the three config layers (bundled, user, workspace). `plugin enable/disable/remove` still require a workspace config because plugin tracking is per-project — those error paths are unchanged.

## 0.1.6 — 2026-05-16

Zero-config first-run: bundled defaults, 3-tier config, in-product profile management, and Ollama auto-launch.

### Features

**Bundled default model profiles**
- Six templates ship with Tierkit core and show up in `/models` immediately, no JSON editing required: `localCoder` / `localFast` (Ollama), `claudeSonnet` / `claudeHaiku` (Anthropic), `gpt4o` / `gpt4oMini` (OpenAI).
- Each profile becomes usable when its prerequisite is satisfied (env var set or Ollama installed). `/test <profileId>` reports readiness without spending tokens.

**3-tier config layering** (low → high)
1. Bundled defaults (shipped in `@tierkit/core`)
2. User-level: `~/.tierkit/config.json` (set once, shared across folders)
3. Workspace-level: `./tierkit.config.json` (overrides for this project)

A profile in a higher layer overrides one with the same id in a lower layer. Setting a profile id to `null` in user or workspace config suppresses the bundled default. `/models` now shows a `source` column (`bundled` / `user` / `workspace`).

**`/profile add` wizard in the sidebar**
- Inline multi-step card: pick provider → fill model + id → choose scope → Save.
- Posts to `POST /v1/config/profile` and refreshes the sidebar profile dropdown automatically.
- Korean fully localized.

**`Tierkit: Add model profile` VS Code command**
- Native QuickPick + InputBox flow for VS Code users who prefer the platform's native dropdowns.
- Same backend endpoint as the sidebar wizard — both UIs are pure clients.

**`/init` slash command** scaffolds `tierkit.config.json` + `.tierkit/plugins.json` in the active workspace via `POST /v1/config/init`.

**`tierkit profile add` / `tierkit profile remove` CLI commands**
- Headless mirror of the wizard. Useful for scripts, CI, and dotfile setups.
- `--scope user` writes to `~/.tierkit/config.json`; default is workspace.

**Ollama auto-launch + auto-shutdown**
- When a call to an Ollama-backed profile hits connection-refused, Tierkit shells out to `ollama serve` and retries once. If Ollama was already running (system service, tray app), Tierkit leaves it alone.
- When the Tierkit daemon shuts down — which on the VS Code extension means when VS Code closes — any Ollama instance Tierkit started goes with it. Pre-existing Ollama installs are never killed.

### Internal
- New `POST /v1/config/profile`, `DELETE /v1/config/profile/:id`, `POST /v1/config/init` daemon endpoints.
- `@tierkit/client` gains `configAddProfile`, `configRemoveProfile`, `configInit`.
- `listModels` response now includes `source`, `configPath`, `userConfigPath`.
- 13 new tests (config layering + profile CRUD). Total: 198 tests.

## 0.1.5 — 2026-05-15

**Actual fix for "Daemon unreachable" in the webview.**

The 0.1.4 portMapping work was on the right track but not the actual cause. The real blocker (visible in the webview's DevTools console) was **CORS**: the VS Code webview runs at origin `vscode-webview://<id>` and treats `http://localhost:4101` as cross-origin. Without `Access-Control-Allow-Origin` on responses, the browser blocked every fetch *before it left the page*.

### Fix
Tierkit daemon (`@tierkit/core` `Server.ts`) now sets standard CORS headers on every response and answers OPTIONS preflights with 204:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, OPTIONS`
- `Access-Control-Allow-Headers: content-type, authorization`

Daemon is still bound to `127.0.0.1` (loopback only) so the wildcard ACAO doesn't widen the attack surface — anything that can already reach the daemon is already on the same machine.

The 0.1.4 portMapping + localhost rewrite is kept (the right pattern for Remote-SSH / Codespaces scenarios), but the CORS fix is what actually unblocks the webview on local desktop.

## 0.1.4 — 2026-05-15

**Windows fix: webview can now actually reach the daemon.**

### What broke (0.1.0 – 0.1.3 on Windows)
Even after auto-start succeeded and the daemon was confirmed listening at `http://127.0.0.1:4101` (verified by opening that URL in a regular browser on the same machine), the sidebar webview kept showing "offline" / "Failed to fetch" for every fetch. Cause: VS Code webviews on Windows can run inside a sandboxed network namespace (UWP AppContainer if installed from Microsoft Store, or under some AV/enterprise security configurations) where the webview iframe is blocked from making HTTP requests to `127.0.0.1`, while the extension host (Node.js) is fully allowed.

### Fix
Use VS Code's [`portMapping`](https://code.visualstudio.com/api/references/vscode-api#WebviewOptions) — the canonical mechanism for exactly this scenario. With portMapping configured, the webview's fetch to `http://localhost:<port>` is routed by VS Code itself to `localhost:<port>` on the extension host machine, completely bypassing the webview's own network sandbox. The webview's base URL now uses `localhost` (required for the mapping to match) instead of `127.0.0.1`.

Works on all platforms — no Windows-only branch.

## 0.1.3 — 2026-05-15

**Sidebar redesign — Claude Code style.** The dashboard is now a single conversation thread with a bottom input box and slash commands, instead of 6 separate control-panel cards.

### What changed

- **Conversation thread** — type a task, see the answer streamed in line. No more clicking between Run / Models / Usage / Session tabs.
- **Slash commands** replace the per-card UI:
  - `/help` — list all commands
  - `/models` · `/test <id>` — list / probe model profiles
  - `/route <task>` — show routing decision without running it
  - `/usage` — per-profile call / token / cost summary
  - `/session [start <task>|approve|advance <state>|abandon]` — drive workflow sessions inline
  - `/check command|path|redact <input>` — secret-redaction · command-classifier · sensitive-path checks
  - `/profile <id|auto>` · `/mode execute|plan|review` — change routing target on the fly
  - `/clear` — clear the conversation
- **Auto-routing** — selecting profile `auto-route` in the dropdown below the input sends each task through `POST /v1/route` first, then `POST /v1/llm-call` with the chosen profile. The routing decision is shown inline.
- **Pickers below the input** (Claude Code-like): profile + mode dropdowns sit under the textarea, not as a separate panel. Selection is persisted in `localStorage`.
- **Enter to send, Shift+Enter for newline.**

### Why
Previous dashboard exposed every daemon capability as a top-level panel — useful for "what can Tierkit do?" demos but bad for daily use, where the only flow that matters is *type task → see answer*. Slash commands keep the secondary features one keystroke away (`/`) without competing for screen space with the conversation.

The browser GUI at `http://127.0.0.1:4101/` gets the same redesign because both contexts share the same `GUI_HTML`.

## 0.1.2 — 2026-05-15

Diagnostics for the "Daemon unreachable: Failed to fetch" case (especially on Windows).

### Features

**Diagnostic Output channel**
- New "Tierkit" Output channel logs every step of `maybeStartDaemon`: VS Code version, Node version, workspace folders, configured baseUrl, existing-daemon probe, port-binding attempts, fallback to port 0, and the full stack of any failure.
- New command **`Tierkit: Show diagnostic output`** opens it from anywhere.
- When auto-start fails, the warning toast now has an **Open output** button.

**Restart daemon command**
- New command **`Tierkit: Restart daemon`** closes the in-process server (if any) and re-runs auto-start. Useful after opening a folder, changing `tierkit.config.json`, or unblocking a port.

**In-sidebar daemon banner**
- When the host (VS Code) flags an auto-start failure, the sidebar shows a clearly worded banner at the top with two buttons: **진단 로그 열기 / Show output** and **데몬 재시작 / Restart daemon**. No more hunting through 5 separate "Failed to fetch" messages.

### Why this matters
The sidebar previously gave 5 identical "Failed to fetch" errors when the daemon didn't start, with no clue why. On Windows in particular, common silent-failure modes are: no workspace folder open, port 4101 inside Hyper-V's reserved port range, AV blocking `node:http.listen`, or a missing `tierkit.config.json`. The new Output channel surfaces the exact failure so it can actually be fixed.

## 0.1.1 — 2026-05-15

Zero-config first run + Korean localization.

### Features

**Auto-start daemon**
- On extension activation the runtime daemon now starts **in-process** at the configured `tierkit.baseUrl` (default `http://127.0.0.1:4101`). No more `Daemon unreachable: Failed to fetch` on first install.
- If something else already owns port 4101, Tierkit transparently falls back to an OS-chosen port and the sidebar uses that base URL automatically.
- If a Tierkit daemon is already running (e.g., you ran `tierkit runtime start` in a terminal), the extension reuses it instead of starting a second one.
- Opt out with `tierkit.autoStartDaemon: false` if you prefer to manage the daemon yourself.

**Korean localization (한글화)**
- Command palette titles, configuration descriptions, and runtime messages are now translated via VS Code's standard `package.nls.*.json` + `l10n/bundle.l10n.*.json` mechanism — VS Code picks the locale automatically.
- The embedded sidebar dashboard (and the GUI served at `http://127.0.0.1:4101/`) localizes labels, placeholders, tooltips, and inline status text based on `navigator.language`. Browsers/VS Code instances set to `ko*` get Korean; everything else stays English.

### Configuration

```jsonc
// .vscode/settings.json
{
  "tierkit.baseUrl":         "http://127.0.0.1:4101",
  "tierkit.statusBar":       true,
  "tierkit.autoStartDaemon": true
}
```

## 0.1.0 — 2026-05-15

Initial sideload release. Not yet on the VS Code Marketplace.

### Features

**Sidebar dashboard** (the main reason to install this extension)
- Activity bar entry **Tierkit** with a three-stacked-tiers icon.
- A webview view (`tierkit.sidebar`) that embeds the same GUI the daemon serves at `http://127.0.0.1:4101/` — no separate browser tab needed.
- Reloads when `tierkit.baseUrl` changes; preserves state when you flip to another sidebar.

What you can do in the sidebar:
- See daemon health + effective freedom at a glance.
- Run a task — pick profile, choose `execute` / `plan` / `review` mode, see the response inline.
- Drive a workflow session (start / approve plan / advance / abandon) with the appropriate buttons for the current state.
- **Security check** card with three tabs:
  - **Redact** — paste text, see which secret patterns hit and the redacted output.
  - **Command** — classify a shell command (`block` / `warn` / `ok`) with matched-rule details.
  - **Path** — check if a file path matches the sensitive-file blocklist.
- **Models** table with a `Test` button per row — probes the provider for reachability + model availability without paying for tokens.
- Usage summary (calls / tokens / cost), per-profile breakdown.

**Status bar + command palette** (unchanged)
- Status bar item polls `GET /v1/health` every 30s.
- Command palette: health, route explain, route run, classify command, usage, session status (now points to the sidebar), and `Tierkit: Focus dashboard sidebar` to open the dashboard from anywhere.

### Configuration

```jsonc
// .vscode/settings.json
{
  "tierkit.baseUrl": "http://127.0.0.1:4101",
  "tierkit.statusBar": true
}
```

### Known limitations
- `routeRun` palette command still requires an explicit profile id (sidebar already routes through `/v1/llm-call`, so use the sidebar Run panel for the smoothest path).
- The Run panel renders the response in one chunk because `/v1/llm-call` currently returns a single JSON after the upstream stream completes. A future `/v1/llm-call/stream` endpoint will give live token-by-token output without changing the sidebar UI.
- No `.vsix` integration tests against the VS Code Extension Development Host yet.
