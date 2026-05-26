# Changelog

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

## 0.17.0 — 2026-05-22

### Track A — Telemetry completion

- **Fixed: streaming chat (`/v1/openai/chat/completions` with `stream: true`)
  now appends a `UsageRecord` to `usage.jsonl` on stream end.** This was the
  root cause of `claudeCode` never appearing in the activity panel — every
  GUI chat call streams, and the streaming path silently skipped logging.
  Aborted streams write `ok: false, failureCode: "stream-aborted"` so users
  see the call happened even if it didn't complete. Provider error events
  (e.g. `cli-exit-nonzero`) write the event's code as `failureCode`.
- **New: Savings card switches from compression-only to routing-based.**
  Today's local-device calls × baseline-profile cost = "Cloud tokens saved"
  and "Estimated cost saved", polled every 5s. The baseline is configurable
  via the new optional `routingBaseline` field in `tierkit.config.json`
  (default `"claudeCode"`). When the baseline can't be priced (profile
  missing or no `cost` block), the card shows `—` values plus a hint
  pointing at the config key.
- **New: `usage.jsonl` auto in-place trim.** When the file exceeds 10 MB,
  the next `appendUsage` call trims it down to ~5 MB, keeping the most
  recent entries. Heterogeneous-shape safe: MCP-tool records (`type: "mcp-tool"`)
  and LLM-call records can coexist; the trim doesn't distinguish.

### Track B — GUI per-tool envelope rendering

- **Replaced raw JSON dumps with per-tool views.** `read_file` shows a
  line-numbered code block plus truncation banner; `list_files` shows a
  file/dir icon tree; `search_files` / `codebase_search` shows match
  snippets with the query `<mark>`-highlighted; `run_command` shows
  terminal-style stdout/stderr with an exit-code badge.
- **Generic failure card with hint table.** Every envelope failure now
  renders with a red error-code badge and a hint pulled from a 16-entry
  table covering all v0.17 error codes (`stale-cursor`, `payload-corrupt`,
  `approval-required`, `command-blocked`, etc.).
- **`[Copy cursor]` button** on truncated results copies the opaque cursor
  to clipboard. (`[▶ Continue]` one-click pagination deferred to v0.17.1 —
  Tierkit core has no general-purpose `POST /v1/tool-call` endpoint.)
- **No syntax highlighting library** in v0.17; code blocks use simple
  monospace + line numbers. v0.17.1 candidate if users ask.
- **Dispatch covers both naming schemes.** The same renderer handles
  Agent-side names (`read_file`, `search_files`, ...) and the MCP-bridge
  names (`tierkit.read_file`, `tierkit.codebase_search`, ...) so MCP tool
  results coming through the agent loop render identically.

### Track C — Windows hardening + cross-OS CI

- **New: `.github/workflows/ci.yml`** runs `pnpm build` + `pnpm test`
  on `ubuntu-latest`, `macos-latest`, AND `windows-latest` for every PR
  and push to `main`. `fail-fast: false` so a Windows-only failure
  doesn't mask Linux feedback.
- **`runChild()` Windows quoting.** New `quoteForWindowsShell()` helper
  wraps `transport.command` and args in cmd.exe-friendly form when
  `shell: true` on Windows. Handles spaces in paths (e.g.,
  `C:\Program Files\Node\node.exe`), pipes, ampersands, and embedded
  quotes. macOS/Linux passthrough unchanged.
- **Junction-point test fixture** verifies `fs.realpathSync` resolves
  Windows reparse points so `workspaceBoundary` catches escapes via
  junctions. Test runs only on Windows; skipped on macOS/Linux.
- **`tierkit doctor`** emits a `warn` check when any subscription-CLI
  profile's `transport.command` contains spaces.

### Track D — Tidy

- **MCP server advertises `TIERKIT_VERSION`** instead of literal `"0.15.0"`,
  so `initialize.serverInfo.version` agrees with `package.json` on every
  release.
- **`docs/MCP_BRIDGE.md` rewritten** for the v0.16 envelope shape with
  a concrete example per tool and a v0.17 error-code table.
- **`read_file` returns `stale-cursor`** (not `not-found`) when the file
  behind a cursor was deleted between issue and reuse. More informative
  for both Agent and MCP callers — `not-found` is now reserved for paths
  that never existed.

### Pre-existing known issue (not introduced by v0.17)

- `@tierkit/client/openaiCompat.test.ts:75` expects HTTP 400 but receives
  404 for unknown profile id. Present at the v0.15.0 baseline before
  any v0.16/v0.17 work. Tracked as a separate followup.

## 0.16.0 — 2026-05-22

### Track A — Windows unlock

- **Fixed `Failed to fetch` on the MCP "Show config snippet" button** in the
  VS Code sidebar. The handler was using raw `fetch()`, which resolves
  against the webview's origin in VS Code rather than the daemon loopback.
  Now uses the same `jget()` transport abstraction as the rest of the GUI.
- **Subscription CLI + viability probe now resolve `.cmd` shims on Windows.**
  A new shared `runChild()` helper uses `shell: process.platform === "win32"`
  so npm-installed CLIs like `claude.cmd` resolve via `PATHEXT`. macOS/Linux
  preserve the v0.15 direct-spawn behavior to avoid quoting/escaping changes.
- **Subscription CLI now propagates caller-supplied env to the child.** The
  `_env` parameter (previously dropped) is now merged onto `process.env` via
  a `mergeEnv()` helper that strips `undefined` values to avoid the literal
  `"undefined"` string leaking into the child env.

### Track B — Tool Result Envelope

**BREAKING for direct MCP/tool-result consumers:** Long-output tools now
return a structured JSON envelope (`tool-result-envelope.v1`) instead of
ad-hoc JSON/text payloads. Agents should inspect `truncated` and
`next.suggestedCall` to continue past truncation. Affected tools:

| Layer | Tool |
|---|---|
| Tierkit Agent | `read_file`, `list_files`, `search_files`, `execute_command` |
| MCP Bridge | `tierkit.read_file`, `tierkit.list_files`, `tierkit.codebase_search`, `tierkit.run_command` |

Envelope shape:

```json
{
  "ok": true,
  "tool": "read_file",
  "version": "tool-result-envelope.v1",
  "data": { "path": "src/foo.ts", "content": "..." },
  "truncated": true,
  "range": { "startLine": 1, "endLine": 300 },
  "size": { "linesReturned": 300, "totalLines": 900, "remainingLines": 600 },
  "next": {
    "cursor": "<opaque base64url>",
    "suggestedCall": { "tool": "read_file", "args": { "cursor": "<same>" } }
  }
}
```

- **`read_file` gains `startLine`, `maxLines`, `cursor` args.** Default
  `maxLines: 300`, hard cap 1000. When `cursor` is present, it is the
  source of truth — other args are ignored. Cursor is base64url-encoded JSON
  including the issuing-time `fileHash`; if the file changes between issue
  and use, the tool returns `stale-cursor`.
- **`run_command` envelope omits `next.cursor`** — command output is not
  deterministic continuation. Surfaces `warnings` and stream-prefixed
  `size.stdoutBytesReturned` / `size.stderrBytesReturned` /
  `size.stdoutTruncated` / `size.stderrTruncated` fields instead.
- **`search_files` warns on broad patterns** like `.*` with a hint to use
  `read_file` with a startLine cursor instead.

### Track C — Timeout policy

- **`claudeCode.timeoutMs` default 180_000 → 300_000** (5 min). Windows
  subprocess startup + Claude Code's first-call auth can exceed 3 min.
- **`tierkit doctor` surfaces a hint** when `.tierkit/runtime/usage.jsonl`
  contains recent `cli-timeout` entries, with a pointer to
  `docs/MODEL_PROFILES.md` for per-profile tuning.

### Out of scope (deferred)

- `read_command_output` tool for paginating subprocess output — v0.16.1.
- Windows CI runner — v0.17.
- HMAC-signed cursors — v0.17 if needed.
- Additional cleanup around subscription CLI process handling beyond
  v0.16's `runChild()` Windows-unlock helper — v0.16.1 if needed.

---

## 0.15.0 — 2026-05-21

### Added — Tierkit MCP Bridge

- **New package `@tierkit/mcp-server`** plus CLI command `tierkit mcp serve
  --workspace <path>`. Spawned by Claude Code / Claude Desktop / any MCP-aware
  client via standard `mcpServers` stdio transport. Implements 7 gated tools:
  `tierkit.list_files`, `tierkit.read_file`, `tierkit.codebase_search`,
  `tierkit.propose_patch`, `tierkit.apply_patch`, `tierkit.run_command`,
  `tierkit.get_policy_status`.
- **Ephemeral patch ticket model.** `propose_patch` never mutates files;
  persists ticket to `.tierkit/runtime/mcp/patches/<id>.json` with risk
  scoring, beforeHash for freshness, payload sidecar at `<id>.payload/f<i>.txt`,
  24h TTL. `apply_patch` accepts ONLY `patchId`, runs freshness + approval
  gates, sha256-verifies each payload against the ticket's afterHash before
  writing, then applies atomically. Raw `write_file` and raw-diff
  `apply_patch` are not exposed.
- **patchStore lives in `@tierkit/core`** so the CLI, the HTTP daemon, and
  the MCP-server stdio process can all read/write the same on-disk state
  without a circular dependency.
- **State-guarded approve/reject.** `approvePatchTicket` / `rejectPatchTicket`
  helpers refuse transitions on already-applied / expired / rejected tickets;
  CLI exits 1 and HTTP returns 409 with the same `InvalidPatchStateError`
  message.
- **Daemon-optional approval channels.** `tierkit mcp patch {approve,reject,list}`
  CLI commands manipulate the same ticket store as the daemon's
  `POST /v1/mcp/patches/:id/{approve,reject}` endpoints. The MCP server
  works without a running daemon; the daemon is convenience only.
- **Activity log.** Every MCP tool call appends one JSONL line to
  `.tierkit/runtime/usage.jsonl` (tool name, ok, code, durationMs,
  redactionHits, sanitized input/output summary). Audit trail does not
  include file bodies, env values, or full command lines.
- **GUI integration.** New "Connect Claude Code (MCP)" card in the
  onboarding panel surfaces the suggested `mcpServers` JSON for the current
  workspace. New "Pending MCP patches" card lists tickets and exposes
  approve/reject buttons.
- **`GET /v1/mcp/config`** returns the suggested `mcpServers` JSON with
  `type: "stdio"`.
- **Path-level secret filter.** `list_files`, `read_file`, and
  `codebase_search` apply a hard denylist (`.env*`, `*.pem`, `*.key`,
  `id_rsa*`, `secrets.json`, `.tierkit/runtime/`) in addition to content
  redaction. Denylisted paths are refused for read_file and dropped from
  list/search output.
- **`run_command` sandboxing.** `cwd` locked to workspace, env allowlist
  (no Anthropic/OpenAI keys passed through), 60s default timeout (max 600s),
  1MB stdout / 256KB stderr caps, stdout/stderr piped through redaction.
  v0.15.0 classifies non-safe non-blocked commands as `approval-required`
  and **does NOT execute them through MCP** — command-ticket flow lands in
  v0.15.1.

### Decided not to do (v0.14.2 spike outcome)

- Claude Agent SDK is **not** integrated as a ProviderClient. The spike
  ([`2026-05-21-claude-agent-sdk-spike.md`](docs/superpowers/spikes/2026-05-21-claude-agent-sdk-spike.md))
  found that Path A is architecturally infeasible (the SDK is a Claude-CLI
  subprocess orchestrator, not a pure model client) and Path B would weaken
  Tierkit's redaction guarantee. The MCP Bridge is the chosen pivot: Claude
  remains the agent; Tierkit becomes the gated tool gateway.

## 0.14.2 — 2026-05-21

### Fixed — AgentLoop ↔ subscription-CLI mismatch

- **Subscription-CLI providers (claudeCode) now run in single-shot mode
  inside Tierkit's agent loop.** When the selected profile has
  `transport.type === "subprocess"`, the loop emits the response text once
  and ends — no XML tool parsing, no recursive tool invocation. Previously
  the agent parsed claudeCode's narrative ("first I'll `<list_files>`...")
  as a tool call, executed it, then re-invoked claudeCode with the
  accumulated history. Because claudeCode has no memory across subprocess
  calls it emitted the same `<list_files>` text again — infinite loop.
- **Subscription-CLI timeouts surface as explicit errors** with code
  `subscription-cli-timeout`. No silent auto-fallback to a weak local
  model after a long-running claudeCode call exceeds its timeoutMs.
- **Activity log now shows the profile id** (`claudeCode (auto)`) instead
  of just the model field (`auto`).
- Bundled `claudeCode.transport.timeoutMs` raised from 120s → 180s to
  better fit project-wide review tasks. Custom subprocess profiles still
  default to 120s via the schema.

### Limitation documented

claudeCode (and other subscription-CLI providers) return text only — they
cannot perform multi-turn tool calls. For file editing and multi-turn
agent behavior inside Tierkit's Chat tab, configure an API key
(ANTHROPIC_API_KEY for claudeSonnet, OPENAI_API_KEY for gpt4o) in
Settings → API Keys. Roo / Cline have their own tool loops that handle
claudeCode-style text models robustly; Tierkit's loop intentionally fails
fast to surface this architectural fact. **Native Claude Agent SDK
integration with proper tool_use bridging is planned for v0.15.**

## 0.14.1 — 2026-05-21

### Fixed

- **Onboarding "Quick check ▷" now renders the route trace correctly.** The
  GUI was reading `r.chain` and `r.selected.profileId` from
  `/v1/route/explain` but the endpoint returns `r.candidates[]` with a
  `selected: boolean` on each row. Result: every trace rendered as `? ⚠`.
  The Quick check now bolds the selected candidate, dims unviable ones,
  and shows the viability reason inline.

## 0.14.0 — 2026-05-21

### Added — Zero-CLI onboarding

- **Onboarding checklist card** (top of Settings tab, dismissable). Detects
  Ollama running + model count, `claude` CLI on PATH, `claudeCode` enable
  state, API keys (env vars + secrets store), Roo/Cline/Continue install
  state. Each row has an actionable button: enable claudeCode in one click,
  open the secrets form pre-filled with the missing key name, run a "Quick
  check ▷" that calls `/v1/route/explain` and shows the resulting trace
  inline. Dismissed via `notices.seenOnboarding`.
- **Inline profile editor.** Each row in the Model Profiles card gets a
  `[⋯]` expand button that reveals a chip-based editor for `roles`,
  `goodAt`, `notGoodAt`. `goodAt`/`notGoodAt` chips autocomplete from the
  `TASK_TYPES` set returned by `GET /v1/environment`. Saves via the
  extended `PATCH /v1/config/profile/:id`. Workspace-scope rows get a
  "Reset to bundled" button (calls `DELETE /v1/config/profile/:id?scope=workspace`).
  No more jq surgery to add `notGoodAt` or swap kinds.
- **Secrets form** (new Settings card). Add / edit / remove API keys for
  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY (and any custom name).
  Persists to `.tierkit/secrets.json` via the existing
  `GET/POST/DELETE /v1/secrets` endpoints. Values are masked end-to-end —
  the GET endpoint already returns `{ masked, set }` only, never the
  plaintext.
- **Chat tab promoted** as the default on first activation per workspace.
  Once onboarding is dismissed, the previously-active tab is respected as
  before.
- **`GET /v1/environment`** HTTP endpoint. Returns `{ ollama, claudeCli,
  envVars, taskTypes }` for any GUI / external diagnostic to read
  environment readiness without probing each provider individually.

### Added — Native streaming for subscription CLIs

- **`SubscriptionCliProvider.stream()` now streams token-by-token natively
  when the subclass overrides `streamArgs()` + `parseStreamLine()`.** Replaces
  the v0.13.x degrade-to-single-delta behavior. The base class still falls
  back to single-delta + `tierkit.warning: "stream-degraded-to-non-stream"`
  for subclasses that don't override (forward compat for Codex CLI etc.).
- **`ClaudeCodeProvider`** overrides both new methods. `streamArgs()`
  rewrites the profile's args to `--output-format stream-json --verbose`.
  `parseStreamLine()` parses Claude Code's NDJSON shapes (`type:"assistant"`
  with `content[].text`, `type:"content_block_delta"`) — permissive, skips
  unrecognized lines, falls back to full-buffer parse for final usage
  extraction.
- **`openaiCompat`** routes subscription-CLI requests through a new
  `streamSubprocessResponse()` that drains the provider's native stream and
  emits OpenAI-format SSE chunks per delta. **The
  `stream-degraded-to-non-stream` warning is no longer emitted for
  `claudeCode`** — Roo / Cline / the Tierkit chat tab now see Claude's
  responses appear word-by-word.
- `tierkit.profileId` / `usageSource` envelope is preserved on every chunk,
  same as v0.13.

### Internal

- `PATCH /v1/config/profile/:id` accepts `roles`, `goodAt`, `notGoodAt` in
  addition to `enabled` (new `updateProfileFields()` in `profileCrud.ts`).
- `notices.seenOnboarding` schema marker.

## 0.13.2 — 2026-05-21

### Fixed

- **Auto-discovered Ollama profiles for non-coder mid-size models (gemma,
  mistral 7b, llama3 8b, command-r, etc.) now declare
  `notGoodAt: ["code-generation","refactor","code-review","plan"]`** and
  `goodAt: ["summarize","translate"]`. Previously the heuristic only covered
  coder + small + large families and left mid-size generic models neutral,
  which let them claim coding tasks at the local-device tier and shadow
  escalation to `claudeCode`. Users who want a specific mid-size non-coder
  model for coding work can override `notGoodAt: []` per-profile in their
  `tierkit.config.json`.
- **`migrateAddMissingRouterMetaFields`** runs on every config load. It
  backfills missing `notGoodAt` / `goodAt` / `displayName` fields on workspace
  profiles that share `provider` + `model` with a bundled default. v0.12.x
  workspaces that copy-pasted `localCoder` / `localFast` automatically pick up
  v0.13's routing-classification fields without manual edits.
  **User-set values (anything not `undefined`) are never overwritten** — an
  explicit `notGoodAt: []` is preserved as an opt-in to use that model
  everywhere.
- **`claudeCode.kind` is now `"public-cloud"`** (was `"private-remote"`).
  Data flows to Anthropic's cloud — same trust boundary as `gpt4o`. The
  bundled profile now also declares `defaultMode: "review-only"` explicitly,
  matching the public-cloud convention. `claudeSonnet` / `claudeHaiku`
  classification revisit is deferred to v0.14 to avoid disrupting v0.12 users
  who rely on the current approval / mode behavior.

### Added

- **`POST /v1/route/explain`** HTTP endpoint mirroring `tierkit route explain`.
  Returns `{taskType, score, reasons, tier, ceiling, candidates[]}` with
  per-candidate viability. Lets GUI / curl users diagnose routing decisions
  without installing the CLI:

  ```bash
  curl -s -X POST http://127.0.0.1:4101/v1/route/explain \
    -H 'content-type: application/json' \
    -d '{"task":"리뷰해줘"}' | jq
  ```

## 0.13.1 — 2026-05-21

### Fixed — Routing now escalates past weak local models for review/plan/refactor

- **`localCoder` (qwen2.5-coder:7b) and `localFast` (llama3.2:3b) now declare
  `notGoodAt: ["code-review", "plan", "refactor"]`.** Tasks classified into
  these types are hard-filtered out of the local-device tier; the escalation
  chain naturally moves to the next tier (`claudeCode` if enabled + viable,
  then API-key cloud profiles). This stops Roo / Cline-style `"review this
  project"` requests from landing on a 7B model that hallucinates tool calls
  and file contents.
- **`RiskScorer.scoreRisk` now accepts a `taskType` and adds +20 for
  `code-review`, +15 for `plan` / `refactor`.** The classifier's output now
  contributes to the risk score, not just HIGH/MEDIUM keywords. Bare "리뷰
  해줘" / "review this" requests escalate to private-remote tier instead of
  staying local at score 10.
- A `model: "auto"` request that hits an empty escalation chain (e.g.,
  `localCoder` filtered out + `claudeCode` disabled + no API keys) now
  returns a clear error instead of silently delivering bad local output.

If you preferred the v0.12.x behavior (qwen handles everything locally),
override the bundled profile in your `tierkit.config.json` with a profile
that omits `notGoodAt`.

## 0.13.0 — 2026-05-21

### BREAKING

- **Pinned model profiles no longer silently fall back to local profiles.** A
  pinned profile (`model: "<id>"` — anything other than `"auto"`) that fails
  viability now returns HTTP 502 with
  `{ error: { type: "profile_not_viable", profileId, reason, message } }`.
  Use `model: "auto"` for fallback routing. Status mapping: 404 for unknown
  profile, 409 for disabled profile, 502 for non-viable, 504 for
  `cli-timeout`.

### Added — Subscription CLI provider (Claude Code)

- `claude-code` provider invokes the Claude Code CLI as a subprocess
  (`claude -p --output-format json`). Multi-turn messages are serialized with
  role-prefixed blocks. text-only completions for v0.13.0; tool-call bridging
  deferred.
- Bundled `claudeCode` profile (`defaultDisabled: true`). The new
  `migrateSeedDefaultDisabled` adds it to `disabledProfileIds` on first
  workspace load; once seeded, the migration never re-disables.
- `ModelProfileSchema` additions: `transport` (discriminated-union, currently
  one variant: subprocess), `displayName`, `defaultDisabled`. New
  `SUBPROCESS_PROVIDERS` constant gates the schema and registry.
- Within-tier `paymentModel` ordering (free → flat-rate → per-token) as the
  primary sort key in `sortProfilesForTier`. Tier order is unchanged.
- `ChatResult.usageSource: "provider-reported" | "estimated"` so consumers can
  distinguish real provider counts from local estimates.
- SSE stream degrade for subprocess providers — `stream: true` still gets a
  valid OpenAI-compatible SSE response, with
  `tierkit.warning: "stream-degraded-to-non-stream"` on the first and final
  chunks. Routing order is NOT changed by `stream: true`.
- `tierkit.profileId` / `usageSource` / optional `warning` envelope on
  chat-completion responses (streaming + non-streaming).
- `/v1/models/test` accepts `smoke: true` (probe + short chat) and
  `ignoreDisabled: true`. Smoke results are recorded in `usage.jsonl` with
  `type: "model-test"`.
- `/v1/notices` endpoint for one-time GUI acknowledgements (PATCH-merge
  semantics).
- GUI: viability badge per profile row, Test button with confirm + result
  panel, one-time v0.13 pinned-no-fallback banner, Recent Activity envelope
  display (`≈` token prefix when estimated, ⚠ chip when stream-degraded,
  `model-test` badge).
- `tierkit doctor` now surfaces the v0.13 pinned-no-fallback behavior change
  (warn until `notices.seenPinnedNoFallbackV013 === true`).
- First-start daemon INFO log on the first v0.13.x boot per workspace.

### Internal

- `TierkitConfig.migrations.defaultDisabledSeededProfileIds` and
  `notices.{seenPinnedNoFallbackV013, seenModelTestExplained}` markers so
  one-shot behaviors run exactly once per workspace.
- `LlmCallOk.usageSource` propagates from `ChatOk` through the executor for
  downstream telemetry.

---

## 0.12.3 — 2026-05-20

### Fixed — Model Profile State Unification

- **Toggle enable/disable now persists correctly.** The legacy `profile.enabled`
  inline field is folded into `disabledProfileIds` on first load (idempotent
  migration), so the array is the only source of truth. The `PATCH` endpoint
  already wrote to the array — readers now route through `isProfileDisabled()`
  which only consults the array.
- **Delete now sticks.** Auto-discovered Ollama profiles and bundled sample
  profiles no longer expose a Delete button (the underlying model exists,
  so Delete would just re-appear on next load). Server returns
  `400 cannot-delete-non-editable` if the API is called directly. Manually-added
  profiles (workspace/user scope) still support Delete.
- **No more duplicate rows.** Profiles sharing `(provider, baseUrl, model)` —
  e.g. `localCoder` (bundled sample) and `ollama-qwen2-5-coder-7b` (auto-discovered),
  both pointing to `qwen2.5-coder:7b` — collapse to a single row. Three layers
  of dedup: Ollama discovery skips already-covered identities, on-load migration
  rewrites the config to remove duplicates, and the GUI dedups the rendered list
  as defense in depth.

### Added

- `canonicalIdentity(profile)` and `isProfileDisabled(cfg, id)` helpers in
  `@tierkit/core`, exported for external consumers (CLI, SDK, plugins).
- `migrateLegacyEnabledField` and `migrateCanonicalDuplicates` run on every
  `loadConfig()` call (idempotent; no-op after first run).

### Backward compatibility

- No `ConfigSchema` major-version bump. Existing `tierkit.config.json` files
  work; the migration cleans them up in place.
- No `@tierkit/client` SDK API change.
- HTTP API unchanged except for the new `400 cannot-delete-non-editable`
  response (replaces a silent no-op delete).

### Non-goals (explicit, deferred)

- Cross-machine sync of disabled state — stays local.
- Backups of pre-migration configs — `git diff tierkit.config.json` covers it.
- Schema removal of the deprecated `enabled` field — keeping for forward
  compat with external editors; readers ignore it.

## 0.12.2 — 2026-05-19

### Added — UI Validation Flow

- **5 new HTTP endpoints** under `/v1/context/*`:
  - `POST /v1/context/build` — wraps `buildCompressedContext` + persists artifact
  - `GET /v1/context/:id` — returns artifact + verdict (or null)
  - `GET /v1/context/recent` — last 20 valid artifacts sorted by `createdAt`,
    `totalCount` excludes malformed dirs
  - `POST /v1/context/:id/compare` — SSE stream (phase / delta / side-result /
    compare-done / error events); requires `{ confirm: true }` body
  - `POST /v1/context/:id/verdict` — writes sidecar `verdict.json`
- **`compareCompressedContext` callbacks wired to SSE** — onPhase /
  onBaselineDelta / onCompressedDelta events stream live to the GUI.
- **Sidecar `verdict.json`** alongside `artifact.json` —
  `{ artifactId, qualityVerdict: "same"|"better"|"worse"|"unusable", missingContext?, notes?, reviewedAt }`.
  Atomic write (tmp + rename), lenient read (corrupted → null + log warning,
  doesn't break artifact view).
- **New GUI "Current project — validation" card** in the Cost Control sidebar.
  Replaces the inert v0.11.2 stub. 8 states (A–H, including failed-partial).
  Recent-contexts dropdown + Build flow + cost-confirmation modal + live
  SSE response viewer + savings table + human verdict form. Session-only
  current-artifact memory (no localStorage).
- **`streamSsePost(url, body, handlers, abortSignal)` helper** inline in
  `gui.ts` — fetch-based SSE consumer (POST + manual `\n\n` parsing) since
  native `EventSource` only supports GET.

### Safety policies pinned at the API layer

- `POST /v1/context/:id/compare` requires `{ confirm: true }`. Without →
  `412 confirm-required` with `estimated` cost payload (the 412 IS the modal
  preview).
- One compare per artifact at a time → `409 compare-already-running` on
  concurrent requests.
- SSE client disconnect → server `AbortController.abort()` on the in-flight
  compare; no background continuation.
- `POST /v1/context/:id/verdict` requires `artifact.compare !== undefined` →
  `409 compare-not-run` otherwise. `artifactId` and `reviewedAt` are
  server-stamped — caller cannot forge either.
- After SSE headers sent, all errors become SSE `error` events
  (`error.side` carries "baseline" | "compressed").

### Backward compatibility

- No `ContextArtifact` schema change. No `ConfigSchema` change. Existing
  artifacts without `verdict.json` show `verdict: null`.
- All 5 new endpoints are additive. No existing endpoint changed.
- CLI commands unchanged.
- Existing v0.12 features (per-profile budget, doctor warnings, GUI per-profile
  bars, `usage --by-profile`) unchanged.

### Non-goals (explicit, deferred)

- `POST /v1/context/:id/send` endpoint + `[Send compressed only]` button →
  v0.12.3 / v0.13 if validation reveals demand
- `[Open prompt.md]` (webview message bridge or file-serve endpoint) →
  v0.12.3+; replaced with path text + `[Copy path]` button in v0.12.2
- CLI `tierkit verdict` commands — not planned (verdict is UI-only)
- Aggregate validation-log generator (`tierkit validation-log`) → v0.13
  polish candidate
- Subscription CLI subprocess provider → v0.13
- Local LLM rerank/compress → v0.14
- Cross-session job queue / daemon-restart job resume → non-goal by principle
  (in-process loopback only)
- LLM-based auto-verdict → non-goal by principle (the human verdict IS the
  validation gate)

## 0.12.0 — 2026-05-19

### Added — Cost-aware routing v2

- **`ModelProfile.paymentModel`** (`free | flat-rate | per-token`) — optional; when omitted, derived from `kind` via `effectivePaymentModel()`. Backward compatible with v0.11.x configs.
- **`BudgetPolicy.perProfile`** — per-profile USD + input-token caps (whichever-first). Boundary: at-limit allowed, over-limit blocked.
- **Per-paymentModel enforcement**:
  - `per-token`: both USD and input-token caps enforced.
  - `flat-rate`: input-token caps only; USD is display-only metadata.
  - `free`: input-token caps only; USD ignored.
- **`checkPerProfileBudget()`** — pure-function gate; runs after `redactSecrets`, before `provider.stream`.
- **Fallback chain integration** — per-profile block returns `budget-exceeded` with `details[]` listing per-candidate skip reasons (Case A); global budget block stays single-line (Case B).
- **`RunRouteFail.details`** — optional `Array<{ profileId; reason }>` for Case A.
- **`/v1/usage` adds `profiles`** — optional top-level field; when present, each `profiles[id]` always contains both `today` and `month` with zero defaults.
- **`tierkit usage --by-profile`** — new CLI flag prints per-profile breakdown with Status column.
- **`tierkit doctor` — 3 new checks**: `flat-rate-or-free-with-usd-limit` (warning; message differs per pm); `per-profile-budget-near-threshold` (warning, 80–99%); `per-profile-budget-blocked` (blocker, ≥100%). Exit code stays 0 for all budget-related states — budget is policy, not failure.
- **`tierkit route run`** — `budget-exceeded` Case A renders per-candidate bullet list with tip pointers to `doctor` and `usage --by-profile`.
- **GUI Cost routing card** — per-profile USD + input-token budget bars for per-token profiles with caps; aggregate "이번 달 per-token 지출" row; flat-rate USD as `Fixed monthly cost: $X — metadata only`; bar color is additive to text status label (`OK / Warning / Near limit / Blocked`). "All capped per-token profiles exhausted" banner when applicable.

### Changed
- `tierkit doctor` exit code policy: budget-related blockers (`per-profile-budget-blocked`) → exit 0. Config / daemon / schema errors → still exit 1.

### Backward compatibility
- All schema changes additive optional. Existing `tierkit.config.json` parses and behaves identically.
- `ConfigSchema.version` stays `"0.1"`.
- Old `tierkit usage` (without `--by-profile`) prints unchanged output.
- `/v1/usage.profiles` is optional in the response; v0.11.x clients ignore it.

### Non-goals (deferred)
- Subscription CLI subprocess provider (Claude Code / Codex / Gemini CLI as model providers) → **v0.13**.
- Routing reorder to prefer flat-rate over per-token → **v0.13** (needs subprocess execution).
- GUI "AI Coding CLIs" status panel → v0.13.
- Per-API-key shared budgets → v0.13 candidate.
- Output token caps → not planned for v0.12; may be added later if requested.
- Daily/monthly call count caps → not planned for v0.12; focus is on input-token + USD.
- GUI "cap reached in ~N days" predictor → v0.15 Savings Intelligence (doctor-only in v0.12).
- Local LLM rerank / compress / summarize → **v0.14**.
- `roles[]` on `ModelProfile` → v0.14.
- `tierkit doctor --strict-budget` flag → v0.13.

## 0.11.1 — 2026-05-19

### Changed (docs / IA realignment — zero runtime change)

- **Repositioning.** Tierkit is now described, throughout README / SPEC /
  INTEGRATIONS / VS Code marketplace listing / GUI sidebar / CLI
  top-level help / all 9 workspace `package.json` descriptions, as a
  **local-first cost optimizer and token firewall for AI coding CLIs**
  (Claude Code, Codex CLI, Gemini CLI, Roo Code, Cline, Continue, aider).
  The previous "local-first hybrid plugin runtime" framing is replaced.
  Plugin runtime, adapters, sessions, and model profiles remain in the
  codebase as implementation mechanisms; they move to the Advanced
  section in docs/UI rather than being removed.
- **README Quick start** now leads with `tierkit context build` /
  `tierkit context compare`. `pnpm install` moves to a new
  "Development setup" section.
- **GUI sidebar** renamed from "Mission Control" to "Cost Control"; cards
  reorganized into Savings / Current project / Cost routing /
  Integrations / Advanced.
- **CLI top-level help** now groups commands under Savings / Cost routing
  / Integrations / Diagnostics / Advanced (string-only edits to the
  `Command.Usage({ category: ... })` fields).
- **docs/INTEGRATIONS.md** reframed as "Integrations as savings channels"
  with an interception-style taxonomy (gateway / helper / MCP /
  export-first) and a per-tool savings-posture table. Accurately records
  that `tierkit connect` supports `roo | cline | continue` only — Codex
  CLI and aider are listed as manual gateway-config today, with
  first-class `connect` deferred to v0.13.

### Not changed in 0.11.1 (deliberate)

- No CLI command path, flag, or behavior changes.
- No HTTP endpoint added / removed / renamed.
- No `ModelProfile` / `tierkit.config.json` schema changes.
- No new filesystem reads or writes (the "Current project" card is an
  inert stub — first-class "last artifact" tracking is a v0.12 feature).
- No new tests; existing 635/635 test count and `pnpm -r typecheck`
  remain green.

### Strategic filter going forward

From v0.11.1 onward, every feature is evaluated against the question:
**"Does this reduce cloud cost, or stretch the same budget further at
equal quality?"** If the answer is no, it's an advanced/secondary
feature, not a headline.

## 0.11.0 — 2026-05-19

### Added

- **Context compression (v1.7-spike)** — deterministic, LLM-free pipeline:
  - `tierkit context build "<task>"` — extracts keywords (no LLM),
    finds candidate files via ripgrep, ranks them, builds skeleton +
    hotspot excerpts, writes a compressed `prompt.md` and metadata
    `artifact.json` under `.tierkit/runtime/context-artifacts/<id>/`.
  - `tierkit context show <id>` — print summary or raw JSON.
  - `tierkit context send <id> --profile <p>` — send the compressed
    prompt via the existing `runRoute` pipeline (redact / budget /
    usage-log all reused).
  - `tierkit context compare <id> --profile <p> [--yes]` — runs the
    same task twice (baseline = selected files raw text; compressed =
    prompt.md), prints a side-by-side savings table, and stores the
    result inside the artifact for later inspection.
- `contextCompression` optional config section (`defaultMaxFiles`,
  `defaultCloudTokenBudget`, `ignoreGlobs`).
- Auto-creates `.tierkit/.gitignore` with `*` on first artifact write
  so artifact contents (workspace paths + source excerpts) are not
  accidentally committed.

### Requirements

- `ripgrep` (`rg`) must be installed for `context build`.

### Backward compatibility

- All prior CLI commands, HTTP endpoints, OpenAI-compatible endpoint,
  plugin system, and `ModelProfile` types are unchanged.
- `tierkit.config.json` is forward-compatible — `contextCompression`
  is optional.

### Explicitly non-goal (deferred)

LLM-based file ranker / compressor, ModelRole system, CompressionMode
enum, `--compress` flag, OpenAI-endpoint auto-compression, agent-loop
integration (Claude Code / Roo / Cline / Continue), GUI Token Savings
card, HTTP `/v1/context/*` endpoints, tree-sitter, response-quality
auto-judge, parallel/multi compare, `--diff` flag, `context clean`.
See the v1.7-spike spec for the full list.
