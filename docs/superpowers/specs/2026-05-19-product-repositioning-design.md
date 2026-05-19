# Tierkit Product Repositioning — v0.11.1

**Date:** 2026-05-19
**Status:** Approved (docs/copy/IA realignment; no runtime change in this round)
**Scope:** README / SPEC.md / INTEGRATIONS.md / package.json descriptions / VS Code extension NLS / GUI sidebar copy + grouping / CLI top-level help / docs roadmap
**Out of scope:** any change to runtime code, CLI command behavior, HTTP endpoints, plugin loader, model profile shape, OpenAI-compatible endpoint, or context-compression internals.

---

## §1. New Identity

**English (one-liner — canonical):**

> Tierkit is a **local-first cost optimizer and token firewall for AI coding CLIs**. It helps tools like Claude Code, Codex CLI, Gemini CLI, Roo Code, Cline, Continue, and aider spend fewer cloud tokens — without losing task quality — by routing context through cheaper local and private models before any premium cloud call.

**Korean (one-liner — canonical):**

> Tierkit은 AI 코딩 CLI를 위한 **로컬 우선 비용 최적화 레이어 / 토큰 방화벽**입니다. Claude Code, Codex CLI, Gemini CLI, Roo Code, Cline, Continue, aider 같은 도구가 비싼 클라우드 모델을 덜 쓰면서도 같은 작업 품질을 유지하도록, 로컬과 프라이빗 모델을 먼저 거쳐 컨텍스트를 찾고·압축하고·마스킹하고·라우팅합니다.

**The filter for every future design decision:**

> *Does this feature reduce cloud-model cost, or let the same budget go further at equal quality?* If the answer is no, it's an advanced/secondary feature, not the headline.

**Existing positioning (to be replaced):**

> ~~"Tierkit is a local-first hybrid plugin runtime for AI coding agents. It lets you write one plugin format and adapt it to tools like Cline, Zoo/Roo Code, and Continue — while routing work across local models, private remote models, and public cloud models based on risk, cost, and workflow policy."~~

Plugin runtime / adapter / model routing all remain in the codebase, but they are *implementation mechanisms* for the cost-optimization promise, not the headline.

---

## §2. Current incoherences (audited)

Every surface below contradicts the new identity and must be rewritten in the v0.11.1 PR.

| # | File | Line(s) | What it currently says | Why it conflicts |
|---|------|---:|---|---|
| 1 | `README.md` | 3 | "Tierkit is a local-first hybrid plugin runtime for AI coding agents." | Lead identity is plugin runtime, not cost optimizer. |
| 2 | `README.md` | 5 | "It lets you write one plugin format and adapt it to tools like Cline, Zoo/Roo Code, and Continue — while routing work across local models…" | Plugin format leads; cost optimization is buried as a side-clause. |
| 3 | `README.md` | 7 | Token-firewall language exists, but appears ~1.5KB into a single status paragraph behind v0.10.7–v0.10.12 release notes. | The actual current value prop is unfindable. |
| 4 | `README.md` | 26 | "Quick start (v0.1)" — `pnpm install && pnpm -r build`. | Onboarding starts with build steps, not with measured savings. |
| 5 | `README.md` | 192–204 | Korean section leads with Roo `connect` wiring and Mission Control. | Same plugin/routing framing as the English section. |
| 6 | `package.json` (root) | 5 | `"description": "Local-first hybrid plugin runtime for AI coding agents"` | Same old positioning at the workspace level. |
| 7 | `packages/core/package.json` | (desc) | "Tierkit core: plugin format, validator, loader, model profiles, adapter interface, usecases." | Plugin format is the first thing named. |
| 8 | `packages/cli/package.json` | (desc) | "Tierkit command-line interface — thin clipanion layer over `@tierkit/core` usecases." | Tells you the implementation, not the purpose. |
| 9 | `packages/agent/package.json` | (desc) | "Tierkit's built-in coding agent. Cline-style XML tool calling with Tierkit policy gates…" | Frames Tierkit as an agent host, not a cost layer. |
| 10 | `packages/{adapter-roo,adapter-cline,adapter-continue}/package.json` | (desc) | "Tierkit adapter that exports plugins for X." | Plugin export-first. Should reframe as integration/savings channel. |
| 11 | `packages/plugin-superpowers/package.json` | (desc) | "Bundled Superpowers-like sample plugins…" | "Superpowers" brand reads as a self-contained product, not a cost-policy rule pack. |
| 12 | `packages/client/package.json` | (desc) | "Typed HTTP client for the Tierkit runtime daemon." | Implementation-only. |
| 13 | `packages/vscode-tierkit/package.nls.json` | 2 | `"description": "Local-first hybrid model routing toolkit…"` | Same outdated identity in the marketplace listing. |
| 14 | `docs/SPEC.md` | §0 | "Tierkit — Local-first Hybrid Coding Agent Runtime" | Identity section sets the wrong North Star. |
| 15 | `docs/SPEC.md` | §0 one-liner | "brings Claude Code-style plugins, Superpowers-like workflows, and cost-aware model routing to multiple AI coding agents" | Cost is one feature of three; should be the headline. |
| 16 | `docs/SPEC.md` | §1 | Positioning table — "new positioning" is *"Common plugin/runtime format for AI coding agents + Local-first hybrid model router + Workflow policy engine + Tool adapter layer"* and "plugin OS for AI coding agents." | The new "new" is "cost optimizer / token firewall." |
| 17 | `docs/SPEC.md` | §2 | Five problems; only #4 is cost. Plugin/workflow/standardization framing dominates. | Problem statement must be cost-first. |
| 18 | `docs/INTEGRATIONS.md` | 1 | Title "Tierkit — Tool integrations (v1.3 / v1.4)" | Frames integrations as a milestone, not a savings vector. |
| 19 | `packages/core/src/runtime/ui/gui.ts` | 2 | Header comment: "Single-file browser UI for the Tierkit runtime daemon — Mission Control." | Sidebar self-identity is "Mission Control," not "Cost Control." |
| 20 | `packages/core/src/runtime/ui/gui.ts` | 622–717 | Card grouping: `groupIntegrations` (Tools, Plugins) → `groupConfiguration` (Models, Daemon) → `groupActivity` (Usage). | First-screen IA leads with plugin/tool management, not savings/quality. |
| 21 | CLI top-level help | (alphabetical) | `tierkit --help` lists commands by clipanion category alphabetically (Check / Config / Connect / Context / Doctor / Export / Init / Models / Plugin / Profile / Route / Runtime / Session / Usage). | No way for a new user to see "this is for saving money." |

---

## §3. Core user promise

**One paragraph (will be lifted verbatim into the new README §1):**

> Tierkit cuts the bill of AI coding without cutting the result. Point an AI coding CLI at Tierkit and your premium-cloud model only sees the prompts that genuinely need its judgment — everything else (file search, context compression, log/diff summarization, simple drafts, low-risk reviews) is handled first by free local models and, when you have one, an optional private remote model. Tierkit measures the trade-off every time: same task, baseline vs. compressed, side-by-side, with real provider usage. You see exactly how many tokens you stopped paying for and whether the quality held.

**Implied user outcomes (success criteria for the product):**

1. Visible "tokens saved today" / "cost saved today" / "calls avoided today" on the first screen.
2. Every cloud call has an audit trail showing why it wasn't handled locally.
3. Users on Claude Max 20x can credibly evaluate dropping to Max 5x.
4. Users on Max 5x can credibly evaluate dropping to Pro.
5. Onboarding ends with a measured savings number, not an installed plugin.

---

## §4. Required feature set (8 primary capabilities)

Order = first-screen prominence. Existing implementations referenced where present.

| # | Capability | Status today | What it must do |
|---|---|---|---|
| 1 | **CLI Gateway** | Partial (OpenAI-compat endpoint exists) | Sit between each supported AI coding CLI and its model provider where possible, applying Tierkit policy. Per-tool strategy in §6. |
| 2 | **Token Firewall** | Partial (`SecretRedactor`, `RiskScorer`, `budget` exist) | Before every public-cloud call: estimate tokens, detect oversized context, redact secrets, warn cost, optionally compress, decide tier. |
| 3 | **Context Compressor** | Shipped (v0.11.0 deterministic; `tierkit context build/show/send/compare`) | Foundation. Next: add local-model rerank/compress on top. |
| 4 | **Local Model Switcher** | Partial (`ModelProfile`, Ollama auto-discovery) | Per-*role* model selection (file-ranker / context-compressor / log-summarizer / diff-summarizer / draft / review) with device-tier presets. See §7. |
| 5 | **Private Remote Model Support** | Partial (any OpenAI-compatible profile works) | First-class middle tier between local-device and public-cloud. See §8. |
| 6 | **Cost Router** | Partial (`ModelRouter` + `goodAt`/`notGoodAt` + risk thresholds) | Reframe from "model routing" to "cheapest acceptable path." See §9. |
| 7 | **Quality Comparator** | Shipped (`tierkit context compare`) | Keep + extend. Add per-run quality verdict storage, history, escalation hints. |
| 8 | **Savings Dashboard** | Not yet (current GUI is Mission Control) | First screen of GUI + CLI summary command. See §10. |

---

## §5. Demoted to Advanced (kept, not deleted)

The following stays in the codebase and remains functional. It just stops being the headline.

| Feature | Where it lives now | Where it moves in IA |
|---|---|---|
| Plugin runtime (`PluginManifest`, validator, loader, registry) | Top-level concept | Re-framed as "**Policy Rules** (advanced) — apply per-task discipline and tool permissions on top of cost routing." |
| `superpowers-free/guided/balanced/strict` plugin pack | First-class bundled sample | Re-framed as "**Cost-policy rule packs** (advanced)." Slug stays for v0.11.x; rename deferred (§15). |
| Workflow sessions (`tierkit session start/advance/...`) | First-class CLI surface | Demoted to **Quality / discipline gates** under Advanced. Same commands, new framing. |
| LLM-generated plugins (`tierkit plugin new` describe-in-natural-language) | Highlighted feature | Demoted to **Advanced authoring tool**. |
| Routing presets (🚀 Local-coder-first / 🔒 Private only / ↺ Defaults) | Models card top row | Renamed to **Cost strategy presets**; stays where it is but in a renamed group ("Cost routing"). |
| Risk threshold editor | Disclosure under Models card | Stays — renamed to **Cost router thresholds**. |
| Doctor (`tierkit doctor`) | First-class CLI command | Stays — re-categorized in help under **Diagnostics**. |
| Adapter export (`tierkit export {roo,cline,continue}`) | First-class CLI surface | Demoted to **Integrations → export-first path** (alternative to gateway). |

**Nothing in this list gets removed in v0.11.1.** The v0.11.1 PR only rewrites copy and reorders UI cards.

---

## §6. CLI integration strategy

Different AI coding CLIs have different control models. Trying to wrap them all the same way (e.g., always-on OpenAI-compatible proxy) breaks the user experience for the most agent-loop-heavy ones.

| Tool | Primary integration | Why | Status |
|---|---|---|---|
| **Codex CLI** | OpenAI-compatible gateway (`base_url` → Tierkit) | Codex speaks OpenAI natively and treats it as a model provider, not as a context source. Compression policy applied server-side. | Endpoint exists. Compression-on-OpenAI-endpoint deferred to **v0.13**. |
| **Roo Code / Cline / Continue / aider** | OpenAI-compatible gateway via `tierkit connect <tool>` | These tools also speak OpenAI-compatible and already have `connect` wiring. Same compression server-side. | `connect` shipped. Compression policy deferred to **v0.13**. |
| **Claude Code CLI** | Context helper + MCP, **not** agent-loop interception | Claude Code has its own strong agentic context management (Read/Grep/Glob/Bash). Wrapping it with a proxy that pre-compresses risks confusing the loop. Safer initial path: surface `tierkit context build/send` as a manual helper, then expose an MCP server that Claude Code can call when it *wants* compressed context. | Manual helper shipped (v0.11.0). MCP wrapper deferred to **v0.13**. |
| **Gemini CLI** | MCP / compressed-context provider | Gemini CLI accepts MCP servers; cleaner than retrofitting an OpenAI-compatible shim. | Deferred to **v0.13**. |

**Rule of thumb for future tools:** if the tool treats the model as a black-box provider, use the gateway. If the tool runs its own agent loop with file-level tools, expose Tierkit as an MCP context source the tool can opt into.

---

## §7. Local Model Switcher design

Users have different hardware. The same Tierkit must run sensibly on a 16 GB laptop and a 128 GB Mac Studio. The switcher exposes **per-role** model selection rather than a single "local model" choice.

**Roles (matches v1.7-spike spec's `ModelRole` plan; introduced for real in v0.12):**

```
file-ranker        — rerank candidate files locally before compression
context-compressor — summarize file content into prompt.md sections
log-summarizer     — fold long error logs / stdout into short claims
diff-summarizer    — turn long diffs into "what changed / why" summaries
local-draft        — first-pass code edit (Tierkit-agent or external)
local-review       — first-pass code review before escalating to cloud
```

**Device tier hints (not enforced — surfaced as defaults during model discovery):**

| Device tier (RAM / GPU) | Default file-ranker | Default compressor | Default reviewer | Notes |
|---|---|---|---|---|
| **32 GB Mac (M1/M2/M3)** | `qwen2.5-coder:7b` or `qwen2.5:7b` | `qwen2.5-coder:7b` | (skip — escalate) | 14B fits but pressures the OS. |
| **64 GB Mac** | `qwen2.5-coder:14b` | `qwen2.5-coder:14b` or `qwen3-coder:30b-a3b` (MoE) | `qwen2.5-coder:14b` | Sweet spot for v0.12 validation. |
| **128 GB Mac / 4090-class GPU** | `qwen3-coder:30b-a3b` or `deepseek-coder:33b` | same | 70B Q4/Q5 candidates | Local-review becomes viable. |
| **Tiny / no local GPU** | (none — deterministic only) | (deterministic only) | (skip) | v0.11 fallback remains the path. |

**UI surface (under "Cost routing" card group — see §10):**

```
Local Compressor:   [ qwen2.5-coder:14b ▼ ]
Local Reviewer:     [ qwen3-coder:30b-a3b ▼ ]   (optional — empty = escalate)
Cloud Final:        [ claudeSonnet ▼ ]
Tier order:         local-device → private-remote → public-cloud
```

**Non-goal in v0.11.1:** the role assignment field is not yet on `ModelProfile`. v0.11.1 only documents the *intended* surface; the field lands in v0.12 alongside the local LLM rerank/compress code path.

---

## §8. Private remote model tier

A user's "private" tier today is anything Tierkit reaches that isn't the public cloud. v0.11.1 names it explicitly in the IA and confirms the supported endpoint shapes.

**Supported (already work via existing OpenAI-compatible / Ollama profile shapes):**

- Remote Ollama (`tierkit.config.json` profile with `provider: "ollama"` + `baseUrl: "http://my-server:11434"`)
- LM Studio server (OpenAI-compatible)
- vLLM server (OpenAI-compatible)
- TGI (Text Generation Inference) (OpenAI-compatible)
- llama.cpp server (OpenAI-compatible)
- Self-hosted gateways (OpenAI-compatible)
- Rented GPU (RunPod / Vast.ai / Lambda) exposing OpenAI-compatible URLs

**Tier semantics:**

```
local-device   → free, but limited by hardware
private-remote → paid hardware/electricity, no per-token cost to provider
public-cloud   → per-token cost, premium reasoning
```

**Routing implication (formalized in v0.14 Cost Router):** for the same `goodAt[]` capability, `private-remote` should be preferred over `public-cloud`. The existing `preferPrivateRemoteBeforePublicCloud: true` policy already encodes this — v0.11.1 elevates it from a config flag to a documented product principle.

---

## §9. Cost Router design

Reframe the existing `ModelRouter` from "pick a tier by risk score" to "pick the **cheapest acceptable path** for this task type, then escalate only if quality fails."

**Task-type → default cheapest path (defaults; user-overridable):**

| Task type | Default path |
|---|---|
| `summarize` (file, log, diff) | local |
| `file-rank` | local |
| `prompt-compress` | local |
| `code-generation` (trivial) | local |
| `code-generation` (non-trivial) | local-draft → cloud-final |
| `code-review` (low-risk diff) | local |
| `code-review` (auth / payments / security) | cloud-final |
| `architecture` / `plan` | cloud-final |
| `debug` (typed error, single file) | local with cloud-fallback |
| `debug` (cross-cutting) | cloud-final |

**Escalation triggers (already partially implemented as `ResponseQualityEvaluator`):**

- Empty / truncated / refusal response → retry on the next tier.
- Quality-comparator verdict "worse" or "unusable" → flag for next-time bypass.
- `notGoodAt[]` capability mismatch → skip tier entirely (already enforced).

**Budget integration:** existing `BudgetPolicy` (daily / monthly limits) stays. v0.11.1 only documents that **budget-blocked** is a valid reason to skip a tier, not just a hard refusal.

**v0.11.1 surface change:** none — this is documentation of intent. The implementation lands progressively in v0.13 / v0.14.

---

## §10. Savings Dashboard IA

The current GUI titles itself "Mission Control" and groups cards as `Integrations / Configuration / Activity`. The new dashboard is **"Cost Control"** and leads with savings.

### First-screen card order (top to bottom)

```
┌──────────────────────────────────────────────────────────────┐
│ Tierkit  v0.11.x  ↻  ⚙                              한 / EN  │
├──────────────────────────────────────────────────────────────┤
│  [Group] Savings                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Today                                                    │ │
│  │   Cloud input tokens saved:      842,000  (87% of base) │ │
│  │   Estimated cost saved:          $2.53                  │ │
│  │   Cloud calls avoided:           14                     │ │
│  │   Local preprocessing success:   71%                    │ │
│  │   Compressed-vs-baseline pass:   4 / 5                  │ │
│  │   Escalations to public cloud:   3                      │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                                │
│  [Group] Current project                                       │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Last compressed context: ctx_a3b2c1d4e5                 │ │
│  │   Baseline:    72,400 tokens                            │ │
│  │   Compressed:   8,930 tokens                            │ │
│  │   Savings:      87.7%                                   │ │
│  │   Quality:      pending human review                    │ │
│  │ [Build] [Compare] [Send]  [Open prompt.md]              │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                                │
│  [Group] Cost routing                                          │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Local Compressor: [ qwen2.5-coder:14b ▼ ]               │ │
│  │ Local Reviewer:   [ — ▼ ]                               │ │
│  │ Cloud Final:      [ claudeSonnet ▼ ]                    │ │
│  │ Tier order:       local → private → public              │ │
│  │ [Cost strategy presets: 🚀 Local-coder-first / ...]     │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                                │
│  [Group] Integrations                                          │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ Connected: Roo (gateway), Cline (gateway), Codex (gw)   │ │
│  │ Available: Claude Code (helper), Gemini CLI (mcp)       │ │
│  │ [Connect a new tool]                                    │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                                │
│  ▾ Advanced                                                    │
│      Active policy rules (plugins)                            │
│      Workflow / discipline gates (sessions)                   │
│      Model profile CRUD                                       │
│      Risk threshold editor                                    │
│      API key management                                       │
│      Adapter export                                           │
│      Daemon controls                                          │
│      LLM-generated rules                                      │
└──────────────────────────────────────────────────────────────┘
```

### Korean labels (matches existing `i18n` table in `gui.ts:731+`)

| Group / card | English | Korean |
|---|---|---|
| Group: Savings | Savings | 절감 |
| Today | Today | 오늘 |
| Group: Current project | Current project | 현재 프로젝트 |
| Group: Cost routing | Cost routing | 비용 라우팅 |
| Group: Integrations | Integrations | 연결된 도구 |
| Group: Advanced | Advanced | 고급 |
| Card: Active policy rules | Active policy rules | 활성 정책 규칙 |
| Card: Workflow gates | Workflow gates | 워크플로 게이트 |
| Card: Model profile CRUD | Model profile editor | 모델 프로파일 편집 |
| Action: Build | Build compressed context | 압축 컨텍스트 생성 |
| Action: Compare | Compare baseline vs compressed | 베이스라인 vs 압축 비교 |
| Action: Send | Send compressed prompt | 압축 프롬프트 전송 |

**Implementation note:** in v0.11.1 we **only** rewrite the labels and reorder/regroup the existing cards. The `Savings` and `Current project` cards are stubs that render existing usage / artifact data with new framing. Real local-preprocessing-success-rate and compressed-vs-baseline-pass-rate metrics depend on validation data (v0.11 manual validation) and v0.12 local-compression rollout — these fields are wired but display `—` until data exists.

---

## §11. Roadmap 0.11 → 0.15

Replaces the existing v1.x milestone narrative. Both labels coexist for one release while memory/CHANGELOG catch up.

| Version | Theme | Concrete deliverables | Status |
|---|---|---|---|
| **0.11.0** | Measurement (foundation) | `tierkit context build/show/send/compare`, deterministic compression, baseline/compressed A/B with real provider usage | **Shipped** (2026-05-19) |
| **0.11.1** | **Repositioning** (this PR) | New README, new SPEC §0–§2, new INTEGRATIONS framing, new GUI card order, new CLI help categories, new package descriptions, new VS Code marketplace copy. **Zero runtime change.** | **This spec** |
| **0.11.x** | Manual validation (in parallel) | 5-task validation on a real project; `validation-log.md` filled in; go/no-go for v0.12 | In-flight |
| **0.12** | Local compression | Local LLM file-ranker, context-compressor, log-summarizer, diff-summarizer; role × model assignment in `ModelProfile`; device-tier defaults; expanded `tierkit context build` with `--local-compress` flag | Planned |
| **0.13** | CLI Gateway integration | Compression policy on the OpenAI-compatible endpoint (auto-apply to Codex / Roo / Cline / Continue / aider); MCP server for Claude Code; MCP provider for Gemini CLI | Planned |
| **0.14** | Cost router | Reframe `ModelRouter` to "cheapest acceptable path"; per-task-type tier defaults; budget-aware tier-skip; private-remote first-class | Planned |
| **0.15** | Savings Intelligence | Weekly savings report; Max 20× → Max 5× downgrade estimator; Max 5× → Pro estimator; model usage breakdown; quality pass rate trend | Planned |

**Validation gates:**
- 0.11 → 0.12: ≥4 of 5 manual validation tasks PASS on a real project.
- 0.12 → 0.13: local-compression with rerank/compress shows ≥10% additional savings over deterministic baseline at equal quality on the same 5 tasks.
- 0.13 → 0.14: at least one CLI integration auto-compresses without measurable quality loss for one full week of use.
- 0.14 → 0.15: cost router shows ≥30% cost reduction vs. always-cloud baseline in real usage data.

---

## §12. What NOT to build next

Each of these is tempting but distracts from the cost-optimization story. Listed so future planning sessions don't accidentally adopt them.

- Replacing Claude / GPT / Gemini with a local model as the headline use case.
- Auto-intercepting Claude Code's agent loop before MCP option is validated.
- Building a separate "Tierkit Agent" that competes with Claude Code / aider.
- New plugin format features (the existing one is sufficient as a policy layer).
- A second plugin registry / marketplace.
- Web-hosted version of the daemon (loopback-only is a security feature, not a limitation to remove).
- Per-team / multi-user features before single-user savings are proven.
- Slack / Discord integrations.
- Anything that needs telemetry phone-home — Tierkit must remain local-data-only.
- A "free tier" of a paid cloud product. Tierkit is an open-source tool; commercialization is out of scope until adoption is proven.

---

## §13. Acceptance criteria for v0.11.1 repositioning PR

The repositioning PR is complete when **all** of the following hold:

**Copy / docs:**
- [ ] `README.md` §1 paragraph matches **Appendix A** (English) verbatim.
- [ ] `README.md` Korean section §1 matches **Appendix B** verbatim.
- [ ] `README.md` "Quick start" begins with `tierkit context build` (not `pnpm install`).
- [ ] `docs/SPEC.md` §0–§2 matches **Appendix C** verbatim.
- [ ] `docs/INTEGRATIONS.md` lead paragraph reframes integrations as "savings channels" (matches **Appendix G** verbatim).
- [ ] `package.json` (root) `description` matches new wording.
- [ ] All 9 workspace package `description` fields match new wording (**Appendix F**).
- [ ] `packages/vscode-tierkit/package.nls.json` `description` matches new wording.

**UI / IA:**
- [ ] `packages/core/src/runtime/ui/gui.ts` header comment changes "Mission Control" → "Cost Control."
- [ ] GUI card groups renamed and reordered per **§10** + **Appendix D**.
- [ ] `i18n` `cardTools / cardPlugins / cardModels / cardUsage / cardDaemon / cardActivity` Korean labels updated; new keys for `groupSavings`, `groupCurrentProject`, `groupCostRouting`, `groupAdvanced` added.

**CLI:**
- [ ] `tierkit --help` top-level groups reorganized per **Appendix E** (Savings / Compression / Routing / Integrations / Diagnostics / Advanced).
- [ ] `tierkit context build/show/send/compare` help descriptions reflect cost-saving framing (currently say "deterministic, compressed context artifact" — adjust to lead with savings).

**Behavior (must NOT change in this PR):**
- [ ] All existing tests pass (currently 635/635 across packages).
- [ ] `pnpm -r typecheck` clean.
- [ ] No change to any source file under `packages/*/src/` except `packages/core/src/runtime/ui/gui.ts` (UI strings + grouping) and CLI command `usage` blocks (help text only).
- [ ] No HTTP endpoint added / removed / renamed.
- [ ] No CLI command added / removed / renamed.
- [ ] No `ModelProfile` / config schema field added / removed / renamed.

**Memory / CHANGELOG:**
- [ ] `CHANGELOG.md` gains a `0.11.1` entry describing this as docs/IA realignment with zero behavior change.
- [ ] Project memory gains `project_v17_1_repositioning.md` (or amend `project_v17_context_compression.md` with a "Repositioning follow-up" section).
- [ ] Memory note explicitly records: "From v0.11.1 onward, evaluate every feature against the cost-optimization filter."

---

## §14. Backward compatibility / non-goals

**Compatibility (mandatory):**
- All existing CLI commands keep their paths, flags, and exit codes.
- `tierkit.config.json` schema unchanged. `contextCompression` section added in v0.11.0 stays optional.
- OpenAI-compatible endpoint, HTTP daemon, plugin loader, adapter exports, session API: unchanged.
- Existing `ModelProfile` fields including `goodAt / notGoodAt / preferred / preferPrivateRemoteBeforePublicCloud` keep current semantics.

**Non-goals for v0.11.1 (deferred to later versions; listed so reviewers don't ask for them here):**
- Adding `roles[]` to `ModelProfile` — v0.12.
- Per-role model assignment UI control — v0.12.
- MCP server — v0.13.
- Auto-compression on OpenAI-compatible endpoint — v0.13.
- Local LLM file-ranker / compressor — v0.12.
- New tests — none required; this PR changes only copy and a couple of UI grouping calls.

---

## §15. Naming hygiene (deferred, documented)

Renames that *should* happen eventually but **do not happen in v0.11.1** (to keep the PR small and reversible). All deferred to ≥ v0.12 with explicit upgrade notes when the rename lands.

| Current | Future name | When | Reason |
|---|---|---|---|
| `@tierkit/plugin-superpowers` (package) | (no rename) | — | Adapter export slugs depend on package-relative paths; renaming requires a migration window. |
| `superpowers-free` (plugin slug) | `local-first-policy` | v0.13 alongside CLI gateway | Plugin slug appears in `tierkit.config.json#activePlugins`, on disk under `.tierkit/plugins/`, and in registry — needs a migration shim. |
| `superpowers-guided` (plugin slug) | `cost-safe-guided` | v0.13 | Same. |
| `superpowers-balanced` (plugin slug) | `cost-safe-balanced` | v0.13 | Same. |
| `superpowers-strict` (plugin slug) | `cloud-safe-strict` | v0.13 | Same. |
| `tierkit-vscode` extension display name | (keep slug, swap display copy) | v0.11.1 (this PR) | Display string change only, no marketplace re-publish under a new id. |
| `"Mission Control"` (GUI comment) | `"Cost Control"` | v0.11.1 (this PR) | Comment + i18n label only. |
| `goodAt` / `notGoodAt` on `ModelProfile` | (keep) | — | Reads naturally as "what this profile is good at routing-wise." Renaming costs more than it earns. |
| `route run` CLI | `tierkit run` | Deferred indefinitely | "Route run" still reads correctly under the new framing. |

**Rule:** any rename that touches `tierkit.config.json` field names, on-disk paths, package slugs, or HTTP routes goes through a deprecation cycle (one release with old + new both accepted before old is removed). Display labels and free-text descriptions can change immediately.

---

## Appendix A — New `README.md` §1 (English, verbatim replacement for lines 1–7)

```markdown
# Tierkit

Tierkit is a **local-first cost optimizer and token firewall for AI coding CLIs**.

It helps tools like Claude Code, Codex CLI, Gemini CLI, Roo Code, Cline,
Continue, and aider spend fewer cloud tokens — without losing task quality.
Before any premium cloud model sees your project, Tierkit can search files
locally, compress them into a minimal high-signal prompt, redact secrets,
compare compressed vs. baseline output side-by-side with real provider
usage, and route easy work to your local or private models so the expensive
model is only used when it actually has to be.

> Status: **v0.11.0**. Foundation shipped — `tierkit context build / show /
> send / compare` lets you measure token savings + response quality on real
> tasks today. v0.11.1 is a docs/UI realignment around this product
> direction. v0.12 adds local-model preprocessing on top of the
> deterministic compressor. v0.13 wires the gateway into Codex / Roo /
> Cline / Continue / aider, and an MCP server for Claude Code and Gemini
> CLI. Past releases (v0.10.x) added the routing engine, response-quality
> evaluator, OpenAI-compatible endpoint, and `tierkit connect`. See
> [`CHANGELOG.md`](CHANGELOG.md) for the full history.
```

## Appendix B — New `README.md` §1 (Korean, verbatim replacement for the Korean intro block)

```markdown
> 🇰🇷 **한글 안내**
>
> Tierkit은 AI 코딩 CLI를 위한 **로컬 우선 비용 최적화 레이어 / 토큰
> 방화벽**입니다. Claude Code, Codex CLI, Gemini CLI, Roo Code, Cline,
> Continue, aider 같은 도구가 비싼 클라우드 모델을 덜 쓰면서도 같은 작업
> 품질을 유지하도록, 클라우드 호출 직전에 로컬에서 파일을 찾고, 압축하고,
> 시크릿을 마스킹하고, baseline vs compressed를 실측 usage로 비교하고,
> 쉬운 작업은 로컬/프라이빗 모델로 처리합니다.
>
> - 빠른 시작: 아래 [Quick start](#quick-start) 섹션
> - 설치부터 첫 모델 호출: [docs/GUIDE.ko.md](docs/GUIDE.ko.md)
> - VS Code 확장 마켓플레이스 publish: [docs/PUBLISH.ko.md](docs/PUBLISH.ko.md)
> - VS Code 확장 직접 설치: 마켓플레이스 페이지에서 **Install**
```

## Appendix C — Rewritten `docs/SPEC.md` §0–§2 (verbatim)

```markdown
## 0. Identity

**Tierkit — Local-first Cost Optimizer for AI Coding CLIs.**

Tierkit sits between an AI coding CLI (Claude Code, Codex CLI, Gemini CLI,
Roo Code, Cline, Continue, aider) and the model providers it would call.
Its job is to spend fewer cloud-model tokens at equal task quality by:

1. compressing repository context with local-first techniques before
   anything leaves the machine;
2. handing as many sub-tasks as possible to local or private-remote models
   (file ranking, summarization, low-risk drafts and reviews);
3. routing the genuinely hard or risky decisions — and only those — to the
   premium cloud model the user actually pays for; and
4. measuring the trade-off every time, so the user can see exactly how
   many tokens they stopped paying for and whether the quality held.

### One-line definition

> Tierkit is a local-first cost optimizer and token firewall for AI coding
> CLIs.

한국어:

> Tierkit은 AI 코딩 CLI가 로컬 모델과 프라이빗 모델을 활용해 클라우드
> 토큰 사용량을 줄이고, 필요한 순간에만 고성능 클라우드 모델로 상승시키는
> 비용 최적화 레이어다.

---

## 1. Positioning

| Aspect | Position |
|---|---|
| What it is | A local-first **cost optimizer and token firewall** for AI coding CLIs. |
| What it is not | A replacement for Claude / GPT / Gemini. Not a coding agent in its own right. Not a plugin marketplace. |
| Primary user outcome | Same coding result, fewer premium-cloud tokens. Credible path from Max 20× → Max 5× → Pro on Claude pricing tiers. |
| Distribution surface | CLI (`tierkit ...`) + VS Code extension + HTTP loopback daemon + OpenAI-compatible gateway + MCP server (from v0.13). |
| Strategic filter | *Does this reduce cloud cost, or stretch the same budget further at equal quality?* If no, it's an advanced/secondary feature. |

The plugin runtime, adapter exports, workflow sessions, and policy rules
remain in the codebase as **implementation mechanisms** of cost
optimization — not as the headline product.

---

## 2. Problems Tierkit solves

1. **Premium-cloud bills compound fast.** Most AI coding sessions burn
   tokens on context that the model didn't actually need to make the right
   decision.
2. **Local compute often sits idle.** Modern dev machines can usefully
   pre-rank files, summarize logs, and compress prompts before any cloud
   call — but no one has tied that to the cloud-CLI flow.
3. **Quality of compression isn't measured.** Most "context shrinkers"
   ship a saved-tokens number with no evidence the model still produces
   the right answer.
4. **Each AI coding CLI re-invents the same policy.** Risk gates, secret
   redaction, budget caps, fallback rules — every tool builds its own
   version, or none.
5. **Private/self-hosted models are second-class.** Existing CLI tools
   treat private endpoints as one of N providers, not as a deliberate
   middle tier between local and public.

Tierkit's answer: one cost layer that sits in front of every coding CLI,
applies the same compression + routing + quality + budget policy, and
shows the user — every day — how much they saved and whether the work
held up.
```

## Appendix D — GUI sidebar new card order + labels

New comment at `packages/core/src/runtime/ui/gui.ts:2`:

```
 * Single-file browser UI for the Tierkit runtime daemon — Cost Control.
```

New `i18n` table additions (next to existing `cardTools / cardPlugins / cardModels / cardUsage / cardDaemon / cardActivity`):

```js
// English
groupSavings: 'Savings',
groupCurrentProject: 'Current project',
groupCostRouting: 'Cost routing',
groupAdvanced: 'Advanced',
cardSavingsToday: 'Today',
cardCurrentArtifact: 'Last compressed context',
cardLocalModels: 'Local + private + cloud models',
labelLocalCompressor: 'Local Compressor',
labelLocalReviewer: 'Local Reviewer',
labelCloudFinal: 'Cloud Final',
labelTierOrder: 'Tier order',
labelTierOrderValue: 'local → private → public',
actionBuild: 'Build compressed context',
actionCompare: 'Compare baseline vs compressed',
actionSend: 'Send compressed prompt',

// Korean
groupSavings: '절감',
groupCurrentProject: '현재 프로젝트',
groupCostRouting: '비용 라우팅',
groupAdvanced: '고급',
cardSavingsToday: '오늘',
cardCurrentArtifact: '마지막 압축 컨텍스트',
cardLocalModels: '로컬 + 프라이빗 + 클라우드 모델',
labelLocalCompressor: '로컬 압축기',
labelLocalReviewer: '로컬 리뷰어',
labelCloudFinal: '클라우드 최종',
labelTierOrder: '계층 순서',
labelTierOrderValue: '로컬 → 프라이빗 → 퍼블릭',
actionBuild: '압축 컨텍스트 생성',
actionCompare: '베이스라인 vs 압축 비교',
actionSend: '압축 프롬프트 전송',
```

Existing card order (from `gui.ts:622–717`):

```
groupIntegrations
  └─ cardTools (Connected tools)
  └─ cardPlugins (Active plugins)
groupConfiguration
  └─ cardModels (Model profiles)
  └─ cardDaemon (Daemon controls)
groupActivity
  └─ cardUsage (Today's usage)
```

New card order:

```
groupSavings
  └─ cardSavingsToday (Today: tokens saved / cost saved / calls avoided)
groupCurrentProject
  └─ cardCurrentArtifact (Last build/compare with action buttons)
groupCostRouting
  └─ cardLocalModels (per-role model selectors + tier order + presets)
groupIntegrations
  └─ cardTools (Connected tools — gateway/helper/mcp/export per tool)
groupAdvanced  (collapsed by default)
  └─ cardPlugins (Active policy rules)
  └─ cardModels (Model profile CRUD)
  └─ cardDaemon (Daemon controls)
  └─ cardUsage (Today's usage — raw counts; the savings card aggregates)
```

**In v0.11.1 PR:** rename labels, regroup. Card *content* stays the same where the underlying data is the same (e.g., `cardTools`, `cardPlugins`, `cardModels`, `cardDaemon`, `cardUsage` are existing cards — only their headings, grouping, and order change). The new `cardSavingsToday` and `cardCurrentArtifact` cards are **stubs** that read from the existing `/v1/usage` and `/v1/context/:id` (the latter does not exist yet — until then, the stub shows the most recent artifact directory under `.tierkit/runtime/context-artifacts/` by filesystem mtime). `cardLocalModels` is a *visual* regrouping of existing `cardModels`'s data behind clearer per-role labels.

## Appendix E — CLI top-level help rewrite

Replace the current alphabetical clipanion category list with a categorized one whose first category is `Savings`. Achieved by editing each command's `static override usage = Command.Usage({ category: ... })` value. **No command path / flag changes.**

```
Tierkit  v0.11.x  ·  local-first cost optimizer for AI coding CLIs

Savings (the headline)
  tierkit context build "<task>"           build a compressed context (no LLM call)
  tierkit context show <id> [--json]       inspect a built context
  tierkit context send <id> --profile <p>  send compressed prompt to a model
  tierkit context compare <id> --profile <p> [--yes]
                                           A/B baseline vs compressed on the same task
  tierkit usage [--since today]            report tokens / cost so far

Cost routing  (how Tierkit picks where each call goes)
  tierkit route explain "<task>"           show the chosen tier + reason
  tierkit route run "<task>" [--mode plan|review|execute]
  tierkit models list                      list local / private / cloud profiles
  tierkit models test <profile>            probe a profile for reachability
  tierkit config show [--reveal-env]       print effective tierkit.config.json

Integrations  (let your AI coding CLI go through Tierkit)
  tierkit connect roo|cline|continue       wire an existing tool to Tierkit
  tierkit export roo|cline|continue|generic   export plugin policy for a tool

Diagnostics
  tierkit doctor                            check setup
  tierkit check command|path|redact         classify shell command, path, or content
  tierkit runtime start|stop|status         loopback HTTP daemon controls

Advanced  (policy rules, workflow gates, profile/plugin editing)
  tierkit plugin list|new|enable|disable|remove|install|sync|validate
  tierkit session start|status|advance|approve-plan|abandon
  tierkit profile add|remove
  tierkit init                              create a workspace tierkit.config.json
```

This is achieved by changing the `category:` field on each command's `Command.Usage` block. Categories that exist today: `Check`, `Config`, `Connect`, `Context`, `Doctor`, `Export`, `Init`, `Models`, `Plugin`, `Profile`, `Route`, `Routing`, `Runtime`, `Session`, `Usage`. New categories: `Savings`, `Cost routing`, `Integrations`, `Diagnostics`, `Advanced`. Old categories are deleted (each command moves to the new one).

## Appendix F — Rewritten package descriptions

```jsonc
// package.json (root)
"description": "Local-first cost optimizer and token firewall for AI coding CLIs."

// packages/core/package.json
"description": "Tierkit core — context compression, secret redaction, cost-aware model routing, quality comparison, plugin runtime. Tool- and CLI-framework-agnostic."

// packages/cli/package.json
"description": "The `tierkit` CLI — measure token savings, build compressed contexts, route work across local / private / cloud models, and audit cost."

// packages/agent/package.json
"description": "Tierkit's built-in coding agent — optional local-first executor that benefits from Tierkit's cost layer (compression / routing / quality / budget) without needing an external CLI."

// packages/adapter-roo/package.json
"description": "Tierkit integration for Roo Code / Zoo Code. Routes Roo's model calls through Tierkit's cost layer or exports policy as `.roomodes` + `.roo/`."

// packages/adapter-cline/package.json
"description": "Tierkit integration for Cline. Routes Cline's model calls through Tierkit's cost layer or exports policy as `.clinerules/`."

// packages/adapter-continue/package.json
"description": "Tierkit integration for Continue. Routes Continue's model calls through Tierkit's cost layer or exports policy as `.continue/{config.yaml, rules, prompts}`."

// packages/client/package.json
"description": "Typed HTTP client for the Tierkit cost-layer daemon. Used by VS Code extensions, web UIs, and any tool integrating with a running `tierkit runtime`."

// packages/plugin-superpowers/package.json
"description": "Bundled Tierkit policy rule packs (currently named `superpowers-{free,guided,balanced,strict}` — slug rename deferred to v0.13). Apply per-task discipline and tool permissions on top of cost routing."

// packages/vscode-tierkit/package.json + package.nls.json
"description": "Local-first cost optimizer for AI coding CLIs — runs the Tierkit daemon and shows real-time token savings, compressed-vs-baseline quality, and cost routing in a VS Code sidebar."
```

## Appendix G — `docs/INTEGRATIONS.md` lead paragraph rewrite

Replace the current title and intro paragraph (`docs/INTEGRATIONS.md:1–6`) with:

```markdown
# Tierkit — Integrations as savings channels

Every supported AI coding CLI is a place Tierkit can save tokens. Each
integration below is rated by its *savings posture* (how aggressively
Tierkit can compress + route on that tool's behalf) and its *interception
style* (gateway / helper / MCP / export-first). Integrations are not
themselves a milestone — they are how the cost layer reaches the user.

## Interception styles

- **Gateway** — Tierkit's OpenAI-compatible endpoint is the tool's model
  provider. Compression and routing happen server-side before the request
  leaves the machine. Used by: Codex CLI, Roo Code, Cline, Continue, aider.
- **Helper** — Tierkit exposes commands (`tierkit context build/send`)
  that the user invokes alongside the tool. The tool's own agent loop is
  not intercepted. Used by: Claude Code today (until MCP path is validated).
- **MCP** — Tierkit exposes itself as an MCP server the tool can call
  when it *wants* compressed context. Planned: Claude Code, Gemini CLI
  (v0.13+).
- **Export-first** — Tierkit writes policy files (`.roomodes`,
  `.clinerules/`, `.continue/config.yaml`) that the tool reads at startup.
  Lighter-touch integration, no live cost layer. Useful as a fallback.

## Savings posture per integration

| Tool | Style today | Style target | Savings effective |
|---|---|---|---|
| Codex CLI            | gateway      | gateway + compression policy (v0.13) | partial |
| Roo Code             | gateway      | gateway + compression policy (v0.13) | partial |
| Cline                | gateway      | gateway + compression policy (v0.13) | partial |
| Continue             | gateway      | gateway + compression policy (v0.13) | partial |
| aider                | gateway      | gateway + compression policy (v0.13) | partial |
| Claude Code          | helper       | helper + MCP (v0.13)                | manual today |
| Gemini CLI           | (none)       | MCP (v0.13)                          | not yet |
```

The rest of `docs/INTEGRATIONS.md` (existing per-tool wiring instructions, OpenAI-compatible endpoint URL, etc.) stays as-is. v0.11.1 PR replaces only the lead title + intro + posture table; per-tool sections are not rewritten until each integration is actually upgraded in v0.13.
