#!/usr/bin/env bash
# Deduplication test for artifact-service.
# Verifies that writing identical content twice returns the original record
# with deduplicated: true instead of creating a duplicate.
#
# Requires: docker compose up -d postgres minio minio-init artifact-service
# Run: bash tests/artifact-service/test-dedup.sh

set -euo pipefail

ARTIFACT_URL="${ARTIFACT_URL:-http://localhost:8090}"
AGENT_NAME="ceo"

# Counters
PASS=0
FAIL=0

pass() { echo "  [PASS] $1"; ((PASS++)) || true; }
fail() { echo "  [FAIL] $1 — $2"; ((FAIL++)) || true; }

summary() {
    local total=$((PASS + FAIL))
    echo ""
    echo "--------------------------------------"
    echo "Results: $PASS/$total passed, $FAIL failed"
    [ "$FAIL" -gt 0 ] && return 1
    return 0
}

echo ""
echo "==================================================="
echo " Artifact Service -- Deduplication Tests"
echo " Target: $ARTIFACT_URL"
echo "==================================================="
echo ""

# --- Prerequisites ---
echo "Checking prerequisites..."
for cmd in curl jq base64; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "[FATAL] Required command: $cmd"
        exit 1
    fi
done
echo "  Tools available."

echo "Waiting for artifact service..."
DEADLINE=$((SECONDS + 30))
while [ "$SECONDS" -lt "$DEADLINE" ]; do
    if curl -sf -o /dev/null "$ARTIFACT_URL/health"; then
        break
    fi
    sleep 2
done
if ! curl -sf -o /dev/null "$ARTIFACT_URL/health"; then
    echo "[FATAL] Artifact service not healthy at $ARTIFACT_URL"
    exit 1
fi
echo "  Artifact service healthy."
echo ""

# ==========================================================
# 1. First write — should succeed normally
# ==========================================================
echo "[1] First write (unique content)"
UNIQUE_CONTENT="dedup-test-$(date +%s%N)-$$"
CONTENT_B64=$(echo -n "$UNIQUE_CONTENT" | base64)

WRITE1_RESP=$(curl -sf -X POST \
    -H "Content-Type: application/json" \
    -H "X-Agent-Name: $AGENT_NAME" \
    -w "\n%{http_code}" \
    -d "{
        \"filename\": \"test-dedup.md\",
        \"content\": \"$CONTENT_B64\",
        \"type\": \"research\",
        \"agent_name\": \"$AGENT_NAME\",
        \"company_id\": \"test\",
        \"project_id\": \"test\"
    }" \
    "$ARTIFACT_URL/artifacts" 2>&1 || true)

WRITE1_STATUS=$(echo "$WRITE1_RESP" | tail -1)
WRITE1_BODY=$(echo "$WRITE1_RESP" | sed '$d')

if [ "$WRITE1_STATUS" = "201" ]; then
    FIRST_ID=$(echo "$WRITE1_BODY" | jq -r '.id // empty')
    FIRST_HASH=$(echo "$WRITE1_BODY" | jq -r '.hash // empty')
    FIRST_DEDUP=$(echo "$WRITE1_BODY" | jq -r '.deduplicated // empty')
    if [ -n "$FIRST_ID" ] && [ -n "$FIRST_HASH" ]; then
        if [ "$FIRST_DEDUP" = "true" ]; then
            fail "First write" "should not be deduplicated (deduplicated=true on fresh content)"
        else
            pass "First write (id=$FIRST_ID)"
        fi
    else
        fail "First write" "response missing id or hash: $WRITE1_BODY"
    fi
else
    fail "First write" "expected 201, got $WRITE1_STATUS: $WRITE1_BODY"
    FIRST_ID=""
fi

# ==========================================================
# 2. Duplicate write — same content, should be deduplicated
# ==========================================================
echo "[2] Duplicate write (same content)"
if [ -n "$FIRST_ID" ]; then
    WRITE2_RESP=$(curl -sf -X POST \
        -H "Content-Type: application/json" \
        -H "X-Agent-Name: $AGENT_NAME" \
        -w "\n%{http_code}" \
        -d "{
            \"filename\": \"test-dedup-copy.md\",
            \"content\": \"$CONTENT_B64\",
            \"type\": \"report\",
            \"agent_name\": \"$AGENT_NAME\",
            \"company_id\": \"test\",
            \"project_id\": \"test\"
        }" \
        "$ARTIFACT_URL/artifacts" 2>&1 || true)

    WRITE2_STATUS=$(echo "$WRITE2_RESP" | tail -1)
    WRITE2_BODY=$(echo "$WRITE2_RESP" | sed '$d')

    SECOND_ID=$(echo "$WRITE2_BODY" | jq -r '.id // empty')
    SECOND_DEDUP=$(echo "$WRITE2_BODY" | jq -r '.deduplicated // empty')
    SECOND_HASH=$(echo "$WRITE2_BODY" | jq -r '.hash // empty')

    # Should return 200 (not 201) and deduplicated: true
    if [ "$SECOND_DEDUP" = "true" ]; then
        pass "Duplicate write flagged as deduplicated"
    else
        fail "Duplicate write" "expected deduplicated=true, got: $WRITE2_BODY"
    fi

    if [ "$SECOND_ID" = "$FIRST_ID" ]; then
        pass "Duplicate write returns same ID ($FIRST_ID)"
    else
        fail "Duplicate write ID" "expected $FIRST_ID, got $SECOND_ID"
    fi

    if [ "$SECOND_HASH" = "$FIRST_HASH" ]; then
        pass "Duplicate write returns same hash"
    else
        fail "Duplicate write hash" "expected $FIRST_HASH, got $SECOND_HASH"
    fi
else
    fail "Duplicate write" "skipped (first write failed)"
    fail "Duplicate write ID" "skipped (first write failed)"
    fail "Duplicate write hash" "skipped (first write failed)"
fi

# ==========================================================
# 3. Different content — should NOT be deduplicated
# ==========================================================
echo "[3] Different content (no dedup)"
DIFF_CONTENT="different-content-$(date +%s%N)-$$"
DIFF_B64=$(echo -n "$DIFF_CONTENT" | base64)

WRITE3_RESP=$(curl -sf -X POST \
    -H "Content-Type: application/json" \
    -H "X-Agent-Name: $AGENT_NAME" \
    -w "\n%{http_code}" \
    -d "{
        \"filename\": \"test-different.md\",
        \"content\": \"$DIFF_B64\",
        \"type\": \"research\",
        \"agent_name\": \"$AGENT_NAME\",
        \"company_id\": \"test\",
        \"project_id\": \"test\"
    }" \
    "$ARTIFACT_URL/artifacts" 2>&1 || true)

WRITE3_STATUS=$(echo "$WRITE3_RESP" | tail -1)
WRITE3_BODY=$(echo "$WRITE3_RESP" | sed '$d')

if [ "$WRITE3_STATUS" = "201" ]; then
    THIRD_ID=$(echo "$WRITE3_BODY" | jq -r '.id // empty')
    THIRD_DEDUP=$(echo "$WRITE3_BODY" | jq -r '.deduplicated // empty')
    if [ "$THIRD_DEDUP" = "true" ]; then
        fail "Different content" "incorrectly flagged as deduplicated"
    elif [ "$THIRD_ID" != "$FIRST_ID" ]; then
        pass "Different content gets new ID ($THIRD_ID)"
    else
        fail "Different content" "got same ID as first write"
    fi
else
    fail "Different content" "expected 201, got $WRITE3_STATUS: $WRITE3_BODY"
fi

# ==========================================================
summary
