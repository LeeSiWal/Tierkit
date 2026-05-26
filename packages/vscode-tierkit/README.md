# Tierkit (VS Code)

> Local-first **runtime + policy layer** for AI coding CLIs — Claude Code, Roo Code, Cline, Continue, aider — and any OpenAI-compatible coding agent.
>
> Claude Code · Roo · Cline · Continue 같은 AI 코딩 도구 **뒤에 깔리는** 로컬 우선 런타임 + 정책 레이어. 사이드바에서 Gateway, 라우팅, 활성 플러그인, 사용량을 한눈에.

[Tierkit](https://github.com/LeeSiWal/Tierkit) is a daemon that sits between your AI coding tools and the actual model providers. It uniformly applies:

- **Context digest MCP tools** — `compress_command`, `get_file_digest`, `get_diff_summary`, `get_error_digest`, `build_context_pack` — let Claude Code (and any MCP client) inspect large files / diffs / logs through compact deterministic digests.
- **Tier-based routing** (local / private-remote / public-cloud) chosen per task by policy
- **Secret redaction** before any remote call
- **Dangerous-command classifier** (`rm -rf /` is blocked before execution)
- **Budget + workflow session gates** (strict mode requires plan approval before execute)
- **Plugin rules** injected into every model call's system prompt
- **Tool-call shim** that makes OpenAI structured tool calling work with weak local models (Cline-style XML/JSON parsing under the hood)
- **Built-in Tierkit Chat** — proxies the `claude` CLI through the sidebar so you can chat without leaving VS Code

This extension is the VS Code companion. The daemon **auto-starts in-process** on activation — open a folder, the daemon runs.

## What's new in 0.24

- **0.24.1** — Release-facing README copy aligned with the Anthropic Gateway release: Gateway connection is stable; experimental request transformation remains disabled by default.
- **0.24.0** — Anthropic Gateway Connection. Route Claude Code through Tierkit with status, diagnostics, scoped terminal launch, Direct fallback, and safe local gateway request logging. Experimental request transformation infrastructure is included but requires explicit opt-in.

## Previous 0.22 updates

- **0.22.6** — Sidebar self-recovers on cold start. If the webview opens before the daemon is accepting connections, `refreshHealth` now detects the offline→online edge and refires `refreshAll()` once — no more "blank cards until I click ↻".
- **0.22.5** — Auto-heal stale MCP `cliPath` on extension auto-update. Previously, when the extension upgraded, Claude Code's `.mcp.json` entry kept pointing at the old extension folder, silently breaking MCP after VS Code GC'd it. Now the daemon's host-info handler rewrites it in place — no manual reconnect needed.
- **0.22.4** — The "today" activity window respects the daemon's local timezone (was UTC midnight — KST users used to see the card reset at 09:00). Long profile/model IDs in the sidebar wrap correctly instead of overflowing. New "System requirements" section below.
- **0.22.3** — The activity card pushes via Server-Sent Events. Sub-second updates after any MCP tool call; no more 5-second polling lag.
- **0.22.2** — Fixed `/v1/usage` endpoint crash when the activity log mixed LlmCall + MCP-tool records.
- **0.22.x** — `byClient` + `byModel` activity breakdown (see exactly which Claude model / which MCP client produced activity).

See [CHANGELOG.md](./CHANGELOG.md) for the full history.

---

## System requirements

**Gateway only** (MCP compression, routing, plugin rules, Tierkit Chat via the `claude` CLI):

- VS Code 1.84+ · Node 20.10+ (bundled) · macOS / Windows / Linux
- 4 GB RAM · 200 MB disk
- Outbound HTTPS only if you opt into a cloud provider profile (`claudeSonnet`, `gpt4o`, …)

**With a local LLM via Ollama**:

| Model | RAM | Disk | Comfortably runs on |
|---|---|---|---|
| `qwen2.5-coder:7b` | 8 GB+ | ~5 GB | Apple Silicon M1+, NVIDIA GPU with 8 GB+ VRAM, or any modern x86 with 16 GB RAM |
| `qwen2.5-coder:14b` | 16 GB+ | ~9 GB | Apple Silicon M2 Pro / M3 Pro+, NVIDIA RTX 3080 / 4070+ |
| `qwen3-coder:30b` | 32 GB+ | ~19 GB | Apple Silicon M2 Max / M3 Max+ (unified memory ≥ 32 GB), NVIDIA RTX 4090 / A100 |

No GPU? The smaller models still run on CPU — expect 10–30 s per response. Cloud profiles work with zero local compute.

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
┌────────────────────────────────────────┐
│ Tierkit  v0.22.3   guided   ↻          │
├────────────────────────────────────────┤
│ Savings — today (live via SSE)         │
│   ▼ 91% · 22.0k tok saved · $0.066     │
│   ▰▰▰▰▰▰▰▰▰▱  88 MCP calls avoided    │
│   by client: claude-code (×85)         │
│   by model:  claude-sonnet-4-6 (×72)   │
├────────────────────────────────────────┤
│ Connected tools                  [Sync]│
│   claude-code  ✓ MCP connected         │
│   roo          routed to Tierkit  [⤴] │
│   cline        not installed   [Connect]│
│   continue     routed to Tierkit       │
├────────────────────────────────────────┤
│ Tierkit Chat (claude CLI proxy)        │
│   ▸ type a message…                    │
├────────────────────────────────────────┤
│ Active plugins                  [+ New]│
│   ▣ superpowers-balanced  guided       │
├────────────────────────────────────────┤
│ Recent activity        (refreshes 5s)  │
│   14:23:01  tierkit.get_file_digest    │
│             7ms · 22k→0.6k tokens      │
├────────────────────────────────────────┤
│ Today's usage                          │
│   24 calls · 18k tokens · $0.00        │
├────────────────────────────────────────┤
│ Model profiles                  [+ Add]│
│   localCoder    ollama          test   │
│   claudeSonnet  anthropic  ⚠    test   │
└────────────────────────────────────────┘
```

The Savings card updates the moment Claude (or any MCP client) calls a Tierkit compression tool — no polling lag. Other cards (activity, usage, health) auto-refresh every 5s. Click `[Connect]` / `[Add]` / `[New]` for inline forms.

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

**Tierkit**은 Claude Code · Roo · Cline · Continue · aider 같은 **AI 코딩 도구 뒤에 깔리는 로컬 런타임 + 정책 레이어**예요. 도구를 대체하지 않고 그들의 모델 호출과 MCP 도구 호출에 통일된 정책을 적용:

- **Context digest MCP 도구** — `compress_command`, `get_file_digest`, `get_diff_summary`, `get_error_digest`, `build_context_pack` 등. Claude Code가 큰 파일/diff/로그를 deterministic digest로 확인할 수 있게 함
- **계층별 라우팅** (로컬 · 프라이빗 원격 · 퍼블릭 클라우드) 정책 기반 선택
- **시크릿 자동 마스킹** (.env, API 키, PEM 패턴)
- **위험 명령 차단** (`rm -rf /` 등)
- **예산 + 워크플로 세션 게이트**
- **Tierkit 플러그인의 룰** 자동으로 system prompt 주입
- **Tool-call shim** — 약한 로컬 모델 (qwen2.5-coder:7b 등)도 OpenAI 구조화 도구 호출이 작동하도록 자동 XML/JSON 변환
- **Tierkit Chat 내장** — `claude` CLI를 사이드바에서 직접 호출해 VS Code를 떠나지 않고 대화

## 0.24 신기능

- **0.24.1** — 공개 README 문구를 Anthropic Gateway 릴리즈 정체성에 맞게 정리했습니다. Gateway 연결은 stable이고, 실험적 request transformation은 기본 비활성입니다.
- **0.24.0** — Anthropic Gateway Connection. Claude Code를 Tierkit을 통해 라우팅하고 상태, 진단, scoped terminal 실행, Direct fallback, 안전한 로컬 Gateway 요청 로그를 제공합니다. 실험적 request transformation 인프라는 포함되지만 명시적 opt-in이 필요합니다.

## 이전 0.22 업데이트

- **0.22.6** — 사이드바 cold-start 자동 복구. 웹뷰가 데몬 ready 전에 열리면 `refreshHealth`가 offline→online 전환을 감지해 `refreshAll()`을 1회 재실행 — "↻ 누르기 전까지 카드 비어있음" 증상 해결.
- **0.22.5** — 익스텐션 자동 업데이트 시 `.mcp.json`이 옛 버전 폴더를 가리키던 stale path 문제 자동 복구. 이전엔 업데이트 후 VS Code가 옛 폴더를 GC하면 Claude Code의 MCP가 조용히 끊어져 활동 카드가 0에 멈춰 있는 증상이 생겼습니다. 이제 데몬이 host-info 받을 때마다 path를 자동 갱신 — 사용자가 재연결 누를 필요 없음.
- **0.22.4** — 활동 "오늘" 윈도우가 PC의 로컬 타임존을 따름 (이전에는 UTC 자정 기준이라 KST 사용자는 매일 오전 9시에 카드가 0으로 리셋되는 버그). 긴 프로파일/모델 ID도 사이드바를 벗어나지 않고 줄바꿈됨. 아래 "추천 사양" 섹션 추가.
- **0.22.3** — 활동 카드가 SSE로 push됨. MCP 도구 호출 후 ~500ms 내 자동 갱신 (수동 새로고침 불필요)
- **0.22.2** — `/v1/usage` 엔드포인트가 activity 로그의 혼합 레코드를 처리하지 못해 크래시되던 버그 수정
- **0.22.x** — `byClient` / `byModel` 활동 분해 (어떤 Claude 모델, 어떤 MCP 클라이언트가 activity를 만들었는지)

## 추천 사양

**게이트웨이 전용** (MCP 압축 · 라우팅 · 플러그인 룰 · `claude` CLI 프록시):

- VS Code 1.84+ · Node 20.10+ (확장에 번들) · macOS / Windows / Linux
- RAM 4 GB · 디스크 200 MB
- 인터넷은 클라우드 프로파일 사용할 때만 (`claudeSonnet`, `gpt4o` 등)

**로컬 LLM (Ollama)까지**:

| 모델 | RAM | 디스크 | 무난한 환경 |
|---|---|---|---|
| `qwen2.5-coder:7b` | 8 GB 이상 | ~5 GB | Apple Silicon M1+, NVIDIA GPU 8 GB+ VRAM, x86 16 GB+ |
| `qwen2.5-coder:14b` | 16 GB 이상 | ~9 GB | Apple Silicon M2 Pro / M3 Pro+, NVIDIA RTX 3080 / 4070+ |
| `qwen3-coder:30b` | 32 GB 이상 | ~19 GB | Apple Silicon M2 Max / M3 Max+ (통합 메모리 32 GB+), NVIDIA RTX 4090 / A100 |

GPU 없어도 작은 모델은 CPU로 돌아감 — 응답에 10~30초 걸린다고 보면 됨. 클라우드 프로파일은 로컬 자원 0으로 동작.

전체 이력: [CHANGELOG.md](./CHANGELOG.md)

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

MIT — Copyright (c) 2026 이제성 (Lee Je-sung / LeeSiWal). See [LICENSE](./LICENSE) for the full text.

All bundled `samples/superpowers-*` plugins ship under the same MIT license.
