# Tierkit

Tierkit is a local-first hybrid plugin runtime for AI coding agents.

It lets you write one plugin format and adapt it to tools like Cline, Zoo/Roo Code, and Continue — while routing work across local models, private remote models, and public cloud models based on risk, cost, and workflow policy.

> Status: **v1.7 alpha.** VS Code extension ([Marketplace](https://marketplace.visualstudio.com/items?itemName=leesiwal.tierkit-vscode)) now **auto-starts the runtime in-process**, **localizes UI to Korean**, and ships a **diagnostic Output channel** for the "Daemon unreachable" case. Browser GUI + VS Code sidebar embedding the same GUI + workflow sessions + 4 export adapters + HTTP daemon. See the [roadmap in SPEC.md §15](docs/SPEC.md#15-roadmap).

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

**Tierkit**은 AI 코딩 에이전트를 위한 **로컬 우선(local-first) 하이브리드 플러그인 런타임**입니다. 한 번 작성한 플러그인을 Cline · Zoo/Roo Code · Continue 같은 도구로 동시에 내보내면서, 모델 호출은 **위험도 · 비용 · 워크플로 정책**에 따라 **로컬 / 프라이빗 원격 / 퍼블릭 클라우드** 3개 계층에 자동 라우팅합니다.

### 가장 빠르게 써보는 법 (VS Code)

1. VS Code Marketplace에서 [**Tierkit**](https://marketplace.visualstudio.com/items?itemName=leesiwal.tierkit-vscode) 확장 설치.
2. **프로젝트 폴더를 열어주세요** — 워크스페이스 폴더가 있어야 런타임이 시작됩니다.
3. 활동 바의 **Tierkit** 아이콘 클릭 → 사이드바 열림.
4. 상단이 **🟢 Tierkit v0.1.0**로 바뀌면 사용 준비 완료. 모델 추가는 `tierkit.config.json`에 modelProfiles를 정의하세요 ([예시](docs/GUIDE.ko.md)).

### 데몬이 안 뜬다면 (Windows 사용자 주의)

VS Code 확장은 활성화될 때 데몬을 **in-process로 자동 시작**합니다. 그래도 "데몬에 연결할 수 없습니다: Failed to fetch"가 뜨는 경우 흔한 원인:

| 증상 | 가능한 원인 | 해결 |
|---|---|---|
| 폴더를 안 열었음 | `startServer`가 cwd를 못 잡음 | File → Open Folder로 폴더 열기 → 명령 팔레트에서 **Tierkit: 데몬 재시작** |
| Windows에서 포트 4101이 Hyper-V 예약 범위 안 | `netsh interface ipv4 show excludedportrange protocol=tcp`로 확인. 확장은 자동으로 빈 포트로 폴백하지만 그것도 막혔다면 실패 | `tierkit.baseUrl`을 `http://127.0.0.1:5101` 같은 다른 포트로 변경 |
| AV/방화벽이 Node listen() 차단 | 토스트로 한 번 뜨고 사라짐 | **Tierkit: 진단 로그 보기** 명령으로 Output 채널 확인 |
| 워크스페이스에 `tierkit.config.json` 없음 | 데몬은 뜨지만 모델/세션 등 일부 패널이 500 | `tierkit init` 또는 [docs/GUIDE.ko.md](docs/GUIDE.ko.md) 참고 |

**모든 경우의 첫 번째 진단**: VS Code의 **출력(Output)** 패널 → 드롭다운에서 **Tierkit** 선택 → auto-start 단계별 로그가 그대로 보입니다.

### 보안 모델 (요점)

- 데몬은 **127.0.0.1 (loopback)만** 바인딩. 다른 머신에서 접근 불가.
- `public-cloud` 프로파일은 기본값이 **review-only + 승인 필요**. 절대 자동으로 넓혀지지 않음.
- 모든 원격 호출 직전 **시크릿 자동 마스킹** (`.env`, API 키, PEM 등).
- `rm -rf /` 같은 명령은 **danger classifier**가 실행 전 블록.
- 텔레메트리 · 분석 · phone-home 일절 없음.

자세한 내용은 [docs/SECURITY.md](docs/SECURITY.md).

### 더 알아보기

- 한글 시작 가이드: [docs/GUIDE.ko.md](docs/GUIDE.ko.md)
- 디자인 스펙: [docs/SPEC.md](docs/SPEC.md)
- 보안 모델: [docs/SECURITY.md](docs/SECURITY.md)
- VS Code 마켓플레이스 publish 절차: [docs/PUBLISH.ko.md](docs/PUBLISH.ko.md)

## License

MIT
