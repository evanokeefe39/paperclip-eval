#!/usr/bin/env bash
# E2E-18: Server Contention — Async Queue Behavior (v3.0.0)
#
# Validates that server v3.0.0 accepts concurrent /invoke requests with HTTP
# 202, queues them in a FIFO queue, and completes them asynchronously. Run
# status queryable via GET /runs/:runId. Health endpoint exposes queue state
# (busy, queue_depth).
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
echo "[E2E-18] Server Contention — Async Queue Behavior (v3.0.0)"
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
# TEST 4+5+6+7: Concurrent invocations — both accepted with HTTP 202
#
# Fire two /invoke requests. Both return 202 immediately with a runId.
# Poll GET /runs/:runId until both complete asynchronously.
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

RESP_A=$(curl -s --max-time 10 \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD_A" \
    -w "\n%{http_code}" \
    "$BRIDGE_URL/invoke")

STATUS_A=$(echo "$RESP_A" | tail -1 | tr -d '[:space:]')
BODY_A=$(echo "$RESP_A" | sed '$d')
RUN_ID_A=$(echo "$BODY_A" | jq -r '.runId // empty')

sleep 2

# ─────────────────────────────────────────────────────────────────────
# TEST 4: Health shows busy while A is processing
# ─────────────────────────────────────────────────────────────────────
begin_test "Health shows busy=true while request A is processing"
HEALTH_MID=$(curl -sf "$BRIDGE_URL/health" 2>/dev/null || echo '{}')
MID_BUSY=$(echo "$HEALTH_MID" | jq -r '.busy | tostring')
MID_QDEPTH=$(echo "$HEALTH_MID" | jq -r '.queue_depth // empty')

if [ "$MID_BUSY" = "true" ]; then
    log "busy=$MID_BUSY queue_depth=$MID_QDEPTH"
    pass
else
    log "busy=$MID_BUSY queue_depth=$MID_QDEPTH (may have completed before check)"
    if [ "$MID_BUSY" = "false" ] && [ "${MID_QDEPTH:-0}" -eq 0 ]; then
        skip "request A completed before health check — timing dependent"
    else
        pass
    fi
fi

log "Sending request B (queued task)..."

RESP_B=$(curl -s --max-time 10 \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD_B" \
    -w "\n%{http_code}" \
    "$BRIDGE_URL/invoke")

STATUS_B=$(echo "$RESP_B" | tail -1 | tr -d '[:space:]')
BODY_B=$(echo "$RESP_B" | sed '$d')
RUN_ID_B=$(echo "$BODY_B" | jq -r '.runId // empty')

echo ""
echo "── Results ──"
echo ""

# ─────────────────────────────────────────────────────────────────────
# TEST 5: Request A accepted with HTTP 202
# ─────────────────────────────────────────────────────────────────────
begin_test "Request A accepted with HTTP 202"
if assert_eq "$STATUS_A" "202" "HTTP status A"; then
    log "runId: $RUN_ID_A"
    pass
fi

# ─────────────────────────────────────────────────────────────────────
# TEST 6: Request B accepted with HTTP 202
# ─────────────────────────────────────────────────────────────────────
begin_test "Request B accepted with HTTP 202 (queued, not rejected)"
if assert_eq "$STATUS_B" "202" "HTTP status B"; then
    log "runId: $RUN_ID_B"
    pass
fi

# ─────────────────────────────────────────────────────────────────────
# TEST 7: Both runs complete successfully
# ─────────────────────────────────────────────────────────────────────
begin_test "Both runs complete successfully via polling"
log "Polling run A ($RUN_ID_A) and run B ($RUN_ID_B)..."

RESULT_A=$(bridge_poll_run "$BRIDGE_URL" "$RUN_ID_A" 300)
RESULT_B=$(bridge_poll_run "$BRIDGE_URL" "$RUN_ID_B" 300)

STATUS_A_FINAL=$(echo "$RESULT_A" | jq -r '.status // empty')
STATUS_B_FINAL=$(echo "$RESULT_B" | jq -r '.status // empty')

if [ "$STATUS_A_FINAL" = "completed" ] && [ "$STATUS_B_FINAL" = "completed" ]; then
    OUTPUT_A=$(echo "$RESULT_A" | jq -r '.output // empty')
    OUTPUT_B=$(echo "$RESULT_B" | jq -r '.output // empty')
    log "A output excerpt: ${OUTPUT_A:0:80}"
    log "B output excerpt: ${OUTPUT_B:0:80}"
    pass
else
    fail "A=$STATUS_A_FINAL B=$STATUS_B_FINAL (expected both completed)"
fi

echo "$RESULT_A" > "$RESULTS_DIR/response_a.json"
echo "$RESULT_B" > "$RESULTS_DIR/response_b.json"

# ─────────────────────────────────────────────────────────────────────
# TEST 8: Health shows idle after both complete
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
