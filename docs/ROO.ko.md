# Roo Code + Tierkit 연동 가이드

> Roo Code가 Tierkit을 거쳐 모델을 호출하도록 설정하는 방법. 5분이면 끝.

## 한 줄 요약

**Roo의 API Provider를 "OpenAI Compatible"로 바꾸고 Base URL을 `http://127.0.0.1:4101/v1/openai` 로 지정.** 끝.

---

## 빠른 참조 카드 (Copy-Paste용)

Roo Code Settings에 그대로 입력:

| 필드 | 정확한 값 |
|---|---|
| **API Provider** | `OpenAI Compatible` ← 절대 `OpenAI` 아님 |
| **Base URL** | `http://127.0.0.1:4101/v1/openai` |
| **API Key** | `tierkit-loopback` (어떤 비어있지 않은 문자열도 OK, 단 비우면 안 됨) |
| **Model ID** | `auto` (또는 `localCoder`, `claudeSonnet` 등 특정 프로파일) |

---

## 단계별 사용법

### 1. 사전 조건 확인

- Tierkit VS Code 확장 설치 (`leesiwal.tierkit-vscode`)
- 워크스페이스 폴더가 열려 있음
- Tierkit 사이드바 상단 health pill이 **🟢 v0.1.0** (오프라인 아님)

빠른 검증:
```bash
curl -sS http://127.0.0.1:4101/v1/health | jq
# {"ok": true, "version": "0.1.0", ...} 가 와야 정상
```

### 2. Roo Code 설정 UI 열기

세 가지 방법:
1. **Roo 아이콘** (활동바) 클릭 → 패널 우측 상단 **⚙ Settings** 버튼
2. 명령 팔레트 (Ctrl+Shift+P) → `Roo Code: Open Settings`
3. Roo 채팅창에 `/settings` 슬래시 명령 (버전 따라 다름)

### 3. Provider 선택

**API Provider** 드롭다운 → `OpenAI Compatible` 선택.

자주 하는 실수:
- ❌ `OpenAI` 선택 (이건 OpenAI 본사 API용, Base URL 필드가 안 나옴)
- ❌ `Anthropic` / `OpenRouter` / 기타 (이러면 Tierkit 거치지 않고 직접 호출)
- ✅ `OpenAI Compatible` / `Custom OpenAI` / `OpenAI-compatible` (이름이 살짝 다를 수 있음)

### 4. 네 개 필드 입력

| 필드 | 값 | 비고 |
|---|---|---|
| **Base URL** | `http://127.0.0.1:4101/v1/openai` | `/v1/openai` 끝부분 중요. 그냥 `/v1`이나 `:4101`만 적으면 안 됨 |
| **API Key** | `tierkit-loopback` | Tierkit은 키 무시 (loopback이라 인증 없음). 단 **빈칸이면 Roo가 거부함** — 아무 비어있지 않은 문자열이면 OK |
| **Model ID** | `auto` | 자동 라우팅 추천. 강제하려면 `claudeSonnet`/`localCoder` 등 |
| **Use Custom Base URL** | ON (있다면 켜기) | Roo 버전에 따라 토글이 있음. 없으면 Base URL 채우는 것만으로 충분 |

### 5. 저장 + VS Code reload

Save 또는 Done 후 **반드시** 명령 팔레트 → **"Developer: Reload Window"** (Ctrl+R).

reload 안 하면 Roo가 새 설정을 안 읽음 — 가장 흔한 함정.

### 6. Roo에서 task 실행 + Tierkit 사이드바 모니터

Roo 채팅창에 아무 task ("test"라도) 입력. 10초 이내 **Tierkit 사이드바 → "최근 활동" 카드**에 그 호출이 나타나면 ✓ 연동 정상.

---

## 검증 (Roo 우회)

Roo 통하지 않고 Tierkit 자체 동작 확인:

```bash
curl -sS -X POST http://127.0.0.1:4101/v1/openai/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [{"role":"user","content":"hi"}],
    "tools": [{
      "type":"function",
      "function": {
        "name":"test_tool",
        "parameters":{"type":"object","properties":{"x":{"type":"string"}}}
      }
    }]
  }' | jq
```

응답이 OpenAI 형식 (`id`, `choices`, `usage`)으로 오면 → Tierkit 정상. Roo 쪽 설정만 점검하면 됨.

응답 본문에 `tierkit.profileId` 필드도 같이 와요 — 어떤 프로파일이 실제로 답했는지 알려주는 디버그 정보.

---

## 자주 보는 에러 + 의미

| Roo가 보여주는 에러 | 진짜 원인 | 해결 |
|---|---|---|
| `API Request Failed` (펼치면 "Provider ended the request") | Roo가 Tierkit endpoint에 도달 못함 | Base URL 정확히 확인, VS Code reload, daemon health 확인 |
| `401 Unauthorized` | API Key 필드 비어있음 | `tierkit-loopback` 또는 아무 값 입력 |
| `[missing-api-key] environment variable "ANTHROPIC_API_KEY" is not set` | Roo가 보낸 모델 id가 `claudeSonnet` 등 원격 프로파일인데 환경변수 없음 | `auto`로 변경 또는 환경변수 설정 |
| `[bad-status] ollama responded with 404 Not Found` | Tierkit이 골라준 로컬 모델이 안 받아져 있음 | `ollama pull <model>` 또는 viable한 다른 프로파일 사용 |
| `[unknown-profile] unknown profile "X"` | Roo가 보낸 Model ID가 Tierkit에 없음 | 사이드바 "모델 프로파일" 카드에서 id 확인, 오타 점검 |
| `Model Response Incomplete / 모델이 도구를 사용하지 않았습니다` | 모델이 텍스트로만 답함 (도구 호출 능력 부족) | 더 좋은 모델 (`qwen2.5-coder:7b`, `claude*`) 또는 Tierkit이 자동 변환 (0.3.3+ tool-shim) |
| `[budget-exceeded]` | Tierkit budget gate 작동 | `tierkit.config.json::budget` 조정 또는 사용량 리셋 |
| `[dangerous-command-blocked]` | 위험 명령 패턴 (`rm -rf` 등)이 prompt에 포함 | 의도된 차단. task 다시 구성 |
| `[plan-not-approved]` | strict freedom 레벨 + 세션이 plan 단계 안 거침 | `tierkit session approve-plan` 또는 freedom 레벨 낮춤 |

---

## 자주 하는 실수 (체크리스트)

- [ ] API Provider를 **OpenAI**로 잘못 선택 (Base URL 필드가 안 나옴 — 다시 OpenAI Compatible로)
- [ ] Base URL 끝에 `/v1/openai` 누락 (`http://127.0.0.1:4101`만 적음)
- [ ] API Key 비워둠 (Roo가 거부)
- [ ] Model ID에 `auto` 대신 존재하지 않는 프로파일 id (오타)
- [ ] 설정 저장 후 **VS Code reload 안 함**
- [ ] Tierkit daemon이 안 떠 있는 상태 (사이드바 빨간 pill)
- [ ] 워크스페이스 폴더 안 연 상태로 Tierkit 사용 (auto-start 실패)
- [ ] 여러 워크스페이스 settings가 충돌 (`.vscode/settings.json` 직접 편집 + Roo UI 설정 동시 변경)

---

## Model ID 선택 가이드

Roo의 Model ID 필드에 무엇을 적을지:

### `auto` (추천)
Tierkit이 task 위험도와 viability에 따라 자동 선택. 작은 task → 로컬, 큰 task → 클라우드 자동 라우팅. **이걸 추천합니다.**

### 특정 프로파일 강제
- `claudeSonnet` — 항상 Anthropic Claude Sonnet으로 (`ANTHROPIC_API_KEY` 필요)
- `claudeHaiku` — 항상 Anthropic Haiku (싸고 빠름)
- `localCoder` — Ollama qwen2.5-coder:7b 강제 (pull 필요)
- `gpt4o` — OpenAI gpt-4o (`OPENAI_API_KEY` 필요, public-cloud는 승인 필요)
- `ollama-<model-name>` — 자동 발견된 Ollama 모델 (Tierkit 0.3.4+)

사이드바 → **"모델 프로파일" 카드**에서 사용 가능한 id 전체 확인 가능.

---

## 한 번에 작동하는 가장 빠른 셋업

Tierkit 0.3.4+ 기준, 처음 사용자가 따라할 단계:

```bash
# 1. Ollama 모델 하나 받기 (없으면)
ollama pull qwen2.5-coder:7b

# 2. (선택) Anthropic API 키 설정
export ANTHROPIC_API_KEY="sk-ant-..."
# 그 셸에서 VS Code 새로 열기 — 환경변수 상속
code .
```

VS Code에서:
1. Tierkit 사이드바 → 상단 health 🟢 확인
2. **"연결된 도구" 카드** → roo 옆 **[연결]** 클릭
3. Ctrl+R (Reload Window)
4. Roo 패널 → ⚙ Settings → 위 빠른 참조 카드 확인 (자동으로 채워져 있어야 함). 안 채워져 있으면 직접 입력
5. Save + 또 한 번 Reload Window
6. Roo 채팅창에서 task → Tierkit 사이드바 "최근 활동" 카드에 등장 확인

---

## code-server (브라우저 VS Code) 특이사항

code-server는 데스크탑 VS Code와 아키텍처가 달라요:

```
[브라우저 (로컬 PC)]            [code-server (원격 서버)]
  └─ Tierkit 사이드바 ←─ HTTPS ─→ ├─ 확장 호스트
                                  ├─ Tierkit 데몬 ✓ (서버 loopback)
                                  ├─ Roo 확장 ✓ (Tierkit과 같은 서버)
                                  └─ Ollama ✓ (서버에 있어야 함)
```

영향:
- **Roo → Tierkit 호출은 서버 내부**라 정상 작동
- **사이드바 UI ↔ Tierkit 데몬 직접 연결은 막힐 수 있음** (브라우저-서버 사이 webview 격리)
- **Ollama는 서버에 있어야 함** — 사용자 로컬 PC의 Ollama 의미 없음

code-server에서 Roo가 안 되면:
1. 서버 터미널에서 `curl http://127.0.0.1:4101/v1/health` — 데몬 살았는지
2. 서버 터미널에서 `curl http://127.0.0.1:11434/api/tags | jq` — Ollama 모델 있는지
3. 둘 다 OK인데 Roo 에러면 Roo 설정 확인 (이 문서 참고)
4. 사이드바 UI는 작동 안 해도 **Roo는 작동해야 정상**

---

## 더 알아보기

- 메인 한국어 안내: [../README.md#한국어-안내](../README.md#한국어-안내)
- 연결 가이드 (Roo/Cline/Continue 통합): [CONNECT.ko.md](CONNECT.ko.md)
- 설치/초기 설정: [GUIDE.ko.md](GUIDE.ko.md)
- 보안 모델: [SECURITY.md](SECURITY.md)
- Tierkit 디자인 스펙: [SPEC.md](SPEC.md)

## 도움이 안 되면

`curl` 진단 결과 + Roo의 정확한 에러 메시지 (Details 클릭해서 펼친 내용)와 함께 GitHub issue 열어주세요: <https://github.com/LeeSiWal/Tierkit/issues>
