# Changelog

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
