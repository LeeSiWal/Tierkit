# Tierkit

**Tierkit** is a local-first cost optimizer and policy gateway for AI coding
agents. Two distribution surfaces:

1. **OpenAI-compatible gateway** — point Roo, Cline, Continue, or any
   OpenAI-compatible coding agent at Tierkit's loopback endpoint and gain
   routing (local-first, subscription before per-token), redaction, budget,
   and approval gates without changing the agent.
2. **MCP server** — expose Tierkit's gated tools (file I/O, search, patch,
   command execution) to Claude Code, Claude Desktop, and any MCP-aware
   agent. Tierkit becomes the local policy gateway; the agent remains in
   the calling client. See [docs/MCP_BRIDGE.md](docs/MCP_BRIDGE.md).

> **Status: v0.17.0** — Telemetry completion + GUI per-tool rendering + Windows hardening + cross-OS CI. See [CHANGELOG.md](CHANGELOG.md#0170--2026-05-22). Key milestones:
>
> - **v0.11** — deterministic `tierkit context build / show / send / compare` CLI for measuring real savings.
> - **v0.12** — cost-aware routing v2 with `paymentModel` dimension (free / flat-rate / per-token), per-profile USD + input-token caps, `/v1/usage.profiles`, GUI per-profile bars.
> - **v0.13** — subscription-CLI provider (claudeCode) with subprocess execution, stream degrade, pinned-no-fallback routing.
> - **v0.14** — zero-CLI onboarding, daemon health checks, profile state unification.
> - **v0.15** — MCP Bridge: `@tierkit/mcp-server` with 7 gated tools, ephemeral patch tickets, approval flow (CLI + GUI), `run_command` sandbox, activity log.
> - **v0.16** — Windows unlock (`.cmd` shim resolution, env propagation), Tool Result Envelope (`tool-result-envelope.v1`) for all long-output tools, timeout policy (300 s default, doctor hint).
> - **v0.17** — Streaming usage telemetry (claudeCode now shows in activity panel), routing-based Savings card, per-tool envelope rendering (read_file/list_files/search_files/run_command + uniform failure card), Windows shell quoting + cross-OS CI matrix.
>
> See [`CHANGELOG.md`](CHANGELOG.md) for the full history.

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

---

## Architecture

Tierkit sits **between** your AI coding tool and the model providers. Tools point at Tierkit's loopback HTTP daemon; Tierkit applies policy, then calls the actual provider.

```
┌─ Editor / IDE / CLI ──────────────────────────────────┐
│  Roo Code · Cline · Continue · Claude Code · aider    │
└──────────────────────────┬────────────────────────────┘
                           │ HTTP (loopback only — 127.0.0.1:4101)
                           ▼
┌─ Tierkit daemon (Node) ───────────────────────────────┐
│                                                       │
│  /v1/openai/chat/completions  ← OpenAI-compat shim    │
│      │                                                │
│      ▼                                                │
│  ┌──────────────────────────────────────────────┐    │
│  │  Pipeline                                    │    │
│  │   ① Auto-router (risk + paymentModel)        │    │
│  │   ② Viability prune (API key? model pulled?) │    │
│  │   ③ Budget gate (per-profile USD + tokens)   │    │
│  │   ④ Workflow session gate (guided/strict)    │    │
│  │   ⑤ Secret redaction (env keys, PEM)         │    │
│  │   ⑥ Command-gate (rm -rf, dangerous shells)  │    │
│  │   ⑦ Provider chat + response-quality check   │    │
│  │   ⑧ Usage log + per-profile aggregate        │    │
│  └──────────────────────────────────────────────┘    │
│                       │                               │
│                       ▼                               │
│        ┌──────────────┼──────────────┐                │
│        ▼              ▼              ▼                │
│    Ollama         Anthropic        OpenAI             │
│  (local-device) (private-remote) (public-cloud)       │
└───────────────────────────────────────────────────────┘
                       ▲
                       │ loopback HTTP
                       │
┌─ GUI (browser + VS Code sidebar webview) ─────────────┐
│  Single inlined HTML at http://127.0.0.1:4101/        │
│   · Models card (toggle / test / delete profiles)     │
│   · Cost Control (per-profile budget bars)            │
│   · Current project — validation (build/compare/save) │
│   · Active plugins (install · enable · NL-generate)   │
│   · API Keys (`.tierkit/secrets.json` 0600)           │
└───────────────────────────────────────────────────────┘
```

### Layered data model (post-v0.12.3)

Profile state is unified into **one** source of truth — `disabledProfileIds` — read through the `isProfileDisabled(cfg, id)` helper. Two on-load idempotent migrations clean up legacy state automatically:

| Layer | Mechanism | Writers |
|---|---|---|
| **Identity** | `canonicalIdentity(profile) = "provider\|baseUrl\|model"` | helpers in `packages/core/src/model/profileIdentity.ts` |
| **Disabled state** | `disabledProfileIds: string[]` on `TierkitConfig` | `PATCH /v1/config/profile/:id` only |
| **Deletion** | `modelProfiles[id]: null` suppression marker | `DELETE /v1/config/profile/:id` (manually-added scopes only — bundled + discovered rejected with `400 cannot-delete-non-editable`) |
| **Dedup** | Discovery skips already-covered identities; GUI dedups display; migration collapses existing dupes | 3-layer defense in depth |

Config precedence (low → high): **bundled defaults → `~/.tierkit/config.json` → `<workspace>/tierkit.config.json` → Ollama auto-discovery (skips covered identities)**. Each profile carries a `source` tag (`bundled | user | workspace | discovered`).

### Loopback-only stance

- Daemon binds **`127.0.0.1`** only — no other machine can reach it.
- All `public-cloud` profiles default to **`review-only` + approval required**. They never auto-execute.
- Secrets are redacted before any remote call (`.env` patterns, API keys, PEM blocks).
- Danger classifier blocks `rm -rf /`, `curl | sh`, etc. pre-execution.
- **No telemetry, analytics, or phone-home.** Ever.

See [docs/SECURITY.md](docs/SECURITY.md) for the full security model.

---

## What's in this monorepo

| Package | What it does |
|---|---|
| [`@tierkit/core`](packages/core) | The daemon. Plugin loader, model profiles, routing, viability, budget, redaction, command-gate, workflow sessions, usage log, context compression usecases, the OpenAI-compat HTTP shim, and the GUI HTML (single inlined file). No CLI framework dep. |
| [`@tierkit/cli`](packages/cli) | The `tierkit` CLI (clipanion). Thin wrapper over `@tierkit/core` usecases. Self-contained binary; doesn't import the daemon. |
| [`@tierkit/agent`](packages/agent) | The tool-using agent loop (`/v1/agent/run` SSE). Built-in tools: `list_files`, `read_file`, `search_and_replace`, `codebase_search`, etc. Talks to the daemon via the OpenAI-compat endpoint. |
| [`@tierkit/client`](packages/client) | Typed HTTP SDK. `usage()`, `session.*()`, `models()`, `plugins()`, etc. |
| [`@tierkit/adapter-roo`](packages/adapter-roo) | Exports Tierkit plugins for Roo Code / Zoo Code (`.roomodes` + `.roo/`). |
| [`@tierkit/adapter-cline`](packages/adapter-cline) | Exports Tierkit plugins for Cline (`.clinerules/` + `.cline/mcp/`). |
| [`@tierkit/adapter-continue`](packages/adapter-continue) | Exports Tierkit plugins for Continue (`.continue/{config.yaml, rules, prompts, mcp}`). |
| [`@tierkit/plugin-superpowers`](packages/plugin-superpowers) | Bundled samples — `superpowers-free` / `guided` / `balanced` / `strict` |
| [`tierkit-vscode`](packages/vscode-tierkit) | VS Code extension. Activity-bar icon + webview that embeds the same daemon GUI; auto-starts the daemon on workspace open. |

---

## Quick start

Requires [ripgrep](https://github.com/BurntSushi/ripgrep) on `PATH` and at least one model profile with an API key (default: `claudeSonnet`) or a local Ollama model.

```sh
# 1. Build a deterministic compressed context for a task — no model call, no cost.
tierkit context build "fix payment success not unlocking premium report"

# 2. (Optional) Inspect what was selected and how it was compressed.
tierkit context show <ctx_id>

# 3. A/B baseline vs compressed on the same task — measures real provider usage.
#    Two paid model calls; TTY confirm or pass --yes for non-interactive.
tierkit context compare <ctx_id> --profile claudeSonnet --yes
```

After `compare` you'll see:

- baseline input tokens (estimated + actual)
- compressed input tokens (estimated + actual)
- savings in tokens, cost, and latency
- both response files saved side-by-side for human quality judgment

That output is the entire product loop. Everything else in Tierkit (cost routing, plugin policy, workflow sessions, adapter exports) is *how* the savings get larger and more automatic.

---

## Three ways to use Tierkit

Pick the entry point that matches your task.

### 1. CLI workflow — terminal-only, scriptable

```sh
tierkit context build "<task description>"
tierkit context show <ctx_id>
tierkit context send <ctx_id> --profile <profile_id>
tierkit context compare <ctx_id> --profile <profile_id> --yes
tierkit usage --by-profile
tierkit doctor
tierkit models list / test / show
tierkit plugin install / enable / disable / remove
tierkit session start / advance / approve-plan / abandon
tierkit route explain "<task>" --mode plan|review|execute
```

### 2. Sidebar Mission Control — GUI from the editor (v0.12.2+)

VS Code Marketplace → install [**Tierkit**](https://marketplace.visualstudio.com/items?itemName=leesiwal.tierkit-vscode) → open your project → click the Tierkit icon in the Activity Bar.

The sidebar embeds the same daemon GUI. Cards:

- **Connected tools** — one-click connect Roo / Cline / Continue (writes `.vscode/settings.json` for OpenAI-compat endpoints)
- **Active plugins** — install/enable/disable + `+ Describe & generate` for natural-language plugin creation
- **Recent activity** — last calls with model, latency, tokens
- **Today's usage** — calls / tokens / cost
- **Cost Control** — per-profile budget bars, payment-model breakdown, auto-escalation ceiling
- **Model profiles** — toggle / test / delete (only on manually-added rows), `+ Add` form supporting API-key paste
- **Current project — validation** (v0.12.2):
   1. Pick a recent task or type a new one → **Build** (no model call)
   2. See selected files + estimated savings
   3. Pick a model profile → **Compare**
   4. Confirm cost in a modal → live SSE stream of baseline + compressed responses side-by-side
   5. Save a quality verdict (`same` / `better` / `worse` / `unusable`) — stored as sidecar `verdict.json` per artifact

### 3. Agent — tool-using assistant (v0.10.x+)

POST `/v1/agent/run` (SSE) with a task, get back streamed events with `tool_call` / `tool_result` / `delta` / `usage` / `done`. The agent uses the same routing + redaction + budget pipeline as direct chat calls.

Built-in tools include `list_files` (respects ignore-globs), `read_file`, `search_and_replace`, `codebase_search`, `web_fetch`, `bash` (with command-gate). The GUI exposes this as a chat-style panel that streams the agent timeline live; you approve tool calls inline when the workflow session requires approval.

`modelId: "auto"` (default) lets the router pick. Pass an explicit profile id to pin.

---

## Cost routing

When a request hits `/v1/openai/chat/completions` with `model: "auto"`, Tierkit walks an **escalation chain** of model profiles. Routing decisions are observable via `tierkit route explain "<task>"`.

### Profile tiers + payment model (v0.12)

Two orthogonal dimensions:

| `kind` (tier) | Network |
|---|---|
| `local-device` | Ollama on `127.0.0.1` |
| `private-remote` | Anthropic, your own private API |
| `public-cloud` | OpenAI, Gemini |

| `cost.type` (paymentModel) | Caps that apply |
|---|---|
| `free` | input-token cap only (USD is meaningless) |
| `flat-rate` | input-token cap only (USD is fixed monthly subscription) |
| `per-token` | both USD and input-token caps |

### Escalation chain (v0.12.3)

`buildEscalationChain` walks `local-device → private-remote → public-cloud` up to a `ceiling` (default `public-cloud`), then appends **all lower tiers as tail fallback** so missing API keys fall through to local instead of dead-ending.

Inside a tier, profiles whose `goodAt: [...]` matches the current task type come first; profiles with `notGoodAt` covering the task type are hard-filtered out.

```sh
tierkit route explain "review my payment refund logic"
# Tier: private-remote (score 55: review-task keywords)
# Chain:
#   1. claudeSonnet     (private-remote, goodAt: code-review)
#   2. claudeHaiku      (private-remote)
#   3. gpt4o            (public-cloud) — requires approval
#   4. gpt4oMini        (public-cloud) — requires approval
#   5. localCoder       (local-device) — tail fallback
```

### Per-profile budgets (v0.12)

Cap each per-token profile's monthly spend in USD or input tokens, or both (whichever-first).

```jsonc
// tierkit.config.json
{
  "budget": {
    "monthlyUsdLimit": 100,
    "perProfile": {
      "claudeSonnet": { "monthlyUsdLimit": 20, "monthlyInputTokenLimit": 200000 },
      "gpt4o":        { "monthlyUsdLimit": 10 }
    }
  }
}
```

When the cap is reached the router skips that profile (`budget-exceeded` for the visible reason) and falls back to the next candidate. Inspect with:

```sh
tierkit usage --by-profile         # per-profile usage / caps / status
tierkit doctor                     # 80%+ warnings + blocked profiles
```

`per-token` caps both USD and input tokens; `flat-rate` and `free` only cap input tokens.

### Viability pre-flight

Before walking the chain, dead candidates are pruned:

- `local-device`: `GET <baseUrl>/api/tags` — model must be in the installed list. If not, `model-not-installed` and the chain walks on. The error message tells you `Run: ollama pull <model>`.
- `private-remote` / `public-cloud`: `apiKeyEnv` env var must be set (or the matching `.tierkit/secrets.json` entry exists).

### Auto-discovery dedup (v0.12.3)

Ollama auto-discovery (`/api/tags`) skips models already covered by an explicit profile. Canonical identity = `(provider, baseUrl, model)`. So if you have a bundled `localCoder` profile pointing at `qwen2.5-coder:7b`, the auto-discovered `ollama-qwen2-5-coder-7b` for the same model is **not** added — preventing the duplicate-row bug present in pre-v0.12.3 configs.

### Validation gate (v0.12.2 → v0.14)

The validation card lets you log human quality verdicts per artifact. Aggregated verdicts gate the v0.14 entry decision (local-LLM rerank/compress on top of the deterministic compressor). Run real tasks through the sidebar, save verdicts, then compile them with `tierkit validation-log` (v0.13 candidate) before flipping the v0.14 switch.

---

## Connecting AI coding tools

### Roo Code

Sidebar → **Connected tools** card → click `[Connect]` next to `roo`. Or:

```sh
tierkit connect roo
```

This writes 4 keys to `.vscode/settings.json` so Roo points at `http://127.0.0.1:4101/v1/openai`. **Reload the VS Code window** once afterward.

If Roo's UI ignores the settings (Roo 3.x sometimes does), use Roo's settings panel directly with the table in [docs/ROO.ko.md](docs/ROO.ko.md).

### Cline / Continue

Same flow: sidebar `[Connect]` button or `tierkit connect cline` / `tierkit connect continue`.

### Cloud API keys

Sidebar → **Model profiles** → `+ Add` → pick provider → paste API key. Keys land in `.tierkit/secrets.json` (`0600`, auto-`.gitignore`d). Shell env vars still work and take precedence:

```sh
export ANTHROPIC_API_KEY="sk-ant-..."
export OPENAI_API_KEY="sk-..."
export GEMINI_API_KEY="..."
```

### Direct verification (curl)

Confirm the daemon is routing correctly:

```sh
curl -sS -X POST http://127.0.0.1:4101/v1/openai/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role":"user","content":"list files in this project"}],
    "tools": [{
      "type":"function",
      "function": {
        "name":"list_files",
        "description":"List files",
        "parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}
      }
    }]
  }' | jq
```

A response with `tool_calls` + `finish_reason: "tool_calls"` means the tool-calling pipeline is healthy. The `tierkit` field on the response surfaces the chosen profileId + redaction count + cost.

---

## Plugin system

Tierkit plugins are **declarative rule bundles** — JSON manifest + Markdown rule files. Activating a plugin auto-injects its rules into the system prompt on every model call **and** auto-exports tool-specific configs (`.roomodes`, `.clinerules/`, `.continue/`) so connected tools see the same rules.

### Quick plugin authoring

```sh
# Scaffold + sample command/mode/rule
tierkit plugin new my-team-rules

# Edit
$EDITOR my-team-rules/tierkit.plugin.json

# Install + activate (auto-syncs to connected tools)
tierkit plugin install ./my-team-rules
tierkit plugin enable my-team-rules
```

### Natural-language plugin generation (v0.3.5)

Sidebar → **Active plugins** card → `+ Describe & generate`:

```
원하는 플러그인을 설명하세요
┌────────────────────────────────────┐
│ Python 프로젝트용 TDD-first 플러그인.│
│ 구현 전에 항상 실패하는 pytest 테스트│
│ 를 먼저 작성하게 함. 작은 커밋 선호. │
└────────────────────────────────────┘
[취소]  [생성 →]
```

LLM call routes via `auto`. Response is parsed as JSON → Zod-validated → previewed. Rule file names must match `^[0-9a-z][0-9a-z._-]*\.md$` (path-traversal defense). Drafts live in `.tierkit/runtime/plugin-drafts/<uuid>/` until installed.

### Bundled samples

- **`superpowers-free`** — minimal hygiene rules
- **`superpowers-guided`** — plan first, frequent commits, ask before destructive actions
- **`superpowers-balanced`** — guided + TDD + code-review reminders
- **`superpowers-strict`** — guided + balanced + plan-must-be-approved-before-execute gating

Strict packs use **workflow sessions**: `tierkit session start` puts the workspace into `plan` state. `execute`-class actions are gated until `tierkit session approve-plan` runs. See [docs/SPEC.md §2.4](docs/SPEC.md) for the state machine.

---

## Development setup

```sh
pnpm install
pnpm -r build
pnpm -r test --run
pnpm -r typecheck
```

The monorepo uses pnpm workspaces. Each package has its own `tsup.config.ts`. Tests are vitest. The `tsup` build define injects `TIERKIT_VERSION` from each `package.json` into the bundled output — bumping a version automatically propagates into the GUI HTML.

```sh
# Watch mode for the daemon (auto-rebuild on save)
pnpm --filter @tierkit/core dev

# Watch + auto-restart daemon
pnpm dev:daemon

# Build the VS Code extension .vsix
cd packages/vscode-tierkit && pnpm run build && pnpm run package
# → tierkit-vscode-<version>.vsix
```

### Layout

```
packages/
├── core/                 ← daemon, GUI HTML, all business logic
│   ├── src/
│   │   ├── config/       ← loadConfig + migrations + profile CRUD
│   │   ├── model/        ← ModelProfile, RiskScorer, ModelRouter, providers
│   │   ├── runtime/      ← Server.ts + ui/gui.ts (inlined HTML)
│   │   ├── usecases/     ← business logic (build/show/compare/send, etc.)
│   │   └── context-compression/  ← v0.11 + v0.12.2 measurement loop
│   └── test/             ← vitest suites
├── cli/                  ← tierkit binary (clipanion)
├── agent/                ← tool-using agent loop
├── client/               ← typed HTTP SDK
├── adapter-{roo,cline,continue}/  ← tool-specific exporters
├── plugin-superpowers/   ← bundled sample plugins
└── vscode-tierkit/       ← VS Code extension (bundles @tierkit/core)
```

### Plan + spec workflow

For multi-step features, Tierkit uses the superpowers brainstorming → spec → plan → subagent-driven execution flow. Recent specs and plans live under:

- `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
- `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`

These document the *why* behind each release (v0.11.1, v0.12, v0.12.2, v0.12.3).

---

## Daemon troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `[bad-status] ollama responded with 404 Not Found` | Model not pulled on this machine | Message tells you the exact `ollama pull <model>` to run (v0.12.2+ friendly message) |
| `[missing-api-key] ANTHROPIC_API_KEY not set` after picking a remote profile | No API key on this machine | Auto-routing now falls back to local-device profiles as tail (v0.12.3); pin a specific profile if you want a different fallback |
| Models card shows duplicate rows | Pre-v0.12.3 config residue | First load after upgrade cleans up `tierkit.config.json` in place; `git diff` to see what changed |
| Toggle reverts after refresh | Pre-v0.12.3 stale `enabled: false` field | First load after upgrade strips the field and folds into `disabledProfileIds` |
| `cannot delete 'localCoder' (source: bundled)` | Trying to delete a bundled or auto-discovered profile | Use toggle (disable). Bundled samples + Ollama discovery recreate themselves on next load. |
| "데몬에 연결할 수 없습니다" (Windows) + 폴더 안 열림 | `startServer` cwd 못 잡음 | File → Open Folder + 명령 팔레트 **Tierkit: 데몬 재시작** |
| Hyper-V가 4101 예약 | Windows-side port reservation | `netsh interface ipv4 show excludedportrange protocol=tcp`; set `tierkit.baseUrl` to `http://127.0.0.1:5101` |
| Microsoft Store VS Code (UWP) blocks loopback | UWP isolation | Run as admin: `CheckNetIsolation LoopbackExempt -a -n="Microsoft.VisualStudioCode_8wekyb3d8bbwe"` |

Diagnostic logs: VS Code → **Output** panel → dropdown **Tierkit** — step-by-step auto-start logs.

---

## 5분 가이드 (한국어) — Roo Code + 로컬 모델로 코딩

### 1. 설치

VS Code Marketplace에서 [**Tierkit**](https://marketplace.visualstudio.com/items?itemName=leesiwal.tierkit-vscode) 확장 설치. **프로젝트 폴더를 열고** 활동 바의 Tierkit 아이콘 클릭 → 사이드바가 미션 컨트롤로 뜨면 OK.

### 2. 로컬 모델 준비

도구 호출 잘 따르는 코더 모델 추천 (4.7GB):

```bash
ollama pull qwen2.5-coder:7b
```

더 좋은 도구 호출 신뢰성:
```bash
ollama pull qwen2.5-coder:14b   # 9GB · 16GB+ RAM
```

Tierkit이 자동으로 `localCoder` 프로파일을 viable로 인식. (v0.12.3부터는 자동 발견과 sample이 같은 모델을 가리키면 중복 행 안 만듦.)

### 3. (선택) Superpowers 플러그인 활성화

워크스페이스에 행동 규율(plan 먼저, tests 우선 등) 적용:

```bash
cd <your-workspace>

# 번들 superpowers-balanced 설치
node <tierkit-source>/packages/cli/dist/index.js plugin install \
  <tierkit-source>/packages/plugin-superpowers/plugins/superpowers-balanced

# 활성화 — 자동으로 Roo/Cline/Continue에 룰 export 동반
node <tierkit-source>/packages/cli/dist/index.js plugin enable superpowers-balanced
```

또는 사이드바 → **Active plugins** → 번들 샘플 인라인 install+enable+init 버튼.

### 4. Roo Code 연결

사이드바 → **"연결된 도구" 카드** → `roo` 행 옆 **[연결]** 클릭. 또는 CLI:

```bash
tierkit connect roo
```

워크스페이스의 `.vscode/settings.json`에 4개 키 추가 — Roo가 Tierkit의 OpenAI-호환 엔드포인트(`http://127.0.0.1:4101/v1/openai`)로 모든 호출을 보냄.

**VS Code 윈도우 reload** 한 번 (Cmd/Ctrl+Shift+P → "Developer: Reload Window").

### 5. Roo의 설정 UI에서 직접 (Roo 3.x에서 필요한 경우)

Roo Code가 settings.json 키를 무시하면 (3.x에서 종종) Roo 아이콘 → ⚙ Settings:

| 필드 | 값 |
|---|---|
| API Provider | **OpenAI Compatible** ← 절대 `OpenAI` 아님 |
| Base URL | `http://127.0.0.1:4101/v1/openai` |
| API Key | `tierkit-loopback` (어떤 비어있지 않은 문자열도 OK) |
| Model ID | `auto` (또는 `localCoder` 등 특정 프로파일) |

**저장 후 반드시 VS Code Reload Window (Ctrl+R)**

자세한 Roo 설정 가이드: [**docs/ROO.ko.md**](docs/ROO.ko.md)

### 6. Roo 채팅창에서 task 실행

평소처럼 Roo 사용. Tierkit이 뒤에서:

```
Roo → Tierkit → [라우팅 → viability 체크 → shim → 룰 주입 → 모델] → tool_calls → Roo
```

Tierkit 사이드바 **"최근 활동"** 카드에 호출이 실시간 등장 → 연동 정상.

---

## Token-saving context compression (deeper dive)

Tierkit can reduce expensive cloud-model usage by building a **deterministic** compressed prompt from your workspace, then sending only that compressed prompt. No LLM is used for the compression step — it's ripgrep + regex-based skeleton/hotspot extraction.

### Pipeline

```
"fix payment success not unlocking premium report"
        │
        ▼
[ keyword extractor ] → ["fix", "payment", "premium", "report", "unlocking", "success"]
        │
        ▼ ripgrep across workspace (respects .gitignore + extraIgnoreGlobs)
        │
[ candidate files + line ranges ]
        │
        ▼ skeleton-extract (functions, classes, imports) + hotspot expansion
        │
prompt.md   ← stored at .tierkit/runtime/context-artifacts/<id>/
artifact.json
```

### Configuration

```jsonc
// tierkit.config.json
{
  "version": "0.1",
  "contextCompression": {
    "defaultMaxFiles": 8,
    "defaultCloudTokenBudget": 12000,
    "ignoreGlobs": ["vendor/**", "generated/**"]
  }
}
```

CLI flags override config; config overrides built-in defaults.

### Warning — do not share artifacts

`.tierkit/runtime/context-artifacts/` contains absolute workspace paths and raw source excerpts. Tierkit auto-creates `.tierkit/.gitignore` with `*` on first write, but **do not** copy these artifacts to issue trackers, gists, or shared docs.

---

## More

- 한글 시작 가이드: [docs/GUIDE.ko.md](docs/GUIDE.ko.md)
- **Roo Code 단독 설정 가이드** (정확한 값 + 자주 보는 에러 + 체크리스트): [docs/ROO.ko.md](docs/ROO.ko.md)
- 연결 가이드 (Roo/Cline/Continue 통합): [docs/CONNECT.ko.md](docs/CONNECT.ko.md)
- 디자인 스펙 (전체): [docs/SPEC.md](docs/SPEC.md)
- 보안 모델: [docs/SECURITY.md](docs/SECURITY.md)
- VS Code 마켓플레이스 publish 절차: [docs/PUBLISH.ko.md](docs/PUBLISH.ko.md)
- Recent design specs: [`docs/superpowers/specs/`](docs/superpowers/specs)
- Recent implementation plans: [`docs/superpowers/plans/`](docs/superpowers/plans)

---

## Roadmap

| Release | Status | What it adds |
|---|---|---|
| v0.11 | shipped | `tierkit context build / show / send / compare` deterministic compressor |
| v0.11.1 | shipped | Repositioning — local-first cost optimizer / token firewall framing |
| v0.12 | shipped | `paymentModel` (free/flat-rate/per-token), per-profile USD + input-token caps, `/v1/usage.profiles`, GUI per-profile bars |
| v0.12.2 | shipped | UI validation flow — 5 new `/v1/context/*` endpoints + SSE compare + sidecar `verdict.json` + GUI validation card |
| v0.12.3 | **current** | Model profile state unification — single `disabledProfileIds` source of truth, canonicalIdentity dedup, 2 on-load migrations |
| v0.13 | planned | Subscription CLI subprocess provider (Claude Code / Codex), MCP server, validation-log generator (`tierkit validation-log`) |
| v0.14 | gated | Local-LLM rerank/compress on top of the deterministic compressor — entry gated by v0.12.2 verdict aggregation |

Non-goals (explicit, deferred):

- Cross-machine sync of disabled state — stays local.
- LLM-based auto-verdict — the human verdict IS the validation gate.
- Telemetry of any kind.

---

## License

MIT
