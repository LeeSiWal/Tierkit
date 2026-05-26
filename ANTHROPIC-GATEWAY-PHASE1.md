# Anthropic Gateway — Phases 0 & 1 (consolidated) · Phase 2 design baseline

> 이 문서는 Phase 0 spike와 Phase 1 productization을 한 곳에 정리한 단일 진실
> 원본(SoT)이다. Phase 2 설계의 출발점으로 사용한다. 더 깊은 내용은 본문이
> 끝에서 가리키는 references로 들어간다.

Status: **Phase 1 implementation complete (PR #2, draft).** Awaiting dogfood +
Phase 2 entry-gate satisfaction.

Branch / PR: `worktree-anthropic-gateway-phase1` → `worktree-anthropic-gateway-spike` (base). 15+ commits.

---

## 0. 이 문서의 위치

| 문서 | 무엇을 다루나 | 누가 읽나 |
|---|---|---|
| **(이 문서)** `ANTHROPIC-GATEWAY-PHASE1.md` | Phase 0+1 통합 요약 + Phase 2 설계 베이스 | Phase 2 설계자, 리뷰어 |
| `docs/RFC-anthropic-gateway.md` | Phase 0 spike의 4가지 validation 원문 + Phase 2 entry gate | 의사결정 추적 |
| `docs/ARCHITECTURE-anthropic-gateway.md` | Phase 1 코드 아키텍처 (다이어그램, 상태 머신, 파일 인벤토리) | Phase 1을 손볼 엔지니어 |
| `docs/ANTHROPIC_GATEWAY.md` / `.ko.md` | 사용자용 how-to | 최종 사용자 |
| `docs/superpowers/plans/2026-05-26-anthropic-gateway-spike.md` | Phase 0 plan | 회고 / 추적 |
| `docs/superpowers/plans/2026-05-26-anthropic-gateway-phase1.md` | Phase 1 plan (rev6, 35 corrections) | 회고 / 추적 |
| `packages/vscode-tierkit/test/MANUAL_gateway_flows.md` | Phase 1 manual test plan (13 cases) | QA / dogfood |

---

## 1. 타임라인

```
2026-05-26  Phase 0 spike  ─┐  4 validations pass
            (worktree-anthropic-gateway-spike)
                            │
2026-05-26  Phase 1 plan    ─┤  rev6 (35 corrections after 6 review rounds)
            ↓
2026-05-26  Phase 1 ship    ─┤  14 tasks (Task 0…13), 1,325 tests pass
            (PR #2 draft)    │
                            │
            ↓               
            Phase 2 entry gate ─→ Phase 2 design (this doc is the input)
```

---

## 2. Phase 0 — Spike validation (요약)

`ANTHROPIC_BASE_URL` 기반 passthrough가 실제 Claude Code v2.1.150 (Claude Max
구독, Mac) 환경에서 안전하게 동작하는지 4가지 question을 라이브 환경에서 검증.

| Question | 결과 | Phase 1 영향 |
|---|---|---|
| **A.** Subscription OAuth credential survives gateway redirection | ✅ 통과 | 구독 사용자 + BYOK 모두 Phase 1 범위. detect-and-warn 불필요. |
| **B-1.** MCP coexistence in default fallback (no `ENABLE_TOOL_SEARCH`) | ✅ 통과 — 14 tools 로드, `tierkit.get_file_digest` 호출, `usage.jsonl`에 `savedTokens: 101` 기록 | 게이트웨이와 MCP는 preload 모드에서 그대로 공존. mitigation 불필요. |
| **B-2.** `ENABLE_TOOL_SEARCH=true` 경유 | ✅ 통과 — "Deferred" 표시 정상, deferred-tool resolution 성공 | Phase 1에 optional `ENABLE_TOOL_SEARCH` 토글을 protocol 문제 없이 노출 가능. |
| **C.** 멀티턴 tool_use 스트리밍 fidelity | ✅ 통과 — Glob → Read × 3 → text 흐름 깨끗하게 종료. orphan tool_use 없음. | 스트리밍 버그 없음. Phase 2 transformation 들어가도 base는 안정. |

### Phase 0가 남긴 코드 (Phase 1이 위에 올린 substrate)

- `packages/core/src/runtime/anthropicGateway.ts` — `forwardMessages`,
  `streamMessages`, `forwardCountTokens`, `observeAuthHeaders` (raw scheme
  prefix 반환), `upstreamUrl()` override via `TIERKIT_ANTHROPIC_UPSTREAM`.
- `packages/core/src/runtime/Server.ts` 안의 두 라우트 (`POST /v1/messages`,
  `POST /v1/messages/count_tokens`) — 무조건 enabled 상태로 wire되어 있던 것.
- 17개 테스트 (`anthropicGateway.test.ts` 14 unit + `Server.anthropicGateway.test.ts` 3 integration).

### Phase 0의 명시적 비목표 (Phase 1도 동일하게 유지)

- request/response body transformation
- 토큰 절감 측정 / 수치 주장
- `.zshrc` 등 persistent shell profile 수정
- 사용자 credential 강제/제거
- `/v1/models` discovery (Claude Code 자체 gating)
- local LLM 라우팅 (Phase 3)
- OAuth 관리 endpoint (Claude Code가 hardcoded)

---

## 3. Phase 1 — 아키텍처 한눈에

목표: Phase 0의 passthrough를 **Tierkit 안의 1급 안전 연결 기능**으로 포장.
**Body transformation은 명시적 비범위.** Phase 2가 같은 자리에서 한다.

### 3.1 Phase 1이 추가한 surface

**Data plane (gated):**
- `POST /v1/messages` — `gatewayMode === "on"`일 때만 forward, 아니면 404
- `POST /v1/messages/count_tokens` — 동일

**Control plane (loopback-only, 403 `{error:"local_only"}` 아닐 시):**
- `GET /v1/gateway/status`
- `PATCH /v1/config/runtime` (field allowlist + full schema parse + atomic write)
- `GET /v1/doctor/gateway`

**CLI:**
- `tierkit doctor gateway` — 6 checks, FAIL 있으면 exit 1

**VS Code 확장:**
- Command `tierkit.toggleGatewayMode` — discriminated reachability, no-fallback-after-PATCH
- Command `tierkit.launchClaudeCodeWithGateway` — readiness classify, scoped terminal, Direct fallback dialog
- Sidebar cards: "Route Claude Code through Tierkit" toggle + "Anthropic Gateway — diagnostics"

**파일:**
- `.tierkit/runtime/anthropic-gateway.jsonl` — 안전 per-request 로그 (아래 3.3)

### 3.2 9가지 invariant (Phase 2가 깨면 안 되는 것)

1. **Local-first control plane.** 3개 컨트롤 endpoint는 비-loopback caller를 403.
2. **Pure / side-effect split.** `vscode` import 있는 파일은 pure module의 얇은 wrapper. 순수 모듈은 VS Code runtime 없이 vitest에서 단독 검증.
3. **Value-constrained safe log.** `appendGatewayLog()`는 `unknown`을 받고 allowlist 필드만 project. enum (`path`, `authorizationScheme`), regex fingerprint, `superRefine()` invariant 강제. `async`라서 schema/byte-guard 실패는 rejected promise로 표출.
4. **Deterministic log writes.** non-stream: `await logFinal(status)` BEFORE `res.end(body)`. stream: `streamMessages` resolve 후 log. 더 강한 pre-client-completion 보증은 명시적으로 Phase 2.
5. **Streaming-aware error status.** pre-headers transport error → 502 (응답 + log). mid-stream upstream failure → log `res.statusCode`(클라이언트가 본 status), stream destroy. mid-stream에서 502를 log하면 wire와 발산.
6. **Discriminated reachability.** 토글 커맨드는 probe 결과를 `reachable | transport-failure | rejected`로 분류. 파일 fallback은 **오직** `transport-failure`에서만.
7. **No-fallback-after-PATCH.** `PATCH /v1/config/runtime`을 시도한 뒤 응답을 잃었으면 데몬이 commit했을 가능성이 있음 → indeterminate-state error만 표시. 파일 mutate 금지.
8. **Authorization scheme normalization.** Server가 비-Bearer raw scheme을 `"Other"`로 정규화한 뒤 log → exotic 헤더로 인한 silent log loss 없음.
9. **Untouched surfaces.** `anthropicGateway.ts` (Phase 0 spike) + ordinary `tierkit doctor`는 Phase 1이 건드리지 않음. Phase 2가 body transformation 들고 들어올 때 `anthropicGateway.ts`를 손댐.

### 3.3 안전 로그 스키마

```jsonc
{
  "ts": "2026-05-26T12:00:00.000Z",
  "path": "/v1/messages",                       // enum
  "stream": true,
  "status": 200,
  "durationMs": 1234,
  "auth": {
    "authorizationScheme": "Bearer",            // "Bearer" | "Other" | null
    "authorizationFingerprint": "abcdef123456", // /^[0-9a-f]{12}$/ | null
    "apiKeyPresent": false,                     // no default — 누락 시 reject
    "apiKeyFingerprint": null                   // /^[0-9a-f]{12}$/ | null
  }
}
```

`superRefine()` invariant:
- `authorizationScheme === null` ⇔ `authorizationFingerprint === null`
- `apiKeyPresent === false` ⇔ `apiKeyFingerprint === null`

**로그에 결코 들어가지 않는 것:** request body, response body, raw
`Authorization` / `x-api-key`, `system` prompt, `messages[]`, `tool_result`
내용.

회전: 5 MB 또는 7일 (먼저 도달하는 쪽). Atomic tmp+rename rewrite. Module-level
promise queue로 writes serialize.

### 3.4 토글 흐름 (요약)

```
사이드바 토글 클릭
  → GET /v1/gateway/status (loopback-canonicalized)
      ├── reachable    → PATCH /v1/config/runtime
      │                     ├── ok     → info + render
      │                     └── throw  → indeterminate-state error (파일 mutate 금지)
      ├── transport-failure → 파일 직접 flip (allow), restartDaemon, render
      └── rejected     → showError (파일 mutate 금지)
```

핵심: rejected ≠ transport-failure. post-PATCH ambiguity는 항상 indeterminate.

### 3.5 Launch 흐름 (요약)

```
"Launch Claude Code through Tierkit" 클릭
  → GET /v1/gateway/status → classifyReadiness
      ├── ready         → openGatewayTerminal(controlBaseUrl)
      ├── mode-off      → info ("토글 켜고 다시 시도"), return (재시작 X)
      └── unreachable   → statusbar "starting…", restartDaemon, 300ms × ≤3000ms poll
                          ↓ (여전히 ready 아니면)
                          warning dialog: "Launch direct?"
                            ├── cancel → return
                            └── direct → Terminal(name "Claude Code (direct)",
                                                  env: { ANTHROPIC_BASE_URL: undefined })
                                          (TIERKIT_CLAUDE_CODE_BIN 존중)
```

핵심: mode-off는 절대 데몬 재시작 트리거 안 함. shell profile은 영구 수정 X.

### 3.6 Phase 1이 만든 파일 (전체 인벤토리는 `docs/ARCHITECTURE-anthropic-gateway.md`)

생성한 source/test: 25개 안팎.
생성한 docs: 4개 (`ANTHROPIC_GATEWAY.md`/`.ko.md`, `ARCHITECTURE-anthropic-gateway.md`, 이 문서).
수정한 source: `Server.ts`, `TierkitConfig.ts`, `index.ts`, `gui.ts`, `cli.ts`, `extension.ts`, `package.json` + nls × 2, `README.md`, `RFC-anthropic-gateway.md`.

---

## 4. Operational baseline (Phase 2 시작 시 운영 중인 것)

Phase 1이 ship되고 dogfood가 시작되면 아래가 항상 가동된다. Phase 2 설계는
이걸 **전제**로 한다.

| Signal | 어디서 | Phase 2가 어떻게 쓰나 |
|---|---|---|
| `tierkit doctor gateway` (6 checks) | CLI, 사이드바 diagnostics 카드 | Phase 2 기능이 들어가도 OK 유지가 entry gate |
| `.tierkit/runtime/anthropic-gateway.jsonl` | 데몬 로컬 파일 | 5xx 카운트, latency 분포, scheme 분포 분석 — 측정의 baseline |
| `runtime.gatewayMode` config | `tierkit.config.json` | Phase 2 기능도 동일 flag 아래에서 라이브 |
| Sidebar 토글 상태 | webview ↔ extension | Phase 2가 추가하는 UI는 같은 toggle을 reactivity source로 |
| `GET /v1/gateway/status` body | `{routesEnabled, messagesPath, countTokensPath, logPath}` | Phase 2 기능 추가 시 status body 확장 가능 (additive only) |
| `GET /v1/doctor/gateway` | 6 checks + 확장 가능 | Phase 2 신규 체크 추가 자리 |

### 측정 baseline 만들기 (entry gate #2와 직결)

```bash
# 5xx 카운트 (entry gate 통과 조건: 0)
jq 'select(.status >= 500)' .tierkit/runtime/anthropic-gateway.jsonl | jq -s 'length'

# 평균 latency (Phase 2 비교 baseline)
jq -s 'map(.durationMs) | add / length' .tierkit/runtime/anthropic-gateway.jsonl

# 스트리밍 비율
jq -s 'group_by(.stream) | map({stream:.[0].stream, n:length})' .tierkit/runtime/anthropic-gateway.jsonl

# scheme 분포 (subscription vs api-key 비율 가늠)
jq -s 'group_by(.auth.authorizationScheme) | map({scheme:.[0].auth.authorizationScheme, n:length})' .tierkit/runtime/anthropic-gateway.jsonl
```

이 4개의 1주일치 baseline은 Phase 2가 "before/after"를 주장하기 위한 출발점.

---

## 5. Decision log — Phase 2가 상속하는 것

> Phase 1에서 내린, **Phase 2 설계가 무의식적으로 깨면 위험한** 결정들.

### 5.1 비측정 = 비주장 (절감 vocabulary 금지)

User-facing strings에서 금지:
`savings, save, saves, saved, cost, cheaper, efficient, 절감, 절약, 비용, 효율,
및 모든 numeric token-count claim.`

Phase 2가 실제 측정을 도입하면 이 규칙이 풀린다. 그러나 **그 측정이 production에서 정직하게 굴러가기 전까지**는 절감 단어 들어간 UI 카피를 추가하지 마라. CI에서 diff-based로 막힌다 (`docs/superpowers/plans/2026-05-26-anthropic-gateway-phase1.md` Task 13 Step 2).

### 5.2 control plane은 loopback만

`GET /v1/gateway/status`, `PATCH /v1/config/runtime`, `GET /v1/doctor/gateway` 셋이 loopback-only. Phase 2가 control endpoint를 추가하면 동일 가드를 통과시켜야 함. LAN-only bind 데몬은 의도적으로 미지원 (다이얼로그도 표시하지 않음).

### 5.3 데몬과 확장 사이의 SoT는 항상 데몬

토글의 디스크 fallback은 transport-failure(데몬 닿지 않음)에서만, 그리고 PATCH 시도 전에만 허용. PATCH 후 실패는 indeterminate. Phase 2가 추가하는 토글/스위치도 같은 규칙. **"확장이 데몬과 의견이 다르면 데몬이 옳다."**

### 5.4 로그 스키마는 strict + superRefine

Phase 2가 새 필드를 넣고 싶다면:
1. allowlist projection 함수에 필드 추가
2. zod object에 필드 추가 (enum/regex/datetime — 자유 string 금지)
3. `superRefine`에 새 invariant 등록 (있다면)
4. `gatewayLog.redaction.test.ts` + `gatewayLog.test.ts`에 케이스 추가
5. `authorizationScheme` enum을 확장하려면 redaction 테스트도 확장 — silent 확장 금지.

### 5.5 스트리밍 로그 contract는 의도적으로 느슨함

Phase 1은 "stream이 끝난 뒤 log"라는 loose contract만 보증. Pre-client-completion guarantee는 Phase 2 후보. 만약 Phase 2가 이걸 강화한다면 `anthropicGateway.ts`의 `streamMessages`를 손대야 함 — `Server.ts` 외곽에서 `res.end` monkey-patch하는 식은 **거부**된 우회 (Task 5 코드 리뷰에서 명시적으로 제거됨). 백프레셔 위험과 fragility 때문.

### 5.6 `anthropicGateway.ts`는 Phase 1에서 변경 0

Phase 2가 body transformation 들어올 때 처음으로 손대는 파일. Phase 1의
`Server.ts` 라우트 plumbing은 그때도 그대로 — hook은 `forwardMessages` /
`streamMessages` 내부.

### 5.7 인증 정보 fingerprint만 (12 hex chars)

Authorization / x-api-key 값 자체를 로그/UI에 보여주지 않음. 12자 lowercase
hex fingerprint만. Phase 2가 BYOK vs subscription 분기 로직을 도입하더라도
원본 토큰은 절대 persistent하게 만지지 않음.

### 5.8 환경변수 주입은 통합 터미널 한정

`.zshrc` / shell profile 영구 수정 금지. `ANTHROPIC_BASE_URL`은 사용자가 누른
launch 버튼이 만든 터미널 그 1개에만. Phase 2가 "더 매끄러운 자동 wiring"을
탐낼 때 이 규칙을 깨지 마라 — Phase 0 RFC가 이걸 명시적 비범위로 잠갔다.

---

## 6. Phase 2 design space

> Phase 2의 미션은 Phase 0 RFC §3 끝부분에서 정의됨:
> **"`tool_result` envelope + cursor pagination + dedupe + secret redaction —
> 그제서야 토큰 절감 주장이 사실로 방어 가능해진다."**

Phase 1이 깔아둔 substrate 위에 들어갈 후보들 (우선순위 미정, 브레인스토밍용):

### 6.1 Body transformation hooks (필수)

위치: `anthropicGateway.ts`의 `forwardMessages` / `streamMessages` 내부.

| Hook | 무엇을 | Phase 1 호환 |
|---|---|---|
| Request body inspection | `messages[]`, `system`, `tools` 읽기 | 로그에 절대 흘리지 않음 (현 스키마 유지) |
| Request body rewriting | `tool_result` envelope 압축, dedupe | atomicity: SSE start 전에 완료 |
| Response body parsing (non-stream) | upstream JSON 인스펙트 | 응답 헤더 보존 |
| Streaming SSE parsing | event-by-event 변환 | 백프레셔 / 부분 chunk 안전성 |

위험: 변환 중 예외 → mid-stream에서 발생하면 Phase 1의 "post-headers는 `res.statusCode` log + destroy" 규칙이 그대로 보호. 단 Phase 2가 이 시점에 partial JSON을 클라이언트에게 보냈을 수 있으니 변환은 **시작 전에 완결**되도록 설계해야 함.

### 6.2 `tool_result` envelope

Phase 0 RFC가 직접 호명한 첫 번째 후보. 큰 tool_result 본문을 capability summary로 압축 (예: `tierkit.get_file_digest`가 이미 하는 일을 gateway 단에서). 측정: `beforeTokens` / `afterTokens` / `savedTokens` (현재 `usage.jsonl` 스키마 그대로 재사용 가능).

설계 질문:
- envelope 결정은 어디서? (a) 데몬이 본문 보고 휴리스틱, (b) 사용자가 `tierkit.config.json`에 룰 정의, (c) MCP 호출 결과는 envelope on, native tool은 off
- "envelope이 적용됐다"를 어떻게 사용자에게 보여주나? 현 `usage.jsonl` + savings SSE 카드 (memory `project_v18_2_ui_validation_flow`) 흐름에 묶을 가능성 큼
- `tool_result` 안의 image / blob은? Phase 2 v1에선 stub

### 6.3 Cursor pagination (큰 메시지 chunk)

Anthropic API의 응답은 페이지네이션이 없지만, 매우 긴 single message가 멀티턴
전체를 무겁게 만든다. Gateway가 turn-N의 큰 텍스트를 nominal envelope + "ask for
more"로 변형할 수 있는지가 R&D 영역.

### 6.4 Dedupe

같은 multi-turn 세션 안에서 동일한 file content / tool output이 반복 inline될
때 두 번째 등장부터 reference로 치환. 측정 기준: 같은 message_id 흐름 내에서 동일 SHA256 detection.

### 6.5 Secret redaction at the gateway

Phase 1은 헤더 단에서만 redact. Phase 2는 request body 안에 들어간 시크릿
(예: 사용자가 코드 paste한 API key) 검출 → upstream 보내기 전에 redact. 위험은 false positive로 코드를 망가뜨리는 것. tierkit.config로 user opt-in 권장.

### 6.6 Optional `ENABLE_TOOL_SEARCH` 표면 노출

Phase 0 RFC §B-2에서 protocol-OK 확인됨. 토글 1개 추가 vs 데몬이 자동 감지 — 결정 미정. 토글이라면 위치는 사이드바 "Anthropic Gateway" 섹션 내부.

### 6.7 Per-call metrics → savings SSE 카드 통합

기존 인프라 활용: `project_v17` 컨텍스트 압축 CLI, `project_v18_2` UI validation flow의 `/v1/context/*` endpoint 5개, savings SSE stream (memory에서 확인). Phase 2의 body transformation 측정값을 이 동일 surface로 흘릴 수 있다.

### 6.8 Cost-aware routing v2와의 접점

`project_v18` (paymentModel × profile USD cap). Gateway는 현재 단일 upstream (`api.anthropic.com`)만 알지만, Phase 2 + Phase 3(local LLM 라우팅)가 만나면 같은 `gatewayMode: "on"` 아래에서 라우팅 정책이 가동될 여지. **단, 이건 Phase 3 영역 — Phase 2가 미리 routing 계층을 만들지 않도록 주의.**

### 6.9 Strengthened stream completion logging contract

Decision log §5.5 참조. 만약 Phase 2가 "스트리밍이 클라이언트에 완전히 도달한 뒤에만 log line이 보이는" 보증을 원한다면, `anthropicGateway.ts`의 `streamMessages`를 다시 디자인. 후보 접근: SSE 마지막 event 전송과 log write를 단일 비동기 sequence로 묶기. **Phase 1에서 시도된 `res.end` monkey-patch 우회는 reject됨** (백프레셔 + fragility) — 정공법으로.

### 6.10 Stream-abort outcome field (correction 32 후속)

Phase 1은 mid-stream upstream failure 시 `res.statusCode`를 log. Phase 2가
별도의 outcome field (`stream_abort: "upstream_disconnect"` 등) 추가 → 스키마
+ redaction 테스트 동시 업데이트.

---

## 7. Phase 2 entry gate

`docs/RFC-anthropic-gateway.md`에 commit된 공식 gate:

1. **≥ 1주 dogfood** with `tierkit doctor gateway` 모든 체크 OK on a real workstation.
2. **5xx zero**: `jq 'select(.status >= 500)' .tierkit/runtime/anthropic-gateway.jsonl | wc -l == 0` (trailing 7 days).
3. **Direct fallback이 적어도 한 번 trigger되고 깨끗하게 회복**된 경험.

추가로 Phase 2 설계자가 self-impose하면 좋은 것:
- 5.x decision log 전부 읽고 어떤 결정이 흔들리는지 명시
- `MANUAL_gateway_flows.md` 13 케이스 통과
- 측정 baseline (§4)를 1주일치 캡처해서 PR에 첨부

---

## 8. Phase 2 brainstorm을 위한 open questions

Phase 2 plan을 짤 때 이 질문들을 먼저 풀어야 한다.

### 트랜스포메이션의 정합성

1. body transformation이 mid-stream에서 일어날 수 있나, 아니면 항상 stream 시작 전에 결정되는가?
2. transformation 실패는 정책: (a) raw passthrough fallback, (b) 502, (c) opt-in?
3. transformation 후의 token count는 어떻게 사용자에게 노출하는가? (`usage.jsonl` 확장 vs 새 파일?)

### 사용자 인터페이스

4. envelope 적용 여부를 사용자가 per-request 알 필요가 있나? (사이드바 카드? 데이터로만?)
5. opt-in / opt-out 단위: 전역? 프로젝트? 도구별?
6. "envelope이 코드를 깨뜨렸다"고 사용자가 의심할 때 raw / envelope 비교 surface 필요한가?

### 안전성 / 개인정보

7. body 인스펙트가 시작되면 어디까지가 "안전 로그"인가? Phase 1의 strict allowlist는 그대로 두고 별도 "audit log"를 만들 것인지?
8. secret detection은 어떤 시그니처 룰? 사용자가 룰 추가 가능?
9. 변환된 body의 캐싱은 디스크에 떨어뜨리나? 메모리 only?

### 측정 정직성

10. "savedTokens"는 어떻게 정의? upstream에 안 보낸 토큰 카운트? Anthropic의 tokenizer로? 추정치인지 명시?
11. before/after 비교를 클라이언트에 표시할 때 변환된 후의 응답 정확성을 누가 검증? (LLM 자체로? heuristic?)
12. 매우 작은 절감 (< 100 토큰)은 보고하지 않는 cut-off?

### 운영

13. transformation pipeline 회귀를 어떻게 감지? (golden corpus? canary requests?)
14. 변환 도중 panic 발생 시 데몬 자체가 죽지 않도록 어떻게 격리?
15. `tierkit doctor gateway`에 어떤 새 check를 추가? (예: "transformation pipeline ready")

### 호환성

16. Claude Code 외 client (Cursor의 Cody, Cline 등 — 메모리상 v0.3/v0.4 어댑터 존재)도 같은 gateway를 쓰는 시나리오?
17. Phase 1 fingerprint 12-hex 포맷은 그대로? Phase 2가 더 긴 hash 필요?
18. `runtime.gatewayMode`만으로 충분? (`runtime.gatewayTransformations: ["envelope", "dedupe"]` 같은 별도 키?)

---

## 9. Phase 2 plan을 시작하기 전 체크리스트

브레인스토밍 → 플랜 → 실행 진입 시:

- [ ] 위 18개 open question 중 최소 절반 답안 확정 (또는 explicit "Phase 2.5로 이연")
- [ ] §5 decision log 8개 중 깨고 싶은 것 있다면 새 RFC 작성
- [ ] §6의 후보 중 Phase 2 v1 scope 결정 (보통 §6.1 + §6.2 + §6.7 통합이 작고 안전한 첫 묶음)
- [ ] §4 baseline 1주일치 데이터 캡처
- [ ] §7 entry gate 3개 모두 만족 증빙
- [ ] Phase 2 plan은 `docs/superpowers/plans/2026-XX-XX-anthropic-gateway-phase2.md`에 (rev1부터 시작, 리뷰 round 거치며 rev↑)

---

## 10. References

### 코드 (Phase 0 spike, 변경 0)
- `packages/core/src/runtime/anthropicGateway.ts` — Phase 2가 처음 손대는 파일
- `packages/core/test/anthropicGateway.test.ts` — 14 unit
- `packages/core/test/Server.anthropicGateway.test.ts` — 3 integration

### 코드 (Phase 1 추가)
- `packages/core/src/runtime/gatewayLog.ts` — 안전 로그 writer
- `packages/core/src/runtime/gatewayStatus.ts` — pure status builder
- `packages/core/src/runtime/loopback.ts`, `runtimePaths.ts`
- `packages/core/src/usecases/doctorGateway.ts` — 6 checks
- `packages/cli/src/commands/DoctorGatewayCommand.ts`
- `packages/vscode-tierkit/src/gateway*.ts` — 5 모듈 (pure + 1 vscode-impure)
- `packages/vscode-tierkit/src/webviewCommandAllowlist.ts`
- `packages/core/src/runtime/ui/gui.ts` — 2 카드

### 문서
- `docs/RFC-anthropic-gateway.md` — Phase 0 RFC + Phase 2 entry gate
- `docs/ARCHITECTURE-anthropic-gateway.md` — 코드 아키텍처 상세
- `docs/ANTHROPIC_GATEWAY.md` / `.ko.md` — 사용자용
- `docs/superpowers/plans/2026-05-26-anthropic-gateway-spike.md` — Phase 0 plan
- `docs/superpowers/plans/2026-05-26-anthropic-gateway-phase1.md` — Phase 1 plan (rev6, 35 corrections)
- `packages/vscode-tierkit/test/MANUAL_gateway_flows.md` — 13 manual cases

### 인접 메모리 (Phase 2 설계 시 참조)
- `project_v17_context_compression` — deterministic context build / show / send / compare CLI (Phase 2가 transformation 측정에 재사용 가능)
- `project_v18_cost_aware_routing` — paymentModel × per-profile USD cap
- `project_v18_2_ui_validation_flow` — `/v1/context/*` 5 endpoints + verdict.json
- `project_v19_subscription_cli` — `claudeCode` 서브프로세스 provider
- `project_v01_scope` ~ `project_v16_sidebar_gui` — overall product evolution
