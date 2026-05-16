# code-server 호환 채팅 UI 리뉴얼

**상태:** Draft
**작성일:** 2026-05-16
**대상 패키지:** `@tierkit/core` (GUI HTML), `tierkit-vscode` (확장 호스트)
**관련 마일스톤:** v1.6 사이드바 GUI 이후 추가 호환 작업

## 1. 배경과 문제

현재 Tierkit의 채팅 UI는 두 가지 호스트에서 동작한다:

1. **데몬이 직접 서빙** (`http://127.0.0.1:4101/`) — 같은 머신의 브라우저에서 접근.
2. **VS Code Desktop 사이드바 webview** (`tierkit-vscode`) — 확장 호스트가 in-process로 데몬을 띄우고, `GUI_HTML`을 webview에 임베드. `portMapping`이 webview iframe의 `fetch('http://localhost:4101/...')`을 확장 호스트 머신의 loopback으로 프록시한다.

이 구조는 **code-server**(브라우저에서 동작하는 원격 VS Code)에서 깨진다:

- **`portMapping`은 VS Code Desktop 전용 기능**이다. 브라우저 webview에서는 동작하지 않는다.
- code-server의 확장 호스트는 원격 서버에서 실행되지만, webview는 사용자의 로컬 브라우저에 sandboxed iframe으로 뜬다. 사용자 브라우저에서 `http://localhost:4101`을 fetch하면 서버 머신의 데몬이 아니라 사용자 로컬 머신을 가리키므로 데몬에 닿지 않는다.
- CSP `connect-src http://127.0.0.1:*; http://localhost:*`로는 브라우저 webview에서 원격 서버의 데몬에 접근할 방법이 없다.

결과적으로 `tierkit-vscode` 확장을 code-server에 설치하면 사이드바 webview가 빈 화면 또는 연결 실패 상태로 뜬다.

## 2. 목표

- **code-server 사이드바**에서 `tierkit-vscode`의 채팅 UI가 Desktop과 동일하게 동작한다.
- **데몬은 loopback only를 유지**한다 (보안 표면 확장 금지). 외부 노출이나 인증 레이어 추가 없음.
- **VS Code Desktop 동작에 회귀 없음.** 같은 코드 경로를 사용한다.
- **빌드 단계 없음 원칙 유지** (v1.5): `GUI_HTML`은 단일 인라인 HTML 그대로.

비목표:
- 데몬을 멀티 사용자/멀티 워크스페이스로 만들기.
- vscode.dev / GitHub Codespaces 공식 지원 (그러나 같은 아키텍처상 자동으로 동작할 가능성 높음 — best-effort만).
- 채팅 UI 자체의 디자인/기능 변경.

## 3. 설계

### 3.1 통신 어댑터 (transport)

`packages/core/src/runtime/ui/gui.ts`에 인라인되는 JavaScript 안에 transport 어댑터를 추가한다.

```js
// gui.ts 내부 인라인 스크립트
const transport = (() => {
  if (window.__TIERKIT_HOST__ === 'vscode') return createVsCodeTransport();
  return createHttpTransport(window.__TIERKIT_BASE_URL__ || '');
})();
```

`transport`는 두 가지 메서드를 제공한다:

```js
// 일반 요청 (GET/POST/JSON)
// 반환: { ok, status, data }  (jpost와 동일한 shape; jget은 data만 throw-on-error 래핑)
transport.request(path, { method, body, signal });

// SSE 스트림 (서버가 text/event-stream으로 응답)
// 반환: async iterable of { data: string } — 호출자가 JSON.parse
// signal로 취소.
transport.stream(path, { method, body, signal });
```

**HTTP transport** (기본): 기존 `fetch(BASE + path)` 로직을 그대로 캡슐화. `stream()`은 `res.body.getReader()`로 NDJSON-shaped SSE 청크를 디코드.

**VsCode transport**: `acquireVsCodeApi()`로 얻은 채널 위에 message-based RPC를 깐다. 자세한 프로토콜은 §3.2.

### 3.2 webview ↔ 확장 호스트 메시지 프로토콜

기존 `tierkit-vscode` 확장은 이미 `previewDiff`, `openFile`, `restartDaemon`, `showOutput` 메시지를 처리한다. 새 메시지는 모두 **`tk:` 네임스페이스**로 분리해 기존과 충돌 없도록 한다.

webview → 확장 호스트:

| type | payload | 동작 |
|---|---|---|
| `tk:req` | `{ id, method, path, body? }` | 확장 호스트가 `@tierkit/client` 또는 직접 `fetch`로 데몬에 호출 → 응답을 `tk:res`로 회신. |
| `tk:stream` | `{ id, method, path, body? }` | 확장 호스트가 SSE 수신 시작. 청크마다 `tk:chunk` 회신. 종료 시 `tk:done`. |
| `tk:abort` | `{ id }` | 진행 중인 `tk:req` 또는 `tk:stream`에 대해 AbortController 발동. |

확장 호스트 → webview:

| type | payload |
|---|---|
| `tk:res` | `{ id, ok, status, data }` |
| `tk:chunk` | `{ id, data: string }` (SSE의 `data:` 라인 페이로드 1개) |
| `tk:done` | `{ id, reason: 'eof' \| 'aborted' \| 'error', error?: string }` |
| `tk:err` | `{ id, message }` (req/stream 시작 실패) |

`id`는 webview에서 발급하는 단조 증가 정수. transport는 in-flight 요청을 `Map<id, { resolve, reject } | streamHandlers>`에 보관하고 `window.addEventListener('message', ...)`로 라우팅.

**Abort 흐름:**

- HTTP transport: `AbortSignal`을 `fetch`/`reader.cancel()`로 그대로 흘림.
- VsCode transport: `signal.addEventListener('abort', () => postMessage({type:'tk:abort', id}))`. 확장 호스트는 보관 중인 `AbortController.abort()`를 호출하고, 이미 끝난 요청이면 무시.
- webview unload 시 확장 호스트가 in-flight 모두 강제 abort (기존 `onDidDispose`에서 처리).

**구현 위치:**

- transport는 `gui.ts` 인라인 스크립트 안에 작성 (단일 파일 원칙 유지). 약 80~120줄 추가 예상.
- 확장 호스트 측 메시지 라우터는 `packages/vscode-tierkit/src/extension.ts`의 `TierkitSidebarProvider.resolveWebviewView` 메시지 핸들러에 추가. `@tierkit/client`의 `TierkitClient`를 재사용하되, SSE는 `client`에 SSE 헬퍼가 없으면 raw `fetch` + reader로 처리. (기존 `serverExtension.ts`가 데몬 측 SSE를 생성하는 코드와 대칭.)

### 3.3 기존 GUI 코드의 fetch 호출 교체

`gui.ts` 안에서 데몬을 호출하는 지점은 4곳이다:

| 위치 | 현재 호출 | 교체 후 |
|---|---|---|
| `gui.ts:551` `jget(p)` | `fetch(BASE + p)` | `transport.request(p, { method:'GET' })` 결과를 throw-on-error 처리 |
| `gui.ts:553` `jpost(p, b)` | `fetch(BASE + p, { method:'POST', ... })` | `transport.request(p, { method:'POST', body: b })` |
| `gui.ts:1364` 워크스페이스 파일 자동완성 | 직접 `fetch(... + signal)` | `transport.request(path, { signal })` |
| `gui.ts:1541` 에이전트 SSE 스트림 | `fetch + getReader` 수동 디코드 | `for await (const ev of transport.stream('/v1/agent/run', { method:'POST', body, signal }))` |

대부분의 호출이 `jget`/`jpost` 두 함수를 통하므로 실제 grep해서 갈아끼울 직접 호출은 단 두 곳(line 1364, 1541)이다.

`jget`/`jpost`의 시그니처는 유지 — 호출자 측 코드 변경은 없음.

### 3.4 portMapping / CSP 단순화

`tierkit-vscode/src/extension.ts:233-237`의 `portMapping` 옵션은 더 이상 필요 없다. webview는 더 이상 직접 데몬에 fetch하지 않는다.

CSP에서 `connect-src http://127.0.0.1:* http://localhost:*` 제거. 새 CSP:

```
default-src 'none';
style-src 'unsafe-inline';
script-src 'unsafe-inline';
img-src data: https:;
font-src data:;
```

`__TIERKIT_BASE_URL__` 주입은 vscode 호스트에서는 더 이상 transport에 영향을 주지 않지만, 디버그 로그/UI 표시를 위해 그대로 유지 (예: 사이드바 상태 카드에서 어떤 데몬에 연결됐는지 보여줄 때 사용).

### 3.5 데몬 측 변경 없음

데몬 (`@tierkit/core` `startServer`, `serverExtension.ts`)은 **수정하지 않는다**. 여전히 loopback only, 여전히 같은 엔드포인트, 같은 SSE 포맷. 확장 호스트가 그 위에 메시지 채널 어댑터를 얹을 뿐.

## 4. 컴포넌트 경계

```
┌─────────────────────────────────────────────────────────────┐
│  사용자 브라우저                                              │
│  ┌────────────────────────────────────┐                     │
│  │ code-server / VS Code Desktop      │                     │
│  │   webview (사이드바)                 │                     │
│  │     GUI_HTML                        │                     │
│  │       transport (VsCodeTransport)   │                     │
│  └────────────┬───────────────────────┘                     │
│               │ postMessage (tk:req / tk:stream / tk:abort) │
└───────────────┼─────────────────────────────────────────────┘
                │
┌───────────────┼─────────────────────────────────────────────┐
│  확장 호스트 (Desktop: 로컬 / code-server: 원격 서버)            │
│  ┌────────────▼───────────────────────┐                     │
│  │ tierkit-vscode/extension.ts        │                     │
│  │   TierkitSidebarProvider           │                     │
│  │     msg router (tk:*)              │                     │
│  │     in-flight Map<id, controller>  │                     │
│  └────────────┬───────────────────────┘                     │
│               │ fetch / SSE reader (loopback)               │
│  ┌────────────▼───────────────────────┐                     │
│  │ @tierkit/core startServer          │                     │
│  │   127.0.0.1:4101 (loopback)        │                     │
│  └────────────────────────────────────┘                     │
└─────────────────────────────────────────────────────────────┘
```

각 단위:

- **transport**: 입력은 `path`, `{method, body, signal}`. 출력은 응답 객체 또는 async iterable. 환경별 구현이 교체 가능.
  - 소스 위치: `packages/core/src/runtime/ui/transport.ts` (신규). 함수 본문을 문자열로 export하는 `TRANSPORT_INLINE_JS` 상수를 둔다. `gui.ts`는 이 상수를 인라인 스크립트 영역에 템플릿 삽입(`${TRANSPORT_INLINE_JS}`)해 단일 HTML 원칙을 유지하면서도 코드를 독립 파일로 관리.
  - 단위 테스트: `packages/core/test/transport.test.ts` (신규). 동일 함수 본문을 `new Function(TRANSPORT_INLINE_JS + ' return { createVsCodeTransport, createHttpTransport }')()` 식으로 평가해 노출하고, jsdom 환경에서 mock postMessage/fetch로 검증. ID 할당, in-flight 맵 정리, abort, stream chunk 순서 보존을 커버.
- **메시지 라우터 (extension.ts 내)**: 입력은 webview 메시지. 출력은 데몬 응답을 메시지로 회신. AbortController 풀 관리. `@tierkit/client`를 재사용해 raw fetch 코드 중복 회피.

## 5. 에러 처리

- **데몬 미기동/연결 실패**: `tk:req`/`tk:stream` 시 확장 호스트가 `tk:err`로 회신. webview transport는 `Error('daemon-unreachable')`을 throw. 기존 `jget`/`jpost`가 throw 받아 toast 또는 사이드바 banner에 표시 (이미 구현됨).
- **타임아웃**: 일반 요청은 확장 호스트에서 30초 default timeout. SSE 스트림은 무제한 (에이전트 작업은 길 수 있음). webview unload 시 강제 종료.
- **메시지 크기**: 이미지 첨부 시 base64 페이로드가 클 수 있음. webview ↔ 확장 호스트 메시지는 structured clone — Chromium 기준 수십 MB까지는 안전. 현재 데몬 측 attachment 상한 20MB가 자연스러운 cap.
- **순서**: SSE 청크 순서는 같은 `id`에 대한 `tk:chunk` 메시지가 postMessage 큐 FIFO를 보장하므로 유지됨.

## 6. 테스트 전략

- **단위 테스트** (`packages/core/test/transport.test.ts` 신규):
  - `TRANSPORT_INLINE_JS`를 `new Function(...)`으로 평가해 createHttpTransport / createVsCodeTransport 노출
  - mock `acquireVsCodeApi` + `window.addEventListener('message')`로 transport.request/stream 동작 검증
  - in-flight id 충돌 방지, abort 시 reject, stream chunk 순서 보존
- **단위 테스트** (`packages/vscode-tierkit/test/messageRouter.test.ts` 신규):
  - mock webview + mock `TierkitClient`로 `tk:req` → `tk:res`, `tk:stream` → `tk:chunk`/`tk:done` 흐름 검증
  - abort 메시지 시 AbortController.abort 호출 검증
- **수동 검증 (회귀)**:
  - VS Code Desktop에 새 VSIX 설치 → 사이드바 채팅 (텍스트 + 이미지 첨부) 정상 동작
  - `tierkit runtime start` 후 `http://127.0.0.1:4101/` 직접 브라우저 접근 정상 동작 (HTTP transport)
- **수동 검증 (code-server)**:
  - `docker run --rm -p 8080:8080 -v $(pwd):/home/coder/project codercom/code-server:latest`로 띄움
  - VSIX 설치 (`code-server --install-extension tierkit-vscode-X.Y.Z.vsix`)
  - 브라우저에서 code-server 접속 → 사이드바 열기 → 채팅 작업 한 차례 실행 → SSE 청크 정상 수신, 이미지 첨부 정상 송신, 취소 정상 동작 확인

## 7. 마이그레이션 / 롤아웃

순서:

1. `gui.ts`에 transport 어댑터 추가. HTTP 모드만 활성화. `jget`/`jpost` 및 직접 fetch 사이트(line 1364, 1541)를 transport API로 교체. **이 시점에 회귀 없음** (HTTP transport는 기존 fetch와 동일 동작).
2. transport에 vscode 모드 추가 (`createVsCodeTransport`).
3. `extension.ts`에 메시지 라우터 추가. 기존 `portMapping` 코드는 유지 (안전망).
4. **회귀 테스트**: Desktop에서 동작 확인. 메시지 채널이 우선되도록 transport 분기.
5. 잘 동작하면 `portMapping` 및 CSP `connect-src` 제거.
6. code-server에서 동작 검증.
7. VSIX 0.8.0 릴리스 — 변경 로그에 "code-server 호환" 명시.

## 8. 리스크 및 미해결 사항

- **이미지 첨부 RTT**: base64 페이로드를 메시지 채널로 한 번 더 직렬화 (webview → 호스트). 큰 이미지(>10MB) 시 메인 스레드 일시 정지 가능. 측정 후 필요하면 chunking 도입. v0.7.0의 attachment 캡(20MB)이 자연스러운 안전선.
- **메시지 채널 디버깅**: 메시지 직렬화 오류 시 silent fail 가능. 확장 호스트의 Output 채널에 `[tk:req id=N path=...]` 로그 라인 추가.
- **vscode.dev / 외부 host**: 데몬이 in-process로 뜨려면 Node 확장 호스트가 필요. vscode.dev는 web-only 확장 호스트라 Node API 미지원 → in-process 데몬 시작 자체가 불가능. 이 케이스는 별도 작업(외부 데몬 + asExternalUri 경로) — 본 스펙 범위 아님.

## 9. 산출물

- `packages/core/src/runtime/ui/transport.ts` 신규 — `TRANSPORT_INLINE_JS` 상수 export
- `packages/core/src/runtime/ui/gui.ts` — `TRANSPORT_INLINE_JS` 임포트 후 인라인, fetch 호출 4곳(jget, jpost, line 1364, line 1541)을 transport API로 교체
- `packages/vscode-tierkit/src/extension.ts` — 메시지 라우터 추가, portMapping/CSP 정리
- `packages/core/test/transport.test.ts` 신규 — transport 단위 테스트
- `packages/vscode-tierkit/test/messageRouter.test.ts` 신규 — 라우터 단위 테스트
- `docs/INTEGRATIONS.md` — code-server 사용법 섹션 추가
- VSIX 0.8.0 변경 로그
