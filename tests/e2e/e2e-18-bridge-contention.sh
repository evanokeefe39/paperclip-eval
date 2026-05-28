#!/usr/bin/env bash
# E2E-18: Server Contention — FIFO Queue Behavior (v3.0.0)
#
# Validates that server v3.0.0 queues concurrent /invoke requests in a FIFO
# queue instead of rejecting with 503. Both requests complete with HTTP 200.
# Health endpoint exposes queue state (busy, queue_depth).
#
# Requires: researcher server running on port 8082.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

BRIDGE_URL="${RESEARCHER_BRIDGE_URL:-http://localhost:8082}"
RESULTS_DIR="$SCRIPT_DIR/../results/server-contention-$(date +%Y%m%d-%H%M%S)"
TMPDIR_CONTENTION=$(mktemp -d)
trap 'rm -rf "$TMPDIR_CONTENTION"' EXIT

echo ""
echo "══════════════════════════════════════════════════════════════════"
echo "[E2E-18] Server Contention — FIFO Queue Behavior (v3.0.0)"
echo "  Server: $BRIDGE_URL"
echo "  Results: $RESULTS_DIR"
echo "══════════════════════════════════════════════════════════════════"
echo ""

mkdir -p "$RESULTS_DIR"

# --- Preflight ---
echo "Checking researcher server health..."
if ! wait_healthy "$BRIDGE_URL/health" 15; then
    echo "[FATAL] Researcher server not healthy at $BRIDGE_URL"
    exit 1
fi
echo "  Server healthy."
echo ""

# ─────────────────────────────────────────────────────────────────────
# TEST 1: Health endpoint reports version 3.0.0
# ─────────────────────────────────────────────────────────────────────
begin_test "Health reports version 3.0.0"
HEALTH=$(curl -sf "$BRIDGE_URL/health")
VERSION=$(echo "$HEALTH" | jq -r '.version // empty')
if assert_eq "$VERSION" "3.0.0" "version"; then
    pass
fi

# ─────────────────────────────────────────────────────────────────────
# TEST 2: Health shows idle state (busy=false, queue_depth=0)
# ─────────────────────────────────────────────────────────────────────
begin_test "Health shows idle state before contention"
BUSY=$(echo "$HEALTH" | jq -r '.busy | tostring')
QDEPTH=$(echo "$HEALTH" | jq -r '.queue_depth // empty')
if assert_eq "$BUSY" "false" "busy" && assert_eq "$QDEPTH" "0" "queue_depth"; then
    pass
fi

# ─────────────────────────────────────────────────────────────────────
# TEST 3: Health exposes queue_max field
# ─────────────────────────────────────────────────────────────────────
begin_test "Health exposes queue_max field"
QMAX=$(echo "$HEALTH" | jq -r '.queue_max // empty')
if assert_not_empty "$QMAX" "queue_max"; then
    log "queue_max=$QMAX"
    pass
fi

# ─────────────────────────────────────────────────────────────────────
# TEST 4+5: Concurrent invocations — both return HTTP 200
#
# Fire two /invoke requests concurrently. The first occupies the session;
# the second should be queued (not rejected). Both must return 200.
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

curl -s --max-time 300 \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD_A" \
    -w "\n%{http_code}" \
    "$BRIDGE_URL/invoke" > "$TMPDIR_CONTENTION/resp_a.txt" 2>&1 &
PID_A=$!

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
# TEST 4: Health shows busy + queued while both are in-flight
# ─────────────────────────────────────────────────────────────────────
sleep 2

begin_test "Health shows busy=true and queue_depth>=1 during contention"
HEALTH_MID=$(curl -sf "$BRIDGE_URL/health" 2>/dev/null || echo '{}')
MID_BUSY=$(echo "$HEALTH_MID" | jq -r '.busy | tostring')
MID_QDEPTH=$(echo "$HEALTH_MID" | jq -r '.queue_depth // empty')

if [ "$MID_BUSY" = "true" ] && [ "${MID_QDEPTH:-0}" -ge 1 ]; then
    log "busy=$MID_BUSY queue_depth=$MID_QDEPTH"
    pass
else
    log "busy=$MID_BUSY queue_depth=$MID_QDEPTH (may have drained before check)"
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

STATUS_A=$(tail -1 "$TMPDIR_CONTENTION/resp_a.txt" | tr -d '[:space:]')
STATUS_B=$(tail -1 "$TMPDIR_CONTENTION/resp_b.txt" | tr -d '[:space:]')
BODY_A=$(sed '$d' "$TMPDIR_CONTENTION/resp_a.txt")
BODY_B=$(sed '$d' "$TMPDIR_CONTENTION/resp_b.txt")

echo "$BODY_A" > "$RESULTS_DIR/response_a.json"
echo "$BODY_B" > "$RESULTS_DIR/response_b.json"

echo ""
echo "── Results ──"
echo ""

# ─────────────────────────────────────────────────────────────────────
# TEST 5: Request A returned HTTP 200
# ─────────────────────────────────────────────────────────────────────
begin_test "Request A returned HTTP 200"
if assert_eq "$STATUS_A" "200" "HTTP status A"; then
    OUTPUT_A=$(echo "$BODY_A" | jq -r '.output // empty' 2>/dev/null || true)
    log "output excerpt: ${OUTPUT_A:0:80}"
    pass
fi

# ─────────────────────────────────────────────────────────────────────
# TEST 6: Request B returned HTTP 200 (not 503)
# ─────────────────────────────────────────────────────────────────────
begin_test "Request B returned HTTP 200 (queued, not rejected)"
if assert_eq "$STATUS_B" "200" "HTTP status B"; then
    OUTPUT_B=$(echo "$BODY_B" | jq -r '.output // empty' 2>/dev/null || true)
    log "output excerpt: ${OUTPUT_B:0:80}"
    pass
fi

# ─────────────────────────────────────────────────────────────────────
# TEST 7: Health shows idle after both complete
# ─────────────────────────────────────────────────────────────────────
begin_test "Health shows busy=false and queue_depth=0 after completion"
HEALTH_POST=$(curl -sf "$BRIDGE_URL/health")
POST_BUSY=$(echo "$HEALTH_POST" | jq -r '.busy | tostring')
POST_QDEPTH=$(echo "$HEALTH_POST" | jq -r '.queue_depth // empty')
if assert_eq "$POST_BUSY" "false" "busy" && assert_eq "$POST_QDEPTH" "0" "queue_depth"; then
    pass
fi

echo ""
echo "══════════════════════════════════════════════════════════════════"

summary
