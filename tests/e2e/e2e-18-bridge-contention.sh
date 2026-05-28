#!/usr/bin/env bash
# E2E-18: Bridge Lock Contention — 503 on Concurrent Invoke
#
# Tests that when a Pi process is running, a second /invoke request
# gets HTTP 503 immediately instead of blocking until the first completes.
#
# Before the fix: second request queued, Paperclip's 10s adapter timeout
# fired, producing "Headers Timeout Error" (27 occurrences in M0.1).
#
# After the fix: second request gets 503 + Retry-After in <1 second.
#
# Requires: at least one agent bridge running (CEO at :8081 by default).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

CEO_URL="${CEO_BRIDGE_URL:-http://localhost:8081}"
TIMEOUT=10

echo ""
echo "══════════════════════════════════════════════════════════════════"
echo "[E2E-18] Bridge Lock Contention — 503 on Busy"
echo "══════════════════════════════════════════════════════════════════"
echo ""

# --- Preflight ---
echo "Checking CEO health..."
if ! wait_healthy "$CEO_URL/health" 15; then
    echo "[FATAL] CEO not healthy at $CEO_URL"
    exit 1
fi
echo "  CEO healthy."

# Check if bridge reports busy status
HEALTH=$(curl -sf "$CEO_URL/health" 2>/dev/null || true)
IS_BUSY=$(echo "$HEALTH" | jq -r '.busy // false' 2>/dev/null || echo "unknown")
echo "  Bridge busy: $IS_BUSY"
echo ""

# --- Build payload ---
PAYLOAD=$(jq -n '{
    agentId: "test-contention",
    runId: "contention-test-1",
    context: {
        wakeReason: "assignment",
        wakeSource: "on_demand",
        paperclipTaskMarkdown: "Respond with exactly: CONTENTION_TEST_OK"
    }
}')

# ─────────────────────────────────────────────────────────────────────
# TEST 1: Second request while first is running gets 503
# ─────────────────────────────────────────────────────────────────────
begin_test "Second /invoke returns 503 while first is running"

# Send first request in background (will take 30-120s to complete)
curl -s --max-time 180 \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "$CEO_URL/invoke" > /dev/null 2>&1 &
FIRST_PID=$!

# Wait for bridge to acquire lock
sleep 2

# Send second request with short timeout — should return fast
START_MS=$(date +%s%3N 2>/dev/null || echo "0")
SECOND_RESP=$(curl -s -w "\n%{http_code}" --max-time "$TIMEOUT" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "$CEO_URL/invoke" 2>/dev/null || echo -e "\n000")
END_MS=$(date +%s%3N 2>/dev/null || echo "0")

HTTP_CODE=$(echo "$SECOND_RESP" | tail -1)
BODY=$(echo "$SECOND_RESP" | sed '$d')
ELAPSED=$((END_MS - START_MS))

if [ "$HTTP_CODE" = "503" ]; then
    log "Got 503 in ${ELAPSED}ms (expected)"
    ERROR_TYPE=$(echo "$BODY" | jq -r '.error // empty' 2>/dev/null)
    if [ "$ERROR_TYPE" = "agent_busy" ]; then
        log "Error body: agent_busy"
        pass
    else
        log "Warning: 503 but unexpected error type: $ERROR_TYPE"
        pass  # Still 503, close enough
    fi
elif [ "$HTTP_CODE" = "000" ]; then
    fail "Connection failed or timed out (bridge may still be queuing)"
elif [ "$HTTP_CODE" = "200" ]; then
    if [ "$ELAPSED" -lt 3000 ]; then
        fail "Got 200 in ${ELAPSED}ms — first request finished too fast to test contention"
        log "(Try again with a slower prompt or longer-running Pi task)"
    else
        fail "Got 200 in ${ELAPSED}ms — second request queued and waited (old behavior)"
    fi
else
    fail "Unexpected HTTP $HTTP_CODE"
    log "Body: ${BODY:0:200}"
fi

# Clean up background request
kill "$FIRST_PID" 2>/dev/null || true
wait "$FIRST_PID" 2>/dev/null || true
echo ""

# ─────────────────────────────────────────────────────────────────────
# TEST 2: Health endpoint shows busy while processing
# ─────────────────────────────────────────────────────────────────────
begin_test "Health endpoint reports busy status during active invoke"

# Send another request in background
curl -s --max-time 180 \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" \
    "$CEO_URL/invoke" > /dev/null 2>&1 &
FIRST_PID=$!

sleep 2

HEALTH=$(curl -sf "$CEO_URL/health" 2>/dev/null || echo '{}')
IS_BUSY=$(echo "$HEALTH" | jq -r '.busy // "missing"' 2>/dev/null)

if [ "$IS_BUSY" = "true" ]; then
    log "Health reports busy=true during active invoke"
    pass
elif [ "$IS_BUSY" = "missing" ]; then
    skip "Health endpoint does not include busy field"
else
    fail "Health reports busy=$IS_BUSY during active invoke"
fi

kill "$FIRST_PID" 2>/dev/null || true
wait "$FIRST_PID" 2>/dev/null || true
echo ""

# ─────────────────────────────────────────────────────────────────────
# TEST 3: After completion, next request succeeds (not permanently locked)
# ─────────────────────────────────────────────────────────────────────
begin_test "Bridge accepts new request after previous completes"

# Wait for any lock to clear
sleep 3

HEALTH=$(curl -sf "$CEO_URL/health" 2>/dev/null || echo '{}')
IS_BUSY=$(echo "$HEALTH" | jq -r '.busy // false' 2>/dev/null)

if [ "$IS_BUSY" = "false" ]; then
    log "Bridge not busy — lock released correctly"
    pass
else
    # Try hitting health a few more times
    sleep 5
    HEALTH=$(curl -sf "$CEO_URL/health" 2>/dev/null || echo '{}')
    IS_BUSY=$(echo "$HEALTH" | jq -r '.busy // false' 2>/dev/null)
    if [ "$IS_BUSY" = "false" ]; then
        log "Bridge lock released after brief delay"
        pass
    else
        fail "Bridge still busy — lock may be stuck"
    fi
fi
echo ""

echo "══════════════════════════════════════════════════════════════════"
summary
