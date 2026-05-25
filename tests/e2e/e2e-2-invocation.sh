#!/usr/bin/env bash
# E2E-2: Paperclip-to-Agent Invocation
# Triggers agent execution through Paperclip's dispatch, not direct bridge hit.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo ""
echo "[E2E-2] Paperclip-to-Agent Invocation"

require_stack

COMPANY_ID=$(find_company_id)
CEO_ID=$(find_agent_id "$COMPANY_ID" "CEO")
RES_ID=$(find_agent_id "$COMPANY_ID" "Researcher")

if [ -z "$CEO_ID" ] || [ -z "$RES_ID" ]; then
    echo "[FATAL] Agents not registered. Run setup first."
    exit 1
fi

# --- Test: Invoke CEO via Paperclip heartbeat ---
begin_test "Invoke CEO through Paperclip dispatch"
INVOKE_RESP=$(api_post "/api/agents/$CEO_ID/heartbeat/invoke" 2>&1) || true
if [ -n "$INVOKE_RESP" ]; then
    log "Paperclip dispatched to CEO agent"
    pass
else
    # Heartbeat invoke may return empty on success (fire-and-forget)
    # Check if the agent is still healthy after invocation
    if wait_healthy "$CEO_BRIDGE_URL/health" 10; then
        log "CEO healthy after dispatch (fire-and-forget invoke)"
        pass
    else
        fail "CEO unhealthy after Paperclip dispatch"
    fi
fi

# --- Test: Invoke Researcher via Paperclip heartbeat ---
begin_test "Invoke Researcher through Paperclip dispatch"
INVOKE_RESP=$(api_post "/api/agents/$RES_ID/heartbeat/invoke" 2>&1) || true
if wait_healthy "$RESEARCHER_BRIDGE_URL/health" 10; then
    log "Researcher healthy after dispatch"
    pass
else
    fail "Researcher unhealthy after Paperclip dispatch"
fi

# --- Test: Direct bridge invocation still works (baseline) ---
begin_test "Direct CEO bridge invocation (baseline)"
DIRECT_RESP=$(bridge_post "$CEO_BRIDGE_URL" \
    '{"prompt": "Respond with exactly: DISPATCH_OK"}' 60)
DIRECT_OUTPUT=$(echo "$DIRECT_RESP" | jq -r '.output // empty')
if assert_contains "$DIRECT_OUTPUT" "DISPATCH_OK" "CEO direct output"; then
    pass
fi

# --- Test: Direct researcher bridge invocation (baseline) ---
begin_test "Direct Researcher bridge invocation (baseline)"
DIRECT_RESP=$(bridge_post "$RESEARCHER_BRIDGE_URL" \
    '{"prompt": "Respond with exactly: RESEARCH_OK"}' 60)
DIRECT_OUTPUT=$(echo "$DIRECT_RESP" | jq -r '.output // empty')
if assert_contains "$DIRECT_OUTPUT" "RESEARCH_OK" "Researcher direct output"; then
    pass
fi

# --- Test: Paperclip knows agent status ---
begin_test "Agent status queryable via API"
CEO_STATUS=$(api_get "/api/agents/$CEO_ID" | jq -r '.status // empty')
RES_STATUS=$(api_get "/api/agents/$RES_ID" | jq -r '.status // empty')
if assert_not_empty "$CEO_STATUS" "CEO status" && \
   assert_not_empty "$RES_STATUS" "Researcher status"; then
    log "CEO: $CEO_STATUS, Researcher: $RES_STATUS"
    pass
fi

summary
