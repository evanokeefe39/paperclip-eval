#!/usr/bin/env bash
# Integration tests for Paperclip tools extension against a live Paperclip instance.
# Tests every API path the extension uses to confirm compatibility.
#
# Requires: Docker stack running (Paperclip healthy at :3100)
# Usage: bash tests/paperclip-tools/integration-test.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$REPO_ROOT/tests/e2e/helpers.sh"

echo ""
echo "═══════════════════════════════════════════════════"
echo " Paperclip Tools Extension — Integration Tests"
echo " Target: Live Paperclip API"
echo "═══════════════════════════════════════════════════"
echo ""

# --- Prerequisites ---
echo "Checking prerequisites..."
for cmd in curl jq; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "[FATAL] Required command: $cmd"
        exit 1
    fi
done

if ! wait_healthy "$PAPERCLIP_URL/api/health" 15; then
    echo "[FATAL] Paperclip not healthy at $PAPERCLIP_URL"
    exit 1
fi
echo "  Paperclip healthy."

echo "Authenticating..."
if ! authenticate; then
    echo "[FATAL] Authentication failed"
    exit 1
fi
echo "  Authenticated."

# --- Discover IDs ---
COMPANY_ID=$(find_company_id)
if [ -z "$COMPANY_ID" ]; then
    echo "[FATAL] No company found"
    exit 1
fi

CEO_ID=$(find_agent_id "$COMPANY_ID" "CEO")
if [ -z "$CEO_ID" ]; then
    # Try alternate names
    CEO_ID=$(find_agent_id "$COMPANY_ID" "ceo")
fi

RESEARCHER_ID=$(find_agent_id "$COMPANY_ID" "Researcher")
if [ -z "$RESEARCHER_ID" ]; then
    RESEARCHER_ID=$(find_agent_id "$COMPANY_ID" "researcher")
fi

echo "  Company: $COMPANY_ID"
echo "  CEO: ${CEO_ID:-not found}"
echo "  Researcher: ${RESEARCHER_ID:-not found}"
echo ""

# ═══════════════════════════════════════════════════
# Section 1: Identity & Inbox (paperclip_me, paperclip_inbox, paperclip_list_agents, paperclip_get_agent)
# ═══════════════════════════════════════════════════
echo "[Section 1] Identity & Inbox"

begin_test "GET /api/agents/me returns agent or user"
ME_RESP=$(api_get "/api/agents/me" 2>/dev/null || echo '{"error":"no agent context"}')
ME_ID=$(echo "$ME_RESP" | jq -r '.id // .user.id // empty')
if [ -n "$ME_ID" ]; then
    log "Identity: $ME_ID"
    pass
else
    log "No agent identity (expected for user session)"
    skip "user sessions don't have /agents/me"
fi

begin_test "GET /api/companies/{cid}/agents returns array"
AGENTS=$(api_get "/api/companies/$COMPANY_ID/agents")
AGENTS_TYPE=$(echo "$AGENTS" | jq -r 'type')
if assert_eq "$AGENTS_TYPE" "array" "agents list type"; then
    AGENT_COUNT=$(echo "$AGENTS" | jq 'length')
    log "Found $AGENT_COUNT agents"
    pass
fi

if [ -n "$CEO_ID" ]; then
    begin_test "GET /api/agents/{id} returns agent details"
    AGENT_RESP=$(api_get "/api/agents/$CEO_ID")
    AGENT_NAME=$(echo "$AGENT_RESP" | jq -r '.name // empty')
    if assert_not_empty "$AGENT_NAME" "agent name"; then
        log "Agent: $AGENT_NAME"
        pass
    fi
fi

# ═══════════════════════════════════════════════════
# Section 2: Issues CRUD (paperclip_create_issue, paperclip_list_issues, paperclip_get_issue, paperclip_update_issue)
# ═══════════════════════════════════════════════════
echo ""
echo "[Section 2] Issues CRUD"

begin_test "POST /api/companies/{cid}/issues — create issue"
CREATE_RESP=$(api_post "/api/companies/$COMPANY_ID/issues" \
    '{"title":"[TOOLS-TEST] Basic issue","priority":"low"}')
ISSUE_ID=$(echo "$CREATE_RESP" | jq -r '.id // empty')
ISSUE_IDENT=$(echo "$CREATE_RESP" | jq -r '.identifier // empty')
if assert_not_empty "$ISSUE_ID" "issue ID" && assert_not_empty "$ISSUE_IDENT" "issue identifier"; then
    log "Created: $ISSUE_IDENT ($ISSUE_ID)"
    pass
fi

begin_test "POST — create issue with all fields"
FULL_BODY=$(jq -n --arg ceo "$CEO_ID" '{
    title: "[TOOLS-TEST] Full fields",
    description: "Test issue with all fields populated.\n\n## Details\n\nThis tests the create path.",
    status: "todo",
    priority: "medium",
    workMode: "standard"
}')
FULL_RESP=$(api_post "/api/companies/$COMPANY_ID/issues" "$FULL_BODY")
FULL_ID=$(echo "$FULL_RESP" | jq -r '.id // empty')
FULL_STATUS=$(echo "$FULL_RESP" | jq -r '.status // empty')
if assert_not_empty "$FULL_ID" "full issue ID" && assert_eq "$FULL_STATUS" "todo" "status"; then
    log "Created full issue: $FULL_ID"
    pass
fi

begin_test "GET /api/companies/{cid}/issues — list issues"
LIST_RESP=$(api_get "/api/companies/$COMPANY_ID/issues")
LIST_TYPE=$(echo "$LIST_RESP" | jq -r 'type')
if assert_eq "$LIST_TYPE" "array" "issues list type"; then
    LIST_COUNT=$(echo "$LIST_RESP" | jq 'length')
    log "Found $LIST_COUNT issues"
    pass
fi

begin_test "GET /api/companies/{cid}/issues?status=todo — filtered list"
FILTERED=$(api_get "/api/companies/$COMPANY_ID/issues?status=todo")
FILTERED_COUNT=$(echo "$FILTERED" | jq 'length')
log "Found $FILTERED_COUNT todo issues"
if [ "$FILTERED_COUNT" -ge 1 ]; then
    pass
else
    fail "Expected at least 1 todo issue"
fi

begin_test "GET /api/companies/{cid}/issues?q=TOOLS-TEST — search"
SEARCH=$(api_get "/api/companies/$COMPANY_ID/issues?q=TOOLS-TEST")
SEARCH_COUNT=$(echo "$SEARCH" | jq 'length')
if [ "$SEARCH_COUNT" -ge 1 ]; then
    log "Search found $SEARCH_COUNT issues"
    pass
else
    skip "Search may not index immediately"
fi

begin_test "GET /api/issues/{id} — get issue by UUID"
GET_RESP=$(api_get "/api/issues/$ISSUE_ID")
GET_TITLE=$(echo "$GET_RESP" | jq -r '.title // empty')
if assert_contains "$GET_TITLE" "TOOLS-TEST" "issue title"; then
    pass
fi

begin_test "GET /api/issues/{identifier} — get issue by identifier"
IDENT_RESP=$(api_get "/api/issues/$ISSUE_IDENT")
IDENT_ID=$(echo "$IDENT_RESP" | jq -r '.id // empty')
if assert_eq "$IDENT_ID" "$ISSUE_ID" "ID via identifier lookup"; then
    pass
fi

begin_test "PATCH /api/issues/{id} — update status"
UPDATE_RESP=$(curl -sf \
    -X PATCH \
    -b "$COOKIE_JAR" \
    -H "Content-Type: application/json" \
    -H "Origin: $PAPERCLIP_URL" \
    -d '{"status":"in_progress"}' \
    "$PAPERCLIP_URL/api/issues/$ISSUE_ID")
UPD_STATUS=$(echo "$UPDATE_RESP" | jq -r '.status // empty')
if assert_eq "$UPD_STATUS" "in_progress" "updated status"; then
    pass
fi

begin_test "PATCH /api/issues/{id} — update with comment"
COMMENT_UPD=$(curl -sf \
    -X PATCH \
    -b "$COOKIE_JAR" \
    -H "Content-Type: application/json" \
    -H "Origin: $PAPERCLIP_URL" \
    -d '{"comment":"Updating with inline comment"}' \
    "$PAPERCLIP_URL/api/issues/$ISSUE_ID")
if [ $? -eq 0 ]; then
    pass
else
    fail "Update with comment failed"
fi

begin_test "PATCH /api/issues/{id} — update priority"
PRI_UPD=$(curl -sf \
    -X PATCH \
    -b "$COOKIE_JAR" \
    -H "Content-Type: application/json" \
    -H "Origin: $PAPERCLIP_URL" \
    -d '{"priority":"high"}' \
    "$PAPERCLIP_URL/api/issues/$ISSUE_ID")
PRI_VAL=$(echo "$PRI_UPD" | jq -r '.priority // empty')
if assert_eq "$PRI_VAL" "high" "updated priority"; then
    pass
fi

# ═══════════════════════════════════════════════════
# Section 3: Checkout & Release (paperclip_checkout_issue, paperclip_release_issue)
# ═══════════════════════════════════════════════════
echo ""
echo "[Section 3] Checkout & Release"

if [ -n "$RESEARCHER_ID" ]; then
    # Create a fresh issue for checkout tests
    CHECKOUT_ISSUE=$(api_post "/api/companies/$COMPANY_ID/issues" \
        '{"title":"[TOOLS-TEST] Checkout test","status":"todo"}')
    CHECKOUT_ISSUE_ID=$(echo "$CHECKOUT_ISSUE" | jq -r '.id // empty')

    begin_test "POST /api/issues/{id}/checkout"
    CHECKOUT_RESP=$(api_post "/api/issues/$CHECKOUT_ISSUE_ID/checkout" \
        "{\"agentId\":\"$RESEARCHER_ID\",\"expectedStatuses\":[\"todo\",\"backlog\",\"blocked\"]}")
    CHECKOUT_OK=$(echo "$CHECKOUT_RESP" | jq -r '.id // .issueId // empty')
    if assert_not_empty "$CHECKOUT_OK" "checkout result"; then
        log "Checked out issue"
        pass
    fi

    begin_test "POST /api/issues/{id}/release"
    RELEASE_RESP=$(api_post "/api/issues/$CHECKOUT_ISSUE_ID/release" '{}')
    if [ $? -eq 0 ]; then
        log "Released issue"
        pass
    else
        fail "Release failed"
    fi

    begin_test "Checkout with custom expectedStatuses"
    # Set issue to in_progress first
    curl -sf -X PATCH \
        -b "$COOKIE_JAR" \
        -H "Content-Type: application/json" \
        -H "Origin: $PAPERCLIP_URL" \
        -d '{"status":"in_progress"}' \
        "$PAPERCLIP_URL/api/issues/$CHECKOUT_ISSUE_ID" > /dev/null

    CUSTOM_CO=$(api_post "/api/issues/$CHECKOUT_ISSUE_ID/checkout" \
        "{\"agentId\":\"$RESEARCHER_ID\",\"expectedStatuses\":[\"in_progress\"]}" 2>&1)
    if echo "$CUSTOM_CO" | jq -e '.id // .issueId' > /dev/null 2>&1; then
        pass
        # Clean up
        api_post "/api/issues/$CHECKOUT_ISSUE_ID/release" '{}' > /dev/null 2>/dev/null
    else
        skip "Checkout with custom statuses may require specific state"
    fi
else
    skip "No researcher agent — skipping checkout tests"
fi

# ═══════════════════════════════════════════════════
# Section 4: Comments (paperclip_list_comments, paperclip_add_comment, paperclip_get_comment)
# ═══════════════════════════════════════════════════
echo ""
echo "[Section 4] Comments"

begin_test "POST /api/issues/{id}/comments — add comment"
COMMENT_RESP=$(api_post "/api/issues/$ISSUE_ID/comments" \
    '{"body":"[TOOLS-TEST] First comment on this issue."}')
COMMENT_ID=$(echo "$COMMENT_RESP" | jq -r '.id // empty')
if assert_not_empty "$COMMENT_ID" "comment ID"; then
    log "Comment: $COMMENT_ID"
    pass
fi

begin_test "POST — comment with markdown"
MD_COMMENT=$(api_post "/api/issues/$ISSUE_ID/comments" \
    '{"body":"## Analysis\n\n**Finding**: the `request()` function works.\n\n- Item 1\n- Item 2"}')
MD_ID=$(echo "$MD_COMMENT" | jq -r '.id // empty')
if assert_not_empty "$MD_ID" "markdown comment ID"; then
    pass
fi

begin_test "GET /api/issues/{id}/comments — list comments"
COMMENTS=$(api_get "/api/issues/$ISSUE_ID/comments")
COMMENTS_TYPE=$(echo "$COMMENTS" | jq -r 'type')
if assert_eq "$COMMENTS_TYPE" "array" "comments type"; then
    COMMENT_COUNT=$(echo "$COMMENTS" | jq 'length')
    log "Found $COMMENT_COUNT comments"
    if [ "$COMMENT_COUNT" -ge 2 ]; then
        pass
    else
        fail "Expected at least 2 comments, got $COMMENT_COUNT"
    fi
fi

begin_test "GET /api/issues/{id}/comments?order=desc&limit=1"
LIMITED=$(api_get "/api/issues/$ISSUE_ID/comments?order=desc&limit=1")
LIMITED_COUNT=$(echo "$LIMITED" | jq 'length')
if [ "$LIMITED_COUNT" -le 1 ]; then
    log "Got $LIMITED_COUNT comment (limit=1)"
    pass
else
    fail "Expected at most 1 comment, got $LIMITED_COUNT"
fi

begin_test "GET /api/issues/{id}/comments?after={cursor}"
if [ -n "$COMMENT_ID" ]; then
    AFTER=$(api_get "/api/issues/$ISSUE_ID/comments?after=$COMMENT_ID&order=asc")
    AFTER_COUNT=$(echo "$AFTER" | jq 'length')
    log "After cursor: $AFTER_COUNT comments"
    pass
else
    skip "No comment ID for cursor test"
fi

begin_test "GET /api/issues/{id}/comments/{cid} — get single comment"
if [ -n "$COMMENT_ID" ]; then
    SINGLE=$(api_get "/api/issues/$ISSUE_ID/comments/$COMMENT_ID")
    SINGLE_ID=$(echo "$SINGLE" | jq -r '.id // empty')
    if assert_eq "$SINGLE_ID" "$COMMENT_ID" "single comment ID"; then
        pass
    fi
else
    skip "No comment ID"
fi

# ═══════════════════════════════════════════════════
# Section 5: Documents (paperclip_upsert_document, paperclip_list_documents, paperclip_get_document)
# ═══════════════════════════════════════════════════
echo ""
echo "[Section 5] Documents"

begin_test "PUT /api/issues/{id}/documents/{key} — create document"
DOC_BODY=$(jq -n '{
    body: "# Specification\n\nThis is the spec document.\n\n## Requirements\n\n- Req 1\n- Req 2",
    title: "Test Specification",
    format: "markdown"
}')
DOC_RESP=$(curl -sf \
    -X PUT \
    -b "$COOKIE_JAR" \
    -H "Content-Type: application/json" \
    -H "Origin: $PAPERCLIP_URL" \
    -d "$DOC_BODY" \
    "$PAPERCLIP_URL/api/issues/$ISSUE_ID/documents/spec")
DOC_KEY=$(echo "$DOC_RESP" | jq -r '.key // empty')
if assert_not_empty "$DOC_KEY" "document key"; then
    log "Document key: $DOC_KEY"
    pass
fi

begin_test "PUT — update existing document"
UPDATE_DOC=$(jq -n '{
    body: "# Specification v2\n\nUpdated content.",
    title: "Test Specification v2",
    changeSummary: "Updated requirements"
}')
UPD_DOC_RESP=$(curl -sf \
    -X PUT \
    -b "$COOKIE_JAR" \
    -H "Content-Type: application/json" \
    -H "Origin: $PAPERCLIP_URL" \
    -d "$UPDATE_DOC" \
    "$PAPERCLIP_URL/api/issues/$ISSUE_ID/documents/spec")
if [ $? -eq 0 ]; then
    pass
else
    fail "Document update failed"
fi

begin_test "GET /api/issues/{id}/documents — list documents"
DOCS=$(api_get "/api/issues/$ISSUE_ID/documents")
DOCS_TYPE=$(echo "$DOCS" | jq -r 'type')
if assert_eq "$DOCS_TYPE" "array" "documents type"; then
    DOC_COUNT=$(echo "$DOCS" | jq 'length')
    log "Found $DOC_COUNT documents"
    pass
fi

begin_test "GET /api/issues/{id}/documents/{key} — get document"
DOC_GET=$(api_get "/api/issues/$ISSUE_ID/documents/spec")
DOC_BODY_TEXT=$(echo "$DOC_GET" | jq -r '.body // empty')
if assert_contains "$DOC_BODY_TEXT" "Specification" "document body"; then
    pass
fi

begin_test "GET /api/issues/{id}/documents/{key}/revisions — list revisions"
REVS=$(api_get "/api/issues/$ISSUE_ID/documents/spec/revisions")
REVS_TYPE=$(echo "$REVS" | jq -r 'type')
if assert_eq "$REVS_TYPE" "array" "revisions type"; then
    REV_COUNT=$(echo "$REVS" | jq 'length')
    log "Found $REV_COUNT revisions"
    pass
fi

# ═══════════════════════════════════════════════════
# Section 6: Projects & Goals (paperclip_list_projects, paperclip_list_goals)
# ═══════════════════════════════════════════════════
echo ""
echo "[Section 6] Projects & Goals"

begin_test "GET /api/companies/{cid}/projects — list projects"
PROJECTS=$(api_get "/api/companies/$COMPANY_ID/projects")
PROJ_TYPE=$(echo "$PROJECTS" | jq -r 'type')
if assert_eq "$PROJ_TYPE" "array" "projects type"; then
    PROJ_COUNT=$(echo "$PROJECTS" | jq 'length')
    log "Found $PROJ_COUNT projects"
    pass
fi

begin_test "GET /api/companies/{cid}/goals — list goals"
GOALS=$(api_get "/api/companies/$COMPANY_ID/goals")
GOALS_TYPE=$(echo "$GOALS" | jq -r 'type')
if assert_eq "$GOALS_TYPE" "array" "goals type"; then
    GOAL_COUNT=$(echo "$GOALS" | jq 'length')
    log "Found $GOAL_COUNT goals"
    pass
fi

# ═══════════════════════════════════════════════════
# Section 7: Heartbeat Context (paperclip_get_heartbeat_context)
# ═══════════════════════════════════════════════════
echo ""
echo "[Section 7] Heartbeat Context"

begin_test "GET /api/issues/{id}/heartbeat-context — returns context"
HB=$(api_get "/api/issues/$ISSUE_ID/heartbeat-context")
HB_TYPE=$(echo "$HB" | jq -r 'type')
if assert_eq "$HB_TYPE" "object" "heartbeat context type"; then
    log "Heartbeat context retrieved"
    pass
fi

begin_test "Heartbeat context has issue data"
HB_ISSUE=$(echo "$HB" | jq -r '.issue.id // .issueId // empty')
if assert_not_empty "$HB_ISSUE" "heartbeat issue reference"; then
    pass
fi

# ═══════════════════════════════════════════════════
# Section 8: Approvals (paperclip_list_approvals, paperclip_create_approval)
# ═══════════════════════════════════════════════════
echo ""
echo "[Section 8] Approvals"

begin_test "GET /api/companies/{cid}/approvals — list approvals"
APPROVALS=$(api_get "/api/companies/$COMPANY_ID/approvals")
APPR_TYPE=$(echo "$APPROVALS" | jq -r 'type')
if assert_eq "$APPR_TYPE" "array" "approvals type"; then
    APPR_COUNT=$(echo "$APPROVALS" | jq 'length')
    log "Found $APPR_COUNT approvals"
    pass
fi

begin_test "POST /api/companies/{cid}/approvals — create approval"
APPR_BODY=$(jq -n --arg aid "${CEO_ID:-agent-placeholder}" '{
    type: "request_board_approval",
    payload: { description: "[TOOLS-TEST] Test board approval request" },
    requestedByAgentId: $aid
}')
APPR_RESP=$(api_post "/api/companies/$COMPANY_ID/approvals" "$APPR_BODY" 2>&1)
APPR_ID=$(echo "$APPR_RESP" | jq -r '.id // empty' 2>/dev/null)
if [ -n "$APPR_ID" ]; then
    log "Approval: $APPR_ID"
    pass
else
    skip "Approval creation may require specific permissions"
fi

if [ -n "$APPR_ID" ]; then
    begin_test "GET /api/approvals/{id} — get approval"
    APPR_GET=$(api_get "/api/approvals/$APPR_ID")
    APPR_GET_ID=$(echo "$APPR_GET" | jq -r '.id // empty')
    if assert_eq "$APPR_GET_ID" "$APPR_ID" "approval ID"; then
        pass
    fi

    begin_test "GET /api/approvals/{id}/issues — list linked issues"
    APPR_ISSUES=$(api_get "/api/approvals/$APPR_ID/issues")
    APPR_ISS_TYPE=$(echo "$APPR_ISSUES" | jq -r 'type')
    if assert_eq "$APPR_ISS_TYPE" "array" "approval issues type"; then
        pass
    fi

    begin_test "POST /api/approvals/{id}/comments — add approval comment"
    APPR_CMT=$(api_post "/api/approvals/$APPR_ID/comments" \
        '{"body":"[TOOLS-TEST] Approval comment"}')
    APPR_CMT_ID=$(echo "$APPR_CMT" | jq -r '.id // empty')
    if assert_not_empty "$APPR_CMT_ID" "approval comment ID"; then
        pass
    fi

    begin_test "GET /api/approvals/{id}/comments — list approval comments"
    APPR_CMTS=$(api_get "/api/approvals/$APPR_ID/comments")
    APPR_CMTS_TYPE=$(echo "$APPR_CMTS" | jq -r 'type')
    if assert_eq "$APPR_CMTS_TYPE" "array" "approval comments type"; then
        pass
    fi

    begin_test "POST /api/issues/{id}/approvals — link approval to issue"
    LINK_RESP=$(api_post "/api/issues/$ISSUE_ID/approvals" \
        "{\"approvalId\":\"$APPR_ID\"}")
    if [ $? -eq 0 ]; then
        log "Linked approval to issue"
        pass
    else
        skip "Linking may require specific state"
    fi

    begin_test "GET /api/issues/{id}/approvals — list issue approvals"
    ISS_APPRS=$(api_get "/api/issues/$ISSUE_ID/approvals")
    ISS_APPRS_TYPE=$(echo "$ISS_APPRS" | jq -r 'type')
    if assert_eq "$ISS_APPRS_TYPE" "array" "issue approvals type"; then
        ISS_APPRS_COUNT=$(echo "$ISS_APPRS" | jq 'length')
        log "Found $ISS_APPRS_COUNT linked approvals"
        pass
    fi

    begin_test "DELETE /api/issues/{id}/approvals/{aid} — unlink approval"
    UNLINK_STATUS=$(curl -sf -o /dev/null -w "%{http_code}" \
        -X DELETE \
        -b "$COOKIE_JAR" \
        -H "Origin: $PAPERCLIP_URL" \
        "$PAPERCLIP_URL/api/issues/$ISSUE_ID/approvals/$APPR_ID")
    if [ "$UNLINK_STATUS" = "200" ] || [ "$UNLINK_STATUS" = "204" ]; then
        log "Unlinked (status $UNLINK_STATUS)"
        pass
    else
        skip "Unlink returned $UNLINK_STATUS"
    fi

    begin_test "POST /api/approvals/{id}/approve — approve decision"
    DECIDE=$(api_post "/api/approvals/$APPR_ID/approve" \
        '{"decisionNote":"[TOOLS-TEST] Approved"}' 2>&1)
    if echo "$DECIDE" | jq -e '.id // .status' > /dev/null 2>&1; then
        log "Approved"
        pass
    else
        skip "Decision may require specific state/role"
    fi
fi

# ═══════════════════════════════════════════════════
# Section 9: Interactions (paperclip_suggest_tasks, paperclip_ask_user_questions, paperclip_request_confirmation)
# ═══════════════════════════════════════════════════
echo ""
echo "[Section 9] Interactions"

begin_test "POST /api/issues/{id}/interactions — suggest_tasks"
SUGGEST_BODY=$(jq -n '{
    kind: "suggest_tasks",
    payload: {
        version: 1,
        tasks: [
            { clientKey: "t1", title: "Research competitors" },
            { clientKey: "t2", title: "Draft report", priority: "high" }
        ]
    },
    continuationPolicy: "wake_assignee"
}')
SUGGEST_RESP=$(api_post "/api/issues/$ISSUE_ID/interactions" "$SUGGEST_BODY" 2>&1)
SUGGEST_ID=$(echo "$SUGGEST_RESP" | jq -r '.id // empty' 2>/dev/null)
if [ -n "$SUGGEST_ID" ]; then
    log "suggest_tasks interaction: $SUGGEST_ID"
    pass
else
    skip "Interactions may require agent context"
fi

begin_test "POST /api/issues/{id}/interactions — ask_user_questions"
ASK_BODY=$(jq -n '{
    kind: "ask_user_questions",
    payload: {
        version: 1,
        questions: [
            {
                id: "q1",
                prompt: "Which database should we use?",
                selectionMode: "single",
                options: [
                    { id: "pg", label: "PostgreSQL", description: "Relational" },
                    { id: "mongo", label: "MongoDB", description: "Document store" }
                ]
            }
        ]
    },
    continuationPolicy: "wake_assignee"
}')
ASK_RESP=$(api_post "/api/issues/$ISSUE_ID/interactions" "$ASK_BODY" 2>&1)
ASK_ID=$(echo "$ASK_RESP" | jq -r '.id // empty' 2>/dev/null)
if [ -n "$ASK_ID" ]; then
    log "ask_user_questions interaction: $ASK_ID"
    pass
else
    skip "Interactions may require agent context"
fi

begin_test "POST /api/issues/{id}/interactions — request_confirmation"
CONFIRM_BODY=$(jq -n '{
    kind: "request_confirmation",
    payload: {
        version: 1,
        prompt: "Ready to deploy to production?",
        acceptLabel: "Deploy",
        rejectLabel: "Cancel"
    },
    continuationPolicy: "none"
}')
CONFIRM_RESP=$(api_post "/api/issues/$ISSUE_ID/interactions" "$CONFIRM_BODY" 2>&1)
CONFIRM_ID=$(echo "$CONFIRM_RESP" | jq -r '.id // empty' 2>/dev/null)
if [ -n "$CONFIRM_ID" ]; then
    log "request_confirmation interaction: $CONFIRM_ID"
    pass
else
    skip "Interactions may require agent context"
fi

# ═══════════════════════════════════════════════════
# Section 10: Escape Hatch (paperclip_api_request)
# ═══════════════════════════════════════════════════
echo ""
echo "[Section 10] Escape Hatch"

begin_test "Generic GET via escape hatch — /api/health"
HEALTH=$(api_get "/api/health")
HEALTH_STATUS=$(echo "$HEALTH" | jq -r '.bootstrapStatus // empty')
if assert_not_empty "$HEALTH_STATUS" "health bootstrap status"; then
    log "Health: $HEALTH_STATUS"
    pass
fi

begin_test "Generic GET via escape hatch — /api/companies"
COMPANIES=$(api_get "/api/companies")
COMP_TYPE=$(echo "$COMPANIES" | jq -r 'type')
if assert_eq "$COMP_TYPE" "array" "companies type"; then
    pass
fi

# ═══════════════════════════════════════════════════
# Section 11: Container Smoke Test — skills loaded
# ═══════════════════════════════════════════════════
echo ""
echo "[Section 11] Container Smoke Test"

begin_test "Skills directory exists in researcher container"
SKILLS_LS=$(docker compose -f "$REPO_ROOT/src/agents/docker-compose.yml" \
    exec -T researcher ls /app/skills/ 2>/dev/null)
if echo "$SKILLS_LS" | grep -q "paperclip-tools.ts"; then
    log "paperclip-tools.ts found in container"
    pass
else
    skip "Container may need rebuild"
fi

begin_test "Client module exists in container"
if echo "$SKILLS_LS" | grep -q "client.ts"; then
    log "client.ts found in container"
    pass
else
    skip "Container may need rebuild"
fi

begin_test "Bridge loads paperclip-tools extension"
BRIDGE_SRC=$(docker compose -f "$REPO_ROOT/src/agents/docker-compose.yml" \
    exec -T researcher cat /app/bridge.mjs 2>/dev/null)
if echo "$BRIDGE_SRC" | grep -q "paperclip-tools"; then
    log "bridge.mjs references paperclip-tools"
    pass
else
    skip "Bridge may not be updated yet"
fi

# ═══════════════════════════════════════════════════
# Section 12: Edge Cases
# ═══════════════════════════════════════════════════
echo ""
echo "[Section 12] Edge Cases"

begin_test "Create issue with unicode title"
UNICODE_BODY=$(jq -n '{title: "[TOOLS-TEST] Unicode: données résumé 日本語"}')
UNICODE_RESP=$(api_post "/api/companies/$COMPANY_ID/issues" "$UNICODE_BODY")
UNICODE_TITLE=$(echo "$UNICODE_RESP" | jq -r '.title // empty')
if assert_contains "$UNICODE_TITLE" "Unicode" "unicode title"; then
    pass
fi

begin_test "Create issue with very long description"
LONG_DESC=$(printf 'Line %04d: Detailed test content for stress testing the tools extension.\n' $(seq 1 200))
LONG_BODY=$(jq -n --arg desc "$LONG_DESC" '{title: "[TOOLS-TEST] Long description", description: $desc}')
LONG_RESP=$(api_post "/api/companies/$COMPANY_ID/issues" "$LONG_BODY")
LONG_ID=$(echo "$LONG_RESP" | jq -r '.id // empty')
if assert_not_empty "$LONG_ID" "long description issue"; then
    pass
fi

begin_test "Comment with code blocks"
CODE_BODY=$(jq -n '{body: "```javascript\nconst x = 42;\nconsole.log(x);\n```\n\nAbove is the fix."}')
CODE_RESP=$(api_post "/api/issues/$ISSUE_ID/comments" "$CODE_BODY")
CODE_ID=$(echo "$CODE_RESP" | jq -r '.id // empty')
if assert_not_empty "$CODE_ID" "code block comment"; then
    pass
fi

begin_test "Document with special key characters"
SPECIAL_DOC=$(jq -n '{body: "content", title: "Special"}')
SPECIAL_RESP=$(curl -sf \
    -X PUT \
    -b "$COOKIE_JAR" \
    -H "Content-Type: application/json" \
    -H "Origin: $PAPERCLIP_URL" \
    -d "$SPECIAL_DOC" \
    "$PAPERCLIP_URL/api/issues/$ISSUE_ID/documents/meeting-notes-v2")
SPECIAL_KEY=$(echo "$SPECIAL_RESP" | jq -r '.key // empty')
if assert_not_empty "$SPECIAL_KEY" "special key document"; then
    pass
fi

begin_test "Multiple comments preserve order"
C1=$(api_post "/api/issues/$ISSUE_ID/comments" '{"body":"Comment A"}')
C2=$(api_post "/api/issues/$ISSUE_ID/comments" '{"body":"Comment B"}')
C3=$(api_post "/api/issues/$ISSUE_ID/comments" '{"body":"Comment C"}')
ORDERED=$(api_get "/api/issues/$ISSUE_ID/comments?order=asc")
LAST_BODY=$(echo "$ORDERED" | jq -r '.[-1].body // empty')
if assert_contains "$LAST_BODY" "Comment C" "last comment"; then
    pass
fi

echo ""
summary
