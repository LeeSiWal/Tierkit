# 모바일 사이드바 재설계 (touch + density)

**상태:** Approved (verbal)
**작성일:** 2026-05-16
**대상 파일:** `packages/core/src/runtime/ui/gui.ts` (CSS만)
**관련:** v0.8.2 회귀 — 모바일에서 터치가 안 먹고, 사이드뷰 폭에서 레이아웃 부적합
**1차 use case:** 폰으로 code-server 접속 → Tierkit 사이드바(폭 ~280–360px)

## 진단

v0.8.2의 두 가지 실수:
1. **`position: sticky` 컴포저** — webview iframe 안에선 scroll-root가 webview document다. composer를 viewport에 고정하려 했지만 실제로는 사이드바 컨테이너의 scroll 동작을 깨고 빈 영역이 클릭을 가로채는 형태로 보였을 가능성.
2. **44px touch target + 14px 본문** — 사이드바 폭이 좁은 환경에선 정상 폰 사이즈가 아니라 **과대 사이즈**. 컨텐츠가 잘리고 시각적으로 답답.

## 목표

- 사이드뷰 폭에서 터치 응답성 회복
- 폭 ~280–360px에서 적절한 정보 밀도
- 데스크탑 동작 0 변경 (모든 변경은 `@media (max-width: 600px)` 안)
- JS 0 변경, 테스트 영향 0

## 변경

### A. 터치 응답성

- 사용자 입력 받는 모든 요소(`button`, `.tab-btn`, `.tiny`, `select`)에:
  - `touch-action: manipulation` — iOS 300ms tap delay + double-tap zoom 무력화
  - `cursor: pointer`
  - `user-select: none` — long-press 텍스트 선택 메뉴 방지
- `#agent-slash-suggest` 빈 상태일 때 `pointer-events: none` (자식 popup이 표시될 때만 활성)
- `position: sticky` composer + `safe-area-inset-bottom` **제거** (v0.8.2 회귀)

### B. 사이드뷰 레이아웃 (`@media (max-width: 600px)`)

기존 `@media (max-width: 480px)`는 폰 풀스크린만 잡지만, **사이드바는 더 좁다**. 600px로 일찍 트리거.

- **topbar 컴팩트**: 패딩 6px, 브랜드 `Tierkit` 라벨 숨김(아이콘만), pill `font-size: 10px`
- **tab nav**: `flex: 1` 균등 분할, `min-height: 36px` (44px 너무 큼), `padding: 8px 12px`
- **agent-card**: `padding: 8px`, h2 `font-size: 13px`, h2 height 컴팩트
- **agent-thread**: `font-size: 13px`, padding 6px
- **컴포저**:
  - sticky 제거. 자연스러운 flex flow.
  - send/stop 버튼 `min-width: 36px; min-height: 36px`
  - textarea `max-height: 25vh`
  - textarea/select `font-size: 16px` 유지 (iOS zoom 방지)
- **컴포저 meta**: `[data-i18n="modeLabel"]`, `[data-i18n="approvalLabel"]`, `[data-i18n="forSlash"]` 텍스트 `display: none` — select만 표시
- **첨부 thumbnail**: 60px (80px → 더 줄임)
- **Settings 탭 카드**: `padding: 8px`, `gap: 8px`, h2 `font-size: 13px`

### C. 폰트 톤 다듬기

- 본문 13px (14px → 사이드뷰엔 큼)
- `.dim`, `.mono` 11px (12px → 시각 노이즈 줄이기)

## 구현 절차

1. 기존 `@media (max-width: 480px)` 블록 전체를 새로운 `@media (max-width: 600px)` 블록으로 교체
2. 빌드, 스모크 테스트 (HTML에 새 규칙 포함, sticky 없음 확인)
3. 회귀 테스트 (256 + 8)
4. VSIX 0.8.2 → 0.8.3 bump, CHANGELOG
5. 태그 push → CI 자동 publish

## 검증

- Chrome DevTools device emulation:
  - 360x780 (Galaxy S20-class) — 사이드뷰 시뮬레이션
  - 390x844 (iPhone 12 Pro)
  - 1280x800 (데스크탑) — 변화 없음 확인
- 실기기 사이드바: 탭 한 번에 반응, 컴포저 자연스럽게 하단, 카드 컴팩트
- 기존 256 + 8 테스트 그대로 통과
