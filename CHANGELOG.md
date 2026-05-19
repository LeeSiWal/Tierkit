# Changelog

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
