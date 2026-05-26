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

## 실험적 요청 변환

Phase 2 v1은 request-side 변환 hook을 추가합니다. 기본값은 꺼짐이며,
`runtime.gatewayMode`와 별개의 설정입니다.

```json
{
  "runtime": {
    "gatewayMode": "on",
    "gatewayTransformations": {
      "mode": "off",
      "toolResultEnvelope": {
        "allowlistedToolNames": [],
        "minInputUtf8Bytes": 4096,
        "preservedHeadUtf8Bytes": 1024,
        "preservedTailUtf8Bytes": 1024
      }
    }
  }
}
```

모드:

- `off`: Phase 1 passthrough와 동일합니다. 검사나 rewrite가 없습니다.
- `observe`: eligible `tool_result` 후보와 payload byte만 계산하고, 원본
  request body를 그대로 전달합니다.
- `envelope`: assistant `tool_use`와 연결되어 tool name을 확인할 수 있고,
  명시적 allowlist와 byte threshold를 통과한 plain-text `tool_result`만
  deterministic envelope로 바꿉니다.

기본 allowlist는 비어 있으므로 gateway를 켜는 것만으로 request rewrite가
켜지지 않습니다. envelope는 memory-only로 생성되며, 원본 tool result 전체를
디스크에 저장하지 않습니다.

gateway log의 optional `transformation` 객체에는 `inputUtf8BytesBefore`,
`inputUtf8BytesAfter`, `reducedUtf8Bytes` 같은 payload byte metric만 들어갑니다.
이 값은 Anthropic token count가 아니며 billing 또는 quota 영향으로 해석하면
안 됩니다.

즉시 rollback하려면 `runtime.gatewayTransformations.mode`를 `"off"`로 바꾸거나
`gatewayTransformations` 블록을 제거하면 됩니다.

Phase 2 동작의 production activation은 1주 dogfood, 최근 7일 5xx 0건, Direct
fallback의 실제 회복 경험, `tierkit doctor gateway` 정상 증빙이 있을 때까지
blocked 상태입니다.

## 측정형 Compact Context 방향

Tierkit의 다음 stable compact-context 방향은 Gateway native rewrite가 아니라
MCP-first 구조입니다. `tierkit.get_file_digest` 같은 MCP 도구가 provenance와
retrieve-more 경로를 포함한 semantic compact context를 만들고, Gateway는
passthrough delivery layer를 유지합니다. 이후 안전한 구조가 갖춰지면 compact
요청과 원문 기준 counterfactual 요청을 비교 측정할 수 있습니다.

새 설정 namespace는 존재하지만 기본값은 비활성입니다.

```json
{
  "runtime": {
    "measuredCompact": {
      "mode": "off",
      "eligibleSources": { "tierkitMcpCompactTools": [] },
      "officialTokenMeasurement": {
        "mode": "off",
        "consentAcknowledged": false
      },
      "privacy": {
        "rawBaselineStorage": "memory_only",
        "rawBaselineTtlMs": 60000,
        "maxRawBaselineBytes": 1048576
      },
      "reporting": {
        "requestLevelMetrics": true,
        "sessionAggregation": false
      }
    }
  }
}
```

이번 bounded implementation에서는 official measurement가 활성화되지 않습니다.
request-level counterfactual measurement는 현재 구조상 blocked입니다. Tierkit
MCP server와 Gateway daemon이 memory-only raw-baseline registry를 공유하지
않기 때문입니다. 기존 digest `savedTokens` 값은 로컬 추정값이며 Anthropic
Token Counting API 측정값이 아닙니다.

향후 official measurement를 구현한다면, 실제 생성 요청에서 제외된 원문 문맥도
토큰 계산 목적으로 Anthropic Token Counting API에 전송될 수 있다는 점을
사용자가 명시적으로 동의해야 합니다. 표시되는 토큰 수는 Anthropic Token
Counting API의 사전 측정값이며, 실제 메시지 생성 시 사용되는 입력 토큰과
소량 차이가 날 수 있습니다.

`tierkit.get_file_digest`는 이제 MCP tool-result envelope 안에 compact context
contract를 표시합니다. `tierkit.read_file`로 복구 가능한 context이며, 안전한
memory-only bridge가 생기기 전까지 measurement ticket은 발급하지 않습니다.
