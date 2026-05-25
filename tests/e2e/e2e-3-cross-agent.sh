#!/usr/bin/env bash
# E2E-3: Cross-Agent Visibility
# Verifies agents can reference each other and that the org structure
# supports inter-agent communication through Paperclip.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo ""
echo "[E2E-3] Cross-Agent Visibility"

require_stack

COMPANY_ID=$(find_company_id)
CEO_ID=$(find_agent_id "$COMPANY_ID" "CEO")
RES_ID=$(find_agent_id "$COMPANY_ID" "Researcher")

if [ -z "$CEO_ID" ] || [ -z "$RES_ID" ]; then
    echo "[FATAL] Agents not registered. Run setup first."
    exit 1
fi

# --- Test: CEO knows about Researcher via system prompt context ---
begin_test "CEO can reference Researcher in org context"
CEO_RESP=$(bridge_post "$CEO_BRIDGE_URL" \
    '{"prompt": "List the agents that report to you by name. Be brief.", "systemPrompt": "You are the CEO of a company. Your direct report is an agent named Researcher who handles information gathering."}' \
    60)
CEO_OUTPUT=$(echo "$CEO_RESP" | jq -r '.output // empty')
if assert_contains "$CEO_OUTPUT" "Researcher" "CEO output referencing Researcher"; then
    pass
fi

# --- Test: Both agents produce independent outputs ---
begin_test "Both agents produce independent coherent output"
CEO_RESP=$(bridge_post "$CEO_BRIDGE_URL" \
    '{"prompt": "What is your role? Answer in one sentence starting with: I am"}' 30)
RES_RESP=$(bridge_post "$RESEARCHER_BRIDGE_URL" \
    '{"prompt": "What is your role? Answer in one sentence starting with: I am"}' 30)

CEO_OUT=$(echo "$CEO_RESP" | jq -r '.output // empty')
RES_OUT=$(echo "$RES_RESP" | jq -r '.output // empty')

CEO_OK=true
RES_OK=true

if ! assert_not_empty "$CEO_OUT" "CEO output"; then CEO_OK=false; fi
if ! assert_not_empty "$RES_OUT" "Researcher output"; then RES_OK=false; fi

if $CEO_OK && $RES_OK; then
    log "CEO: $(echo "$CEO_OUT" | head -1 | cut -c1-80)..."
    log "RES: $(echo "$RES_OUT" | head -1 | cut -c1-80)..."
    pass
fi

# --- Test: Org tree reflects reporting structure ---
begin_test "Org tree contains both agents with hierarchy"
ORG=$(get_org_tree "$COMPANY_ID")

# Check CEO exists at top level (or root)
CEO_IN_ORG=$(echo "$ORG" | jq -r '.. | objects | select(.name == "CEO") | .id // empty' 2>/dev/null | head -1)
RES_IN_ORG=$(echo "$ORG" | jq -r '.. | objects | select(.name == "Researcher") | .id // empty' 2>/dev/null | head -1)

if assert_eq "$CEO_IN_ORG" "$CEO_ID" "CEO ID in org tree" && \
   assert_eq "$RES_IN_ORG" "$RES_ID" "Researcher ID in org tree"; then
    pass
fi

# --- Test: Agent workspaces are isolated ---
begin_test "Agent workspaces isolated (no cross-contamination)"
CEO_MARKER="CEO_MARKER_$(date +%s)"
RES_MARKER="RES_MARKER_$(date +%s)"

# Have each agent echo a unique marker
CEO_RESP=$(bridge_post "$CEO_BRIDGE_URL" \
    "{\"prompt\": \"Repeat this code exactly: $CEO_MARKER\"}" 30)
RES_RESP=$(bridge_post "$RESEARCHER_BRIDGE_URL" \
    "{\"prompt\": \"Repeat this code exactly: $RES_MARKER\"}" 30)

CEO_OUT=$(echo "$CEO_RESP" | jq -r '.output // empty')
RES_OUT=$(echo "$RES_RESP" | jq -r '.output // empty')

ISOLATED=true
if ! assert_contains "$CEO_OUT" "$CEO_MARKER" "CEO echoed marker"; then ISOLATED=false; fi
if ! assert_contains "$RES_OUT" "$RES_MARKER" "Researcher echoed marker"; then ISOLATED=false; fi
# CEO should not have researcher's marker and vice versa
if ! assert_not_contains "$CEO_OUT" "$RES_MARKER" "CEO output cross-contamination"; then ISOLATED=false; fi
if ! assert_not_contains "$RES_OUT" "$CEO_MARKER" "Researcher output cross-contamination"; then ISOLATED=false; fi

if $ISOLATED; then
    pass
fi

# --- Test: Concurrent cross-agent requests ---
begin_test "Concurrent requests to both agents"
CEO_BODY='{"prompt": "Your secret word is EXECUTIVE. State it."}'
RES_BODY='{"prompt": "Your secret word is ANALYST. State it."}'

CEO_TMP=$(mktemp)
RES_TMP=$(mktemp)

curl -sf --max-time 60 -X POST \
    -H "Content-Type: application/json" \
    -d "$CEO_BODY" \
    "$CEO_BRIDGE_URL/invoke" > "$CEO_TMP" &
CEO_PID=$!

curl -sf --max-time 60 -X POST \
    -H "Content-Type: application/json" \
    -d "$RES_BODY" \
    "$RESEARCHER_BRIDGE_URL/invoke" > "$RES_TMP" &
RES_PID=$!

wait $CEO_PID || true
wait $RES_PID || true

CEO_OUT=$(jq -r '.output // empty' < "$CEO_TMP")
RES_OUT=$(jq -r '.output // empty' < "$RES_TMP")
rm -f "$CEO_TMP" "$RES_TMP"

CONCURRENT_OK=true
if ! assert_contains "$CEO_OUT" "EXECUTIVE" "CEO concurrent output"; then CONCURRENT_OK=false; fi
if ! assert_contains "$RES_OUT" "ANALYST" "Researcher concurrent output"; then CONCURRENT_OK=false; fi
if ! assert_not_contains "$CEO_OUT" "ANALYST" "CEO leaking researcher secret"; then CONCURRENT_OK=false; fi
if ! assert_not_contains "$RES_OUT" "EXECUTIVE" "Researcher leaking CEO secret"; then CONCURRENT_OK=false; fi

if $CONCURRENT_OK; then
    pass
fi

summary
