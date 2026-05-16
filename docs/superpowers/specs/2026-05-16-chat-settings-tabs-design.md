# 채팅 UI 탭 분리 (Chat / Settings)

**상태:** Approved (verbal)
**작성일:** 2026-05-16
**대상 파일:** `packages/core/src/runtime/ui/gui.ts` (단일 파일 수정)
**관련:** v0.8.0 (code-server 호환 채팅 UI) 후속 UX 개선

## 배경

GUI는 현재 단일 페이지에 카드 7개(연결된 도구, 플러그인, 활동, 사용량, 모델, 데몬, 설정) + 에이전트 채팅 패널을 세로로 적층한다. VS Code 사이드바(폭 ~300px)에선 채팅 도중 스크롤이 많고 채팅 몰입을 깎는다.

## 목표

- **2탭 분리**: Chat / Settings
- **단일 인라인 HTML 원칙 유지** (v1.5): 빌드 단계 추가 없음
- **HTTP 모드(`http://127.0.0.1:4101/`)와 VS Code webview 모드 모두 동일하게 동작**
- 활성 탭 선택을 **세션 간 유지** (브라우저: localStorage / webview: vscode.getState())

비목표:
- 키보드 단축키
- 3탭 이상
- 좁은 폭에서의 라벨 축약(YAGNI; 두 라벨 모두 짧음)
- 탭 추가/제거 사용자 정의

## 레이아웃

```
┌─────────────────────────────────┐
│ Tierkit · health · freedom · ↻  │  topbar (공통, 변경 없음)
├─────────────────────────────────┤
│ ▎Chat │  Settings               │  tab nav (신규, 약 32px)
├─────────────────────────────────┤
│   activated tab content         │
│   (Chat 또는 Settings)          │
└─────────────────────────────────┘
```

## 탭 내용 분배

| 탭 | 포함 요소 |
|---|---|
| **Chat** | `host-banner` + `agent-shell` (현재 마크업 그대로) |
| **Settings** | `main` 안의 7개 카드 (Connected tools / Active plugins / Recent activity / Today's usage / Model profiles / Daemon / Settings) |

## 구현

### 1. HTML 마크업

`topbar` 직후, `host-banner` 앞에 탭 nav를 삽입:

```html
<div class="tab-nav" role="tablist">
  <button class="tab-btn active" data-tab="chat" role="tab" data-i18n="tabChat">Chat</button>
  <button class="tab-btn"        data-tab="settings" role="tab" data-i18n="tabSettings">Settings</button>
</div>
```

기존 `<div id="host-banner">` ~ `</div>` + `<div class="agent-shell">` ~ `</div>`를 `<div class="tab-panel" data-tab-panel="chat">` 으로 래핑.

기존 `<main>...</main>`은 `<div class="tab-panel" data-tab-panel="settings">` 로 래핑 (또는 `<main>` 자체에 class 추가).

### 2. CSS

스타일 블록 안에 추가:

```css
.tab-nav {
  display: flex;
  border-bottom: 1px solid var(--border);
  background: var(--bg-card);
  padding: 0 6px;
  flex-shrink: 0;
}
.tab-btn {
  background: none;
  border: none;
  padding: 8px 14px;
  font-size: 12px;
  color: var(--fg-dim);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.tab-btn:hover { color: var(--fg); }
.tab-btn.active {
  color: var(--fg);
  border-bottom-color: var(--accent);
  font-weight: 600;
}
.tab-panel { display: none; }
.tab-panel.active { display: block; }
```

### 3. JS

기존 IIFE 안 (`State + helpers` 섹션 근처)에 추가:

```javascript
// ── Tab nav ─────────────────────────────────────────────────────────────────
const TAB_STORAGE_KEY = 'tierkit.activeTab';
const isVsCode = window.__TIERKIT_HOST__ === 'vscode';
const vscodeApi = isVsCode && typeof acquireVsCodeApi === 'function' ? null /* router already grabbed it */ : null;
// transport.ts already calls acquireVsCodeApi() once; subsequent calls throw.
// For tab persistence we read/write to window-level storage instead:
function loadActiveTab() {
  try {
    if (isVsCode) return null; // no persistent storage from webview without coordinating with router
    return localStorage.getItem(TAB_STORAGE_KEY);
  } catch { return null; }
}
function saveActiveTab(name) {
  try {
    if (!isVsCode) localStorage.setItem(TAB_STORAGE_KEY, name);
  } catch { /* ignore */ }
}
function setActiveTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach((p) => {
    p.classList.toggle('active', p.dataset.tabPanel === name);
  });
  saveActiveTab(name);
}
document.querySelectorAll('.tab-btn').forEach((b) => {
  b.addEventListener('click', () => setActiveTab(b.dataset.tab));
});
const initial = loadActiveTab() || 'chat';
setActiveTab(initial);
```

**localStorage 호환성**: VS Code webview의 localStorage는 휘발성이지만 세션 내에서는 작동함. 처음에는 webview에서도 localStorage를 그대로 쓰는 단순한 길로 가고, 만약 가시적 불편이 있으면 후속으로 vscode `getState/setState`로 대체. (이번 스펙에선 webview 분기 안 함 — 단순화.)

### 4. i18n 키 추가

`RUNTIME.en.tabChat = 'Chat'`, `RUNTIME.en.tabSettings = 'Settings'`, `RUNTIME.ko.tabChat = '채팅'`, `RUNTIME.ko.tabSettings = '설정'`.

## 검증

- `pnpm -F @tierkit/core build` 통과
- 데몬 띄워서 `http://127.0.0.1:PORT/`에서:
  - 탭 두 개 표시, Chat이 기본 활성
  - 클릭 시 패널 전환
  - 새로고침 후 마지막 활성 탭 유지 (브라우저 모드)
- 통합 테스트(`packages/vscode-tierkit/test/integration.test.ts`)는 transport 경로 영향 없으므로 그대로 통과해야 함

## 마이그레이션 / 롤아웃

- v0.8.1 패치로 VSIX 배포 — 데몬 측 변경 없음, 확장 변경 없음, GUI 마크업만.
- 회귀 위험: 낮음. 모든 기존 카드/채팅은 그대로 살아있고 단지 부모 컨테이너가 토글될 뿐.

## 산출물

- `packages/core/src/runtime/ui/gui.ts` — 마크업 / CSS / JS / i18n 패치
- `packages/vscode-tierkit/package.json` — version 0.8.0 → 0.8.1
- `packages/vscode-tierkit/CHANGELOG.md` — 0.8.1 항목
