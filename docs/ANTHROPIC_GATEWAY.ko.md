# Anthropic Gateway

Tierkit는 Anthropic Messages API 앞에 투명한 게이트웨이로 동작할 수 있습니다.
Claude Code를 Tierkit 데몬으로 가리키면, 모든 요청이 `api.anthropic.com`에
도달하기 전에 Tierkit를 거칩니다. 게이트웨이는 메시지 내용을 변경하지 않고
요청을 로컬 데몬을 통해 전달합니다.

## 활성화

1. Tierkit 사이드바를 엽니다.
2. **Claude Code를 Tierkit 통해 연결** 토글을 켭니다. `tierkit.config.json`의
   `runtime.gatewayMode`가 `"on"`이 됩니다.
3. **Tierkit 통해 Claude Code 실행** 버튼을 누릅니다. 새 integrated terminal에
   해당 터미널 한정으로 `ANTHROPIC_BASE_URL`이 주입됩니다. shell profile은
   수정되지 않으며, `ANTHROPIC_API_KEY`가 설정되어 있다면 그대로 보존됩니다.

## 점검

```bash
tierkit doctor gateway
```

`runtime.gatewayMode`, `daemon @ ...`, `routes`, `safe gateway log`, 그리고
설치되어 있다면 `claude (Claude Code CLI)`까지 `OK`로 표시되어야 합니다.

## 요청 단위 로그

게이트웨이가 켜져 있을 때, 데몬은 `.tierkit/runtime/anthropic-gateway.jsonl`에
요청 단위 로그를 남깁니다. 각 레코드는 timestamp, path, stream 여부, 업스트림
상태 코드, 처리 시간과, `auth` 블록을 포함합니다. `auth`는 Authorization 분류
값(`Bearer`, `Other`, 또는 Authorization 헤더가 없을 때 `null`), `x-api-key`
존재 여부를 나타내는 `apiKeyPresent` boolean, 그리고 존재했던 각 인증 채널의
12자 fingerprint로 구성됩니다. 스키마는 채널이 존재할 때에만 해당 채널의
fingerprint가 기록되도록 보장합니다 — 없는 채널의 fingerprint가 기록되는
레코드는 발생하지 않습니다. 요청·응답 본문, `Authorization`·`x-api-key`
원문, `system` 프롬프트, `messages[]`, `tool_result` 내용은 포함되지 않습니다.
5 MB 또는 7일 중 먼저 도달하는 조건으로 회전합니다.

스트리밍 요청의 경우, 기록되는 `status`는 클라이언트가 실제로 관측한 HTTP
상태 코드(보통 200)이며, 업스트림 스트림이 중간에 끊긴 경우에도 그렇습니다.
별도의 stream-abort outcome 필드는 후속 단계에서 제공할 예정입니다.

## 로컬 전용 제어 surface

`GET /v1/gateway/status`, `GET /v1/doctor/gateway`, `PATCH /v1/config/runtime`는
loopback이 아닌 호출자를 HTTP 403으로 거부합니다.

이 제어 endpoint를 사용하려면 데몬은 `127.0.0.1`, `::1`, `0.0.0.0`, `::`처럼
loopback 또는 wildcard 주소에 바인딩되어야 합니다. 특정 LAN 인터페이스 주소
(예: `192.168.1.50`)에만 바인딩된 데몬은 Phase 1 제어 흐름의 지원 대상이
아닙니다.

## Direct fallback

**Tierkit 통해 Claude Code 실행**을 눌렀을 때 데몬이 닿지 않으면 확장 프로그램
이 먼저 데몬 재시작을 시도합니다. 그래도 실패하면 게이트웨이를 우회하는
**Launch direct** 버튼을 제공합니다. Direct 터미널은 `ANTHROPIC_BASE_URL`을
명시적으로 제거하므로, VS Code 프로세스가 부모 shell에서 해당 변수를 상속했더
라도 실제로 direct 경로로 동작합니다.

추가적인 컨텍스트 처리 및 정책 기능은 후속 단계에서 제공될 예정입니다.
