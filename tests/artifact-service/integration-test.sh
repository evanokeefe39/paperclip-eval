#!/usr/bin/env bash
# Integration tests for artifact-service.
# Tests the HTTP API directly via curl/jq — no bridge involved.
#
# Requires: docker compose up -d postgres minio minio-init artifact-service
# Run: bash tests/artifact-service/integration-test.sh

set -euo pipefail

ARTIFACT_URL="${ARTIFACT_URL:-http://localhost:8090}"
AGENT_NAME="test-agent"
RUN_ID="integ-$(date +%s)"

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
echo " Artifact Service -- Integration Tests"
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
# 1. Health check
# ==========================================================
echo "[1] Health check"
HEALTH=$(curl -sf "$ARTIFACT_URL/health")
if echo "$HEALTH" | jq -e '.status == "ok"' > /dev/null 2>&1; then
    PG=$(echo "$HEALTH" | jq -r '.postgres')
    S3=$(echo "$HEALTH" | jq -r '.minio')
    if [ "$PG" = "true" ] && [ "$S3" = "true" ]; then
        pass "Health check (status=ok, postgres=true, minio=true)"
    else
        fail "Health check" "postgres=$PG, minio=$S3 (expected both true)"
    fi
else
    fail "Health check" "unexpected response: $HEALTH"
fi

# ==========================================================
# 2. Write artifact
# ==========================================================
echo "[2] Write artifact"
WRITE_CONTENT="hello from integration test"
WRITE_B64=$(echo -n "$WRITE_CONTENT" | base64)
WRITE_RESP=$(curl -sf -X POST \
    -H "Content-Type: application/json" \
    -H "X-Agent-Name: researcher" \
    -w "\n%{http_code}" \
    -d "{
        \"filename\": \"test-report.txt\",
        \"content\": \"$WRITE_B64\",
        \"type\": \"report\",
        \"bucket\": \"artifacts\",
        \"run_id\": \"$RUN_ID\",
        \"metadata\": {\"source\": \"integration-test\"}
    }" \
    "$ARTIFACT_URL/artifacts" 2>&1 || true)

WRITE_STATUS=$(echo "$WRITE_RESP" | tail -1)
WRITE_BODY=$(echo "$WRITE_RESP" | sed '$d')

if [ "$WRITE_STATUS" = "201" ]; then
    ARTIFACT_ID=$(echo "$WRITE_BODY" | jq -r '.id // empty')
    ARTIFACT_REF=$(echo "$WRITE_BODY" | jq -r '.ref // empty')
    ARTIFACT_SIZE=$(echo "$WRITE_BODY" | jq -r '.size // empty')
    ARTIFACT_HASH=$(echo "$WRITE_BODY" | jq -r '.hash // empty')
    if [ -n "$ARTIFACT_ID" ] && [ -n "$ARTIFACT_REF" ] && [ -n "$ARTIFACT_SIZE" ] && [ -n "$ARTIFACT_HASH" ]; then
        pass "Write artifact (id=$ARTIFACT_ID, size=$ARTIFACT_SIZE)"
    else
        fail "Write artifact" "response missing fields: $WRITE_BODY"
    fi
else
    fail "Write artifact" "expected 201, got $WRITE_STATUS: $WRITE_BODY"
    ARTIFACT_ID=""
fi

# ==========================================================
# 3. Read artifact
# ==========================================================
echo "[3] Read artifact"
if [ -n "$ARTIFACT_ID" ]; then
    READ_RESP=$(curl -sf -D - \
        -H "X-Agent-Name: researcher" \
        "$ARTIFACT_URL/artifacts/$ARTIFACT_ID" 2>&1 || true)

    READ_BODY=$(echo "$READ_RESP" | sed -n '/^\r*$/,$p' | tail -n +2)
    META_HEADER=$(echo "$READ_RESP" | grep -i "x-artifact-metadata:" | sed 's/^[^:]*: //' | tr -d '\r')

    if [ "$READ_BODY" = "$WRITE_CONTENT" ]; then
        pass "Read artifact content matches"
    else
        fail "Read artifact" "content mismatch: expected '$WRITE_CONTENT', got '$READ_BODY'"
    fi

    if [ -n "$META_HEADER" ]; then
        META_ID=$(echo "$META_HEADER" | jq -r '.id // empty' 2>/dev/null)
        if [ "$META_ID" = "$ARTIFACT_ID" ]; then
            pass "X-Artifact-Metadata header present and parseable"
        else
            fail "X-Artifact-Metadata header" "id mismatch in header JSON"
        fi
    else
        fail "X-Artifact-Metadata header" "header not found in response"
    fi
else
    fail "Read artifact" "skipped (no artifact id from write)"
    fail "X-Artifact-Metadata header" "skipped (no artifact id from write)"
fi

# ==========================================================
# 4. List artifacts
# ==========================================================
echo "[4] List artifacts"
if [ -n "$ARTIFACT_ID" ]; then
    # List all
    LIST_ALL=$(curl -sf -H "X-Agent-Name: researcher" "$ARTIFACT_URL/artifacts")
    LIST_COUNT=$(echo "$LIST_ALL" | jq 'length')
    if [ "$LIST_COUNT" -gt 0 ]; then
        FOUND=$(echo "$LIST_ALL" | jq -r --arg id "$ARTIFACT_ID" '[.[] | select(.id == $id)] | length')
        if [ "$FOUND" = "1" ]; then
            pass "List artifacts (found written artifact in full list)"
        else
            fail "List artifacts" "written artifact not in list"
        fi
    else
        fail "List artifacts" "empty list returned"
    fi

    # Filter by agent_name
    LIST_AGENT=$(curl -sf -H "X-Agent-Name: researcher" "$ARTIFACT_URL/artifacts?agent_name=researcher")
    FOUND_AGENT=$(echo "$LIST_AGENT" | jq -r --arg id "$ARTIFACT_ID" '[.[] | select(.id == $id)] | length')
    if [ "$FOUND_AGENT" = "1" ]; then
        pass "List filter by agent_name"
    else
        fail "List filter by agent_name" "artifact not found with agent_name=researcher"
    fi

    # Filter by artifact_type
    LIST_TYPE=$(curl -sf -H "X-Agent-Name: researcher" "$ARTIFACT_URL/artifacts?artifact_type=report")
    FOUND_TYPE=$(echo "$LIST_TYPE" | jq -r --arg id "$ARTIFACT_ID" '[.[] | select(.id == $id)] | length')
    if [ "$FOUND_TYPE" = "1" ]; then
        pass "List filter by artifact_type"
    else
        fail "List filter by artifact_type" "artifact not found with artifact_type=report"
    fi
else
    fail "List artifacts" "skipped (no artifact id)"
    fail "List filter by agent_name" "skipped (no artifact id)"
    fail "List filter by artifact_type" "skipped (no artifact id)"
fi

# ==========================================================
# 5. Update metadata
# ==========================================================
echo "[5] Update metadata"
if [ -n "$ARTIFACT_ID" ]; then
    PATCH_RESP=$(curl -sf -X PATCH \
        -H "Content-Type: application/json" \
        -H "X-Agent-Name: researcher" \
        -d '{"metadata": {"reviewed": true, "grade": "A"}}' \
        "$ARTIFACT_URL/artifacts/$ARTIFACT_ID")

    REVIEWED=$(echo "$PATCH_RESP" | jq -r '.metadata.reviewed // empty')
    SOURCE=$(echo "$PATCH_RESP" | jq -r '.metadata.source // empty')
    GRADE=$(echo "$PATCH_RESP" | jq -r '.metadata.grade // empty')

    if [ "$REVIEWED" = "true" ] && [ "$SOURCE" = "integration-test" ] && [ "$GRADE" = "A" ]; then
        pass "Update metadata (merged: original source + new reviewed + grade)"
    else
        fail "Update metadata" "merge failed: reviewed=$REVIEWED, source=$SOURCE, grade=$GRADE"
    fi
else
    fail "Update metadata" "skipped (no artifact id)"
fi

# ==========================================================
# 6. RBAC write deny
# ==========================================================
echo "[6] RBAC write deny"
# Writer trying to write to researcher's namespace by spoofing agent name.
# The s3_key is constructed server-side from X-Agent-Name, so writer writes to
# writer's namespace. But we test: an agent not in rbac.json at all gets denied.
RBAC_WRITE_RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Content-Type: application/json" \
    -H "X-Agent-Name: stranger" \
    -d "{
        \"filename\": \"denied.txt\",
        \"content\": \"$(echo -n "should fail" | base64)\",
        \"type\": \"report\"
    }" \
    "$ARTIFACT_URL/artifacts")

if [ "$RBAC_WRITE_RESP" = "403" ]; then
    pass "RBAC write deny (unknown agent 'stranger' blocked)"
else
    fail "RBAC write deny" "expected 403, got $RBAC_WRITE_RESP"
fi

# ==========================================================
# 7. RBAC read deny
# ==========================================================
echo "[7] RBAC read deny"
if [ -n "$ARTIFACT_ID" ]; then
    # researcher wrote the artifact. An unknown agent should not be able to read it.
    RBAC_READ_RESP=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "X-Agent-Name: stranger" \
        "$ARTIFACT_URL/artifacts/$ARTIFACT_ID")

    if [ "$RBAC_READ_RESP" = "403" ]; then
        pass "RBAC read deny (unknown agent 'stranger' blocked)"
    else
        fail "RBAC read deny" "expected 403, got $RBAC_READ_RESP"
    fi

    # CEO can read all (read: ["**"])
    CEO_READ_RESP=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "X-Agent-Name: ceo" \
        "$ARTIFACT_URL/artifacts/$ARTIFACT_ID")

    if [ "$CEO_READ_RESP" = "200" ]; then
        pass "RBAC read allow (ceo reads researcher artifact)"
    else
        fail "RBAC read allow" "expected 200 for ceo, got $CEO_READ_RESP"
    fi
else
    fail "RBAC read deny" "skipped (no artifact id)"
    fail "RBAC read allow" "skipped (no artifact id)"
fi

# ==========================================================
# 8. Metadata filter on list
# ==========================================================
echo "[8] Metadata filter on list"
# Write artifact with distinctive metadata
META_B64=$(echo -n "metadata filter test" | base64)
META_WRITE=$(curl -sf -X POST \
    -H "Content-Type: application/json" \
    -H "X-Agent-Name: researcher" \
    -d "{
        \"filename\": \"meta-test.txt\",
        \"content\": \"$META_B64\",
        \"type\": \"finding\",
        \"run_id\": \"$RUN_ID\",
        \"metadata\": {\"style\": \"intelligence\", \"priority\": \"high\"}
    }" \
    "$ARTIFACT_URL/artifacts" 2>/dev/null || echo '{}')

META_ID=$(echo "$META_WRITE" | jq -r '.id // empty')

if [ -n "$META_ID" ]; then
    # List with metadata containment filter
    META_FILTER=$(curl -sf \
        -H "X-Agent-Name: researcher" \
        --get \
        --data-urlencode 'metadata={"style":"intelligence"}' \
        "$ARTIFACT_URL/artifacts")

    META_FOUND=$(echo "$META_FILTER" | jq -r --arg id "$META_ID" '[.[] | select(.id == $id)] | length')
    if [ "$META_FOUND" = "1" ]; then
        pass "List with metadata filter (style=intelligence)"
    else
        fail "List with metadata filter" "artifact $META_ID not found in filtered results"
    fi
else
    fail "List with metadata filter" "setup write failed"
fi

# ==========================================================
# 9. Different buckets
# ==========================================================
echo "[9] Different buckets"
LOGS_B64=$(echo -n "log entry test" | base64)
LOGS_WRITE=$(curl -sf -X POST \
    -H "Content-Type: application/json" \
    -H "X-Agent-Name: researcher" \
    -d "{
        \"filename\": \"run.log\",
        \"content\": \"$LOGS_B64\",
        \"type\": \"log\",
        \"bucket\": \"logs\",
        \"run_id\": \"$RUN_ID\"
    }" \
    "$ARTIFACT_URL/artifacts" 2>/dev/null || echo '{}')

LOGS_ID=$(echo "$LOGS_WRITE" | jq -r '.id // empty')

if [ -n "$LOGS_ID" ]; then
    # List with bucket=logs filter
    BUCKET_LIST=$(curl -sf \
        -H "X-Agent-Name: researcher" \
        "$ARTIFACT_URL/artifacts?bucket=logs")

    BUCKET_FOUND=$(echo "$BUCKET_LIST" | jq -r --arg id "$LOGS_ID" '[.[] | select(.id == $id)] | length')
    if [ "$BUCKET_FOUND" = "1" ]; then
        pass "Write to logs bucket and list with bucket filter"
    else
        fail "Bucket filter" "artifact $LOGS_ID not found in bucket=logs list"
    fi

    # Verify it does NOT appear in bucket=artifacts filter
    ARTIFACTS_LIST=$(curl -sf \
        -H "X-Agent-Name: researcher" \
        "$ARTIFACT_URL/artifacts?bucket=artifacts")

    NOT_IN_ARTIFACTS=$(echo "$ARTIFACTS_LIST" | jq -r --arg id "$LOGS_ID" '[.[] | select(.id == $id)] | length')
    if [ "$NOT_IN_ARTIFACTS" = "0" ]; then
        pass "Logs artifact excluded from bucket=artifacts list"
    else
        fail "Bucket isolation" "logs artifact appeared in bucket=artifacts list"
    fi
else
    fail "Write to logs bucket" "write failed"
    fail "Bucket isolation" "skipped (write failed)"
fi

# ==========================================================
# 10. 404 on read
# ==========================================================
echo "[10] 404 on nonexistent artifact"
NOT_FOUND_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "X-Agent-Name: researcher" \
    "$ARTIFACT_URL/artifacts/00000000000000000000000000")

if [ "$NOT_FOUND_STATUS" = "404" ]; then
    pass "404 on nonexistent artifact"
else
    fail "404 on nonexistent artifact" "expected 404, got $NOT_FOUND_STATUS"
fi

# ==========================================================
summary
