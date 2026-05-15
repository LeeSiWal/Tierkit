# Tierkit (VS Code)

> Local-first policy + routing layer for **Roo Code · Cline · Continue · aider** — and any OpenAI-compatible coding agent.
>
> Roo/Cline/Continue 같은 코딩 에이전트 **뒤에 깔리는** 로컬 우선 정책·라우팅 레이어. 사이드바는 미션 컨트롤 (라우팅·활성 플러그인·실시간 활동·사용량·모델).

[Tierkit](https://github.com/LeeSiWal/Tierkit) is a routing/policy daemon that sits between your existing coding agent (Roo, Cline, Continue, aider, …) and the actual model providers. It uniformly applies:

- **Tier-based routing** (local / private-remote / public-cloud) chosen per-task by risk + cost
- **Secret redaction** before any remote call
- **Dangerous-command classifier** (`rm -rf /` is blocked before execution)
- **Budget + workflow session gates** (strict mode requires plan approval before execute)
- **Plugin rules** injected into every model call's system prompt
- **Tool-call shim** that makes OpenAI structured tool calling work with weak local models (Cline-style XML/JSON parsing under the hood)

This extension is the VS Code companion. The daemon **auto-starts in-process** on activation — open a folder, the daemon runs.

---

## How to use (5 min)

### 1. Install + open a folder

Marketplace listing: `leesiwal.tierkit-vscode`. After install, open a project folder. Click the **Tierkit** icon in the activity bar — Mission Control sidebar appears.

### 2. Pull a tool-calling-capable local model (optional but recommended)

```bash
ollama pull qwen2.5-coder:7b
```

Tierkit's `localCoder` bundled profile points to this. Larger and more reliable for tool calls: `qwen2.5-coder:14b`.

Or set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in your shell before launching VS Code — bundled `claudeSonnet`/`gpt4o` profiles activate automatically.

### 3. (Optional) Enable a Tierkit plugin

For workflow discipline (plan-first, tests-first, etc.):

```bash
# Install the bundled superpowers-balanced plugin
tierkit plugin install <path-to-tierkit-source>/packages/plugin-superpowers/plugins/superpowers-balanced
tierkit plugin enable superpowers-balanced
```

Plugin rules are auto-injected into every model call's system prompt. (Sidebar-button install for bundled plugins is on the 0.3.4 roadmap.)

### 4. Connect your coding agent

In the Mission Control sidebar → **Connected tools** card → click `[Connect]` next to Roo / Cline / Continue. This edits `.vscode/settings.json` (or `.continue/config.yaml` for Continue) so the tool routes through Tierkit's OpenAI-compatible endpoint at `http://127.0.0.1:4101/v1/openai`.

**Reload VS Code** after connecting.

### 5. Use the tool as normal

Open Roo Code (or Cline, Continue) and start a task. Tierkit transparently:
- Picks a viable model profile (skips Ollama profiles whose model isn't pulled)
- Falls back to next candidate if one fails
- Injects active plugin rules
- Converts OpenAI structured tool calling → XML/JSON for weak local models, parses response back
- Logs the call to Mission Control's Recent Activity card

You should see the request appear in the sidebar within 5 seconds.

---

## Mission Control sidebar

```
┌──────────────────────────────────────┐
│ Tierkit  v0.1  guided  ↻              │
├──────────────────────────────────────┤
│ Connected tools                [Sync]│
│   roo       routed to Tierkit  [⤴]  │
│   cline     not installed     [Connect]│
│   continue  routed to Tierkit       │
├──────────────────────────────────────┤
│ Active plugins              [+ New] │
│   ▣ superpowers-balanced  guided    │
├──────────────────────────────────────┤
│ Recent activity      (refreshes 5s) │
│   14:23:01  localCoder              │
│             856ms · 1.2k↑/450↓      │
├──────────────────────────────────────┤
│ Today's usage                       │
│   24 calls · 18k tokens · $0.00     │
├──────────────────────────────────────┤
│ Model profiles                [+ Add]│
│   localCoder    ollama        test  │
│   claudeSonnet  anthropic ⚠   test  │
└──────────────────────────────────────┘
```

Auto-refreshes every 5s for activity + usage. Click `[Connect]`/`[Add]`/`[New]` for inline forms. No chat input — Tierkit is the policy layer behind agents, not an agent itself.

---

## Roo Code on the openai-compatible endpoint

If `tierkit connect roo` doesn't take effect (Roo 3.x sometimes ignores VS Code settings.json keys), configure manually via Roo's own UI:

1. Open Roo panel → ⚙ Settings
2. **API Provider** → `OpenAI Compatible` (NOT `OpenAI`)
3. **Base URL** → `http://127.0.0.1:4101/v1/openai`
4. **API Key** → `tierkit-loopback` (any non-empty string; empty fields are rejected by Roo)
5. **Model ID** → `auto` (let Tierkit route) or a specific profile id like `localCoder` / `claudeSonnet`
6. **Save + Reload Window** (Ctrl+R / Cmd+R)

Detailed Roo guide (Korean) with error meanings + checklist: [docs/ROO.ko.md](https://github.com/LeeSiWal/Tierkit/blob/main/docs/ROO.ko.md)

After saving, run any task in Roo and watch Mission Control's Recent Activity card.

---

## Tool-call shim — how weak local models work

`qwen2.5-coder:7b` and other small models often emit OpenAI tool calls as TEXT in `content` rather than as a structured `tool_calls` field. Roo/Cline see no `tool_calls` and report "model didn't use any tool".

Tierkit's tool-shim (auto-enabled for local-device tier) does what Cline / Roo themselves do internally:
1. Convert OpenAI `tools` array into XML-tag instructions in the system prompt
2. Strip structured `tools` from the outgoing request — model sees plain instructions
3. Parse model's text response for XML tags or JSON patterns
4. Return as structured `tool_calls` to the caller

Supported response formats:
- `<read_file><path>foo.ts</path></read_file>` (XML)
- ` ```json {"name": "X", "arguments": {...}} ``` ` (code-fenced JSON)
- Bare `{"name": "X", "arguments": {...}}` (the qwen2.5-coder pattern)
- Multiple tool calls per response

Config: `tierkit.config.json::runtime.toolShim` = `auto` (default, local only) | `on` | `off`.

---

## Diagnostics (when something doesn't work)

| Symptom | What to do |
|---|---|
| Sidebar shows "offline" | VS Code → Output → select **Tierkit** channel → read auto-start log |
| Roo says "API request failed" | Run `tierkit connect roo` again + reload window |
| Roo says "model didn't use any tool" | Check the model — try `qwen2.5-coder:7b` or Claude. The shim works but if the model emits nothing tool-like in content, it can't translate |
| Daemon won't start on Windows | Common: AppContainer (Microsoft Store VS Code) blocks loopback. Run `CheckNetIsolation LoopbackExempt -a -n="Microsoft.VisualStudioCode_8wekyb3d8bbwe"` as admin |
| Port 4101 taken | Tierkit auto-falls back to an OS-assigned port; check Output channel for the new URL |

The **"Tierkit" Output channel** (View → Output → Tierkit) logs every auto-start step. If something's off, that's the first place to check.

---

# 한국어 사용법

**Tierkit**은 Roo Code · Cline · Continue · aider 같은 **코딩 에이전트 뒤에 깔리는 정책·라우팅 레이어**예요. 에이전트를 대체하지 않고 그들의 모델 호출을 가로채서 통일된 정책 적용:

- **계층별 라우팅** (로컬 · 프라이빗 원격 · 퍼블릭 클라우드) 위험도+비용 자동 선택
- **시크릿 자동 마스킹** (.env, API 키, PEM 패턴)
- **위험 명령 차단** (`rm -rf /` 등)
- **예산 + 워크플로 세션 게이트**
- **Tierkit 플러그인의 룰** 자동으로 system prompt 주입
- **Tool-call shim** — 약한 로컬 모델 (qwen2.5-coder:7b 등)도 OpenAI 구조화 도구 호출이 작동하도록 자동 XML/JSON 변환

## 5분 사용법

### 1. 설치 + 폴더 열기

Marketplace에서 `leesiwal.tierkit-vscode` 설치. 프로젝트 폴더를 열고 활동 바의 Tierkit 아이콘 클릭 → 사이드바에 미션 컨트롤 표시.

### 2. 로컬 모델 받기

도구 호출 잘 따르는 모델:
```bash
ollama pull qwen2.5-coder:7b   # 4.7GB · 8GB+ RAM
# 더 신뢰성 있게:
ollama pull qwen2.5-coder:14b  # 9GB · 16GB+ RAM
```

또는 클라우드 사용:
```bash
export ANTHROPIC_API_KEY="sk-ant-..."
# 환경변수가 잡힌 셸에서 VS Code 다시 열기 (code .)
```

### 3. (선택) Tierkit 플러그인 활성화

워크플로 규율 (plan 먼저, tests 우선 등):
```bash
cd <workspace>
tierkit plugin install <tierkit-source>/packages/plugin-superpowers/plugins/superpowers-balanced
tierkit plugin enable superpowers-balanced
```

룰이 모든 모델 호출의 system prompt에 자동 주입됨.

### 4. 코딩 에이전트 연결

사이드바 → **"연결된 도구" 카드** → `roo` 옆 **[연결]** 클릭. `.vscode/settings.json`에 자동으로 4개 키 작성. **VS Code 윈도우 reload** 필수.

Roo 3.x가 settings.json을 무시하면 Roo 패널 → ⚙ Settings에서 직접:

| 필드 | 값 |
|---|---|
| API Provider | **OpenAI Compatible** ← 절대 `OpenAI` 아님 |
| Base URL | `http://127.0.0.1:4101/v1/openai` |
| API Key | `tierkit-loopback` (빈칸 안 됨) |
| Model ID | `auto` (또는 `localCoder` 등) |

**저장 후 Ctrl+R로 reload 필수.** 자세한 Roo 가이드: [docs/ROO.ko.md](https://github.com/LeeSiWal/Tierkit/blob/main/docs/ROO.ko.md)

### 5. Roo에서 평소처럼 사용

Roo 채팅창에서 task. Tierkit이 뒤에서:
- viable한 모델 프로파일 자동 선택 (안 받은 Ollama 모델 등 skip)
- 첫 시도 실패 시 다음 후보로 폴백
- 활성 플러그인 룰 주입
- 작은 모델이 텍스트로 도구 호출 emit해도 자동으로 구조화 변환
- 모든 호출을 사이드바 "최근 활동" 카드에 5초 안에 표시

## 직접 검증 (Roo 우회 curl)

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
        "parameters":{"type":"object","properties":{"path":{"type":"string"}}}
      }
    }]
  }' | jq
```

응답에 `tool_calls` 배열 + `finish_reason: "tool_calls"`가 보이면 → 파이프라인 정상.

## 작동 안 할 때

| 증상 | 처방 |
|---|---|
| 사이드바 "오프라인" | View → Output → **Tierkit** 채널 → 자동 시작 로그 확인 |
| Roo "API request failed" | `tierkit connect roo` 다시 + VS Code reload |
| Roo "도구 안 썼다" | 모델 한계. `qwen2.5-coder:7b` 또는 Claude로 변경 |
| Windows에서 데몬 안 뜸 | Microsoft Store VS Code는 AppContainer로 localhost 차단. `CheckNetIsolation LoopbackExempt -a -n="Microsoft.VisualStudioCode_8wekyb3d8bbwe"` 관리자 PS |
| 4101 포트 막힘 | Tierkit이 자동으로 빈 포트 폴백. Output 채널에서 새 URL 확인 |

**모든 진단의 시작**: VS Code → 출력(Output) 패널 → 드롭다운 **Tierkit** 선택 → 단계별 로그.

## 자기 플러그인 만들기

```bash
tierkit plugin new my-team-rules
$EDITOR my-team-rules/tierkit.plugin.json
tierkit plugin install ./my-team-rules
tierkit plugin enable my-team-rules
# → 자동으로 연결된 Roo/Cline/Continue에 export
```

플러그인 하나 작성 = 모든 도구에 동일 룰 적용.

## 보안

- 데몬은 `127.0.0.1` (loopback) 전용
- `public-cloud` 프로파일은 review-only + 승인 필요 기본값
- 원격 호출 직전 시크릿 자동 마스킹
- 위험 명령 사전 차단
- 텔레메트리 없음

## 더 알아보기

- GitHub: <https://github.com/LeeSiWal/Tierkit>
- 연결 가이드: [docs/CONNECT.ko.md](https://github.com/LeeSiWal/Tierkit/blob/main/docs/CONNECT.ko.md)
- 디자인 스펙: [docs/SPEC.md](https://github.com/LeeSiWal/Tierkit/blob/main/docs/SPEC.md)
- 보안 모델: [docs/SECURITY.md](https://github.com/LeeSiWal/Tierkit/blob/main/docs/SECURITY.md)

## License

MIT
