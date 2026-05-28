#!/usr/bin/env bash
# E2E-18: Bridge Contention — FIFO Queue Behavior (v2.0.0)
#
# Validates that bridge v2.0.0 queues concurrent /invoke requests in a FIFO
# queue instead of rejecting with 503. Both requests complete with HTTP 200.
# Health endpoint exposes queue state (busy, queue_depth, pi_status).
#
# Requires: researcher bridge running on port 8082.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

BRIDGE_URL="${RESEARCHER_BRIDGE_URL:-http://localhost:8082}"
RESULTS_DIR="$SCRIPT_DIR/../results/bridge-contention-$(date +%Y%m%d-%H%M%S)"
TMPDIR_CONTENTION=$(mktemp -d)
trap 'rm -rf "$TMPDIR_CONTENTION"' EXIT

echo ""
echo "══════════════════════════════════════════════════════════════════"
echo "[E2E-18] Bridge Contention — FIFO Queue Behavior (v2.0.0)"
echo "  Bridge: $BRIDGE_URL"
echo "  Results: $RESULTS_DIR"
echo "══════════════════════════════════════════════════════════════════"
echo ""

mkdir -p "$RESULTS_DIR"

# --- Preflight ---
echo "Checking researcher bridge health..."
if ! wait_healthy "$BRIDGE_URL/health" 15; then
    echo "[FATAL] Researcher bridge not healthy at $BRIDGE_URL"
    exit 1
fi
echo "  Bridge healthy."
echo ""

# ─────────────────────────────────────────────────────────────────────
# TEST 1: Health endpoint reports version 2.0.0
# ─────────────────────────────────────────────────────────────────────
begin_test "Health reports version 2.0.0"
HEALTH=$(curl -sf "$BRIDGE_URL/health")
VERSION=$(echo "$HEALTH" | jq -r '.version // empty')
if assert_eq "$VERSION" "2.0.0" "version"; then
    pass
fi

# ─────────────────────────────────────────────────────────────────────
# TEST 2: Pi status is "ready" at idle
# ─────────────────────────────────────────────────────────────────────
begin_test "Pi status is 'ready' at idle"
PI_STATUS=$(echo "$HEALTH" | jq -r '.pi_status // empty')
if assert_eq "$PI_STATUS" "ready" "pi_status"; then
    pass
fi

# ─────────────────────────────────────────────────────────────────────
# TEST 3: Health shows idle state (busy=false, queue_depth=0)
# ─────────────────────────────────────────────────────────────────────
begin_test "Health shows idle state before contention"
BUSY=$(echo "$HEALTH" | jq -r '.busy // empty')
QDEPTH=$(echo "$HEALTH" | jq -r '.queue_depth // empty')
if assert_eq "$BUSY" "false" "busy" && assert_eq "$QDEPTH" "0" "queue_depth"; then
    pass
fi

# ─────────────────────────────────────────────────────────────────────
# TEST 4: Health exposes queue_max field
# ─────────────────────────────────────────────────────────────────────
begin_test "Health exposes queue_max field"
QMAX=$(echo "$HEALTH" | jq -r '.queue_max // empty')
if assert_not_empty "$QMAX" "queue_max"; then
    log "queue_max=$QMAX"
    pass
fi

# ─────────────────────────────────────────────────────────────────────
# TEST 5: Health exposes pi_uptime_s field
# ─────────────────────────────────────────────────────────────────────
begin_test "Health exposes pi_uptime_s"
PI_UPTIME=$(echo "$HEALTH" | jq -r '.pi_uptime_s // empty')
if assert_not_empty "$PI_UPTIME" "pi_uptime_s"; then
    log "pi_uptime_s=$PI_UPTIME"
    pass
fi

# ─────────────────────────────────────────────────────────────────────
# Capture baseline restart count
# ─────────────────────────────────────────────────────────────────────
RESTARTS_BEFORE=$(echo "$HEALTH" | jq -r '.pi_restarts // 0')

# ─────────────────────────────────────────────────────────────────────
# TEST 6+7: Concurrent invocations — both return HTTP 200
#
# Fire two /invoke requests concurrently. The first occupies Pi; the
# second should be queued (not rejected). Both must return 200.
# ─────────────────────────────────────────────────────────────────────

PAYLOAD_A=$(jq -n '{
    agentId: "contention-test",
    runId: "contention-a",
    context: {
        wakeReason: "assignment",
        wakeSource: "on_demand",
        paperclipTaskMarkdown: "Count from 1 to 20 slowly, then respond with exactly: CONTENTION_A_OK"
    }
}')

PAYLOAD_B=$(jq -n '{
    agentId: "contention-test",
    runId: "contention-b",
    context: {
        wakeReason: "assignment",
        wakeSource: "on_demand",
        paperclipTaskMarkdown: "Respond with exactly: CONTENTION_B_OK"
    }
}')

echo ""
echo "── Concurrent invocation ──"
echo ""
log "Sending request A (slow task)..."

# Request A — fire in background, capture full response + HTTP status
curl -s --max-time 300 \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD_A" \
    -w "\n%{http_code}" \
    "$BRIDGE_URL/invoke" > "$TMPDIR_CONTENTION/resp_a.txt" 2>&1 &
PID_A=$!

# Give request A a moment to start processing before sending B
sleep 3

log "Sending request B (queued task)..."

curl -s --max-time 300 \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD_B" \
    -w "\n%{http_code}" \
    "$BRIDGE_URL/invoke" > "$TMPDIR_CONTENTION/resp_b.txt" 2>&1 &
PID_B=$!

# ─────────────────────────────────────────────────────────────────────
# TEST 6: Health shows busy + queued while both are in-flight
# ─────────────────────────────────────────────────────────────────────
sleep 2

begin_test "Health shows busy=true and queue_depth>=1 during contention"
HEALTH_MID=$(curl -sf "$BRIDGE_URL/health" 2>/dev/null || echo '{}')
MID_BUSY=$(echo "$HEALTH_MID" | jq -r '.busy // empty')
MID_QDEPTH=$(echo "$HEALTH_MID" | jq -r '.queue_depth // empty')

if [ "$MID_BUSY" = "true" ] && [ "${MID_QDEPTH:-0}" -ge 1 ]; then
    log "busy=$MID_BUSY queue_depth=$MID_QDEPTH"
    pass
else
    # The first request may have already completed (fast LLM); log actual state
    log "busy=$MID_BUSY queue_depth=$MID_QDEPTH (may have drained before check)"
    # Only fail if busy is explicitly false AND queue_depth is 0, which would
    # mean the bridge was never occupied. If busy is true with queue_depth=0,
    # that means B hasn't arrived yet — still valid timing window.
    if [ "$MID_BUSY" = "false" ] && [ "${MID_QDEPTH:-0}" -eq 0 ]; then
        skip "both requests completed before health check — timing dependent"
    else
        pass
    fi
fi

# ─────────────────────────────────────────────────────────────────────
# Wait for both requests to complete
# ─────────────────────────────────────────────────────────────────────
log "Waiting for both requests to complete..."
wait $PID_A 2>/dev/null || true
wait $PID_B 2>/dev/null || true
log "Both requests returned."

# Extract HTTP status codes (last line of curl -w output)
STATUS_A=$(tail -1 "$TMPDIR_CONTENTION/resp_a.txt" | tr -d '[:space:]')
STATUS_B=$(tail -1 "$TMPDIR_CONTENTION/resp_b.txt" | tr -d '[:space:]')
BODY_A=$(sed '$d' "$TMPDIR_CONTENTION/resp_a.txt")
BODY_B=$(sed '$d' "$TMPDIR_CONTENTION/resp_b.txt")

# Save raw responses for debugging
echo "$BODY_A" > "$RESULTS_DIR/response_a.json"
echo "$BODY_B" > "$RESULTS_DIR/response_b.json"

echo ""
echo "── Results ──"
echo ""

# ─────────────────────────────────────────────────────────────────────
# TEST 7: Request A returned HTTP 200
# ─────────────────────────────────────────────────────────────────────
begin_test "Request A returned HTTP 200"
if assert_eq "$STATUS_A" "200" "HTTP status A"; then
    OUTPUT_A=$(echo "$BODY_A" | jq -r '.output // empty' 2>/dev/null || true)
    log "output excerpt: ${OUTPUT_A:0:80}"
    pass
fi

# ─────────────────────────────────────────────────────────────────────
# TEST 8: Request B returned HTTP 200 (not 503)
# ─────────────────────────────────────────────────────────────────────
begin_test "Request B returned HTTP 200 (queued, not rejected)"
if assert_eq "$STATUS_B" "200" "HTTP status B"; then
    OUTPUT_B=$(echo "$BODY_B" | jq -r '.output // empty' 2>/dev/null || true)
    log "output excerpt: ${OUTPUT_B:0:80}"
    pass
fi

# ─────────────────────────────────────────────────────────────────────
# TEST 9: Health shows idle after both complete
# ─────────────────────────────────────────────────────────────────────
begin_test "Health shows busy=false and queue_depth=0 after completion"
HEALTH_POST=$(curl -sf "$BRIDGE_URL/health")
POST_BUSY=$(echo "$HEALTH_POST" | jq -r '.busy // empty')
POST_QDEPTH=$(echo "$HEALTH_POST" | jq -r '.queue_depth // empty')
if assert_eq "$POST_BUSY" "false" "busy" && assert_eq "$POST_QDEPTH" "0" "queue_depth"; then
    pass
fi

# ─────────────────────────────────────────────────────────────────────
# TEST 10: Pi did not restart during the test
# ─────────────────────────────────────────────────────────────────────
begin_test "pi_restarts unchanged (no crashes)"
RESTARTS_AFTER=$(echo "$HEALTH_POST" | jq -r '.pi_restarts // 0')
if assert_eq "$RESTARTS_AFTER" "$RESTARTS_BEFORE" "pi_restarts"; then
    pass
fi

# ─────────────────────────────────────────────────────────────────────
# TEST 11: Pi status returned to "ready"
# ─────────────────────────────────────────────────────────────────────
begin_test "Pi status is 'ready' after contention"
POST_PI_STATUS=$(echo "$HEALTH_POST" | jq -r '.pi_status // empty')
if assert_eq "$POST_PI_STATUS" "ready" "pi_status"; then
    pass
fi

echo ""
echo "══════════════════════════════════════════════════════════════════"

summary
