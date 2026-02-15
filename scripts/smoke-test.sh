#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-${1:-http://127.0.0.1:8080}}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-10}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
TENANT_ID="${TENANT_ID:-}"
EXPECT_PROVIDER="${EXPECT_PROVIDER:-any}" # any|mock|dify
EXPECT_METRICS_ENABLED="${EXPECT_METRICS_ENABLED:-true}" # true|false
EXPECT_KB_ID="${EXPECT_KB_ID:-}"

CURL_COMMON=(--silent --show-error --max-time "$TIMEOUT_SECONDS")
if [[ -n "$AUTH_TOKEN" ]]; then
  CURL_COMMON+=( -H "Authorization: Bearer ${AUTH_TOKEN}" )
fi
if [[ -n "$TENANT_ID" ]]; then
  CURL_COMMON+=( -H "X-Tenant-Id: ${TENANT_ID}" )
fi

pass() { echo "[PASS] $1"; }
fail() { echo "[FAIL] $1" >&2; exit 1; }

request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"

  local output
  if [[ -n "$body" ]]; then
    output=$(curl "${CURL_COMMON[@]}" -X "$method" "$BASE_URL$path" -H "Content-Type: application/json" -d "$body" -w "\nHTTP_STATUS:%{http_code}")
  else
    output=$(curl "${CURL_COMMON[@]}" -X "$method" "$BASE_URL$path" -w "\nHTTP_STATUS:%{http_code}")
  fi

  HTTP_STATUS=$(echo "$output" | sed -n 's/^HTTP_STATUS://p' | tail -n1)
  RESPONSE_BODY=$(echo "$output" | sed '/^HTTP_STATUS:/d')
}

assert_status() {
  local expected="$1"
  local name="$2"
  [[ "$HTTP_STATUS" == "$expected" ]] || fail "$name (expected HTTP $expected, got $HTTP_STATUS). body=$RESPONSE_BODY"
}

assert_contains() {
  local needle="$1"
  local name="$2"
  echo "$RESPONSE_BODY" | grep -q "$needle" || fail "$name (missing '$needle'). body=$RESPONSE_BODY"
}

extract_first_trace_id() {
  echo "$RESPONSE_BODY" | sed -n 's/.*"trace_id":"\([^"]*\)".*/\1/p' | head -n1
}

echo "[INFO] Smoke test started. base_url=$BASE_URL expect_provider=$EXPECT_PROVIDER"

request GET /health
assert_status 200 "health status"
assert_contains '"success":true' "health success"
assert_contains '"status":"ok"' "health payload"
assert_contains '"dify":' "health dify info"
if [[ "$EXPECT_PROVIDER" == "dify" ]]; then
  assert_contains '"enabled":true' "health dify enabled"
fi
if [[ "$EXPECT_PROVIDER" == "mock" ]]; then
  assert_contains '"enabled":false' "health mock mode"
fi
pass "GET /health"

INFER_SYNC_PAYLOAD='{"scenario_id":"exam_qa","input":{"images":["img1"]},"options":{"stream":false,"quality_tier":"balanced"}}'
request POST /v1/infer "$INFER_SYNC_PAYLOAD"
assert_status 200 "infer(sync) status"
assert_contains '"success":true' "infer(sync) success"
assert_contains '"scenario_id":"exam_qa"' "infer(sync) scenario"
assert_contains '"route"' "infer(sync) route metadata"
INFER_TRACE_ID="$(extract_first_trace_id)"
[[ -n "$INFER_TRACE_ID" ]] || fail "infer(sync) trace_id missing"
if [[ "$EXPECT_PROVIDER" == "dify" ]]; then
  assert_contains 'provider:dify' "infer(sync) dify provider path"
fi
if [[ "$EXPECT_PROVIDER" == "mock" ]]; then
  echo "$RESPONSE_BODY" | grep -Eq 'router:mock|provider:mock-fallback' || fail "infer(sync) mock provider path missing. body=$RESPONSE_BODY"
fi
if [[ -n "$EXPECT_KB_ID" ]]; then
  assert_contains "\"kb_id\":\"${EXPECT_KB_ID}\"" "infer(sync) kb_hits expected"
fi
pass "POST /v1/infer (sync)"

INFER_STREAM_PAYLOAD='{"scenario_id":"exam_qa","input":{"images":["img1"]},"options":{"stream":true}}'
request POST /v1/infer "$INFER_STREAM_PAYLOAD"
assert_status 200 "infer(stream bootstrap) status"
assert_contains '"stream_url":"/v1/infer/stream/' "infer(stream bootstrap) stream_url"
STREAM_TRACE_ID="$(extract_first_trace_id)"
[[ -n "$STREAM_TRACE_ID" ]] || fail "infer(stream bootstrap) trace_id missing"
STREAM_URL="$(echo "$RESPONSE_BODY" | sed -n 's/.*"stream_url":"\([^"]*\)".*/\1/p' | head -n1)"
[[ -n "$STREAM_URL" ]] || fail "infer(stream bootstrap) stream_url parse failed"
pass "POST /v1/infer (stream bootstrap)"

STREAM_OUTPUT=$(curl "${CURL_COMMON[@]}" -N --max-time 6 "$BASE_URL$STREAM_URL" || true)
echo "$STREAM_OUTPUT" | grep -q 'event: connected' || fail "SSE connected event missing"
echo "$STREAM_OUTPUT" | grep -Eq 'event: progress|event: completed|event: error|event: heartbeat' || fail "SSE events missing"
pass "GET $STREAM_URL (SSE)"

FEEDBACK_PAYLOAD="{\"trace_id\":\"$INFER_TRACE_ID\",\"scenario_id\":\"exam_qa\",\"feedback\":{\"label\":\"correct\"}}"
request POST /v1/feedback "$FEEDBACK_PAYLOAD"
assert_status 200 "feedback status"
assert_contains '"accepted":true' "feedback accepted"
pass "POST /v1/feedback"

request GET "/v1/traces/$INFER_TRACE_ID"
assert_status 200 "trace query status"
assert_contains '"trace"' "trace query payload"
assert_contains "$INFER_TRACE_ID" "trace query id match"
pass "GET /v1/traces/:trace_id"

request GET /metrics
if [[ "$EXPECT_METRICS_ENABLED" == "true" ]]; then
  assert_status 200 "metrics status"
  assert_contains '"requests_total"' "metrics counters"
  assert_contains '"infer_total"' "metrics infer"
  pass "GET /metrics"
else
  if [[ "$HTTP_STATUS" != "403" && "$HTTP_STATUS" != "404" ]]; then
    fail "metrics disabled status (expected HTTP 403/404, got $HTTP_STATUS). body=$RESPONSE_BODY"
  fi
  pass "GET /metrics disabled"
fi

INVALID_PAYLOAD='{"scenario_id":"exam_qa","input":{"images":"bad"}}'
request POST /v1/infer "$INVALID_PAYLOAD"
assert_status 400 "infer invalid status"
assert_contains '"code":"INVALID_INPUT"' "infer invalid code"
pass "POST /v1/infer invalid payload validation"

echo "[INFO] Smoke test completed successfully."
