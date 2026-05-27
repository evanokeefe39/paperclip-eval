#!/usr/bin/env bash
# E2E: artifact service round-trip and cross-agent handoff.
# Tests write/read/list/RBAC through the artifact service HTTP API with
# realistic multi-agent scenarios.
#
# Requires: full stack (docker compose up -d)
# Run: bash tests/e2e/e2e-10-artifacts.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

ARTIFACT_URL="${ARTIFACT_URL:-http://localhost:8090}"
RUN_ID="e2e-$(date +%s)"

echo ""
echo "E2E-10: Artifact Service"
echo "========================"

require_stack

# Also check artifact service
echo "Checking artifact service..."
if ! wait_healthy "$ARTIFACT_URL/health" 30; then
    echo "[FATAL] Artifact service not healthy at $ARTIFACT_URL"
    exit 1
fi
echo "  Artifact service healthy."
echo ""

# ==========================================================
# 1. Write artifact as researcher
# ==========================================================
begin_test "Write artifact as researcher"
RESEARCHER_CONTENT="research findings from e2e test run $RUN_ID"
RESEARCHER_B64=$(echo -n "$RESEARCHER_CONTENT" | base64)
WRITE_RESP=$(curl -sf -X POST \
    -H "Content-Type: application/json" \
    -H "X-Agent-Name: researcher" \
    -w "\n%{http_code}" \
    -d "{
        \"filename\": \"findings.txt\",
        \"content\": \"$RESEARCHER_B64\",
        \"type\": \"report\",
        \"run_id\": \"$RUN_ID\",
        \"metadata\": {\"source\": \"e2e-10\", \"agent\": \"researcher\"}
    }" \
    "$ARTIFACT_URL/artifacts" 2>&1 || true)

WRITE_STATUS=$(echo "$WRITE_RESP" | tail -1)
WRITE_BODY=$(echo "$WRITE_RESP" | sed '$d')

if assert_eq "$WRITE_STATUS" "201" "write status"; then
    RESEARCHER_ART_ID=$(echo "$WRITE_BODY" | jq -r '.id // empty')
    if assert_not_empty "$RESEARCHER_ART_ID" "artifact id"; then
        log "Researcher artifact id: $RESEARCHER_ART_ID"
        pass
    fi
else
    fail "expected 201, got $WRITE_STATUS: $WRITE_BODY"
    RESEARCHER_ART_ID=""
fi

# ==========================================================
# 2. Read artifact as CEO
# ==========================================================
begin_test "CEO reads researcher artifact"
if [ -n "$RESEARCHER_ART_ID" ]; then
    CEO_READ=$(curl -sf \
        -H "X-Agent-Name: ceo" \
        "$ARTIFACT_URL/artifacts/$RESEARCHER_ART_ID" 2>&1 || true)

    if assert_eq "$CEO_READ" "$RESEARCHER_CONTENT" "content"; then
        pass
    fi
else
    fail "skipped (no artifact id from write)"
fi

# ==========================================================
# 3. Read artifact as unknown agent (RBAC deny)
# ==========================================================
begin_test "Unknown agent read denied"
if [ -n "$RESEARCHER_ART_ID" ]; then
    STRANGER_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "X-Agent-Name: stranger" \
        "$ARTIFACT_URL/artifacts/$RESEARCHER_ART_ID")

    if assert_eq "$STRANGER_STATUS" "403" "status"; then
        pass
    fi
else
    fail "skipped (no artifact id from write)"
fi

# ==========================================================
# 4. List artifacts by agent
# ==========================================================
begin_test "List artifacts filtered by agent_name=researcher"
if [ -n "$RESEARCHER_ART_ID" ]; then
    LIST_RESP=$(curl -sf \
        -H "X-Agent-Name: researcher" \
        "$ARTIFACT_URL/artifacts?agent_name=researcher")

    FOUND=$(echo "$LIST_RESP" | jq -r --arg id "$RESEARCHER_ART_ID" \
        '[.[] | select(.id == $id)] | length')
    if assert_eq "$FOUND" "1" "matching artifacts"; then
        pass
    fi
else
    fail "skipped (no artifact id from write)"
fi

# ==========================================================
# 5. Write artifact as data agent
# ==========================================================
begin_test "Write artifact as data agent"
DATA_CONTENT="dataset output from e2e test run $RUN_ID"
DATA_B64=$(echo -n "$DATA_CONTENT" | base64)
DATA_WRITE=$(curl -sf -X POST \
    -H "Content-Type: application/json" \
    -H "X-Agent-Name: data" \
    -w "\n%{http_code}" \
    -d "{
        \"filename\": \"dataset.csv\",
        \"content\": \"$DATA_B64\",
        \"type\": \"dataset\",
        \"run_id\": \"$RUN_ID\",
        \"mime\": \"text/csv\",
        \"metadata\": {\"source\": \"e2e-10\", \"agent\": \"data\"}
    }" \
    "$ARTIFACT_URL/artifacts" 2>&1 || true)

DATA_STATUS=$(echo "$DATA_WRITE" | tail -1)
DATA_BODY=$(echo "$DATA_WRITE" | sed '$d')

if assert_eq "$DATA_STATUS" "201" "write status"; then
    DATA_ART_ID=$(echo "$DATA_BODY" | jq -r '.id // empty')
    if assert_not_empty "$DATA_ART_ID" "artifact id"; then
        log "Data artifact id: $DATA_ART_ID"
        pass
    fi
else
    fail "expected 201, got $DATA_STATUS: $DATA_BODY"
    DATA_ART_ID=""
fi

# ==========================================================
# 6. Cross-agent read (researcher reads data's artifact)
# ==========================================================
begin_test "Researcher reads data agent artifact (cross-agent)"
if [ -n "$DATA_ART_ID" ]; then
    # RBAC: researcher.read includes "*/*/*/*/data/**"
    CROSS_READ=$(curl -sf \
        -H "X-Agent-Name: researcher" \
        "$ARTIFACT_URL/artifacts/$DATA_ART_ID" 2>&1 || true)

    if assert_eq "$CROSS_READ" "$DATA_CONTENT" "content"; then
        pass
    fi
else
    fail "skipped (no data artifact id)"
fi

# ==========================================================
# 7. Metadata round-trip
# ==========================================================
begin_test "Metadata round-trip (write, patch, verify merged)"
META_CONTENT="metadata round-trip test"
META_B64=$(echo -n "$META_CONTENT" | base64)
META_WRITE=$(curl -sf -X POST \
    -H "Content-Type: application/json" \
    -H "X-Agent-Name: researcher" \
    -d "{
        \"filename\": \"meta-test.txt\",
        \"content\": \"$META_B64\",
        \"type\": \"report\",
        \"run_id\": \"$RUN_ID\",
        \"metadata\": {\"version\": 1, \"status\": \"draft\"}
    }" \
    "$ARTIFACT_URL/artifacts" 2>/dev/null || echo '{}')

META_ART_ID=$(echo "$META_WRITE" | jq -r '.id // empty')

if [ -n "$META_ART_ID" ]; then
    # Patch with additional metadata
    PATCH_RESP=$(curl -sf -X PATCH \
        -H "Content-Type: application/json" \
        -H "X-Agent-Name: researcher" \
        -d '{"metadata": {"status": "reviewed", "grade": "B+"}}' \
        "$ARTIFACT_URL/artifacts/$META_ART_ID")

    PATCHED_STATUS=$(echo "$PATCH_RESP" | jq -r '.metadata.status // empty')
    PATCHED_GRADE=$(echo "$PATCH_RESP" | jq -r '.metadata.grade // empty')
    PATCHED_VERSION=$(echo "$PATCH_RESP" | jq -r '.metadata.version // empty')

    if [ "$PATCHED_STATUS" = "reviewed" ] && [ "$PATCHED_GRADE" = "B+" ] && [ "$PATCHED_VERSION" = "1" ]; then
        pass
    else
        fail "metadata merge failed: status=$PATCHED_STATUS, grade=$PATCHED_GRADE, version=$PATCHED_VERSION"
    fi
else
    fail "setup write failed"
fi

# ==========================================================
# 8. Different bucket (logs)
# ==========================================================
begin_test "Write to logs bucket and filter by bucket"
LOGS_CONTENT="structured log line from e2e test"
LOGS_B64=$(echo -n "$LOGS_CONTENT" | base64)
LOGS_WRITE=$(curl -sf -X POST \
    -H "Content-Type: application/json" \
    -H "X-Agent-Name: researcher" \
    -d "{
        \"filename\": \"run.log.jsonl\",
        \"content\": \"$LOGS_B64\",
        \"type\": \"log\",
        \"bucket\": \"logs\",
        \"run_id\": \"$RUN_ID\"
    }" \
    "$ARTIFACT_URL/artifacts" 2>/dev/null || echo '{}')

LOGS_ART_ID=$(echo "$LOGS_WRITE" | jq -r '.id // empty')

if [ -n "$LOGS_ART_ID" ]; then
    BUCKET_LIST=$(curl -sf \
        -H "X-Agent-Name: researcher" \
        "$ARTIFACT_URL/artifacts?bucket=logs")

    BUCKET_FOUND=$(echo "$BUCKET_LIST" | jq -r --arg id "$LOGS_ART_ID" \
        '[.[] | select(.id == $id)] | length')

    if assert_eq "$BUCKET_FOUND" "1" "artifact in logs bucket"; then
        pass
    fi
else
    fail "setup write to logs bucket failed"
fi

summary
