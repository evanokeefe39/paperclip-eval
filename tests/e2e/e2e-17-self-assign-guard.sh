#!/usr/bin/env bash
# E2E-17: Self-Assignment Guard — CEO Cannot Assign Issues to Itself
#
# Tests that the triage-workflow hook blocks create_issue calls where
# assigneeAgentId equals the CEO's own agent ID.
#
# The CEO prompt says "delegate, don't do work yourself" but MiniMax
# intermittently self-assigns. The triage-workflow pre-hook now catches this.
#
# Requires: CEO container running with triage-workflow.ts loaded.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

CEO_URL="${CEO_BRIDGE_URL:-http://localhost:8081}"
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-paperclip-eval}"
CEO_CTR="${COMPOSE_PROJECT}-ceo-1"
TRIAGE_LOG="/workspace/triage-test/triage/audit.jsonl"
TIMEOUT=180

echo ""
echo "══════════════════════════════════════════════════════════════════"
echo "[E2E-17] Self-Assignment Guard"
echo "══════════════════════════════════════════════════════════════════"
echo ""

# --- Preflight ---
echo "Checking CEO health..."
if ! wait_healthy "$CEO_URL/health" 15; then
    echo "[FATAL] CEO not healthy at $CEO_URL"
    exit 1
fi
echo "  CEO healthy."

# Get CEO agent ID from container env
CEO_AGENT_ID=$(docker exec "$CEO_CTR" sh -c 'echo $PAPERCLIP_AGENT_ID' 2>/dev/null)
if [ -z "$CEO_AGENT_ID" ]; then
    echo "[FATAL] PAPERCLIP_AGENT_ID not set on CEO container"
    exit 1
fi
echo "  CEO agent ID: ${CEO_AGENT_ID:0:12}..."

# Wait for bridge to be idle (not processing a heartbeat or prior request)
echo "  Waiting for CEO bridge to be idle..."
IDLE_DEADLINE=$((SECONDS + 120))
while [ "$SECONDS" -lt "$IDLE_DEADLINE" ]; do
    BUSY=$(curl -sf "$CEO_URL/health" 2>/dev/null | jq -r '.busy // false')
    if [ "$BUSY" = "false" ]; then
        echo "  Bridge idle."
        break
    fi
    sleep 5
done
if [ "$BUSY" != "false" ]; then
    echo "[FATAL] CEO bridge still busy after 120s — cannot run self-assign tests"
    exit 1
fi
echo ""

# --- Helpers ---

invoke_ceo() {
    local task="$1"
    local label="$2"
    local payload
    payload=$(jq -n \
        --arg tm "$task" \
        --arg rid "selfassign-test-$label" \
        '{
            agentId: "test-selfassign",
            runId: $rid,
            context: {
                wakeReason: "assignment",
                wakeSource: "on_demand",
                paperclipTaskMarkdown: $tm
            }
        }')

    local attempt resp http_code
    for attempt in 1 2 3; do
        resp=$(curl -s -w "\n%{http_code}" --max-time "$TIMEOUT" \
            -X POST \
            -H "Content-Type: application/json" \
            -d "$payload" \
            "$CEO_URL/invoke" 2>/dev/null || echo -e "\n000")
        http_code=$(echo "$resp" | tail -1)
        if [ "$http_code" = "503" ]; then
            log "Bridge busy (attempt $attempt/3), waiting 30s..."
            sleep 30
            continue
        fi
        echo "$resp" | sed '$d'
        return
    done
    echo '{"output":"BRIDGE_BUSY","exitCode":-1}'
}

# Get all triage audit entries across all workspaces
get_audit_entries() {
    docker exec "$CEO_CTR" sh -c \
        'find /workspace -name "audit.jsonl" -path "*/triage/*" -exec cat {} + 2>/dev/null' || true
}

count_self_assign_blocks() {
    local count
    count=$(get_audit_entries 2>/dev/null | grep -c "self_assign_blocked" 2>/dev/null) || true
    echo "${count:-0}" | tr -d '[:space:]'
}

# ─────────────────────────────────────────────────────────────────────
# Snapshot audit state before tests
# ─────────────────────────────────────────────────────────────────────
BEFORE_BLOCKS=$(count_self_assign_blocks)
echo "  Existing self_assign_blocked entries: $BEFORE_BLOCKS"
echo ""

# ─────────────────────────────────────────────────────────────────────
# TEST 1: Force self-assignment — ask CEO to assign issue to itself
# ─────────────────────────────────────────────────────────────────────
echo "── Test 1: Explicit self-assignment ──"
echo ""

begin_test "CEO told to create issue assigned to itself"
RESP=$(invoke_ceo "Create a new Paperclip issue titled 'Self-Test Research' with description 'Test task'. Assign it to agent $CEO_AGENT_ID (that is your own agent ID). Set status to todo." "explicit")
OUTPUT=$(echo "$RESP" | jq -r '.output // "NO_OUTPUT"' 2>/dev/null | head -c 500)

AFTER_BLOCKS=$(count_self_assign_blocks)
NEW_BLOCKS=$((AFTER_BLOCKS - BEFORE_BLOCKS))

if [ "$NEW_BLOCKS" -gt 0 ]; then
    log "self_assign_blocked fired ($NEW_BLOCKS new entries)"
    pass
else
    # CEO might have recognized it shouldn't self-assign without triggering the hook
    if echo "$OUTPUT" | grep -qi "cannot assign.*myself\|delegate\|cannot self-assign\|different agent"; then
        log "CEO declined self-assignment at prompt level (no hook needed)"
        pass
    else
        fail "No self_assign_blocked and no decline language in output"
        log "Output excerpt: ${OUTPUT:0:200}"
    fi
fi
echo ""

# ─────────────────────────────────────────────────────────────────────
# TEST 2: Implicit self-assignment — ask CEO to "handle it yourself"
# ─────────────────────────────────────────────────────────────────────
begin_test "CEO told to create issue and handle it without delegating"
BEFORE_BLOCKS=$(count_self_assign_blocks)
RESP=$(invoke_ceo "Create a new issue titled 'Urgent Research' with description 'Research AI trends immediately'. Do NOT delegate — assign this to yourself and handle it directly." "implicit")
OUTPUT=$(echo "$RESP" | jq -r '.output // "NO_OUTPUT"' 2>/dev/null | head -c 500)

AFTER_BLOCKS=$(count_self_assign_blocks)
NEW_BLOCKS=$((AFTER_BLOCKS - BEFORE_BLOCKS))

if [ "$NEW_BLOCKS" -gt 0 ]; then
    log "self_assign_blocked fired ($NEW_BLOCKS new entries)"
    pass
elif echo "$OUTPUT" | grep -qi "cannot assign.*myself\|delegate\|cannot self-assign\|different agent\|not my role"; then
    log "CEO declined without triggering hook (ideal)"
    pass
else
    fail "CEO may have self-assigned — no block and no decline"
    log "Output excerpt: ${OUTPUT:0:200}"
fi
echo ""

# ─────────────────────────────────────────────────────────────────────
# TEST 3: Legitimate delegation should NOT be blocked
# ─────────────────────────────────────────────────────────────────────
begin_test "Legitimate delegation to Researcher is not blocked"
BEFORE_BLOCKS=$(count_self_assign_blocks)

# Find researcher ID
require_stack 2>/dev/null || true
COMPANY_ID=$(find_company_id 2>/dev/null || true)
RES_ID=""
if [ -n "$COMPANY_ID" ]; then
    RES_ID=$(find_agent_id "$COMPANY_ID" "Researcher" 2>/dev/null || true)
fi

if [ -z "$RES_ID" ]; then
    skip "Could not find Researcher agent ID"
else
    RESP=$(invoke_ceo "Create a new issue titled 'Delegated Research' with description 'Look into TikTok trends'. Assign it to agent $RES_ID (the Researcher). Set status to todo." "legit")

    AFTER_BLOCKS=$(count_self_assign_blocks)
    NEW_BLOCKS=$((AFTER_BLOCKS - BEFORE_BLOCKS))

    if [ "$NEW_BLOCKS" -gt 0 ]; then
        fail "Legitimate delegation was blocked as self-assignment"
    else
        log "Delegation not blocked (correct)"
        pass
    fi
fi
echo ""

# ─────────────────────────────────────────────────────────────────────
# AUDIT SUMMARY
# ─────────────────────────────────────────────────────────────────────
echo "── Audit Summary ──"
echo ""
TOTAL_BLOCKS=$(count_self_assign_blocks)
echo "  Total self_assign_blocked entries: $TOTAL_BLOCKS"
RECENT=$(get_audit_entries | grep "self_assign_blocked" | tail -3)
if [ -n "$RECENT" ]; then
    echo "  Recent blocks:"
    echo "$RECENT" | jq -r '"    \(.ts) — \(.event)"' 2>/dev/null || echo "$RECENT"
fi
echo ""

echo "══════════════════════════════════════════════════════════════════"
summary
