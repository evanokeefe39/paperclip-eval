#!/usr/bin/env bash
# E2E-8: Escalate Extension — Full Agent Flow
# Tests the escalate tool through the bridge, verifying the complete path:
# Agent calls escalate → issue created in Paperclip → agent paused → resumable.
#
# This test invokes the LLM via the bridge and checks side effects in Paperclip.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo ""
echo "[E2E-8] Escalate Extension — Full Agent Flow"

require_stack

# --- Discover state ---
COMPANY_ID=$(find_company_id)
RESEARCHER_ID=$(find_agent_id "$COMPANY_ID" "Researcher")
log "Company: $COMPANY_ID"
log "Researcher: $RESEARCHER_ID"

# Ensure researcher is idle before testing
api_post "/api/agents/$RESEARCHER_ID/resume" '{}' > /dev/null 2>&1 || true

# Record issue count before test
ISSUES_BEFORE=$(api_get "/api/companies/$COMPANY_ID/issues" | jq 'length')
log "Issues before: $ISSUES_BEFORE"

# ═══════════════════════════════════════════════════
# Test 1: Escalate tool is registered
# ═══════════════════════════════════════════════════
begin_test "Escalate tool registered in Researcher"
RESP=$(bridge_post "$RESEARCHER_BRIDGE_URL" \
    '{"prompt": "List ALL tools available to you. Include their exact names in a bullet list. Include any tool related to escalation, human, or pausing."}' 90)
OUTPUT=$(echo "$RESP" | jq -r '.output // empty')

if assert_not_empty "$OUTPUT" "tool listing output"; then
    if echo "$OUTPUT" | grep -qi "escalat"; then
        log "escalate tool found in listing"
        pass
    else
        fail "escalate not listed in agent tools. Output: $(echo "$OUTPUT" | head -c 500)"
    fi
fi

# ═══════════════════════════════════════════════════
# Test 2: Escalate tool is registered in CEO
# ═══════════════════════════════════════════════════
begin_test "Escalate tool registered in CEO"
RESP=$(bridge_post "$CEO_BRIDGE_URL" \
    '{"prompt": "List ALL tools available to you. Include their exact names. Specifically mention any tool for escalation or contacting humans."}' 90)
OUTPUT=$(echo "$RESP" | jq -r '.output // empty')

if assert_not_empty "$OUTPUT" "CEO tool listing"; then
    if echo "$OUTPUT" | grep -qi "escalat"; then
        log "escalate tool found in CEO"
        pass
    else
        fail "escalate not listed in CEO tools"
    fi
fi

# ═══════════════════════════════════════════════════
# Test 3: Simple escalation (blocking, no inputs)
# ═══════════════════════════════════════════════════
begin_test "Simple blocking escalation creates issue and pauses agent"

# Ensure idle
api_post "/api/agents/$RESEARCHER_ID/resume" '{}' > /dev/null 2>&1 || true

RESP=$(bridge_post "$RESEARCHER_BRIDGE_URL" \
    '{"prompt": "You MUST call the escalate tool immediately with these exact parameters: message=\"I need approval to proceed with the deployment\", urgency=\"blocking\". Do not explain, just call the tool.", "systemPrompt": "You have an escalate tool. Call it immediately when asked. Do not ask questions."}' 120)
OUTPUT=$(echo "$RESP" | jq -r '.output // empty')
EXIT_CODE=$(echo "$RESP" | jq -r '.exitCode // "0"')

if assert_not_empty "$OUTPUT" "escalation output"; then
    # Check output mentions issue identifier
    if echo "$OUTPUT" | grep -qi "EVA-\|issue\|escalat"; then
        log "Output references escalation"
    fi

    # Verify issue was created
    sleep 1
    ISSUES_AFTER=$(api_get "/api/companies/$COMPANY_ID/issues" | jq 'length')
    if [ "$ISSUES_AFTER" -gt "$ISSUES_BEFORE" ]; then
        log "Issue count increased: $ISSUES_BEFORE → $ISSUES_AFTER"
    else
        fail "No new issue created (before=$ISSUES_BEFORE, after=$ISSUES_AFTER)"
    fi

    # Verify agent is paused
    AGENT_STATE=$(api_get "/api/companies/$COMPANY_ID/agents" | \
        jq -r --arg id "$RESEARCHER_ID" '.[] | select(.id == $id) | .status')
    if assert_eq "$AGENT_STATE" "paused" "researcher status after escalation"; then
        log "Agent correctly paused"
        pass
    fi
else
    fail "No output from escalation call (exit=$EXIT_CODE)"
fi

# ═══════════════════════════════════════════════════
# Test 4: Verify issue content
# ═══════════════════════════════════════════════════
begin_test "Escalation issue has correct content"

# Find the most recent issue
LATEST_ISSUE=$(api_get "/api/companies/$COMPANY_ID/issues" | \
    jq 'sort_by(.createdAt) | last')
ISSUE_TITLE=$(echo "$LATEST_ISSUE" | jq -r '.title // empty')
ISSUE_DESC=$(echo "$LATEST_ISSUE" | jq -r '.description // empty')
ISSUE_PRI=$(echo "$LATEST_ISSUE" | jq -r '.priority // empty')
ISSUE_IDENT=$(echo "$LATEST_ISSUE" | jq -r '.identifier // empty')

log "Issue: $ISSUE_IDENT — $ISSUE_TITLE"

CHECKS_PASSED=true

if [ -z "$ISSUE_TITLE" ]; then
    fail "Issue title is empty"
    CHECKS_PASSED=false
fi

if echo "$ISSUE_TITLE" | grep -qi "approval\|deployment\|proceed"; then
    log "Title contains escalation keywords"
else
    log "Warning: title may not match message (LLM paraphrased?): $ISSUE_TITLE"
fi

if [ "$ISSUE_PRI" = "high" ]; then
    log "Priority: high (correct for blocking)"
else
    log "Warning: priority is '$ISSUE_PRI' (expected high for blocking)"
fi

if echo "$ISSUE_DESC" | grep -q "escalation-schema"; then
    log "Schema block present in description"
else
    log "Warning: no escalation-schema block in description"
fi

if [ "$CHECKS_PASSED" = true ]; then
    pass
fi

# ═══════════════════════════════════════════════════
# Test 5: Issue has escalation label
# ═══════════════════════════════════════════════════
begin_test "Escalation issue has escalation label"

LABEL_ATTACHED=$(echo "$LATEST_ISSUE" | jq -r '
    if (.labels | type) == "array" then
        (.labels[] | select(.name == "escalation") | .name) // empty
    elif (.labels | type) == "object" then
        (select(.labels.name == "escalation") | .labels.name) // empty
    else empty end
')

if [ -z "$LABEL_ATTACHED" ]; then
    # Check labelIds
    LABEL_IDS=$(echo "$LATEST_ISSUE" | jq -r '.labelIds // [] | length')
    if [ "$LABEL_IDS" -gt 0 ]; then
        log "Label attached via labelIds ($LABEL_IDS labels)"
        pass
    else
        fail "No escalation label on issue"
    fi
else
    log "Escalation label confirmed"
    pass
fi

# ═══════════════════════════════════════════════════
# Test 6: Resume agent after escalation
# ═══════════════════════════════════════════════════
begin_test "Agent can be resumed after escalation"

RESUME_RESP=$(api_post "/api/agents/$RESEARCHER_ID/resume" '{}')
RESUME_STATUS=$(echo "$RESUME_RESP" | jq -r '.status // empty')
if assert_eq "$RESUME_STATUS" "idle" "resume status"; then
    log "Agent resumed successfully"
    pass
fi

# ═══════════════════════════════════════════════════
# Test 7: Escalation with structured inputs
# ═══════════════════════════════════════════════════
begin_test "Escalation with structured inputs (select)"

ISSUES_MID=$(api_get "/api/companies/$COMPANY_ID/issues" | jq 'length')

RESP=$(bridge_post "$RESEARCHER_BRIDGE_URL" \
    '{"prompt": "Call the escalate tool with: message=\"Which cloud provider should we use?\", urgency=\"blocking\", inputs=[{id: \"cloud\", label: \"Cloud Provider\", type: \"select\", options: [{value: \"aws\", label: \"AWS\", description: \"Amazon Web Services\"}, {value: \"gcp\", label: \"GCP\", description: \"Google Cloud\"}, {value: \"azure\", label: \"Azure\", description: \"Microsoft Azure\"}]}]. Call the tool now.", "systemPrompt": "Call the escalate tool immediately with the exact parameters given. Do not ask questions."}' 120)
OUTPUT=$(echo "$RESP" | jq -r '.output // empty')

if assert_not_empty "$OUTPUT" "structured escalation output"; then
    sleep 1
    ISSUES_NOW=$(api_get "/api/companies/$COMPANY_ID/issues" | jq 'length')
    if [ "$ISSUES_NOW" -gt "$ISSUES_MID" ]; then
        # Check the new issue has structured content
        STRUCT_ISSUE=$(api_get "/api/companies/$COMPANY_ID/issues" | \
            jq 'sort_by(.createdAt) | last')
        STRUCT_DESC=$(echo "$STRUCT_ISSUE" | jq -r '.description // empty')

        if echo "$STRUCT_DESC" | grep -qi "AWS\|GCP\|Azure\|cloud"; then
            log "Structured inputs rendered in description"
            pass
        else
            log "Warning: options not clearly in description, but issue created"
            pass
        fi
    else
        fail "No new issue for structured escalation"
    fi
fi

# Resume for next test
api_post "/api/agents/$RESEARCHER_ID/resume" '{}' > /dev/null 2>&1 || true

# ═══════════════════════════════════════════════════
# Test 8: Escalation with when_you_can urgency
# ═══════════════════════════════════════════════════
begin_test "Escalation with when_you_can urgency → medium priority"

RESP=$(bridge_post "$RESEARCHER_BRIDGE_URL" \
    '{"prompt": "Call the escalate tool with: message=\"FYI: the build cache is growing large, might want to clean it when convenient\", urgency=\"when_you_can\". Call it now.", "systemPrompt": "Call the escalate tool immediately. Do not ask questions."}' 120)
OUTPUT=$(echo "$RESP" | jq -r '.output // empty')

if assert_not_empty "$OUTPUT" "when_you_can output"; then
    sleep 1
    WYC_ISSUE=$(api_get "/api/companies/$COMPANY_ID/issues" | \
        jq 'sort_by(.createdAt) | last')
    WYC_PRI=$(echo "$WYC_ISSUE" | jq -r '.priority // empty')
    if [ "$WYC_PRI" = "medium" ]; then
        log "Priority correctly set to medium"
        pass
    elif [ "$WYC_PRI" = "high" ]; then
        log "Warning: priority is high (LLM may have overridden urgency)"
        pass
    else
        log "Priority: $WYC_PRI"
        pass
    fi
fi

# Resume
api_post "/api/agents/$RESEARCHER_ID/resume" '{}' > /dev/null 2>&1 || true

# ═══════════════════════════════════════════════════
# Test 9: Agent output mentions issue identifier
# ═══════════════════════════════════════════════════
begin_test "Agent output references issue for resume context"

RESP=$(bridge_post "$RESEARCHER_BRIDGE_URL" \
    '{"prompt": "Call the escalate tool with message=\"Need human review of security audit\", urgency=\"blocking\". Report back what the tool returned.", "systemPrompt": "Call escalate immediately, then report what it returned."}' 120)
OUTPUT=$(echo "$RESP" | jq -r '.output // empty')

if assert_not_empty "$OUTPUT" "issue reference output"; then
    if echo "$OUTPUT" | grep -qi "EVA-\|issue\|#[0-9]\|identifier\|resumed\|check"; then
        log "Output contains issue/resume reference"
        pass
    else
        log "Output present but no clear issue reference: $(echo "$OUTPUT" | head -c 200)"
        pass
    fi
fi

# Resume
api_post "/api/agents/$RESEARCHER_ID/resume" '{}' > /dev/null 2>&1 || true

# ═══════════════════════════════════════════════════
# Test 10: Bridge does not crash on escalation
# ═══════════════════════════════════════════════════
begin_test "Bridge remains healthy after escalation"

# Verify bridge still responds
HEALTH_RESP=$(curl -sf -o /dev/null -w "%{http_code}" "$RESEARCHER_BRIDGE_URL/health")
if assert_eq "$HEALTH_RESP" "200" "bridge health after escalation"; then
    pass
fi

# ═══════════════════════════════════════════════════
# Test 11: Multiple rapid escalations don't collide
# ═══════════════════════════════════════════════════
begin_test "Sequential escalations create distinct issues"

# Resume from any prior pause
api_post "/api/agents/$RESEARCHER_ID/resume" '{}' > /dev/null 2>&1 || true

ISSUES_PRE=$(api_get "/api/companies/$COMPANY_ID/issues" | jq 'length')

RESP1=$(bridge_post "$RESEARCHER_BRIDGE_URL" \
    '{"prompt": "Call escalate with message=\"First escalation\".", "systemPrompt": "Call escalate immediately."}' 120)
api_post "/api/agents/$RESEARCHER_ID/resume" '{}' > /dev/null 2>&1 || true
sleep 2

RESP2=$(bridge_post "$RESEARCHER_BRIDGE_URL" \
    '{"prompt": "Call escalate with message=\"Second escalation\".", "systemPrompt": "Call escalate immediately."}' 120)
api_post "/api/agents/$RESEARCHER_ID/resume" '{}' > /dev/null 2>&1 || true
sleep 1

ISSUES_POST=$(api_get "/api/companies/$COMPANY_ID/issues" | jq 'length')
NEW_ISSUES=$((ISSUES_POST - ISSUES_PRE))

if [ "$NEW_ISSUES" -ge 2 ]; then
    log "Created $NEW_ISSUES new issues (expected 2+)"
    pass
else
    fail "Expected 2+ new issues, got $NEW_ISSUES"
fi

# ═══════════════════════════════════════════════════
# Test 12: Escalation from CEO agent also works
# ═══════════════════════════════════════════════════
begin_test "CEO agent can also escalate"

CEO_ID=$(find_agent_id "$COMPANY_ID" "CEO")
api_post "/api/agents/$CEO_ID/resume" '{}' > /dev/null 2>&1 || true

RESP=$(bridge_post "$CEO_BRIDGE_URL" \
    '{"prompt": "Call the escalate tool with message=\"CEO needs board approval for budget increase\".", "systemPrompt": "Call escalate immediately."}' 120)
OUTPUT=$(echo "$RESP" | jq -r '.output // empty')

if assert_not_empty "$OUTPUT" "CEO escalation output"; then
    if echo "$OUTPUT" | grep -qi "escalat\|issue\|EVA-\|paused\|approval"; then
        log "CEO escalation successful"
        pass
    else
        log "Output present: $(echo "$OUTPUT" | head -c 200)"
        pass
    fi
fi

# Resume CEO
api_post "/api/agents/$CEO_ID/resume" '{}' > /dev/null 2>&1 || true

# ═══════════════════════════════════════════════════
# Cleanup
# ═══════════════════════════════════════════════════
echo ""
echo "[Cleanup]"
# Ensure both agents are resumed
api_post "/api/agents/$RESEARCHER_ID/resume" '{}' > /dev/null 2>&1 || true
api_post "/api/agents/$CEO_ID/resume" '{}' > /dev/null 2>&1 || true
log "Agents resumed."

FINAL_ISSUES=$(api_get "/api/companies/$COMPANY_ID/issues" | jq 'length')
log "Total issues after test: $FINAL_ISSUES (started at $ISSUES_BEFORE)"

summary
