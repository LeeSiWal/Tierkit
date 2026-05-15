# Tierkit (VS Code)

> Local-first hybrid model routing for AI coding agents — now with a one-click sidebar dashboard.
>
> 한 번에 켜지는 로컬 우선 하이브리드 모델 라우팅 툴킷. 사이드바에서 작업 실행 · 워크플로 세션 · 보안 검사 · 사용량까지 한 곳에서.

[Tierkit](https://github.com/LeeSiWal/Tierkit) is a local-first HTTP daemon that sits between your IDE and the model providers. It handles **model routing** (local / private-remote / public-cloud), **secret redaction**, **dangerous-command classification**, **budget enforcement**, and **workflow session gating** — uniformly, for every tool that talks to it.

This extension is the VS Code companion. The runtime now **auto-starts in-process** the moment the extension activates, so there is nothing to install or configure on a fresh machine beyond opening a folder.

---

## Sidebar dashboard

Pin the **Tierkit** icon on the activity bar — the sidebar embeds the same dashboard the daemon serves at `http://127.0.0.1:4101/`:

- **Run** — pick a profile, choose `execute` / `plan` / `review`, see the response inline.
- **Session** — start, approve plan, advance, abandon. Strict packs gate execute on `state=implementing` + `planApproved`.
- **Check** — three tabs: secret redaction, dangerous-command classifier, sensitive-path blocklist.
- **Models** — table of configured profiles, with a `Test` button per row that probes the provider for reachability + model availability (no tokens spent).
- **Usage** — calls / tokens / cost rolled up per profile.

A status bar item polls `GET /v1/health` every 30s; click it to re-check.

## Command palette

| Command | What it does |
|---|---|
| `Tierkit: Focus dashboard sidebar` | Open the dashboard from anywhere. |
| `Tierkit: Check runtime health` | `GET /v1/health` — version + project root. |
| `Tierkit: Explain route for current task` | Prompt for a task → `POST /v1/route` → prints the decision (tier, profile, score, reasons). |
| `Tierkit: Run task through Tierkit (streamed)` | Prompt for task + profile id → `POST /v1/llm-call` → streams the response into an output channel. |
| `Tierkit: Classify a shell command` | Prompt for a command → shows `block` / `warn` / `ok` with matched rule ids. |
| `Tierkit: Show usage summary` | `GET /v1/usage` — per-profile totals. |
| `Tierkit: Show workflow session status` | Current session state + reminder that the sidebar has full controls. |

## Auto-start daemon (new in 0.1.1)

The extension launches the Tierkit runtime in-process when it activates. No `tierkit runtime start` in a separate terminal is needed.

- If a Tierkit daemon is already running at `tierkit.baseUrl`, the extension **reuses** it.
- If the configured port is busy with something else, Tierkit falls back to an OS-chosen port and the sidebar uses that base URL automatically.
- Opt out with `tierkit.autoStartDaemon: false` if you prefer to manage the daemon yourself in a terminal.

### Configuration

```jsonc
// .vscode/settings.json
{
  "tierkit.baseUrl":         "http://127.0.0.1:4101",
  "tierkit.statusBar":       true,
  "tierkit.autoStartDaemon": true
}
```

## Localization

Both VS Code surfaces (command titles, settings descriptions, runtime messages) and the embedded dashboard are localized. VS Code picks the locale from your IDE display language; the dashboard picks from `navigator.language`. **Korean (한국어)** is supported today; contributions for more locales are welcome.

## Privacy and security

- The daemon binds **`127.0.0.1` (loopback) only** — never reachable from another machine.
- Secret redaction runs before any request leaves the daemon for a remote model tier (`private-remote` or `public-cloud`).
- Public-cloud profiles are **review-only and require approval** by default — never widened.
- No telemetry. No analytics. No phone-home.

See [docs/SECURITY.md](https://github.com/LeeSiWal/Tierkit/blob/main/docs/SECURITY.md).

---

# 한국어 안내

**Tierkit**은 로컬 우선(local-first) 하이브리드 모델 라우팅 데몬이에요. IDE와 모델 제공자 사이에 끼어서 다음을 통일된 정책으로 처리합니다:

- **모델 라우팅** — `local-device` / `private-remote` / `public-cloud` 3티어를 작업 위험도 · 비용 · 워크플로 정책에 따라 자동 선택
- **시크릿 가리기** — 모든 원격 호출 직전에 `.env`/API 키/PEM 등 패턴 자동 마스킹
- **위험 명령 분류** — `rm -rf /` 같은 명령을 `block` / `warn` / `ok`로 분류해서 실행 게이트
- **예산 강제** — 호출 · 토큰 · 비용 한도 초과 시 게이트
- **워크플로 세션** — `guided` / `balanced` / `strict` 자유도에 따라 실행 권한 게이트 (예: strict는 plan 승인 + `state=implementing`이어야 execute 허용)

## 사이드바 대시보드

활동 바의 **Tierkit** 아이콘을 누르면 데몬이 `http://127.0.0.1:4101/`에 띄우는 것과 동일한 GUI가 사이드바에 임베드됩니다:

- **작업 실행** — 프로파일 + 모드(`execute`/`plan`/`review`) 선택 후 결과 인라인 표시
- **세션** — 시작 / 계획 승인 / 단계 진행 / 폐기. strict 팩은 plan 승인 + `state=implementing` 만족해야 execute 가능
- **보안 검사** — 시크릿 가리기 / 명령어 위험도 / 경로 차단 3개 탭
- **모델** — 등록된 프로파일 목록 + 행별 `Test` 버튼으로 도달성 + 모델 가용성 확인 (토큰 소비 없음)
- **사용량** — 프로파일별 호출 · 토큰 · 비용 요약

## 자동 실행 (0.1.1 신규)

확장이 활성화될 때 Tierkit 런타임이 in-process로 **자동 시작**됩니다. 별도 터미널에서 `tierkit runtime start`를 실행할 필요가 없어요.

- 이미 데몬이 떠 있으면 그것을 **재사용**합니다.
- 설정된 포트가 다른 프로세스에 막혀 있으면 OS가 고른 빈 포트로 폴백하고, 사이드바는 그 새 주소를 자동으로 사용합니다.
- 직접 데몬을 관리하고 싶다면 `tierkit.autoStartDaemon: false`로 끄세요.

### 한글 표시

VS Code 표시 언어가 한국어이면 명령 팔레트 · 설정 설명 · 상태바 메시지가 한글로 보입니다. 사이드바 대시보드는 브라우저(또는 VS Code 웹뷰)의 `navigator.language`를 따라 자동 전환됩니다.

## 설치 후 첫 실행

1. VS Code에서 **폴더를 열어주세요** — 런타임이 working directory가 있어야 시작됩니다.
2. 활동 바의 **Tierkit** 아이콘을 누르면 사이드바가 열립니다.
3. 상단 상태 영역이 **🟢 Daemon OK**로 바뀌면 사용 준비 완료. (포트가 막혀 있으면 자동으로 다른 포트로 폴백되며 그 주소가 사이드바에 표시됩니다.)

## 알려진 제약

- `tierkit.routeRun` 명령 팔레트 경로는 아직 명시적인 profile id가 필요합니다. 자동 라우팅이 필요하면 사이드바의 **Run** 패널을 쓰세요.
- `/v1/llm-call`은 현재 업스트림 스트림 종료 후 단일 JSON으로 응답하기 때문에 사이드바의 Run 결과가 한 번에 그려집니다. 토큰 단위 스트림은 향후 `/v1/llm-call/stream` 엔드포인트에서 지원 예정입니다.

## 더 알아보기

- GitHub: <https://github.com/LeeSiWal/Tierkit>
- 한글 시작 가이드: [docs/GUIDE.ko.md](https://github.com/LeeSiWal/Tierkit/blob/main/docs/GUIDE.ko.md)
- 디자인 스펙: [docs/SPEC.md](https://github.com/LeeSiWal/Tierkit/blob/main/docs/SPEC.md)
- 보안 모델: [docs/SECURITY.md](https://github.com/LeeSiWal/Tierkit/blob/main/docs/SECURITY.md)

## License

MIT
