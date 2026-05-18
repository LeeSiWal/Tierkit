# Tierkit

Tierkit is a local-first hybrid plugin runtime for AI coding agents.

It lets you write one plugin format and adapt it to tools like Cline, Zoo/Roo Code, and Continue — while routing work across local models, private remote models, and public cloud models based on risk, cost, and workflow policy.

> Status: **v0.10.10.** Critical fix to v0.10.9 force-edit: when the caller sets `toolChoice: "required"` (or a specific function), `llmCall.ts` now bypasses the XML tool-shim so the structured `tools` array + `toolChoice` flow through to the provider. Without this, the shim would silently strip them and the model only saw a polite XML system-prompt nudge — which weak local models ignored. With the bypass: cloud honors `tool_choice` natively; local Ollama receives `format` JSON-schema enforcement. v0.10.9: Force-edit mode — when the user asks for a code change ("fix X" / "수정해줘") and the model responds with just prose, AgentLoop retries the turn with `tool_choice: "required"` restricted to `write_file` / `apply_diff` / `search_and_replace`. Works on cloud (OpenAI/Anthropic/Gemini-OpenAI-compat honor `tool_choice` natively) AND local Ollama (translated to Ollama's `format` JSON schema, then the constrained JSON envelope is adopted as a toolCall). Composer has a `🪄 force edit` toggle for manual override. v0.10.8: streaming chat. v0.10.7: stale-daemon adoption fix. Adds LLM-generated plugins (describe a plugin in natural language → Tierkit auto-routes the description through an LLM → previews a manifest + rule files → one-click install), model management UI (add/delete profiles, paste API keys from the GUI), Gemini preset, cross-tier auto-fallback (local → private-remote → public-cloud), response quality evaluator (retries on refusal/empty/truncated/repetition), task-type classifier + per-profile `goodAt[]`, and budget-aware downgrade. Prior: tool-shim for weak local models, plugin-rule system-prompt injection, profile viability pre-flighting, mission-control sidebar, OpenAI-compatible endpoint for Roo/Cline/Continue/aider/etc. See the [roadmap in SPEC.md §15](docs/SPEC.md#15-roadmap).

> 🇰🇷 **한글 안내**
> - 빠른 시작: 아래 [한국어 안내](#한국어-안내) 섹션
> - 설치부터 첫 모델 호출: [docs/GUIDE.ko.md](docs/GUIDE.ko.md)
> - VS Code 확장 마켓플레이스 publish: [docs/PUBLISH.ko.md](docs/PUBLISH.ko.md)
> - VS Code 확장 직접 설치: [마켓플레이스 페이지](https://marketplace.visualstudio.com/items?itemName=leesiwal.tierkit-vscode)에서 **Install** 또는 `code --install-extension leesiwal.tierkit-vscode`

## What's in this monorepo

| Package | What it does |
|---|---|
| [`@tierkit/core`](packages/core)                                   | Plugin manifest, validator, loader, registry, model profile types, adapter interface, business-logic usecases. Has no dependency on any CLI framework or IDE. |
| [`@tierkit/cli`](packages/cli)                                     | The `tierkit` CLI built on [clipanion](https://mael.dev/clipanion/). Thin wrapper over `@tierkit/core` usecases. |
| [`@tierkit/adapter-roo`](packages/adapter-roo)                     | Exports Tierkit plugins for Roo Code / Zoo Code (`.roomodes` + `.roo/`). |
| [`@tierkit/adapter-cline`](packages/adapter-cline)                 | Exports Tierkit plugins for Cline (`.clinerules/` + `.cline/mcp/`). |
| [`@tierkit/adapter-continue`](packages/adapter-continue)           | Exports Tierkit plugins for Continue (`.continue/{config.yaml, rules, prompts, mcp}`). |
| [`@tierkit/plugin-superpowers`](packages/plugin-superpowers)       | Bundled sample plugins: `superpowers-free` (v0.1) plus `guided` / `balanced` / `strict` (later). |

## Quick start (v0.1)

```sh
pnpm install
pnpm -r build

# Validate the bundled sample plugin
node packages/cli/dist/index.js plugin validate packages/plugin-superpowers/plugins/superpowers-free

# Export it as plain markdown
node packages/cli/dist/index.js export generic --out ./dist/exports

# Or export for Roo / Zoo Code (.roomodes + .roo/ at the project root)
node packages/cli/dist/index.js export roo

# Or export for Cline (.clinerules/ + .cline/mcp/ at the project root)
node packages/cli/dist/index.js export cline

# Or export for Continue (.continue/{config.yaml, rules, prompts, mcp} at the project root)
node packages/cli/dist/index.js export continue

# v0.5 — inspect model routing
node packages/cli/dist/index.js models list
node packages/cli/dist/index.js models test localFast
node packages/cli/dist/index.js route explain "refactor the auth service" --files 8
node packages/cli/dist/index.js config show

# v0.6 — security checks
node packages/cli/dist/index.js check redact ./scratch.txt
node packages/cli/dist/index.js check command "rm -rf /"
node packages/cli/dist/index.js check path .env

# v1.0 — runtime alpha (loopback HTTP daemon)
node packages/cli/dist/index.js runtime start             # foreground; ^C to stop
node packages/cli/dist/index.js runtime status            # query daemon state
node packages/cli/dist/index.js usage                     # per-profile call/token/cost summary
node packages/cli/dist/index.js plugin enable superpowers-free
node packages/cli/dist/index.js plugin disable superpowers-free
node packages/cli/dist/index.js plugin remove superpowers-free

# Daemon endpoints (default http://127.0.0.1:4101)
#   GET  /                            ← browser GUI (alias for /v1/ui)
#   GET  /v1/health
#   POST /v1/route                    { task, filesTouchedEstimate?, involvesSecrets?, involvesProductionInfra? }
#   POST /v1/check/command            { command }
#   POST /v1/check/path               { path }
#   POST /v1/redact                   { text }
#   POST /v1/llm-call                 { profileId, messages, toolCommands? }
#   GET  /v1/usage
#   GET  /v1/budget
#   GET  /v1/session                  ← current session + effective freedom
#   POST /v1/session/start            { task }
#   POST /v1/session/approve-plan
#   POST /v1/session/advance          { toState: planning|implementing|reviewing|done|abandoned, reason? }
#   POST /v1/session/abandon          { reason? }
#   GET  /v1/models                   ← list configured profiles
#   POST /v1/models/test              { profileId }      ← probe reachability + model availability
#   GET  /v1/plugins                  ← list installed plugins
#
# v0.3.4 — model management + auto-fallback endpoints
#   GET    /v1/secrets                ← list env-var keys + masked previews (never plaintext)
#   POST   /v1/secrets                { key, value }   ← paste an API key from the GUI; persisted under .tierkit/secrets.json (mode 0600, .gitignore'd) and injected into process.env
#   DELETE /v1/secrets/:key           ← remove a key the GUI stored (shell-env values are never touched)
#   POST   /v1/config/profile         { id, profile, scope? }   ← add a model profile from the GUI
#   DELETE /v1/config/profile/:id     ← remove a profile
#   PATCH  /v1/config/routing         { autoEscalationCeiling?, budgetAwareDowngrade?, responseQualityCheck? }
#
# v0.3.5 — LLM-generated plugins
#   POST   /v1/plugins/generate       { description }   ← Tierkit auto-routes the description through an LLM, validates the response, stashes a draft in .tierkit/runtime/plugin-drafts/<uuid>/
#   POST   /v1/plugins/generate/install { draftId, enable? }   ← promote a draft to an installed plugin; optionally enable

# Browser GUI — once `tierkit runtime start` is up:
#   open http://127.0.0.1:4101/       # run tasks, drive sessions, watch usage, no terminal
#
# Or install the VS Code companion (`packages/vscode-tierkit/tierkit-vscode-*.vsix`)
# and pin the Tierkit sidebar — the same GUI lives in the activity bar.

# v1.1 — actually run the model (streaming)
node packages/cli/dist/index.js route run "summarize this project"
node packages/cli/dist/index.js route run "outline a plan" --mode plan --files 8
node packages/cli/dist/index.js route run "review the auth diff" --mode review --profile privateRemoteStrong
node packages/cli/dist/index.js route run "say OK" --no-stream
node packages/cli/dist/index.js route run "audit prod secrets" --secrets --prod --local-only

# v1.2 — workflow sessions (guided/balanced/strict)
node packages/cli/dist/index.js plugin install packages/plugin-superpowers/plugins/superpowers-strict
node packages/cli/dist/index.js plugin enable superpowers-strict
node packages/cli/dist/index.js session start "refactor auth middleware"
node packages/cli/dist/index.js route run "outline plan" --mode plan
node packages/cli/dist/index.js session approve-plan
node packages/cli/dist/index.js session advance implementing
node packages/cli/dist/index.js route run "carry out the plan"
node packages/cli/dist/index.js session advance reviewing
node packages/cli/dist/index.js route run "review the diff" --mode review
node packages/cli/dist/index.js session advance done

# v1.3 — talk to the runtime from any tool (TypeScript SDK)
#   import { TierkitClient } from "@tierkit/client";
#   const client = new TierkitClient();        // defaults to http://127.0.0.1:4101
#   await client.health();
#   for await (const evt of client.llmCallStream({ profileId: "localFast", messages: [...] })) { ... }
#
#   See packages/vscode-tierkit/ for a VS Code companion that uses the same SDK.
#
# v1.4 — see docs/INTEGRATIONS.md for per-tool binding paths (Roo / Cline / Continue / your own)
```

## Design

See [docs/SPEC.md](docs/SPEC.md) for the full design specification — positioning, plugin format, model routing, security stance, and the v0.1+ roadmap.

---

## 한국어 안내

**Tierkit**은 AI 코딩 에이전트(Roo Code · Cline · Continue · aider 등)를 위한 **로컬 우선 정책·라우팅 레이어**입니다. 에이전트를 대체하지 않고 그 **뒤에 깔려서** 모든 모델 호출을 가로채:

- **위험도·비용에 따라 모델 자동 라우팅** (작은 일은 로컬 무료, 큰 일은 클라우드)
- **Tier 간 자동 fallback** (local 실패 → private-remote → public-cloud, ceiling 설정 가능)
- **응답 품질 평가 + 자동 재시도** (거부/빈 응답/잘림/반복-루프 감지)
- **시크릿 자동 마스킹** 후 원격 호출
- **위험 명령(`rm -rf` 등) 사전 차단**
- **예산·세션 게이트** (strict는 plan 승인 후만 execute, budget 80% 이상 시 자동 다운그레이드)
- **활성 Tierkit 플러그인의 룰** 자동으로 system prompt에 주입
- **OpenAI 구조화 tool calling을 약한 로컬 모델에서도 작동**시키는 자동 shim (XML 태그/JSON 변환)
- **GUI에서 API 키 직접 입력** (Claude / ChatGPT / Gemini 모두 OK, 키는 `.tierkit/secrets.json`에 0600으로 저장)
- **자연어로 플러그인 생성** — "TDD 우선 Python 플러그인" 같은 설명을 사이드바에 적으면 LLM이 매니페스트+룰 파일 생성, 미리보기 후 원-클릭 설치

한 번 작성한 Tierkit 플러그인을 활성화하면 모든 연결된 도구에 자동 동기화돼서 일관된 행동.

## 5분 가이드 — Roo Code + 로컬 모델로 코딩

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

Tierkit이 자동으로 `localCoder` 프로파일을 viable로 인식.

### 3. (선택) Superpowers 플러그인 활성화

워크스페이스에 행동 규율(plan 먼저, tests 우선 등) 적용:

```bash
cd <your-workspace>

# 번들 superpowers-balanced 설치 (소스 경로는 본인 환경에 맞게)
node <tierkit-source>/packages/cli/dist/index.js plugin install \
  <tierkit-source>/packages/plugin-superpowers/plugins/superpowers-balanced

# 활성화 — 자동으로 Roo/Cline/Continue에 룰 export 동반
node <tierkit-source>/packages/cli/dist/index.js plugin enable superpowers-balanced
```

(자세한 plugin install UX는 0.3.4에서 사이드바 버튼화 예정)

Tierkit이 활성 플러그인의 룰을 모든 모델 호출의 system prompt에 자동 주입.

### 4. Roo Code 연결

사이드바 → **"연결된 도구" 카드** → `roo` 행 옆 **[연결]** 클릭. 또는 CLI:

```bash
tierkit connect roo
```

이게 워크스페이스의 `.vscode/settings.json`에 4개 키를 추가해서 Roo가 Tierkit의 OpenAI-호환 엔드포인트(`http://127.0.0.1:4101/v1/openai`)로 모든 호출을 보내게 합니다.

**VS Code 윈도우 reload** 한 번. (Cmd/Ctrl+Shift+P → "Developer: Reload Window")

### 5. Roo의 설정 UI에서 직접 (Roo 3.x에서 필요한 경우)

Roo Code가 settings.json 키를 무시하면 (3.x에서 종종 발생) Roo 아이콘 → ⚙ Settings:

| 필드 | 값 |
|---|---|
| API Provider | **OpenAI Compatible** ← 절대 `OpenAI` 아님 |
| Base URL | `http://127.0.0.1:4101/v1/openai` |
| API Key | `tierkit-loopback` (어떤 비어있지 않은 문자열도 OK, 빈칸은 안 됨) |
| Model ID | `auto` (또는 `localCoder` 등 특정 프로파일) |

**저장 후 반드시 VS Code Reload Window (Ctrl+R)**

더 자세한 Roo 설정 가이드 (자주 보는 에러 의미, 체크리스트, code-server 특이사항 등): [**docs/ROO.ko.md**](docs/ROO.ko.md)

### 6. Roo 채팅창에서 task 실행

평소처럼 Roo 사용. Tierkit이 뒤에서:

```
Roo → Tierkit → [라우팅 → viability 체크 → shim → 룰 주입 → 모델] → tool_calls → Roo
```

Tierkit 사이드바 **"최근 활동"** 카드에 호출이 실시간으로 등장 → 연동 정상 확인.

## 클라우드 모델 쓰기 (Claude / ChatGPT / Gemini)

**v0.3.4부터:** GUI에서 직접 키를 붙여넣을 수 있습니다 (셸 환경변수 export 불필요).

사이드바 → **Model profiles** 카드 → `+ Add` → provider 선택 (`anthropic` / `openai` / `gemini` / `ollama`) → `API key value` 필드에 키 붙여넣기 → 저장. 키는 `.tierkit/secrets.json`에 `0600` 권한으로 저장되고 자동으로 `.gitignore`에 추가됩니다.

이미 등록된 profile 옆에 ⚠ API key not set이 보이면 `[Set key]` 버튼으로 인라인 입력. 별도 **API Keys** 서브섹션에서 키 일괄 관리(보기/삭제).

또는 기존 방식대로 셸 환경변수도 여전히 동작:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."   # Claude
export OPENAI_API_KEY="sk-..."          # ChatGPT
export GEMINI_API_KEY="..."             # Google Gemini (OpenAI-compat 엔드포인트 사용)
```

셸 env가 있으면 셸 env가 우선합니다. 둘 다 동작.

Roo의 Model ID에 `claudeHaiku`(싸고 빠름) / `claudeSonnet` / `gpt4o` / 추가한 Gemini profile id를 지정하거나, **`auto`** 로 두면 Tierkit이 자동 선택.

### 자동 라우팅 + fallback (v0.3.4)

`model: "auto"` 호출에서 Tierkit이 다음을 자동으로 수행합니다:

1. **Task 분류** — 메시지에서 task type 감지 (`code-review`, `refactor`, `summarize`, `translate`, `plan`, `code-generation`, `general`)
2. **Tier 결정** — 위험도 점수로 시작 tier 결정 (local-device / private-remote / public-cloud)
3. **Escalation chain 구성** — 시작 tier부터 ceiling(기본 `public-cloud`)까지 viable profile을 순서대로 나열. 같은 tier 안에서는 profile의 `goodAt: [...]` 배열에 현재 task type이 들어있는 것을 먼저
4. **Viability pre-flight** — 죽은 후보 자동 제거 (ollama 미설치, API 키 없음 등)
5. **Budget-aware downgrade** — 일일 예산 80% 이상 소진 시 primary tier를 한 단계 낮춤. 100% 도달 시 public-cloud 후보 제거
6. **Walker + 품질 평가** — 후보를 순서대로 호출. 실패 시 다음 후보. 응답이 거부(`I cannot…`/`할 수 없습니다`)/비어있음/잘림/반복-루프이면 transient failure로 취급하고 다음 후보로

GUI **Model profiles** 카드 상단 `Auto-escalation up to [public-cloud ▼]` 드롭다운으로 ceiling 즉시 변경 가능 (`local-device`로 두면 fallback 비활성, `private-remote`로 두면 과금 API 절대 자동 호출 안 함).

각 profile 폼에 `Good at (comma-separated)` 필드로 capability 선언:
```
code-review, korean, summarize
```
같은 tier에서 task type이 일치하는 profile이 우선 선택됩니다.

## 자연어로 플러그인 만들기 (v0.3.5)

사이드바 → **Active plugins** 카드 → `+ Describe & generate` 버튼:

```
원하는 플러그인을 설명하세요
┌────────────────────────────────────┐
│ Python 프로젝트용 TDD-first 플러그인.│
│ 구현 전에 항상 실패하는 pytest 테스트│
│ 를 먼저 작성하게 함. 작은 커밋 선호. │
└────────────────────────────────────┘
[취소]  [생성 →]
```

`생성 →` 클릭 시 Tierkit이 `auto` 라우팅으로 LLM 호출(현재 escalation chain의 첫 viable 모델 — 로컬 우선, 필요 시 자동 escalation). 응답이 도착하면 미리보기:

- 매니페스트 메타데이터 (id, name, version, freedom level)
- 각 룰 파일 (펼침/접힘 코드 블록)
- 어떤 모델이 생성했는지 표시

`[설치만]` / `[설치 + 활성화]` / `[취소]` 중 선택. 설치 후 plugins 리스트 자동 갱신.

**동작 원리:**
- 응답은 JSON으로 파싱 → `PluginManifestSchema` Zod 검증 → 검증 실패 시 LLM에 1회 재시도 (이전 응답과 에러 메시지 첨부)
- 모든 draft는 `.tierkit/runtime/plugin-drafts/<uuid>/`에 저장 — 사용자가 install 클릭 전까지 어디에도 영향 없음
- 룰 파일명은 `^[0-9a-z][0-9a-z._-]*\.md$` 패턴만 허용 (path traversal 방어)
- 0개 룰 / 41자 이상 id 등 빈약한 결과 자동 거부

## 사이드바 미션 컨트롤 (사용 중 보이는 것)

```
┌─────────────────────────────────────────┐
│ Tierkit  v0.1.0  guided  ↻              │
├─────────────────────────────────────────┤
│ 연결된 도구                              [동기화]│
│   roo       Tierkit으로 라우팅됨   [재연결]│
│   cline     미설치              [연결]    │
│   continue  Tierkit으로 라우팅됨           │
├─────────────────────────────────────────┤
│ 활성 플러그인  [+ 새 플러그인] [+ 설명으로 만들기]│
│   ▣ superpowers-balanced   guided  [비활성]│
├─────────────────────────────────────────┤
│ 최근 활동                       (5초마다 갱신)│
│   14:23:01  localCoder (local-device)   │
│             856ms · 1.2k↑/450↓ tokens   │
│   14:22:48  localCoder                  │
│             220ms · free                 │
├─────────────────────────────────────────┤
│ 오늘 사용량                              │
│   24 호출 │ 18k 토큰 │ $0.00            │
│   localCoder    24 · $0.00              │
├─────────────────────────────────────────┤
│ 모델 프로파일                        [+ 추가]│
│   Auto-escalation up to [public-cloud ▼] │
│   localCoder    ollama · qwen2.5-…       │
│                              [test] [삭제]│
│   claudeSonnet  anthropic · claude-…     │
│      ⚠ API key not set [Set key]         │
│                              [test] [삭제]│
│   geminiFast   openai · gemini-2.0-flash │
│                              [test] [삭제]│
│ ── API Keys ──                           │
│   ANTHROPIC_API_KEY  ⚠ not set    [Set]  │
│   GEMINI_API_KEY     sk-ai-…xyz4  [삭제]  │
└─────────────────────────────────────────┘
```

## 직접 검증 (Roo 우회 curl)

Tierkit 자체 동작 확인:

```bash
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

응답에 `tool_calls` 배열 + `finish_reason: "tool_calls"`이 보이면 → 도구 호출 파이프라인 정상.

## 데몬이 안 뜬다면 (Windows 진단)

| 증상 | 원인 | 해결 |
|---|---|---|
| "데몬에 연결할 수 없습니다" + 폴더 안 열림 | `startServer`가 cwd 못 잡음 | File → Open Folder + 명령 팔레트 **Tierkit: 데몬 재시작** |
| Hyper-V가 4101 예약 | `netsh interface ipv4 show excludedportrange protocol=tcp` | `tierkit.baseUrl`을 `http://127.0.0.1:5101`로 |
| AV가 Node listen 차단 | Output에 EACCES/EPERM | AV 임시 비활성화 후 재시도 |
| Microsoft Store VS Code (UWP) | localhost 접근 차단 | `CheckNetIsolation LoopbackExempt -a -n="Microsoft.VisualStudioCode_8wekyb3d8bbwe"` 관리자 PowerShell |

진단 로그: VS Code → **출력(Output)** 패널 → 드롭다운 **Tierkit** 선택 → auto-start 단계별 로그.

## 자기 플러그인 만들기

```bash
# 디렉토리 + 매니페스트 + 샘플 command/mode/rule 생성
tierkit plugin new my-team-rules

# 편집
$EDITOR my-team-rules/tierkit.plugin.json

# 설치 + 활성화 (자동으로 Roo/Cline/Continue 다 동기화)
tierkit plugin install ./my-team-rules
tierkit plugin enable my-team-rules
```

이제 모든 연결된 도구가 같은 룰을 따름. 사이드바에서도 동일하게 가능.

## 보안 모델 (요점)

- 데몬은 **`127.0.0.1` (loopback)만** 바인딩. 다른 머신 접근 불가.
- `public-cloud` 프로파일은 기본값이 **review-only + 승인 필요**. 절대 자동 확장 안 됨.
- 모든 원격 호출 직전 **시크릿 자동 마스킹** (`.env` 키 패턴, API 키, PEM 등).
- `rm -rf /` 같은 명령은 **danger classifier**가 실행 전 차단.
- 텔레메트리·분석·phone-home 일절 없음.

자세한 보안 모델: [docs/SECURITY.md](docs/SECURITY.md).

## 더 알아보기

- 한글 시작 가이드: [docs/GUIDE.ko.md](docs/GUIDE.ko.md)
- **Roo Code 단독 설정 가이드** (정확한 값 + 자주 보는 에러 + 체크리스트): [docs/ROO.ko.md](docs/ROO.ko.md)
- 연결 가이드 (Roo/Cline/Continue 통합): [docs/CONNECT.ko.md](docs/CONNECT.ko.md)
- 디자인 스펙: [docs/SPEC.md](docs/SPEC.md)
- 보안 모델: [docs/SECURITY.md](docs/SECURITY.md)
- VS Code 마켓플레이스 publish 절차: [docs/PUBLISH.ko.md](docs/PUBLISH.ko.md)

## License

MIT
