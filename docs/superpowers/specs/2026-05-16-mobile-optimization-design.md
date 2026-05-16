# 모바일 환경 GUI 최적화

**상태:** Approved (verbal)
**작성일:** 2026-05-16
**대상 파일:** `packages/core/src/runtime/ui/gui.ts` (CSS 추가 위주, 단일 파일)
**관련:** v0.8.1 (Chat/Settings 탭) 후속 UX 개선
**1차 use case:** code-server를 폰/태블릿 브라우저로 접속 → Tierkit 사이드바 사용

## 목표

- 폰 화면(≤ 480px)에서 가독성·터치 사용성 향상
- 데스크탑·사이드바 환경 동작은 0 변경 (모든 변경은 `@media (max-width: 480px)` 안)
- 네트워킹·노출·인증 변경 없음 (이건 별도 작업)
- JS 변경 없음, 테스트 영향 없음
- 단일 인라인 HTML 원칙 유지

비목표: 좌우 swipe 탭 전환, PWA 메타, 폰 노출용 데몬 바인딩 변경, 추가 라이브러리

## 변경 요약 (모두 모바일 한정 미디어쿼리)

### 폰트 / 가독성
- 본문 12.5px → 14px (한글 가독성)
- 채팅 thread 본문 13.5px
- `.dim`, `.mono` 11px → 12px
- input/textarea/select **16px** (iOS Safari zoom-in 방지)

### 터치 타깃 ≥40px
- `.tiny` 버튼: `min-height: 36px`, `padding: 8px 12px`
- `.tab-btn`: `min-height: 44px`, `padding: 12px 16px`
- 컴포저 `→`/`■`: `min-width: 44px`, `min-height: 44px`
- approval/mode select: `min-height: 32px`

### 컴포저 (가장 중요)
- `position: sticky; bottom: 0` + `padding-bottom: env(safe-area-inset-bottom)` — iPhone 노치/홈바 회피
- textarea `max-height: 35vh` (현재 140px) — 키보드 가려도 입력창 보임
- 첨부 thumbnail `max-width: 80px` (현재 120px)

### overflow / 가로 스크롤 정리
- `pre`, `code`: `overflow-x: auto`, `word-break: break-word`
- 메시지 body: `overflow-wrap: anywhere` (긴 URL 끊기)
- topbar의 health/freedom pill: `flex-wrap: wrap` 허용

### 탭 nav
- `font-size: 13px`, `padding: 12px 18px`
- 활성 탭 border-bottom 2px → 3px (시각 명확성)

## 구현

`gui.ts`의 `</style>` 직전에 단일 `@media (max-width: 480px) { ... }` 블록 추가.

기존 CSS rules는 건드리지 않음 — 모바일 미디어쿼리가 cascade로 override.

필요한 곳에 한해 셀렉터 안정성을 위한 클래스 추가 (예: 컴포저 root `.agent-composer-shell` 같은 hook가 필요하면 단 한 곳).

## 검증

- `pnpm -F @tierkit/core build` 통과
- 데몬 띄워서 `http://127.0.0.1:PORT/`:
  - DevTools → device emulation (iPhone 12 Pro, 390x844) → 폰트 14px, 탭 큰 터치, 컴포저 sticky 확인
  - 데스크탑 viewport는 변화 없음
- 기존 256 + 8 테스트 그대로 통과 (CSS만 변경)

## 마이그레이션

- VSIX 0.8.1 → 0.8.2 bump
- 태그 v0.8.2 push → 기존 GitHub Actions가 Marketplace + OpenVSX publish

## 산출물

- `packages/core/src/runtime/ui/gui.ts`
- `packages/vscode-tierkit/package.json` version 0.8.2
- `packages/vscode-tierkit/CHANGELOG.md` 0.8.2 항목
