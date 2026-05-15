# Tierkit 시작 가이드 (한글)

Tierkit을 처음 설치하고 첫 모델 호출까지 가는 가장 짧은 경로를 다룹니다. 이 문서는 *동작하는 최단 경로*에 집중합니다 — 세부 옵션은 [SPEC.md](SPEC.md) / [MODEL_ROUTING.md](MODEL_ROUTING.md) / [SECURITY.md](SECURITY.md)를 보세요.

---

## 0. 한 줄 정리

```
Tierkit = "내 컴퓨터의 ollama부터 클라우드 모델까지를 한 줄의 CLI로 라우팅하는 로컬 우선 런타임"
        + "AI 코딩 도구(Roo / Cline / Continue / VS Code)에 같은 플러그인을 export"
```

설치 후 핵심 흐름은 단 4단계:

```sh
1) tierkit init                              # 프로젝트 초기화
2) tierkit doctor                            # 환경 점검
3) tierkit runtime start                     # 로컬 데몬 띄우기
4) 브라우저: http://127.0.0.1:4101/           # GUI로 task 실행
```

---

## 1. 요구사항

| 항목 | 버전 | 비고 |
|---|---|---|
| Node.js | **≥ 20.10** | LTS 권장. `node -v`로 확인 |
| pnpm | **≥ 9.0** | `npm i -g pnpm` 또는 [pnpm 공식 설치 가이드](https://pnpm.io/installation) |
| Ollama (선택) | 최신 | 로컬 모델용. 없어도 클라우드 프로파일만 쓸 수 있음 |
| Git | 최신 | 소스 받을 때만 |

운영체제: macOS / Linux 검증. Windows는 WSL2 권장 (loopback HTTP daemon이라 native Windows도 작동하지만 미검증).

---

## 2. 설치

### A. 소스에서 빌드 (현재 권장 — 알파)

```sh
# 1) 클론
git clone https://your-org/tierkit.git
cd tierkit

# 2) 의존성 설치
pnpm install

# 3) 전체 빌드 (8개 패키지)
pnpm -r build

# 4) (선택) tierkit 명령을 전역으로 사용 가능하게
pnpm --filter @tierkit/cli link --global
# → 이제 어떤 디렉토리에서든 `tierkit` 사용 가능

# 검증
tierkit --version    # 0.1.0
tierkit --help
```

> 전역 link 안 하면 `node /path/to/tierkit/packages/cli/dist/index.js`로 호출하면 됩니다. 본인 dotfiles에 alias 걸어도 OK.

### B. (향후) npm 배포 후

```sh
npm i -g @tierkit/cli         # 아직 publish 안 됨, 로드맵에 있음
```

---

## 3. 첫 프로젝트 초기화

내 프로젝트 디렉토리로 이동해서:

```sh
cd ~/my-coding-project
tierkit init
```

생성되는 파일:

```
my-coding-project/
├── tierkit.config.json          ← 모델 프로파일 + 라우팅 정책 + 예산
└── .tierkit/
    └── plugins.json             ← 설치된 플러그인 레지스트리
```

기본 `tierkit.config.json`은 *비어 있는* `modelProfiles`로 시작합니다 — 본인 환경에 맞게 채워야 합니다.

---

## 4. 모델 프로파일 설정

`tierkit.config.json`을 열어 `modelProfiles`를 채우세요. **Tier가 3개**라는 점만 기억하면 됩니다:

- `local-device` — 본인 컴퓨터의 ollama 등 (무료, 무난한 task)
- `private-remote` — 회사 내부의 LLM 서버 (vLLM, llama.cpp server, LM Studio, …)
- `public-cloud` — Anthropic / OpenAI (default review-only, approval 필수)

### 4.1 ollama만 쓰는 최소 설정

```json
{
  "version": "0.1",
  "modelProfiles": {
    "localFast": {
      "kind": "local-device",
      "provider": "ollama",
      "baseUrl": "http://localhost:11434",
      "model": "qwen2.5-coder:7b",
      "roles": ["simple-coder"],
      "cost": { "type": "free" }
    }
  }
}
```

먼저 ollama에 모델이 설치돼 있어야 합니다:

```sh
ollama pull qwen2.5-coder:7b
ollama serve     # 보통 자동 실행됨
```

### 4.2 회사 내부 LLM 서버 추가 (private-remote)

```json
{
  "version": "0.1",
  "modelProfiles": {
    "localFast": { /* 위와 동일 */ },
    "privateRemoteStrong": {
      "kind": "private-remote",
      "provider": "openai-compatible",
      "baseUrl": "https://my-llm.company.internal/v1",
      "model": "qwen-coder-72b",
      "apiKeyEnv": "TIERKIT_PRIVATE_LLM_KEY",
      "roles": ["complex-coder"]
    }
  }
}
```

API 키는 **환경변수로만** 저장하세요 (config 파일에 직접 적지 마세요):

```sh
export TIERKIT_PRIVATE_LLM_KEY="sk-..."        # .zshrc / .bashrc 에 추가
```

### 4.3 Anthropic public-cloud 추가 (선택)

```json
{
  "publicCloudPremium": {
    "kind": "public-cloud",
    "provider": "anthropic",
    "model": "claude-sonnet",
    "apiKeyEnv": "ANTHROPIC_API_KEY",
    "roles": ["architect"],
    "requiresApproval": true,
    "defaultMode": "review-only"
  }
}
```

```sh
export ANTHROPIC_API_KEY="sk-ant-..."
```

> **public-cloud는 자동으로 review-only로 강제됩니다** — Tierkit이 클라우드 모델의 응답을 직접 파일에 적용하지 않습니다. 사람 또는 로컬 모델이 검토 후 적용해야 합니다.

---

## 5. 환경 점검 (doctor)

```sh
tierkit doctor
```

기대 출력:

```
Tierkit doctor — /Users/me/my-coding-project
  [OK  ] Node.js 24.10.0
  [OK  ] tierkit.config.json
  [OK  ] .tierkit/plugins.json
  [OK  ] installed plugins — no plugins installed
  [OK  ] security policy — all defaults intact
  [OK  ] plugin permission risk — no plugins installed
  [OK  ] model API key env vars

Overall: OK
```

만약 `[WARN] model API key env vars — missing: TIERKIT_PRIVATE_LLM_KEY (used by "priv")`가 보이면 → 해당 환경변수를 export 안 한 것. shell 재시작 또는 `source ~/.zshrc`.

---

## 6. 첫 모델 호출 — 두 가지 방법

### 6.1 CLI 한 줄 (`tierkit route run`)

```sh
tierkit route run "Reply with one word: ok"
# [local-device] localFast (ollama/qwen2.5-coder:7b, mode=execute)
#
# ok
#
# — 82 in / 2 out · 277ms · $0.000000
```

옵션:

```sh
# 강제 profile
tierkit route run "..." --profile privateRemoteStrong

# plan / review / execute (default execute)
tierkit route run "이 함수 리팩토링 계획" --mode plan
tierkit route run "이 diff 리뷰" --mode review

# 스트리밍 대신 완료 후 한 번에
tierkit route run "..." --no-stream

# 안전 제약
tierkit route run "..." --local-only       # 절대 클라우드로 escalate 안 함
tierkit route run "..." --private          # private-remote까지만 허용
tierkit route run "audit prod secrets" --secrets --prod --files 12
# → risk score 100/100 → public-cloud 라우팅 + approval 요구
```

### 6.2 브라우저 GUI

```sh
tierkit runtime start          # 백그라운드: tierkit runtime start &
```

다른 터미널 또는 브라우저에서:

```sh
open http://127.0.0.1:4101/
```

GUI에서 할 수 있는 것:

- 우측 상단에서 daemon health + 현재 freedom level 확인
- "Run a task" 패널에서 task 입력 → profile/mode 선택 → Run
- 좌측 하단 "Usage" 카드에서 누적 calls / tokens / cost 자동 갱신
- 우측 "Session" 카드에서 workflow session 시작 / advance / abandon

종료: `tierkit runtime stop` (또는 foreground 실행 중이면 `^C`)

---

## 7. 보안 도구 사용

### 7.1 시크릿 감지 (redact)

파일에서 API 키 / 토큰 / 자격증명을 찾아 가립니다:

```sh
tierkit check redact ./scratch.txt
# → openai-api-key × 1, github-token × 1 등
# → exit 1 if found, 0 if clean

tierkit check redact ./scratch.txt --print
# 가린 본문도 출력
```

지원 패턴: OpenAI / Anthropic / AWS / GitHub / GCP / Slack / Stripe / Google / JWT / PEM private key / basic-auth URL / Bearer 헤더 등.

### 7.2 명령어 위험도 분류

```sh
tierkit check command "rm -rf /"
# → BLOCK (exit 2) — rm-rf-root rule matched

tierkit check command "git reset --hard origin/main"
# → WARN (exit 1)

tierkit check command "ls -la"
# → OK (exit 0)
```

스크립팅용 exit code 보장 (block=2, warn=1, ok=0).

### 7.3 sensitive 파일 경로 검사

```sh
tierkit check path .env                     # → YES (.env 패턴 매칭)
tierkit check path README.md                # → no
tierkit check path packages/cred/id_rsa     # → YES
```

플러그인 매니페스트가 `.env`나 `id_rsa` 같은 파일을 참조하면 Tierkit은 플러그인 설치를 거부합니다 (`allowSensitive: true`로만 override 가능).

---

## 8. 워크플로우 세션 (선택 — strict 모드 예시)

기본은 `free` freedom level이라 enforcement가 없습니다. 강제 워크플로를 원하면 superpowers 플러그인 중 하나를 enable:

```sh
# 번들된 strict 플러그인 설치
tierkit plugin install /path/to/tierkit/packages/plugin-superpowers/plugins/superpowers-strict
tierkit plugin enable superpowers-strict
```

이제 `route run --mode execute`는 세션 없이는 거부됩니다:

```sh
tierkit route run "..." 
# → no-session: freedom level "strict" requires an active session.
```

올바른 흐름:

```sh
# 1) 세션 시작 (state=planning)
tierkit session start "Refactor the auth middleware"

# 2) plan 모드로 계획 만들기
tierkit route run "auth middleware 리팩토링 계획 수립" --mode plan

# 3) 사용자가 plan을 검토하고 승인
tierkit session approve-plan

# 4) 상태 전환 (state=implementing)
tierkit session advance implementing

# 5) 이제 실제 구현 호출 가능
tierkit route run "위 계획대로 구현" --mode execute

# 6) 리뷰 단계
tierkit session advance reviewing
tierkit route run "이 diff 리뷰" --mode review

# 7) 종료
tierkit session advance done
```

언제든 현재 상태 확인:

```sh
tierkit session status
```

GUI(브라우저)에서도 같은 흐름을 버튼으로 조작할 수 있습니다.

Freedom 레벨 차이 요약:

| Level | 강제 동작 |
|---|---|
| `free` | 없음 |
| `guided` | 경고만 (output context에 warning 첨부) |
| `balanced` | 다중 파일(≥3) execute 시 session=implementing 강제 |
| `strict` | 모든 execute에 plan-approved + state=implementing 강제 |

---

## 9. 어댑터로 다른 도구에 export

Tierkit 플러그인 하나를 작성하면 4개 도구 형식으로 변환 가능:

```sh
tierkit export generic --out ./dist          # 도구 중립 markdown
tierkit export roo --out .                   # .roomodes + .roo/
tierkit export zoo --out .                   # roo와 동일 alias
tierkit export cline --out .                 # .clinerules/
tierkit export continue --out .              # .continue/{config.yaml, rules, prompts, mcp}
```

예: 본인 프로젝트 루트에서 Cline용으로:

```sh
cd ~/my-coding-project
tierkit plugin install /path/to/tierkit/packages/plugin-superpowers/plugins/superpowers-balanced
tierkit export cline
# → .clinerules/ 폴더에 5개 markdown 생성
# → Cline 확장이 자동으로 읽음
```

---

## 10. VS Code 확장 설치 (사이드로드)

```sh
# Tierkit 저장소에서
cd packages/vscode-tierkit
pnpm exec vsce package --no-dependencies --allow-missing-repository --skip-license

# 본인 VS Code에 설치
code --install-extension tierkit-vscode-0.1.0.vsix
```

확장이 켜진 후 Command Palette (`⌘⇧P`)에서:
- `Tierkit: Check runtime health`
- `Tierkit: Run task through Tierkit (streamed)`
- `Tierkit: Show usage summary`
- 등

상태바에 daemon health pill이 표시됩니다.

---

## 11. 자주 나오는 문제

### `cannot reach ollama at http://localhost:11434 — is the daemon running? Try: ollama serve`

→ Ollama 서버가 안 떠 있음. 다른 터미널에서:
```sh
ollama serve
# 또는 background:
ollama serve &
```

### `bad-status: ollama responded with 404 Not Found`

→ 프로파일의 `model` 이름이 Ollama에 설치돼 있지 않음.
```sh
ollama list                    # 설치된 모델 확인
ollama pull qwen2.5-coder:7b   # 필요한 모델 받기
tierkit models test localFast  # 다시 시도 — 모델 가용성 확인됨
```

### `missing-api-key: environment variable "TIERKIT_PRIVATE_LLM_KEY" is not set or empty`

→ shell에서 export 안 됨. `.zshrc`/`.bashrc`에 적었으면 새 터미널 열거나 `source ~/.zshrc`.

```sh
tierkit config show
# API key env vars 섹션에 (not set) 표시됨

echo $TIERKIT_PRIVATE_LLM_KEY  # 비어 있으면 export 안 된 것
```

### `unknown-profile: unknown profile "xxx". Known: localFast, …`

→ `tierkit.config.json::modelProfiles`에 그 id가 없음. `tierkit models list`로 확인.

### `no-session: freedom level "strict" requires an active session`

→ strict 플러그인이 active. 세션 시작 필요:
```sh
tierkit session start "<task>"
```
또는 strict가 필요 없으면:
```sh
tierkit plugin disable superpowers-strict
```

### `budget-exceeded: ...`

→ `tierkit.config.json::budget`의 `dailyUsdLimit` / `monthlyUsdLimit` 도달. 한도 올리거나 다음 날 다시 시도.

### Daemon 포트 충돌 (4101이 이미 사용 중)

```sh
tierkit runtime start --port 4200
# 또는 config에 영구 변경:
# tierkit.config.json: { "runtime": { "port": 4200 } }
```

---

## 12. 다음으로

- **모든 CLI 명령어 보기**: `tierkit --help`
- **모델 라우팅 자세히**: [MODEL_ROUTING.md](MODEL_ROUTING.md)
- **보안 정책**: [SECURITY.md](SECURITY.md)
- **플러그인 직접 만들기**: [PLUGIN_FORMAT.md](PLUGIN_FORMAT.md)
- **본인 도구를 Tierkit에 붙이기**: [INTEGRATIONS.md](INTEGRATIONS.md)
- **전체 아키텍처**: [ARCHITECTURE.md](ARCHITECTURE.md)

---

## 빠른 명령 참고표

```sh
# 프로젝트
tierkit init                              # 초기화
tierkit doctor                            # 환경 점검
tierkit config show                       # 현재 설정 출력 (API 키 마스킹)

# 플러그인
tierkit plugin install <path>             # 로컬 폴더에서 설치
tierkit plugin list                       # 설치 목록
tierkit plugin enable / disable / remove <id>
tierkit plugin validate <path> [--strict]

# 모델
tierkit models list                       # 프로파일 표
tierkit models test <profileId>           # 도달성 + 모델 가용성 확인

# 라우팅 / 실행
tierkit route explain "<task>"            # 어떤 tier가 선택될지 설명
tierkit route run "<task>" [--profile X] [--mode plan|review|execute]
                          [--no-stream] [--local-only] [--private]
                          [--files N] [--secrets] [--prod]

# 세션 (guided/balanced/strict가 active일 때)
tierkit session start "<task>"
tierkit session status
tierkit session approve-plan
tierkit session advance <state>           # planning|implementing|reviewing|done|abandoned
tierkit session abandon

# 보안
tierkit check redact <file> [--print]
tierkit check command "<cmd>"
tierkit check path <path>

# 런타임 (HTTP daemon + GUI)
tierkit runtime start [--port N]          # foreground 데몬
tierkit runtime stop
tierkit runtime status
tierkit usage [--since YYYY-MM-DD]        # 누적 사용량

# 어댑터 export
tierkit export generic [--out <dir>]
tierkit export roo [--out <dir>]          # roo / zoo 동일
tierkit export cline [--out <dir>]
tierkit export continue [--out <dir>]
```
