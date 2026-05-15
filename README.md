# Tierkit

Tierkit is a local-first hybrid plugin runtime for AI coding agents.

It lets you write one plugin format and adapt it to tools like Cline, Zoo/Roo Code, and Continue — while routing work across local models, private remote models, and public cloud models based on risk, cost, and workflow policy.

> Status: **v0.3.3.** Tool-shim for weak local models, plugin-rule system-prompt injection, profile viability pre-flighting, mission-control sidebar, OpenAI-compatible endpoint for Roo/Cline/Continue/aider/etc. See the [roadmap in SPEC.md §15](docs/SPEC.md#15-roadmap).

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
- **시크릿 자동 마스킹** 후 원격 호출
- **위험 명령(`rm -rf` 등) 사전 차단**
- **예산·세션 게이트** (strict는 plan 승인 후만 execute)
- **활성 Tierkit 플러그인의 룰** 자동으로 system prompt에 주입
- **OpenAI 구조화 tool calling을 약한 로컬 모델에서도 작동**시키는 자동 shim (XML 태그/JSON 변환)

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
| API Provider | **OpenAI Compatible** |
| Base URL | `http://127.0.0.1:4101/v1/openai` |
| API Key | `tierkit-loopback` (아무 값) |
| Model ID | `auto` (또는 `localCoder` 등 특정 프로파일) |

### 6. Roo 채팅창에서 task 실행

평소처럼 Roo 사용. Tierkit이 뒤에서:

```
Roo → Tierkit → [라우팅 → viability 체크 → shim → 룰 주입 → 모델] → tool_calls → Roo
```

Tierkit 사이드바 **"최근 활동"** 카드에 호출이 실시간으로 등장 → 연동 정상 확인.

## 클라우드 모델 쓰기 (Anthropic / OpenAI)

도구 호출 100% 신뢰성을 원하면:

```bash
# 환경변수 설정
export ANTHROPIC_API_KEY="sk-ant-..."
# 또는
export OPENAI_API_KEY="sk-..."
```

그 셸에서 VS Code를 다시 열어 (`code .`) 환경변수 상속. Tierkit이 자동으로 `claudeSonnet`/`claudeHaiku`/`gpt4o` 프로파일을 viable로 인식. Roo의 Model ID를 `claudeHaiku` (싸고 빠름) 또는 `claudeSonnet`으로 변경.

`auto`로 두면 Tierkit이 task 위험도에 따라 자동 선택 — 작은 일은 로컬, 큰 일은 클라우드.

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
│ 활성 플러그인                       [+ 새 플러그인]│
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
│   localCoder    ollama · qwen2.5-…  test │
│   claudeSonnet  anthropic · ⚠ key   test │
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
- 연결 가이드 (Roo/Cline/Continue): [docs/CONNECT.ko.md](docs/CONNECT.ko.md)
- 디자인 스펙: [docs/SPEC.md](docs/SPEC.md)
- 보안 모델: [docs/SECURITY.md](docs/SECURITY.md)
- VS Code 마켓플레이스 publish 절차: [docs/PUBLISH.ko.md](docs/PUBLISH.ko.md)

## License

MIT
