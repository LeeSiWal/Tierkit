# Tierkit — Design Specification

> Authored by the project owner on 2026-05-15. Canonical truth source for the Tierkit project. Future implementation choices defer to this document unless explicitly amended by the owner.

---

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
| Distribution surface | CLI (`tierkit ...`) + VS Code extension + HTTP loopback daemon + OpenAI-compatible gateway + MCP server (from v0.13, planned). |
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

---

### 2.5 Payment models (v0.12)

Every `ModelProfile` has an optional `paymentModel: free | flat-rate | per-token`. When omitted, it's derived from `kind` (`local-device` → `free`, `private-remote` → `free`, `public-cloud` → `per-token`). Explicit override wins.

- `free` — zero marginal token cost from Tierkit's perspective. Hardware / electricity / rental may still cost real money; "free" only means Tierkit will not bill or budget-gate per-call.
- `flat-rate` — subscription or fixed-cost access (Claude Code Max, ChatGPT Pro on Codex CLI, monthly rented GPU). NOT necessarily unlimited; subscription products typically have usage limits that Tierkit can protect via input-token caps.
- `per-token` — metered API billing by input/output tokens (direct Anthropic / OpenAI / Google API keys).

This dimension lets versions route preferentially: free → flat-rate → per-token. **v0.13: implemented** (Claude Code only; Codex CLI deferred to v0.13.1). v0.12 added the data and budget enforcement; the routing reorder and subscription-CLI execution both landed in v0.13 via `sortProfilesForTier` paymentModel ordering and the `claude-code` subprocess provider.

### 2.6 Per-profile budgets (v0.12)

`BudgetPolicy.perProfile` lets each profile carry its own daily/monthly caps in USD and/or input tokens. Boundary: `>` comparison — at-limit allowed, over-limit blocked.

Enforcement varies by `paymentModel`:

| paymentModel | USD enforced? | Input tokens enforced? |
|---|---|---|
| `per-token` | yes | yes |
| `flat-rate` | no (display-only metadata) | yes (subscription quota protection) |
| `free` | no (ignored — `tierkit doctor` warns if set) | yes (local resource protection) |

The gate runs **after `redactSecrets`** and **before `provider.stream`**, against the final post-redact `ChatRequest`. Per-profile block → skip candidate + return `budget-exceeded` with `details[]`. Global budget block → hard stop (single-line message, no details). Both have error code `budget-exceeded`; clients differentiate via `message` and `details` presence.

### 2.7 Validation flow (UI) (v0.12.2)

The Cost Control sidebar exposes the v0.11/v0.12 measurement loop as
a complete validation flow: task input → build → estimated savings →
cost-confirmation modal → SSE-streamed compare → savings summary →
human quality verdict saved to sidecar `verdict.json`.

Five HTTP endpoints under `/v1/context/*` (build / `:id` / recent /
`:id/compare` (SSE) / `:id/verdict`) wrap the existing core usecases.
The compare endpoint requires explicit `{ confirm: true }` in the
request body — without it, returns `412 confirm-required` with an
`estimated` cost payload (which is what the UI modal renders). One
compare per artifact at a time; second concurrent request returns
`409 compare-already-running`. SSE client disconnect aborts the
in-flight run best-effort; no background continuation.

Verdict storage is a sidecar `verdict.json` — no `ContextArtifact`
schema change. Verdict write requires that `artifact.compare`
exists, else `409 compare-not-run`. The recorded `qualityVerdict`
values (`same | better | worse | unusable`) feed the v0.14 entry
gate validation.

---

## 3. High-level architecture

```
Tierkit
│
├─ Core Runtime
│  ├─ Plugin Manifest
│  ├─ Plugin Loader
│  ├─ Command Registry
│  ├─ Workflow Engine
│  ├─ Hook Policy Engine
│  ├─ Model Router
│  ├─ Permission Manager
│  ├─ Context Redactor
│  └─ Usage / Cost Logger
│
├─ Agent Adapters
│  ├─ Zoo/Roo Adapter
│  ├─ Cline Adapter
│  ├─ Continue Adapter
│  ├─ Claude Code Adapter (future)
│  └─ Generic MCP Adapter
│
├─ Model Providers
│  ├─ Local Device
│  ├─ Private Remote
│  └─ Public Cloud
│
├─ Plugin Packs
│  ├─ superpowers-free
│  ├─ superpowers-guided
│  ├─ superpowers-balanced
│  └─ superpowers-strict
│
└─ CLI / Dev Tools
   ├─ tierkit init
   ├─ tierkit plugin validate
   ├─ tierkit plugin install
   ├─ tierkit export roo
   ├─ tierkit export cline
   └─ tierkit export continue
```

### Critical design change

Tierkit Core is an **independent package**. Each AI coding tool integrates via an **Adapter**. Core never reaches into tool-specific internals.

---

## 4. Monorepo structure

```
tierkit/
├─ packages/
│  ├─ core/
│  ├─ cli/
│  ├─ adapter-roo/
│  ├─ adapter-cline/
│  ├─ adapter-continue/
│  └─ plugin-superpowers/
│
├─ examples/
│  ├─ nextjs-app/
│  ├─ node-api/
│  └─ generic-workspace/
│
├─ docs/
│  ├─ SPEC.md
│  ├─ ARCHITECTURE.md
│  ├─ PLUGIN_FORMAT.md
│  ├─ MODEL_ROUTING.md
│  ├─ SECURITY.md
│  └─ ADAPTERS.md
│
├─ tierkit.config.json
├─ package.json
└─ README.md
```

---

## 5. Plugin format — `tierkit.plugin.json`

```json
{
  "schemaVersion": "0.1",
  "id": "superpowers-balanced",
  "name": "Superpowers Balanced",
  "version": "0.1.0",
  "description": "Balanced Superpowers-like workflow for AI coding agents",
  "author": "tierkit",
  "license": "MIT",
  "compatibility": {
    "tierkit": ">=0.1.0",
    "targets": ["roo", "zoo", "cline", "continue"]
  },
  "components": {
    "commands": [
      { "name": "brainstorm", "file": "commands/brainstorm.md", "description": "Explore requirements and implementation approaches", "category": "planning" },
      { "name": "review",     "file": "commands/review.md",     "description": "Review current diff or selected files",           "category": "review"   }
    ],
    "modes": [
      { "id": "planner",  "name": "Planner",  "file": "modes/planner.md",  "tools": ["read", "search"], "role": "planner"  },
      { "id": "reviewer", "name": "Reviewer", "file": "modes/reviewer.md", "tools": ["read", "search"], "role": "reviewer" }
    ],
    "rules": [
      "rules/local-first.md",
      "rules/planning-required-for-multi-file.md",
      "rules/safety.md"
    ],
    "workflows": [
      "workflows/planning.json",
      "workflows/review.json"
    ],
    "hooks": [
      "hooks/dangerous-command-require-approval.json"
    ],
    "mcpServers": "mcp/mcp.json"
  },
  "permissions": {
    "readFiles": true,
    "editFiles": true,
    "runCommands": true,
    "registerMcp": false,
    "useLocalDeviceModel": true,
    "usePrivateRemoteModel": true,
    "usePublicCloudModel": true,
    "accessSecrets": false
  },
  "modelPolicy": {
    "defaultTier": "local-strong",
    "preferPrivateRemoteBeforePublicCloud": true,
    "publicCloudRequiresApproval": true,
    "publicCloudDefaultMode": "review-only"
  },
  "freedom": {
    "level": "balanced"
  }
}
```

---

## 6. Config file — `tierkit.config.json`

```json
{
  "version": "0.1",
  "activePlugins": ["superpowers-balanced"],
  "defaultTarget": "roo",
  "modelProfiles": {
    "localFast": {
      "kind": "local-device",
      "provider": "ollama",
      "baseUrl": "http://localhost:11434",
      "model": "qwen2.5-coder:7b",
      "roles": ["summarizer", "simple-coder"],
      "cost": { "type": "free" }
    },
    "localStrong": {
      "kind": "local-device",
      "provider": "ollama",
      "baseUrl": "http://localhost:11434",
      "model": "qwen2.5-coder:32b",
      "roles": ["coder", "debugger"]
    },
    "privateRemoteStrong": {
      "kind": "private-remote",
      "provider": "openai-compatible",
      "baseUrl": "https://my-private-llm.example.com/v1",
      "model": "qwen-coder-72b",
      "apiKeyEnv": "TIERKIT_PRIVATE_LLM_KEY",
      "roles": ["planner", "reviewer", "complex-coder"],
      "requiresApproval": false
    },
    "publicCloudPremium": {
      "kind": "public-cloud",
      "provider": "anthropic",
      "model": "claude-sonnet",
      "roles": ["architect", "critical-reviewer"],
      "requiresApproval": true,
      "defaultMode": "review-only"
    }
  },
  "routingPolicy": {
    "default": "localFast",
    "preferPrivateRemoteBeforePublicCloud": true,
    "publicCloudRequiresApproval": true,
    "publicCloudDefaultMode": "review-only",
    "riskThresholds": {
      "localFastMax": 25,
      "localStrongMax": 50,
      "privateRemoteMax": 75,
      "publicCloudReviewMin": 76
    }
  },
  "security": {
    "redactSecretsForRemote": true,
    "blockSecretFiles": true,
    "dangerousCommandsRequireApproval": true
  },
  "budget": {
    "dailyUsdLimit": 3,
    "monthlyUsdLimit": 30,
    "warnAtPercent": 70,
    "blockAtPercent": 100
  }
}
```

---

## 7. Target adapters

Tierkit never directly drives an IDE. Each tool has an **adapter** that converts Tierkit plugins into that tool's native config.

```
Tierkit Plugin
      │
      ├─ export roo       → .roomodes, Roo/Zoo rules, command prompts
      ├─ export cline     → .clinerules, workflow prompts, MCP config
      ├─ export continue  → config.yaml / assistant rules / prompts / model config
      └─ generic          → markdown prompts + MCP config + model profiles
```

### 7.1 Zoo/Roo adapter (v0.2)

Supports: modes → `.roomodes`, rules → mode instructions, commands → slash command templates, MCP servers → MCP config, modelPolicy → Roo provider/profile guidance.

Hard parts (deferred): real hook runtime, agent-loop intervention, live model router.

### 7.2 Cline adapter (v0.3)

Supports: rules → `.clinerules`, commands → prompt templates, workflows → task prompt packs, modelPolicy → Cline model profile guide, MCP → MCP config guide/export.

Hard parts: injecting slash commands into Cline; UI-level plugin manager.

### 7.3 Continue adapter (v0.4)

Supports: model profiles → Continue provider config, rules → custom instructions, commands → prompt templates, MCP → agent mode MCP config, local/private/public model split.

Hard parts: full sync of Continue's autocomplete/edit/chat model selection with Tierkit router; enforcing workflow state machine.

---

## 8. Execution mode strategy

**Method A — Export-first (v0.1–v0.3, MVP).** Tierkit plugin → `tierkit export <target>` → tool-specific config files → user uses the tool normally.

**Method B — Runtime-integrated (v1.0+).** Tierkit daemon/extension intercepts tool requests and enforces routing, permissions, cost, and workflow policy live.

> Start with Export-first. Move to Runtime-integrated only after the export pipeline and plugin format are validated.

---

## 9. Model routing

Tiers:
1. `local-device`
2. `private-remote`
3. `public-cloud`

Universal commands (translated per adapter):

```
/local-only
/private
/review-private
/escalate
/review-cloud
/model
/router
/cost
```

---

## 10. Plugin freedom levels

| Level | Purpose | Enforcement |
|---|---|---|
| `superpowers-free`     | Command pack            | Almost none |
| `superpowers-guided`   | Encourages good habits  | Approval on dangerous commands |
| `superpowers-balanced` | Practical default       | Plan before multi-file edits; review after big diffs; approval on dangerous work |
| `superpowers-strict`   | Closest to Superpowers original | Plan approval before implementation; TDD workflow forced; review required before "finish" |

---

## 11. Security

**Core principles:**
1. Plugins have **no** command execution permission by default.
2. MCP server registration **always** requires user approval.
3. Public-cloud context is auto-redacted.
4. Private-remote is still remote — secret redaction applies.
5. Hooks in v0.x are declarative only. Arbitrary shell hooks land in v1.0+, disabled by default.
6. Plugin install displays a permission manifest before consent.
7. Adapters never downgrade a high-risk permission to a low one when translating.

---

## 12. Permission enum

```ts
type TierkitPermission =
  | "readFiles"
  | "editFiles"
  | "runCommands"
  | "registerMcp"
  | "useLocalDeviceModel"
  | "usePrivateRemoteModel"
  | "usePublicCloudModel"
  | "accessSecrets"
  | "modifyAgentSettings"
  | "installDependencies"
  | "useNetwork";
```

Each permission is translated per target (Roo custom mode tools, Cline rule instructions, Continue config/instructions).

---

## 13. Hook format (declarative, v0.x)

```json
{
  "id": "dangerous-command-require-approval",
  "event": "beforeCommandRun",
  "match": "(rm -rf|git reset --hard|git clean -fd|npm publish|pnpm publish)",
  "action": "requireApproval",
  "message": "Dangerous command detected. Manual approval required."
}
```

v0.x: "soft hook" (declarative; adapters render hints/rules). v1.x: "hard hook" (runtime enforcement).

---

## 14. CLI surface

```
tierkit init [--target <tool>]
tierkit plugin validate <path>
tierkit plugin install <path>
tierkit list
tierkit export roo
tierkit export cline
tierkit export continue
tierkit models test
tierkit route explain "<task description>"
tierkit doctor
```

---

## 15. Roadmap

| Version | Goal |
|---|---|
| v0.1 | Common plugin format + CLI (`validate`, `install`, generic markdown `export`); `superpowers-free` sample; `docs/PLUGIN_FORMAT.md`. Adapter interface only — no concrete adapters yet. |
| v0.2 | Zoo/Roo exporter ✅ shipped 2026-05-15 — `tierkit export roo` (alias: `export zoo`), produces `.roomodes` + `.roo/{commands,rules,mcp,TIERKIT.md}` |
| v0.3 | Cline exporter ✅ shipped 2026-05-15 — `tierkit export cline`, produces `.clinerules/` (permission contract + rules + modes-as-personas + commands-as-rules) + `.cline/mcp/` |
| v0.4 | Continue exporter ✅ shipped 2026-05-15 — `tierkit export continue`, produces `.continue/{config.yaml, rules/, prompts/, mcp/, TIERKIT.md}`. `.prompt` files become native Continue slash commands; `config.yaml::models[]` populated from `tierkit.config.json::modelProfiles`. |
| v0.5 | Model profiles + `route explain` + risk score + cost policy ✅ shipped 2026-05-15 — `tierkit models list/test`, `tierkit route explain`, `tierkit config show`. Provider clients: ollama, openai/openai-compatible, anthropic. Probe latency + model-availability check. API keys referenced via `apiKeyEnv`, never inlined; `config show` masks values by default. |
| v0.6 | Security + redaction + dangerous command policy ✅ shipped 2026-05-15 — `tierkit check {redact,command,path}` CLI; sensitive-file blocklist enforced in `PluginLoader` and `exportTarget` (override: `allowSensitive`); dangerous-command classifier with `block`/`warn`/`ok` severities; extended secret-redaction rules (Anthropic api03, Slack, Stripe, Google AIza, PEM private keys, JWT, basic-auth-in-URLs); `tierkit doctor` warns on risky permission combos and weakened security policy. |
| v1.0 | Runtime alpha — first runtime-integrated adapter, command interception, model routing UI, usage log |

---

## 16. Differentiators

1. Common plugin format, not tied to any one agent.
2. Generalizes Claude Code-style plugin UX into an open format.
3. Superpowers-like workflow available at four freedom tiers.
4. Local → Private Remote → Public Cloud routing.
5. Public cloud defaults to review-only.
6. Cost/risk-driven escalation.
7. Export-first for fast adoption, runtime-integrated for the next phase.

---

## 17. README positioning (target copy)

```
# Tierkit

Tierkit is a local-first cost optimizer and token firewall for AI coding CLIs.
It helps tools like Claude Code, Codex CLI, Gemini CLI, Roo Code, Cline, Continue, and aider spend fewer cloud tokens — without losing task quality. Before any premium cloud model sees your project, Tierkit can search files locally, compress them into a minimal high-signal prompt, redact secrets, compare compressed vs. baseline output side-by-side with real provider usage, and route easy work to your local or private models so the expensive model is only used when it actually has to be.
```

> Note: §17 is preserved as the historical "target copy" anchor. The
> canonical lead identity is §0 (Identity) + §1 (Positioning). When the
> README copy and §17 disagree, §0/§1 win. §17 updated in v0.11.1 to keep
> the two in sync.

---

## 18. v0.1 build prompt (canonical)

> Build Tierkit as an open-source TypeScript monorepo. v0.1 scope: `packages/core`, `packages/cli`, `packages/plugin-superpowers`; `tierkit.plugin.json` schema; `plugin validate`; `plugin install` from a local folder; generic markdown `export`; `superpowers-free` sample plugin; `docs/PLUGIN_FORMAT.md`. Do not yet implement Roo/Cline/Continue exporters — but define the adapter interface they will implement. All manifests validated via zod. Block path traversal in the loader. Declare plugin permissions explicitly. Distinguish public-cloud from private-remote. v0.1 follows export-first; runtime-integrated is deferred past v1.0.

---

## 19. CLI framework decision (addendum 2026-05-15)

**Decision: Tierkit CLI uses [`clipanion`](https://mael.dev/clipanion/), not `commander`.**

Rationale:
1. Tierkit has many nested subcommands (`plugin`, `export`, `models`, `route`, `config`) and that surface will grow.
2. Class-based commands give one-file-per-command discipline (`PluginValidateCommand.ts`, `ExportRooCommand.ts`).
3. TypeScript-first option types match the rest of the project (manifest, model profile, adapter contract are all strict-typed; CLI should be too).
4. Avoids a later commander → clipanion migration cost since long-term growth is expected.

**Non-negotiable architectural rule:** `packages/core` must **not** import `clipanion`. Core stays CLI-framework-agnostic so it can also serve a VS Code extension, web UI, and the Tierkit daemon.

All business logic lives in `packages/core/src/usecases/` as plain async functions:

```ts
validatePlugin(input: ValidatePluginInput): Promise<ValidatePluginResult>
installPlugin(input: InstallPluginInput): Promise<InstallPluginResult>
listPlugins(input: ListPluginsInput): Promise<ListPluginsResult>
exportTarget(input: ExportTargetInput): Promise<ExportResult>
explainRoute(input: ExplainRouteInput): Promise<RouteDecision>
initProject(input: InitProjectInput): Promise<InitProjectResult>
doctor(input: DoctorInput): Promise<DoctorResult>
```

`packages/cli` is a thin layer: clipanion `Command` classes parse args/options, invoke a usecase, then format output.

### Confirmed v0.1 stack

| Concern | Choice |
|---|---|
| Language | TypeScript |
| Monorepo | pnpm workspaces |
| CLI | clipanion |
| Schema | zod |
| Test | vitest |
| Build | tsup |
| Format/lint | prettier + eslint |

### v0.1 CLI surface

```
tierkit init
tierkit plugin validate <path> [--strict]
tierkit plugin install <path>
tierkit plugin list
tierkit export generic [--out <dir>]
tierkit doctor
```

Deferred to v0.2+: `export roo`, `export cline`, `export continue`, `models *`, `route explain`, `config *`, `plugin remove`, `plugin permissions`, `plugin trust`.

### CLI package layout

```
packages/cli/src/
├─ index.ts                # bin entry
├─ cli.ts                  # clipanion Cli instance + command registration
├─ context/CliContext.ts   # cwd, stdout/stderr, env wiring
├─ commands/
│  ├─ InitCommand.ts
│  ├─ DoctorCommand.ts
│  ├─ plugin/
│  │  ├─ PluginValidateCommand.ts
│  │  ├─ PluginInstallCommand.ts
│  │  └─ PluginListCommand.ts
│  └─ export/
│     └─ ExportGenericCommand.ts
└─ output/
   ├─ printIssues.ts
   ├─ printPluginList.ts
   └─ printExportResult.ts
```

## Context compression (v1.7-spike)

Deterministic, LLM-free pipeline that compresses workspace context for
one-shot CLI calls. Goal is to measure whether compressed prompts
preserve response quality vs. raw selected files.

**Module:** `packages/core/src/context-compression/`
**Usecases:** `buildCompressedContext`, `sendCompressedContext`, `compareCompressedContext`
**CLI:** `tierkit context build|show|send|compare`
**Store:** `.tierkit/runtime/context-artifacts/<id>/{artifact.json, prompt.md, baseline.md?, response-{baseline,compressed}.md?}`

Full design: [`docs/superpowers/specs/2026-05-19-v1.7-spike-context-compression-design.md`](superpowers/specs/2026-05-19-v1.7-spike-context-compression-design.md)

**Explicit non-goals in v1.7** (see spec for full list): local LLM
file-ranker / compressor, ModelRole system, CompressionMode enum,
OpenAI-compatible endpoint auto-compression, agent-loop integration
(Claude Code / Roo / Cline / Continue), GUI Token Savings card,
HTTP endpoints, tree-sitter, response-quality auto-judge, parallel
compare, multi-compare per artifact.
