# Tierkit 연결 가이드 — Roo / Cline / Continue + 내 플러그인

> **요약**: Tierkit은 라우팅·보안 정책 레이어예요. Roo Code · Cline · Continue 같은 이미 익숙한 코딩 에이전트 **뒤**에 깔려서, 그들이 모델을 호출할 때 자동으로 위험도에 따라 모델을 고르고, 시크릿을 가리고, 위험 명령을 차단합니다. 한 번 작성한 Tierkit 플러그인을 세 도구 모두에 자동 배포합니다.

---

## 1. 준비

```sh
# (한 번만) 워크스페이스 초기화 + 기본 모델 프로파일 사용
cd <your-project>
tierkit init                              # tierkit.config.json 생성 (선택 — 번들 defaults도 동작)
tierkit runtime start                     # 데몬 띄움 (또는 VS Code 확장이 자동 실행)
tierkit models list                       # 6개 번들 프로파일 보임
```

## 2. 가지고 있는 에이전트 연결

### Roo Code

```sh
tierkit connect roo
```

이게 하는 일:
- `.vscode/settings.json`에 다음 키를 씁니다 (기존 설정은 보존):
  ```jsonc
  {
    "roo-cline.apiProvider": "openai",
    "roo-cline.openAiBaseUrl": "http://127.0.0.1:4101/v1/openai",
    "roo-cline.openAiApiKey": "tierkit-loopback",
    "roo-cline.openAiModelId": "auto"
  }
  ```
- Roo Code를 reload하면 모든 모델 호출이 Tierkit을 거쳐갑니다.
- Roo 채팅창에서 model id를 `localCoder` / `claudeSonnet` / `gpt4o` 같은 Tierkit 프로파일 id로 바꾸면 그 모델로 강제 라우팅. `auto`로 두면 Tierkit이 task 위험도 기반으로 자동 선택.

### Cline

```sh
tierkit connect cline
```

같은 패턴 — `.vscode/settings.json`에 `cline.apiProvider` 등 작성. Reload 후 동작.

### Continue

```sh
tierkit connect continue
```

`.continue/config.yaml`에 Tierkit-routed model 항목 추가:
```yaml
# tierkit-routed-model
- name: Tierkit (auto-route)
  provider: openai
  model: auto
  apiBase: http://127.0.0.1:4101/v1/openai
  apiKey: tierkit-loopback
  roles: [chat, edit, apply]
```

Continue의 model picker에서 "Tierkit (auto-route)" 선택.

## 3. 내 플러그인 만들기

```sh
tierkit plugin new my-team-rules
```

다음 디렉토리 구조가 생성됨:
```
my-team-rules/
├── tierkit.plugin.json     ← 매니페스트 (commands, modes, rules, permissions, freedom, modelPolicy)
├── commands/
│   └── review.md           ← 슬래시 명령 prompt
├── modes/
│   └── default.md          ← 모드별 system prompt
└── rules/
    └── baseline.md         ← 항상 적용되는 룰
```

매니페스트 편집 → 설치 → 활성화 → 자동 배포:
```sh
# 편집 — 우리 팀이 원하는 commands/modes/rules로 수정
$EDITOR my-team-rules/tierkit.plugin.json

# 설치 + 활성화
tierkit plugin install ./my-team-rules
tierkit plugin enable my-team-rules
#  → enabled my-team-rules
#  → roo: 6 files synced       ← 자동으로 Roo .roomodes/.roo로 export
#  → cline: 4 files synced     ← 자동으로 Cline .clinerules/로 export
#  → continue: 3 files synced  ← 자동으로 Continue .continue/로 export
```

이제 모든 연결된 도구가 **같은 룰**을 따라요. Tierkit 자신의 사이드바도 마찬가지.

### 다른 머신/팀원에게 공유

플러그인 디렉토리 자체를 git에 올리면 끝. 클론한 사람은 `tierkit plugin install` + `tierkit plugin enable`만 하면 됩니다.

## 4. 일상 사용 흐름

```
사용자: "src/auth/login.ts 보안 이슈 찾아 고쳐줘"
        │
        ▼
Roo Code (또는 Cline, Continue): 자체 read_file 도구로 login.ts 읽음
        │
        ▼ 모델 호출 시 → http://127.0.0.1:4101/v1/openai/chat/completions
        │
   [Tierkit이 한꺼번에 처리]
     1. 활성 플러그인의 rules가 system prompt에 자동 prepend
     2. 라우팅 — auth/login = 위험도 높음 → claudeSonnet 자동 선택
        (간단한 작업이면 localCoder로 갔을 것)
     3. 시크릿 마스킹 — .env API 키 패턴 발견 시 마스킹 후 송신
     4. plan 게이트 — freedom=guided/strict면 plan 단계 강제
     5. budget 체크 — daily $5 한도 초과면 거부
        │
        ▼
   Anthropic API (또는 Ollama / OpenAI / etc.)
        │
        ▼
   응답 → Roo Code에 도착 → Roo가 edit_file로 수정 시도
        │
        ▼
   [Tierkit이 또 끼어들음]
     6. edit_file이 .env나 *.pem이면 → sensitive-file blocklist로 차단
     7. shell command 실행 (예: rm) → dangerousCommand 분류기로 차단/경고
     8. 모든 호출 토큰·비용 → tierkit usage 또는 사이드바 Usage 패널
```

## 5. 자주 하는 검증

### "정말 Tierkit을 거치고 있나?"
```sh
tierkit usage                # Roo로 쓴 호출이 여기 기록되면 ok
```
또는 Tierkit 사이드바 → `/usage` 슬래시.

### "내 플러그인이 Roo에 잘 들어갔나?"
```sh
ls .roomodes .roo/ .clinerules/ .continue/ 2>/dev/null
cat .roomodes                # Tierkit 플러그인의 모드들이 보임
```

### "강제 재동기화"
플러그인 파일을 수동으로 편집했을 때:
```sh
tierkit plugin sync          # 모든 감지된 도구로 재export
```

## 6. 사이드바에서 모두 할 수 있음

CLI를 거치지 않고 Tierkit VS Code 사이드바에서:

```
▸ /connect roo
  ✓ connected · roo
  → .vscode/settings.json

▸ /plugin new my-team-rules
  ✓ plugin scaffolded
  → /path/to/my-team-rules
    + tierkit.plugin.json
    + commands/review.md
    + modes/default.md
    + rules/baseline.md

▸ /plugin sync
  ✓ roo: 6 files
  ✓ cline: 4 files
  ✓ continue: 3 files
```

## 7. 한 번 정리

| 명령 (CLI) | 명령 (사이드바) | 무엇 |
|---|---|---|
| `tierkit connect <tool>` | `/connect <tool>` | Roo/Cline/Continue를 Tierkit으로 라우팅 |
| `tierkit plugin new <id>` | `/plugin new <id>` | 새 플러그인 스캐폴드 |
| `tierkit plugin install <dir>` | (CLI만) | 스캐폴드된 플러그인 등록 |
| `tierkit plugin enable <id>` | (CLI만) | 활성화 + 모든 연결 도구로 자동 export |
| `tierkit plugin sync` | `/plugin sync` | 활성 플러그인 재export |
| `tierkit models list` | `/models` | 모델 프로파일 + source 표시 |
| `tierkit profile add <id>` | `/profile add` | 모델 프로파일 추가 (대화형) |
| `tierkit usage` | `/usage` | 사용량 요약 |

## 핵심 약속

> **한 번 작성한 플러그인 = Tierkit 사이드바 + Roo + Cline + Continue 어디서든 동작.**
> **어떤 도구를 쓰든 동일한 보안 정책 + 라우팅 + 사용량 추적.**
