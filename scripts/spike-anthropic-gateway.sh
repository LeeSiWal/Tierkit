#!/usr/bin/env bash
# Manual smoke test for the Anthropic gateway spike.
#
# Usage:
#   ANTHROPIC_API_KEY=sk-... ./scripts/spike-anthropic-gateway.sh
#
# Prerequisites:
#   - Tierkit daemon is running on 127.0.0.1:4101 (check: curl -sf http://127.0.0.1:4101/v1/health)
#   - ANTHROPIC_API_KEY is set in the current shell (BYOK path; subscription users see Task 10)
#   - `jq` is installed
set -euo pipefail

BASE="${TIERKIT_BASE:-http://127.0.0.1:4101}"
KEY="${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY must be set}"
MODEL="${MODEL:-claude-haiku-4-5}"

echo "==> 0. Health check"
curl -sf "$BASE/v1/health" | jq .
echo

echo "==> 1. Non-streaming round-trip via Tierkit"
curl -sS -X POST "$BASE/v1/messages" \
  -H "x-api-key: $KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"reply with exactly the word OK\"}]}" \
  | jq '.content'
echo

echo "==> 2. Streaming round-trip via Tierkit (raw SSE — should see message_start, deltas, message_stop)"
curl -sS -N -X POST "$BASE/v1/messages" \
  -H "x-api-key: $KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -H "accept: text/event-stream" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":32,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"reply with exactly the word OK\"}]}"
echo
echo

echo "==> 3. count_tokens via Tierkit"
curl -sS -X POST "$BASE/v1/messages/count_tokens" \
  -H "x-api-key: $KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
  | jq .
echo

echo "==> 4. Auth-failure passthrough (401 should propagate verbatim)"
curl -sS -X POST "$BASE/v1/messages" \
  -H "x-api-key: sk-deliberately-invalid" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":4,\"messages\":[{\"role\":\"user\",\"content\":\"x\"}]}" \
  -o /tmp/tierkit-spike-401.json -w "HTTP %{http_code}\n"
cat /tmp/tierkit-spike-401.json | jq .
echo

echo "All four checks passed if you see: real content, SSE chunks, an input_tokens number, and a 401 with an Anthropic-shaped error body."
