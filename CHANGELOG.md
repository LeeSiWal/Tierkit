# Changelog

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
