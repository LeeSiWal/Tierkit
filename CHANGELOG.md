# Changelog

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
