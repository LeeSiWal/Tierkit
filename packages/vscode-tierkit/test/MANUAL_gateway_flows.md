# Manual: gateway flows (Phase 1)

## Setup
1. Open a workspace folder. Confirm `tierkit doctor` is green.
2. Sidebar → toggle "Route Claude Code through Tierkit" ON.
3. `tierkit doctor gateway` reports OK.

## Test 1 — Happy launch
- Click "Tierkit: Launch Claude Code through Tierkit".
- New terminal: `echo "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"` → `http://127.0.0.1:<port>`.

## Test 2 — Auth preservation
- Parent shell: `export ANTHROPIC_API_KEY=sk-test-DO-NOT-USE`. Launch VS Code from that shell.
- Click launch. `echo $ANTHROPIC_API_KEY` → prints the test value.

## Test 3 — Mode-off guidance (NO daemon restart)
- Sidebar toggle OFF. Click launch.
- Expected info message: `Enable "Route Claude Code through Tierkit" before launching a routed session.`
- Expected: NO "starting daemon…" message and NO daemon restart attempt.

## Test 4 — Auto-restart + fallback
- Mode ON. `pkill -f 'tierkit runtime'`. Click launch.
- Status bar: `Tierkit Gateway: starting daemon…`. Daemon restarts → terminal opens.

## Test 5 — Hard fallback (env stripping + custom binary)
- `tierkit.autoStartDaemon: false`. Kill daemon. Click launch.
- Dialog appears → click "Launch direct".
- `echo "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"` → empty.
- With `TIERKIT_CLAUDE_CODE_BIN=/opt/custom/claude`, confirm BOTH routed AND direct terminals launch `/opt/custom/claude`.

## Test 6 — Safe log inspection
- After Tests 1 and 4: `cat .tierkit/runtime/anthropic-gateway.jsonl`.
- Each record has only `ts, path, stream, status, durationMs, auth {authorizationScheme, authorizationFingerprint, apiKeyPresent, apiKeyFingerprint}`.
- `authorizationScheme` is `null`, `"Bearer"`, or `"Other"`.
- The invariant holds in every record: scheme null iff fingerprint null; apiKeyPresent false iff fingerprint null.
- Negative: grep for `sk-`, API key prefix, message text → no hits.

## Test 7 — Local-only enforcement (LAN)
- Temporarily set `runtime.host: "0.0.0.0"` and restart daemon.
- From ANOTHER machine on the same LAN: `curl http://<machine-ip>:<port>/v1/gateway/status` → 403 `local_only`.
- `curl -X PATCH http://<machine-ip>:<port>/v1/config/runtime ...` → 403.
- From the same machine: `curl http://127.0.0.1:<port>/v1/gateway/status` → 200.
- Restore.

## Test 8 — Offline toggle works in both directions
- With daemon running: sidebar toggle to ON.
- Stop daemon. Sidebar toggle → file should flip ON → OFF.

## Test 9 — Daemon rejection does NOT trigger offline fallback
- With daemon running, send a request that the daemon will reject (the sidebar
  toggle's PATCH should succeed under normal conditions; this test exercises
  the rejection path by temporarily exporting a value the daemon rejects).
- Expected: error message containing daemon's rejection detail.
- tierkit.config.json on disk is NOT silently overwritten by the extension.

## Test 10 — Extension uses loopback even with LAN configured baseUrl
- Set `tierkit.baseUrl` in VS Code settings to `http://192.168.1.50:4101`.
- Sidebar toggle and launch button still work (extension canonicalizes to `127.0.0.1:4101`).
- Restore.

## Test 11 — Streaming abort logs the observed HTTP status (correction 32)
- Mode ON. From `claude` running in the gateway terminal, start a long streaming completion.
- Kill the daemon mid-stream (`pkill -f 'tierkit runtime'`).
- The Claude Code session may show a disconnect.
- After restart, `cat .tierkit/runtime/anthropic-gateway.jsonl | tail -1`.
- Expected: the aborted record's `status` is `200` (the status the client actually observed at the start of the stream), NOT `502`. `stream: true` is present.

## Test 12 — Bind-mode constraints (LAN-only bind is NOT supported)
- Set `runtime.host: "192.168.1.50"` (a specific LAN interface, NOT 0.0.0.0). Restart daemon.
- `tierkit doctor gateway` reports `gateway-daemon: fail` because the extension's loopback probe cannot reach the LAN-only bind. This is expected behavior (docs/ANTHROPIC_GATEWAY.md lists the supported bind modes).
- Restore to `127.0.0.1` or `0.0.0.0`.

## Test 13 — PATCH-then-transport-failure indeterminate state (correction 31)
- Mode ON. Set up a flaky network condition between extension and daemon (or kill the daemon between the status probe and the PATCH request).
- Click sidebar toggle.
- Expected: indeterminate-state error like "The gateway update request did not complete cleanly. Check the current status before trying again."
- Expected: `tierkit.config.json` was NOT silently overwritten by the extension.

## Phase 2 v1 experimental cases

## Test 14 — Transformations off preserves Phase 1 passthrough
- Set `runtime.gatewayMode: "on"` and remove `runtime.gatewayTransformations`, or set `runtime.gatewayTransformations.mode: "off"`.
- Send a Claude Code request through the gateway.
- Expected: upstream receives the original request body. Gateway status reports `transformations.mode: "off"`.

## Test 15 — Observe mode does not rewrite request body
- Set `runtime.gatewayTransformations.mode: "observe"`.
- Send a synthetic request containing an assistant `tool_use` and matching user `tool_result`.
- Expected: upstream receives the original body. Gateway log contains `transformation.outcome: "observed"` and payload byte fields.

## Test 16 — Envelope mode with empty allowlist does not rewrite
- Set `runtime.gatewayTransformations.mode: "envelope"` and `toolResultEnvelope.allowlistedToolNames: []`.
- Send the same synthetic request.
- Expected: upstream receives the original body. Gateway log contains `transformation.outcome: "bypassed_ineligible"`.

## Test 17 — Allowlisted synthetic tool_result gets an envelope
- Set `toolResultEnvelope.allowlistedToolNames: ["SyntheticRead"]` and a low `minInputUtf8Bytes`.
- Send a synthetic `SyntheticRead` `tool_result` with large plain text content.
- Expected: upstream request contains `[TIERKIT_TOOL_RESULT_ENVELOPE_V1]`, `content_sha256`, preserved head/tail, and no full original body in `.tierkit/runtime/anthropic-gateway.jsonl`.

## Test 18 — Unsupported result bypass
- Send image/blob/document-like `tool_result` content.
- Expected: no rewrite and `transformation.outcome: "bypassed_ineligible"`.

## Test 19 — Transformer failure recovers with raw passthrough
- Inject a local test failure in the transform hook or run the automated fail-open test.
- Expected: upstream receives the raw request body and gateway log records `transformation.outcome: "bypassed_error"`.

## Test 20 — Safe log remains body-free
- Grep `.tierkit/runtime/anthropic-gateway.jsonl` for known synthetic message text, tool output text, and credential test values.
- Expected: no hits. The log may contain only safe enum/count/payload-byte fields.

## Test 21 — Doctor reports transformation state
- Run `tierkit doctor gateway` in `off`, `observe`, and `envelope` modes.
- Expected: `off` is normal, `observe` is experimental, and `envelope` without an explicit allowlist fails diagnostics.

## Test 22 — Direct fallback still strips gateway env
- Repeat Test 5 while `runtime.gatewayTransformations.mode` is `observe` or `envelope`.
- Expected: Direct terminal still removes `ANTHROPIC_BASE_URL`.

## Test 23 — Sidebar copy remains bounded
- Open the Tierkit sidebar.
- Expected: the gateway card shows `Experimental request transformation: Off|Observe|Envelope`; it does not show token or billing impact claims.

## Measured Compact Context bounded cases

## Test 24 — Measured compact default is off
- Remove `runtime.measuredCompact` from `tierkit.config.json`.
- Run `tierkit doctor gateway`.
- Expected: `Measured Compact Context: OFF` and `Official Token Measurement: OFF`.

## Test 25 — MCP compact contract is present for file digest
- Call `tierkit.get_file_digest` from Claude Code or an MCP test client.
- Expected: the tool result envelope includes `compactContext.version:
  "tierkit-compact-context.v1"`, `sourceKind: "file_digest"`,
  `recoverable: true`, and `retrieveMoreTool: "tierkit.read_file"`.
- Expected: `measurementTicket` is `null`.

## Test 26 — Official measurement requires explicit consent
- Try setting `runtime.measuredCompact.officialTokenMeasurement.mode:
  "anthropic_count_tokens_opt_in"` with `consentAcknowledged: false`.
- Expected: config validation or PATCH rejects the state.

## Test 27 — Request-level measurement is blocked, not fabricated
- Set `runtime.measuredCompact.mode: "measured_compact"` with consent true.
- Run `tierkit doctor gateway` and `GET /v1/gateway/status`.
- Expected: diagnostics report request-level counterfactual measurement as
  blocked because MCP and Gateway do not share a memory-only raw-baseline
  registry.
- Expected: no measured input-token delta is displayed.

## Test 28 — Legacy envelope conflict
- Try enabling both `runtime.measuredCompact.mode: "measured_compact"` and
  `runtime.gatewayTransformations.mode: "envelope"`.
- Expected: config validation rejects the combination or doctor reports a
  conflict. Actual requests must not be silently double-transformed.

## Test 29 — No raw baseline persistence
- Grep `.tierkit/runtime` after file digest and Gateway requests.
- Expected: logs contain no raw file content, no `messages[]`, no tool result
  bodies, no measurement ticket entry content, and no credentials.

## Test 30 — Copy remains precise
- Open any measured compact diagnostics surface.
- Expected: it does not claim billing certainty, guaranteed reduction, or
  request-level measured input-token delta while request-level measurement is
  blocked.
