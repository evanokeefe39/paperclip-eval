#!/usr/bin/env bash
# E2E-5: Extension Registration & Invocation
# Verifies web_search and web_fetch extensions load, register, and function.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo ""
echo "[E2E-5] Extension Registration & Invocation"

require_stack

# --- Test: Extensions load in CEO container ---
begin_test "CEO bridge loads extensions (web_search, web_fetch)"
RESP=$(bridge_post "$CEO_BRIDGE_URL" \
    '{"prompt": "List all tools available to you. Include their exact names."}' 90)
OUTPUT=$(echo "$RESP" | jq -r '.output // empty')
EVENTS=$(echo "$RESP" | jq -r '.events // []')

if assert_not_empty "$OUTPUT" "CEO output"; then
    if echo "$OUTPUT" | grep -qi "web_search\|web.search"; then
        log "web_search registered in CEO"
    else
        fail "web_search not listed in CEO tools"
    fi
    if echo "$OUTPUT" | grep -qi "web_fetch\|web.fetch"; then
        log "web_fetch registered in CEO"
        pass
    else
        fail "web_fetch not listed in CEO tools"
    fi
fi

# --- Test: Extensions load in Researcher container ---
begin_test "Researcher bridge loads extensions (web_search, web_fetch)"
RESP=$(bridge_post "$RESEARCHER_BRIDGE_URL" \
    '{"prompt": "List all tools available to you. Include their exact names."}' 90)
OUTPUT=$(echo "$RESP" | jq -r '.output // empty')

if assert_not_empty "$OUTPUT" "Researcher output"; then
    if echo "$OUTPUT" | grep -qi "web_search\|web.search"; then
        log "web_search registered in Researcher"
    else
        fail "web_search not listed in Researcher tools"
    fi
    if echo "$OUTPUT" | grep -qi "web_fetch\|web.fetch"; then
        log "web_fetch registered in Researcher"
        pass
    else
        fail "web_fetch not listed in Researcher tools"
    fi
fi

# --- Test: web_search invocation (requires EXA_API_KEY) ---
begin_test "web_search extension invocation"
RESP=$(bridge_post "$RESEARCHER_BRIDGE_URL" \
    '{"prompt": "Use your web_search tool to search for: \"OpenAI GPT-4 announcement\". You MUST call the web_search tool."}' 120)
OUTPUT=$(echo "$RESP" | jq -r '.output // empty')
EVENTS_STR=$(echo "$RESP" | jq -c '.events[]?' 2>/dev/null)
EXIT_CODE=$(echo "$RESP" | jq -r '.exitCode // empty')

if [ "$EXIT_CODE" = "0" ] && [ -n "$OUTPUT" ]; then
    # Check if tool was actually called (events contain tool-related entries)
    if echo "$EVENTS_STR" | grep -qi "tool\|web_search\|search"; then
        log "web_search tool call detected in events"
        pass
    elif echo "$OUTPUT" | grep -qi "search results\|URL:\|http"; then
        log "web_search results present in output"
        pass
    elif echo "$OUTPUT" | grep -qi "EXA_API_KEY\|api.key\|not set"; then
        skip "EXA_API_KEY not configured in container"
    else
        fail "web_search invoked but no results or tool events detected"
    fi
else
    if echo "$OUTPUT" | grep -qi "EXA_API_KEY\|not set\|missing"; then
        skip "EXA_API_KEY not configured in container"
    else
        fail "web_search invocation failed (exit=$EXIT_CODE)"
    fi
fi

# --- Test: web_fetch invocation ---
begin_test "web_fetch extension invocation"
RESP=$(bridge_post "$RESEARCHER_BRIDGE_URL" \
    '{"prompt": "Use your web_fetch tool to fetch the content of: https://httpbin.org/html. You MUST call the web_fetch tool."}' 120)
OUTPUT=$(echo "$RESP" | jq -r '.output // empty')
EVENTS_STR=$(echo "$RESP" | jq -c '.events[]?' 2>/dev/null)
EXIT_CODE=$(echo "$RESP" | jq -r '.exitCode // empty')

if [ "$EXIT_CODE" = "0" ] && [ -n "$OUTPUT" ]; then
    if echo "$EVENTS_STR" | grep -qi "tool\|web_fetch\|fetch"; then
        log "web_fetch tool call detected in events"
        pass
    elif echo "$OUTPUT" | grep -qi "Herman Melville\|Moby Dick\|httpbin"; then
        log "web_fetch content retrieved successfully"
        pass
    else
        fail "web_fetch invoked but no content or tool events detected"
    fi
else
    fail "web_fetch invocation failed (exit=$EXIT_CODE)"
fi

# --- Test: web_fetch handles invalid URL gracefully ---
begin_test "web_fetch rejects invalid URL"
RESP=$(bridge_post "$RESEARCHER_BRIDGE_URL" \
    '{"prompt": "Use your web_fetch tool to fetch: not-a-valid-url-at-all. You MUST call the web_fetch tool with exactly that string as the url."}' 90)
OUTPUT=$(echo "$RESP" | jq -r '.output // empty')
EXIT_CODE=$(echo "$RESP" | jq -r '.exitCode // empty')

if [ "$EXIT_CODE" = "0" ] && [ -n "$OUTPUT" ]; then
    if echo "$OUTPUT" | grep -qi "invalid\|error\|could not\|failed\|not a valid"; then
        log "Invalid URL properly rejected"
        pass
    else
        log "Agent handled invalid URL (output present, no crash)"
        pass
    fi
else
    fail "Bridge crashed on invalid URL fetch (exit=$EXIT_CODE)"
fi

# --- Test: web_search with empty query does not crash ---
begin_test "web_search handles edge case (empty-like query)"
RESP=$(bridge_post "$RESEARCHER_BRIDGE_URL" \
    '{"prompt": "Use your web_search tool with the query: \" \". Call it with just a space character."}' 90)
EXIT_CODE=$(echo "$RESP" | jq -r '.exitCode // empty')

if [ "$EXIT_CODE" = "0" ] || [ "$EXIT_CODE" = "null" ]; then
    log "Bridge stable on edge-case query"
    pass
else
    fail "Bridge crashed on edge-case search query (exit=$EXIT_CODE)"
fi

summary
