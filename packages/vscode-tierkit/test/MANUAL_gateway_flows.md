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
