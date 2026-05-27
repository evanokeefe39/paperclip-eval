#!/usr/bin/env bash
# E2E-13: Real Use Case — CEO Delegation Chain
#
# Tests the actual multi-agent workflow through Paperclip:
#   1. Create issue assigned to CEO with research brief
#   2. CEO wakes, reads brief, delegates to Researcher via child issues
#   3. Researcher wakes, executes research, writes artifacts
#   4. Verify: delegation happened, research produced, content covers required topics
#
# This is the "faceless tech channels" use case — the real workflow this system exists for.
# Requires running stack: docker compose up

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

# --- Config ---
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-paperclip-eval}"
CEO_URL="${CEO_BRIDGE_URL:-http://localhost:8081}"
RESEARCHER_URL="${RESEARCHER_BRIDGE_URL:-http://localhost:8082}"
RUN_ID="delegation-$(date +%Y%m%d-%H%M%S)"
ARTIFACTS_DIR="/artifacts/$RUN_ID"
RESULTS_DIR="$SCRIPT_DIR/../results/$RUN_ID"
TIMEOUT=600
POLL_INTERVAL=10
MAX_WAIT=300

echo ""
echo "══════════════════════════════════════════════════════════════════"
echo "[E2E-13] CEO Delegation Chain — Faceless Tech Channel Research"
echo "  Run ID:  $RUN_ID"
echo "  Results: $RESULTS_DIR"
echo "══════════════════════════════════════════════════════════════════"
echo ""

mkdir -p "$RESULTS_DIR"

# --- Container name helper ---
ctr_name() { echo "${COMPOSE_PROJECT}-${1}-1"; }

# --- Preflight ---
echo "Checking prerequisites..."

require_stack

COMPANY_ID=$(find_company_id)
CEO_ID=$(find_agent_id "$COMPANY_ID" "CEO")
RES_ID=$(find_agent_id "$COMPANY_ID" "Researcher")

if [ -z "$CEO_ID" ]; then echo "[FATAL] CEO not registered."; exit 1; fi
if [ -z "$RES_ID" ]; then echo "[FATAL] Researcher not registered."; exit 1; fi

echo "  Company:    $COMPANY_ID"
echo "  CEO:        $CEO_ID"
echo "  Researcher: $RES_ID"
echo ""

# Create artifacts dir in containers
for svc in ceo researcher; do
    docker exec "$(ctr_name "$svc")" sh -c "mkdir -p $ARTIFACTS_DIR" 2>/dev/null || true
done

# ─────────────────────────────────────────────────────────────────────
# STEP 1: Create research brief as Paperclip issue assigned to CEO
# ─────────────────────────────────────────────────────────────────────

RESEARCH_BRIEF="Research faceless (no-face) social media channels in the tech niche. Focus on channels that post content about these subtopics:

- AI / machine learning / LLMs
- Cybersecurity / hacking / infosec
- Investing / business / entrepreneurship in tech
- Mindset / productivity for tech professionals
- Lifestyle in tech / day-in-the-life / remote work
- Job opportunities / career advice / tech hiring

Platforms to cover: Instagram and TikTok.

Deliverables:
1. Delegate Instagram channel research to Researcher agent
2. Delegate TikTok channel research to Researcher agent
3. Each delegation should ask for: channel handle, follower count, primary subtopic, content format, posting frequency
4. Researcher should write findings to /artifacts/$RUN_ID/ as structured markdown

Do NOT do the research yourself. Create child issues assigned to Researcher for each platform. Set status to todo so Researcher picks them up."

begin_test "Create research issue assigned to CEO"
ISSUE_BODY=$(jq -n \
    --arg title "Research: Faceless Tech Channels (IG + TikTok)" \
    --arg desc "$RESEARCH_BRIEF" \
    --arg agent "$CEO_ID" \
    '{title: $title, description: $desc, status: "todo", priority: "high", assigneeAgentId: $agent}')

ISSUE_RESP=$(api_post "/api/companies/$COMPANY_ID/issues" "$ISSUE_BODY")
ISSUE_ID=$(echo "$ISSUE_RESP" | jq -r '.id // empty')
ISSUE_KEY=$(echo "$ISSUE_RESP" | jq -r '.identifier // empty')

if assert_not_empty "$ISSUE_ID" "issue ID"; then
    log "Created: $ISSUE_KEY ($ISSUE_ID)"
    pass
fi

echo ""

# ─────────────────────────────────────────────────────────────────────
# STEP 2: Wake CEO via Paperclip dispatch
# ─────────────────────────────────────────────────────────────────────

begin_test "Invoke CEO via Paperclip heartbeat"
CEO_PRE_METRICS=$(curl -sf "$CEO_URL/metrics" | jq -r '.requests_total // 0')
api_post "/api/agents/$CEO_ID/heartbeat/invoke" 2>/dev/null || true

# Wait for CEO to finish processing
DEADLINE=$((SECONDS + MAX_WAIT))
CEO_DONE=false
while [ "$SECONDS" -lt "$DEADLINE" ]; do
    sleep "$POLL_INTERVAL"
    CEO_POST_METRICS=$(curl -sf "$CEO_URL/metrics" | jq -r '.requests_total // 0')
    CEO_ACTIVE=$(curl -sf "$CEO_URL/metrics" | jq -r '.requests_active // 0')
    if [ "$CEO_POST_METRICS" -gt "$CEO_PRE_METRICS" ] && [ "$CEO_ACTIVE" -eq 0 ]; then
        CEO_DONE=true
        break
    fi
done

if $CEO_DONE; then
    log "CEO processed the dispatch"
    pass
else
    fail "CEO did not complete within ${MAX_WAIT}s"
fi

echo ""

# ─────────────────────────────────────────────────────────────────────
# STEP 3: Verify CEO delegated (created child issues for Researcher)
# ─────────────────────────────────────────────────────────────────────

begin_test "CEO created child issues assigned to Researcher"
sleep 3

# Get all issues, find children of our parent issue
ALL_ISSUES=$(api_get "/api/companies/$COMPANY_ID/issues?limit=50")
CHILD_ISSUES=$(echo "$ALL_ISSUES" | jq --arg pid "$ISSUE_ID" --arg rid "$RES_ID" \
    '[.[] | select(.parentId == $pid and .assigneeAgentId == $rid)]')
CHILD_COUNT=$(echo "$CHILD_ISSUES" | jq 'length')

if [ "$CHILD_COUNT" -gt 0 ]; then
    log "Found $CHILD_COUNT child issues assigned to Researcher"
    echo "$CHILD_ISSUES" | jq -r '.[] | "    \(.identifier): \(.title) [status=\(.status)]"'
    pass
else
    # Check if CEO created ANY child issues (maybe assigned to wrong agent)
    ANY_CHILDREN=$(echo "$ALL_ISSUES" | jq --arg pid "$ISSUE_ID" '[.[] | select(.parentId == $pid)]')
    ANY_COUNT=$(echo "$ANY_CHILDREN" | jq 'length')
    if [ "$ANY_COUNT" -gt 0 ]; then
        fail "CEO created $ANY_COUNT child issues but none assigned to Researcher"
        echo "$ANY_CHILDREN" | jq -r '.[] | "    \(.identifier): \(.title) [assignee=\(.assigneeAgentId)]"'
    else
        fail "CEO did not create any child issues — likely did work itself instead of delegating"
    fi
fi

begin_test "Child issues have status todo (visible to Researcher inbox)"
TODO_CHILDREN=$(echo "$CHILD_ISSUES" | jq '[.[] | select(.status == "todo")]')
TODO_COUNT=$(echo "$TODO_CHILDREN" | jq 'length')
if [ "$TODO_COUNT" -eq "$CHILD_COUNT" ] && [ "$CHILD_COUNT" -gt 0 ]; then
    pass
elif [ "$CHILD_COUNT" -eq 0 ]; then
    skip "no child issues to check"
else
    NON_TODO=$(echo "$CHILD_ISSUES" | jq -r '.[] | select(.status != "todo") | "\(.identifier): status=\(.status)"')
    fail "some child issues not in todo status: $NON_TODO"
fi

echo ""

# ─────────────────────────────────────────────────────────────────────
# STEP 4: Wake Researcher to process delegated work
# ─────────────────────────────────────────────────────────────────────

if [ "$CHILD_COUNT" -gt 0 ]; then
    begin_test "Invoke Researcher to process delegated issues"
    RES_PRE=$(curl -sf "$RESEARCHER_URL/metrics" | jq -r '.requests_total // 0')
    api_post "/api/agents/$RES_ID/heartbeat/invoke" 2>/dev/null || true

    DEADLINE=$((SECONDS + MAX_WAIT))
    RES_DONE=false
    while [ "$SECONDS" -lt "$DEADLINE" ]; do
        sleep "$POLL_INTERVAL"
        RES_POST=$(curl -sf "$RESEARCHER_URL/metrics" | jq -r '.requests_total // 0')
        RES_ACTIVE=$(curl -sf "$RESEARCHER_URL/metrics" | jq -r '.requests_active // 0')
        if [ "$RES_POST" -gt "$RES_PRE" ] && [ "$RES_ACTIVE" -eq 0 ]; then
            RES_DONE=true
            break
        fi
    done

    if $RES_DONE; then
        log "Researcher completed processing"
        pass
    else
        fail "Researcher did not complete within ${MAX_WAIT}s"
    fi
else
    begin_test "Invoke Researcher to process delegated issues"
    skip "no child issues were created"
fi

echo ""

# ─────────────────────────────────────────────────────────────────────
# STEP 5: Check research artifacts
# ─────────────────────────────────────────────────────────────────────

begin_test "Researcher produced artifact files"
# Copy artifacts from researcher container
RES_CTR="$(ctr_name researcher)"
docker cp "$RES_CTR:$ARTIFACTS_DIR/." "$RESULTS_DIR/" 2>/dev/null || true
# Also check CEO container (artifacts volume is shared)
CEO_CTR="$(ctr_name ceo)"
docker cp "$CEO_CTR:$ARTIFACTS_DIR/." "$RESULTS_DIR/" 2>/dev/null || true

ARTIFACT_COUNT=$(ls -1 "$RESULTS_DIR"/*.md 2>/dev/null | wc -l)
if [ "$ARTIFACT_COUNT" -gt 0 ]; then
    log "Found $ARTIFACT_COUNT artifact files:"
    ls -la "$RESULTS_DIR"/*.md 2>/dev/null | while read -r line; do echo "    $line"; done
    pass
else
    fail "no .md artifacts found in $ARTIFACTS_DIR"
fi

echo ""

# ─────────────────────────────────────────────────────────────────────
# STEP 6: Validate research content quality
# ─────────────────────────────────────────────────────────────────────

# Concatenate all artifacts for content checking
ALL_CONTENT=""
for f in "$RESULTS_DIR"/*.md; do
    [ -f "$f" ] && ALL_CONTENT="$ALL_CONTENT$(cat "$f")"
done

if [ -z "$ALL_CONTENT" ]; then
    begin_test "Research covers required subtopics"
    skip "no content to validate"
else
    begin_test "Research mentions Instagram channels"
    if echo "$ALL_CONTENT" | grep -qi "instagram\|IG\|insta"; then
        pass
    else
        fail "no Instagram coverage found"
    fi

    begin_test "Research mentions TikTok channels"
    if echo "$ALL_CONTENT" | grep -qi "tiktok\|tik tok"; then
        pass
    else
        fail "no TikTok coverage found"
    fi

    begin_test "Research covers AI/ML subtopic"
    if echo "$ALL_CONTENT" | grep -qi "artificial intelligence\|machine learning\|AI\|LLM\|GPT\|deep learning"; then
        pass
    else
        fail "AI/ML subtopic not covered"
    fi

    begin_test "Research covers cybersecurity subtopic"
    if echo "$ALL_CONTENT" | grep -qi "cyber\|security\|hacking\|infosec\|pentest"; then
        pass
    else
        fail "cybersecurity subtopic not covered"
    fi

    begin_test "Research includes channel handles"
    # Look for @ handles or handle-like patterns
    HANDLE_COUNT=$(echo "$ALL_CONTENT" | grep -oiE "@[a-z0-9_.]{2,30}" | wc -l)
    if [ "$HANDLE_COUNT" -ge 3 ]; then
        log "Found $HANDLE_COUNT channel handles"
        pass
    else
        fail "only $HANDLE_COUNT handles found (expected 3+)"
    fi

    begin_test "Research includes follower counts"
    FOLLOWER_REFS=$(echo "$ALL_CONTENT" | grep -oiE "[0-9]+[kKmM]?\s*(follower|subscriber|fan)" | wc -l)
    if [ "$FOLLOWER_REFS" -ge 2 ]; then
        log "Found $FOLLOWER_REFS follower references"
        pass
    else
        fail "only $FOLLOWER_REFS follower counts found (expected 2+)"
    fi

    begin_test "Research is substantive (500+ words)"
    WORD_COUNT=$(echo "$ALL_CONTENT" | wc -w)
    if [ "$WORD_COUNT" -ge 500 ]; then
        log "$WORD_COUNT words total"
        pass
    else
        fail "only $WORD_COUNT words (expected 500+)"
    fi
fi

echo ""

# ─────────────────────────────────────────────────────────────────────
# STEP 7: Verify issue status updated in Paperclip
# ─────────────────────────────────────────────────────────────────────

begin_test "Parent issue status updated by CEO"
PARENT_STATUS=$(api_get "/api/companies/$COMPANY_ID/issues/$ISSUE_ID" 2>/dev/null | jq -r '.status // empty')
if [ -n "$PARENT_STATUS" ] && [ "$PARENT_STATUS" != "todo" ]; then
    log "Parent issue status: $PARENT_STATUS"
    pass
else
    log "Parent issue still in todo — CEO may not have updated status"
    fail "expected status change from todo, got: ${PARENT_STATUS:-empty}"
fi

# ─────────────────────────────────────────────────────────────────────
# RESULTS
# ─────────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════════"
echo "Artifacts: $RESULTS_DIR"
ls -la "$RESULTS_DIR/" 2>/dev/null || true
echo ""
echo "Paperclip issues:"
echo "  Parent: $ISSUE_KEY ($ISSUE_ID)"
if [ "$CHILD_COUNT" -gt 0 ]; then
    echo "$CHILD_ISSUES" | jq -r '.[] | "  Child:  \(.identifier) — \(.title) [\(.status)]"'
fi
echo "══════════════════════════════════════════════════════════════════"

summary
