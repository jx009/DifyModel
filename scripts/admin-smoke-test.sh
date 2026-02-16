#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-${1:-http://127.0.0.1:8080}}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-10}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
RUN_DIFY_TEST="${RUN_DIFY_TEST:-false}"

[[ -n "$ADMIN_TOKEN" ]] || { echo "[FAIL] ADMIN_TOKEN is required"; exit 1; }

CURL_COMMON=(--silent --show-error --max-time "$TIMEOUT_SECONDS")
AUTH_HEADER=(-H "Authorization: Bearer ${ADMIN_TOKEN}")

pass() { echo "[PASS] $1"; }
fail() { echo "[FAIL] $1" >&2; exit 1; }

request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local output
  if [[ -n "$body" ]]; then
    output=$(curl "${CURL_COMMON[@]}" -X "$method" "$BASE_URL$path" "${AUTH_HEADER[@]}" -H "Content-Type: application/json" -d "$body" -w "\nHTTP_STATUS:%{http_code}")
  else
    output=$(curl "${CURL_COMMON[@]}" -X "$method" "$BASE_URL$path" "${AUTH_HEADER[@]}" -w "\nHTTP_STATUS:%{http_code}")
  fi
  HTTP_STATUS=$(echo "$output" | sed -n 's/^HTTP_STATUS://p' | tail -n1)
  RESPONSE_BODY=$(echo "$output" | sed '/^HTTP_STATUS:/d')
}

assert_status() {
  local expected="$1"
  local name="$2"
  [[ "$HTTP_STATUS" == "$expected" ]] || fail "$name (expected $expected got $HTTP_STATUS). body=$RESPONSE_BODY"
}

assert_contains() {
  local needle="$1"
  local name="$2"
  echo "$RESPONSE_BODY" | grep -q "$needle" || fail "$name missing '$needle'. body=$RESPONSE_BODY"
}

echo "[INFO] admin smoke started base_url=$BASE_URL"

request GET /admin/api/config
assert_status 200 "get config status"
assert_contains '"admin_config"' "get config payload"
pass "GET /admin/api/config"

request PUT /admin/api/routes '{"routes":{"sub_type_routes":{"logic":"wf_exam_logic","language":"wf_exam_language"}}}'
assert_status 200 "update routes status"
assert_contains '"routes"' "update routes payload"
pass "PUT /admin/api/routes"

request PUT /admin/api/subtypes/logic/profile '{"display_name":"逻辑判断","classifier_hints":{"keywords":["逻辑","削弱"]},"workflow_guidance":{"solving_steps":["识别论点"],"prompt_focus":["论证关系"],"answer_constraints":["给出选项"]}}'
assert_status 200 "update sub type profile status"
assert_contains '"sub_type":"logic"' "update sub type profile payload"
pass "PUT /admin/api/subtypes/:subType/profile"

request PUT /admin/api/workflows/wf_exam_logic/prompt '{"content":"You are a strict logic solver."}'
assert_status 200 "update prompt status"
assert_contains '"workflow_id":"wf_exam_logic"' "update prompt payload"
pass "PUT /admin/api/workflows/:id/prompt"

request PUT /admin/api/workflows/wf_exam_logic/key '{"key":"dummy_test_key_value"}'
assert_status 200 "update key status"
assert_contains '"masked"' "update key payload"
pass "PUT /admin/api/workflows/:id/key"

request GET /admin/api/history
assert_status 200 "history status"
assert_contains '"snapshots"' "history payload"
pass "GET /admin/api/history"

if [[ "$RUN_DIFY_TEST" == "true" ]]; then
  request POST /admin/api/test/run '{"scenario_id":"exam_qa","workflow_id":"wf_exam_logic","input":{"images":[{"transfer_method":"remote_url","url":"https://example.com/test.png"}]},"context":{"tenant_id":"smoke"},"options":{"stream":false}}'
  if [[ "$HTTP_STATUS" != "200" ]]; then
    fail "admin test run status expected 200 got $HTTP_STATUS. body=$RESPONSE_BODY"
  fi
  assert_contains '"workflow_id":"wf_exam_logic"' "admin test run payload"
  pass "POST /admin/api/test/run"
fi

echo "[INFO] admin smoke completed."
