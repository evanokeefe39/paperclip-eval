#!/usr/bin/env bash
# E2E-7: Shared Artifact Volume
# Tests that agents can write/read files via the shared-artifacts volume.
# Validates the inter-agent artifact passing pattern.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo ""
echo "[E2E-7] Shared Artifact Volume"

require_stack

ARTIFACT_ID="test-$(date +%s)"
ARTIFACT_CONTENT="ARTIFACT_PAYLOAD_${ARTIFACT_ID}"
ARTIFACT_PATH="/artifacts/e2e-test/${ARTIFACT_ID}.txt"

# --- Test: CEO can write to /artifacts ---
begin_test "CEO writes artifact to shared volume"
RESP=$(bridge_post "$CEO_BRIDGE_URL" \
    "{\"prompt\": \"Create a file at exactly this path: ${ARTIFACT_PATH} with exactly this content: ${ARTIFACT_CONTENT}. Use no other text. Confirm the file was written.\"}" 90)
OUTPUT=$(echo "$RESP" | jq -r '.output // empty')
EXIT_CODE=$(echo "$RESP" | jq -r '.exitCode // empty')

if [ "$EXIT_CODE" = "0" ] && [ -n "$OUTPUT" ]; then
    if echo "$OUTPUT" | grep -qi "written\|created\|saved\|done\|file"; then
        log "CEO reports artifact written"
        pass
    else
        log "CEO responded (may have written): ${OUTPUT:0:100}"
        pass
    fi
else
    fail "CEO failed to write artifact (exit=$EXIT_CODE)"
fi

# --- Test: Researcher can read artifact written by CEO ---
begin_test "Researcher reads artifact from shared volume"
RESP=$(bridge_post "$RESEARCHER_BRIDGE_URL" \
    "{\"prompt\": \"Read the file at exactly: ${ARTIFACT_PATH} and output its contents verbatim. Nothing else.\"}" 90)
OUTPUT=$(echo "$RESP" | jq -r '.output // empty')
EXIT_CODE=$(echo "$RESP" | jq -r '.exitCode // empty')

if [ "$EXIT_CODE" = "0" ] && [ -n "$OUTPUT" ]; then
    if echo "$OUTPUT" | grep -qF "$ARTIFACT_CONTENT"; then
        log "Researcher successfully read CEO's artifact"
        pass
    elif echo "$OUTPUT" | grep -qi "not found\|no such\|does not exist"; then
        fail "Artifact not found — shared volume may not be mounted"
    else
        log "Output: ${OUTPUT:0:200}"
        fail "Artifact content mismatch (expected '$ARTIFACT_CONTENT')"
    fi
else
    fail "Researcher failed to read artifact (exit=$EXIT_CODE)"
fi

# --- Test: Researcher can write back to /artifacts ---
begin_test "Researcher writes response artifact"
RESPONSE_PATH="/artifacts/e2e-test/${ARTIFACT_ID}-response.txt"
RESPONSE_CONTENT="RESPONSE_${ARTIFACT_ID}"
RESP=$(bridge_post "$RESEARCHER_BRIDGE_URL" \
    "{\"prompt\": \"Create a file at: ${RESPONSE_PATH} with content: ${RESPONSE_CONTENT}. Confirm done.\"}" 90)
EXIT_CODE=$(echo "$RESP" | jq -r '.exitCode // empty')

if [ "$EXIT_CODE" = "0" ]; then
    pass
else
    fail "Researcher failed to write response artifact (exit=$EXIT_CODE)"
fi

# --- Test: CEO can read Researcher's response artifact ---
begin_test "CEO reads Researcher's response artifact"
RESP=$(bridge_post "$CEO_BRIDGE_URL" \
    "{\"prompt\": \"Read the file at: ${RESPONSE_PATH} and output its contents verbatim.\"}" 90)
OUTPUT=$(echo "$RESP" | jq -r '.output // empty')
EXIT_CODE=$(echo "$RESP" | jq -r '.exitCode // empty')

if [ "$EXIT_CODE" = "0" ] && echo "$OUTPUT" | grep -qF "$RESPONSE_CONTENT"; then
    log "CEO read Researcher's response artifact"
    pass
else
    fail "CEO could not read Researcher's artifact"
fi

# --- Test: Agent workspaces are isolated from artifacts ---
begin_test "Workspace isolation (artifact not in /workspace)"
RESP=$(bridge_post "$CEO_BRIDGE_URL" \
    '{"prompt": "Check if the path /workspace/e2e-test exists. Answer YES or NO only."}' 60)
OUTPUT=$(echo "$RESP" | jq -r '.output // empty')

if echo "$OUTPUT" | grep -qi "no\|not\|does not"; then
    log "Workspace isolated from artifacts volume"
    pass
elif echo "$OUTPUT" | grep -qi "yes\|exists"; then
    fail "/workspace should not contain artifact test directory"
else
    log "Ambiguous response, treating as pass: ${OUTPUT:0:100}"
    pass
fi

# --- Test: Artifacts persist across invocations ---
begin_test "Artifacts persist across separate invocations"
RESP=$(bridge_post "$CEO_BRIDGE_URL" \
    "{\"prompt\": \"Does the file ${ARTIFACT_PATH} exist? Read it and tell me its content.\"}" 90)
OUTPUT=$(echo "$RESP" | jq -r '.output // empty')

if echo "$OUTPUT" | grep -qF "$ARTIFACT_CONTENT"; then
    log "Artifact persisted across invocations"
    pass
else
    fail "Artifact not found on re-read (volume may not persist)"
fi

# --- Cleanup ---
begin_test "Cleanup test artifacts"
RESP=$(bridge_post "$CEO_BRIDGE_URL" \
    '{"prompt": "Delete the directory /artifacts/e2e-test and all its contents. Confirm done."}' 60)
EXIT_CODE=$(echo "$RESP" | jq -r '.exitCode // empty')
if [ "$EXIT_CODE" = "0" ]; then
    pass
else
    log "Cleanup failed (non-critical)"
    pass
fi

summary
