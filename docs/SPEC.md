# Tierkit — Design Specification

> Authored by the project owner on 2026-05-15. Canonical truth source for the Tierkit project. Future implementation choices defer to this document unless explicitly amended by the owner.

---

## 0. Identity

**Tierkit — Local-first Hybrid Coding Agent Runtime**
for Cline, Zoo/Roo Code, Continue, and future AI coding agents.

Tierkit is **not** a Roo Code fork. It is a tool-agnostic plugin format + model routing runtime + workflow policy layer that lets the same plugins, workflows, and model policy be reused across multiple AI coding agents.

### One-line definition

> Tierkit is a local-first hybrid agent runtime that brings Claude Code-style plugins, Superpowers-like workflows, and cost-aware model routing to multiple AI coding agents.

한국어:

> Tierkit는 Claude Code식 플러그인 구조, Superpowers식 개발 워크플로우, 로컬/개인서버/클라우드 모델 라우팅을 여러 AI 코딩 에이전트에서 공통으로 사용할 수 있게 하는 런타임이다.

---

## 1. Positioning

| Old positioning | New positioning |
|---|---|
| Roo Code fork + plugin manager | Common plugin/runtime format for AI coding agents + Local-first hybrid model router + Workflow policy engine + Tool adapter layer |

Tierkit aims to become the **"plugin OS" for AI coding agents** — but not by trying to support every tool from day one. The realistic rollout is **Zoo/Roo → Cline → Continue**.

---

## 2. Problems Tierkit solves

1. Same workflow gets re-implemented per tool.
2. Superpowers-style discipline cannot be shared across tools.
3. Model selection policy is fragmented per tool.
4. Cost optimization across local / private remote / public cloud is hard.
5. Plugin install/permission/security policy is not standardized.

Tierkit's answer: one plugin format, written once; per-agent adapters translate/execute it.

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

Tierkit is a local-first hybrid plugin runtime for AI coding agents.
It lets you write one plugin format and adapt it to tools like Cline, Zoo/Roo Code, and Continue — while routing work across local models, private remote models, and public cloud models based on risk, cost, and workflow policy.
```

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
