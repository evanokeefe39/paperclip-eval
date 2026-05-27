#!/usr/bin/env bash
# E2E-12: Agent Invocation Correctness
# Verifies agents are correctly invoked by Paperclip: payload structure,
# prompt extraction, heartbeat config, and extension gating.
# Requires running stack (docker compose up).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo ""
echo "[E2E-12] Agent Invocation Correctness"

require_stack

COMPANY_ID=$(find_company_id)
CEO_ID=$(find_agent_id "$COMPANY_ID" "CEO")
RES_ID=$(find_agent_id "$COMPANY_ID" "Researcher")

if [ -z "$CEO_ID" ]; then
    echo "[FATAL] CEO not registered. Run setup first."
    exit 1
fi

# ──────────────────────────────────────────────────
# Section 1: Heartbeat config registered correctly
# ──────────────────────────────────────────────────

begin_test "CEO heartbeat intervalSec registered in Paperclip"
CEO_JSON=$(api_get "/api/agents/$CEO_ID")
CEO_HB_SEC=$(echo "$CEO_JSON" | jq -r '.runtimeConfig.heartbeat.intervalSec // empty')
CEO_HB_MS=$(echo "$CEO_JSON" | jq -r '.runtimeConfig.heartbeat.intervalMs // empty')
if [ -n "$CEO_HB_SEC" ] && [ "$CEO_HB_SEC" -gt 0 ] 2>/dev/null; then
    log "intervalSec=$CEO_HB_SEC"
    pass
elif [ -n "$CEO_HB_MS" ]; then
    fail "Paperclip has intervalMs=$CEO_HB_MS — wrong field, heartbeat silently disabled"
else
    fail "no heartbeat interval found in registered config"
fi

begin_test "CEO heartbeat enabled in Paperclip"
CEO_HB_ENABLED=$(echo "$CEO_JSON" | jq -r '.runtimeConfig.heartbeat.enabled // empty')
if assert_eq "$CEO_HB_ENABLED" "true" "heartbeat.enabled"; then
    pass
fi

if [ -n "$RES_ID" ]; then
    begin_test "Researcher heartbeat intervalSec registered in Paperclip"
    RES_JSON=$(api_get "/api/agents/$RES_ID")
    RES_HB_SEC=$(echo "$RES_JSON" | jq -r '.runtimeConfig.heartbeat.intervalSec // empty')
    RES_HB_MS=$(echo "$RES_JSON" | jq -r '.runtimeConfig.heartbeat.intervalMs // empty')
    if [ -n "$RES_HB_SEC" ] && [ "$RES_HB_SEC" -gt 0 ] 2>/dev/null; then
        log "intervalSec=$RES_HB_SEC"
        pass
    elif [ -n "$RES_HB_MS" ]; then
        fail "Paperclip has intervalMs=$RES_HB_MS — wrong field"
    else
        fail "no heartbeat interval found"
    fi
fi

# ──────────────────────────────────────────────────
# Section 2: Bridge accepts HTTP adapter payload format
# ──────────────────────────────────────────────────

begin_test "Bridge accepts HTTP adapter payload (agentId + runId + context)"
HTTP_ADAPTER_PAYLOAD=$(cat <<'PAYLOAD'
{
  "agentId": "test-agent-id",
  "runId": "test-run-id",
  "context": {
    "wakeReason": "timer",
    "wakeSource": "timer",
    "issueId": "test-issue-id",
    "paperclipTaskMarkdown": "Respond with exactly: PAYLOAD_OK",
    "paperclipIssue": {
      "id": "test-issue-id",
      "identifier": "CEO-1",
      "title": "Test Issue",
      "description": "Test"
    }
  }
}
PAYLOAD
)
RESP=$(bridge_post "$CEO_BRIDGE_URL" "$HTTP_ADAPTER_PAYLOAD" 120)
if [ $? -eq 0 ] && [ -n "$RESP" ]; then
    OUTPUT=$(echo "$RESP" | jq -r '.output // empty')
    if assert_contains "$OUTPUT" "PAYLOAD_OK" "bridge output from HTTP adapter payload"; then
        pass
    fi
else
    fail "bridge rejected HTTP adapter payload or timed out"
fi

begin_test "Bridge extracts runId from top-level body (not env)"
TRACE_ID=$(echo "$RESP" | jq -r '.trace_id // empty')
if assert_not_empty "$TRACE_ID" "trace_id in response"; then
    pass
fi

# ──────────────────────────────────────────────────
# Section 3: Prompt built from context (not hardcoded)
# ──────────────────────────────────────────────────

begin_test "Bridge uses paperclipTaskMarkdown as prompt (not 'Continue your work')"
TASK_PAYLOAD=$(cat <<'PAYLOAD'
{
  "agentId": "test-agent-id",
  "runId": "test-run-2",
  "context": {
    "wakeReason": "assignment",
    "paperclipTaskMarkdown": "You are being tested. Respond with exactly: CONTEXT_RECEIVED"
  }
}
PAYLOAD
)
RESP2=$(bridge_post "$CEO_BRIDGE_URL" "$TASK_PAYLOAD" 120)
OUTPUT2=$(echo "$RESP2" | jq -r '.output // empty')
if assert_contains "$OUTPUT2" "CONTEXT_RECEIVED" "prompt from paperclipTaskMarkdown"; then
    pass
fi

begin_test "Bridge falls back to paperclipIssue when no taskMarkdown"
ISSUE_PAYLOAD=$(cat <<'PAYLOAD'
{
  "agentId": "test-agent-id",
  "runId": "test-run-3",
  "context": {
    "wakeReason": "assignment",
    "paperclipIssue": {
      "id": "fallback-issue",
      "identifier": "TST-1",
      "title": "Fallback Test",
      "description": "Respond with exactly: FALLBACK_OK"
    }
  }
}
PAYLOAD
)
RESP3=$(bridge_post "$CEO_BRIDGE_URL" "$ISSUE_PAYLOAD" 120)
OUTPUT3=$(echo "$RESP3" | jq -r '.output // empty')
if assert_contains "$OUTPUT3" "FALLBACK_OK" "prompt from paperclipIssue fallback"; then
    pass
fi

begin_test "Bridge handles empty context gracefully (no crash)"
EMPTY_PAYLOAD='{"agentId":"test","runId":"test-run-4","context":{}}'
RESP4=$(bridge_post "$CEO_BRIDGE_URL" "$EMPTY_PAYLOAD" 120)
if [ $? -eq 0 ] && [ -n "$RESP4" ]; then
    log "bridge handled empty context without crash"
    pass
else
    fail "bridge crashed or timed out on empty context"
fi

# ──────────────────────────────────────────────────
# Section 4: CEO extension gating
# ──────────────────────────────────────────────────

begin_test "CEO does NOT have web_search tool"
TOOL_CHECK_PAYLOAD=$(cat <<'PAYLOAD'
{
  "agentId": "test-agent-id",
  "runId": "test-run-5",
  "context": {
    "wakeReason": "timer",
    "paperclipTaskMarkdown": "List all your available tools. Output each tool name on its own line, one per line. Do not add descriptions."
  }
}
PAYLOAD
)
RESP5=$(bridge_post "$CEO_BRIDGE_URL" "$TOOL_CHECK_PAYLOAD" 120)
OUTPUT5=$(echo "$RESP5" | jq -r '.output // empty')
if [ -z "$OUTPUT5" ]; then
    fail "no output from tool listing"
elif echo "$OUTPUT5" | grep -qi "web_search"; then
    fail "CEO has web_search tool — should be stripped for coordination-only role"
else
    log "web_search not in CEO tool list"
    pass
fi

begin_test "CEO does NOT have web_scrape tool"
if echo "$OUTPUT5" | grep -qi "web_scrape\|scrape_static\|scrape_stealth\|scrape_browser"; then
    fail "CEO has scrape tools — should be stripped"
else
    log "scrape tools not in CEO tool list"
    pass
fi

begin_test "CEO HAS paperclip coordination tools"
if echo "$OUTPUT5" | grep -qi "paperclip"; then
    log "paperclip tools present in CEO"
    pass
else
    fail "CEO missing paperclip coordination tools"
fi

# ──────────────────────────────────────────────────
# Section 5: Worker has full tools (if researcher running)
# ──────────────────────────────────────────────────

if wait_healthy "$RESEARCHER_BRIDGE_URL/health" 5; then
    begin_test "Researcher HAS web_search tool"
    RESP6=$(bridge_post "$RESEARCHER_BRIDGE_URL" "$TOOL_CHECK_PAYLOAD" 120)
    OUTPUT6=$(echo "$RESP6" | jq -r '.output // empty')
    if echo "$OUTPUT6" | grep -qi "web_search"; then
        pass
    else
        fail "Researcher missing web_search — workers should have full tool set"
    fi

    begin_test "Researcher HAS paperclip tools"
    if echo "$OUTPUT6" | grep -qi "paperclip"; then
        pass
    else
        fail "Researcher missing paperclip tools"
    fi
fi

# ──────────────────────────────────────────────────
# Section 6: Paperclip dispatch triggers agent correctly
# ──────────────────────────────────────────────────

begin_test "Paperclip heartbeat invoke reaches CEO"
PRE_METRICS=$(curl -sf "$CEO_BRIDGE_URL/metrics")
PRE_COUNT=$(echo "$PRE_METRICS" | jq -r '.requests_total // 0')

api_post "/api/agents/$CEO_ID/heartbeat/invoke" 2>/dev/null || true
sleep 5

POST_METRICS=$(curl -sf "$CEO_BRIDGE_URL/metrics")
POST_COUNT=$(echo "$POST_METRICS" | jq -r '.requests_total // 0')

if [ "$POST_COUNT" -gt "$PRE_COUNT" ]; then
    log "requests_total: $PRE_COUNT -> $POST_COUNT"
    pass
else
    fail "no new request after Paperclip dispatch (before=$PRE_COUNT, after=$POST_COUNT)"
fi

begin_test "CEO bridge still healthy after Paperclip dispatch"
if wait_healthy "$CEO_BRIDGE_URL/health" 10; then
    pass
else
    fail "CEO bridge unhealthy after dispatch"
fi

summary
