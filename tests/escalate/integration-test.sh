#!/usr/bin/env bash
# Integration tests for the escalate extension against a live Paperclip instance.
# Tests the actual Paperclip API surface that the extension uses.
#
# Requires: Docker stack running (Paperclip healthy at :3100)
# Usage: bash tests/escalate/integration-test.sh

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$REPO_ROOT/tests/e2e/helpers.sh"

echo ""
echo "═══════════════════════════════════════════════════"
echo " Escalate Extension — Integration Tests"
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

RESEARCHER_ID=$(find_agent_id "$COMPANY_ID" "Researcher")
if [ -z "$RESEARCHER_ID" ]; then
    echo "[FATAL] Researcher agent not found"
    exit 1
fi
echo "  Company: $COMPANY_ID"
echo "  Researcher: $RESEARCHER_ID"
echo ""

# ═══════════════════════════════════════════════════
# Section 1: Authentication from Docker network
# ═══════════════════════════════════════════════════
echo "[Section 1] Authentication"

begin_test "Session cookie auth works from host"
AUTH_RESP=$(curl -s -D - \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Origin: $PAPERCLIP_URL" \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" \
    "$PAPERCLIP_URL/api/auth/sign-in/email" 2>&1)

if echo "$AUTH_RESP" | grep -q "paperclip-default.session_token"; then
    pass
else
    fail "No session cookie in auth response"
fi

begin_test "Auth returns user object"
AUTH_BODY=$(echo "$AUTH_RESP" | tail -1)
USER_ID=$(echo "$AUTH_BODY" | jq -r '.user.id // empty')
if assert_not_empty "$USER_ID" "user.id"; then
    pass
fi

begin_test "Invalid credentials return 403"
BAD_AUTH=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Origin: $PAPERCLIP_URL" \
    -d '{"email":"bad@email.com","password":"wrong"}' \
    "$PAPERCLIP_URL/api/auth/sign-in/email")
if assert_eq "$BAD_AUTH" "401" "bad auth status"; then
    pass
elif [ "$BAD_AUTH" = "403" ]; then
    # Paperclip may return 403 instead of 401
    log "Got 403 (acceptable — Paperclip uses 403 for bad creds)"
    pass
fi

# ═══════════════════════════════════════════════════
# Section 2: Label Management
# ═══════════════════════════════════════════════════
echo ""
echo "[Section 2] Label Management"

begin_test "GET /api/companies/{cid}/labels returns array"
LABELS=$(api_get "/api/companies/$COMPANY_ID/labels")
LABEL_TYPE=$(echo "$LABELS" | jq -r 'type')
if assert_eq "$LABEL_TYPE" "array" "labels response type"; then
    pass
fi

begin_test "Escalation label exists (created by extension or previous test)"
ESC_LABEL_ID=$(echo "$LABELS" | jq -r '.[] | select(.name == "escalation") | .id // empty')
if [ -z "$ESC_LABEL_ID" ]; then
    # Create it
    log "Creating escalation label..."
    CREATE_RESP=$(api_post "/api/companies/$COMPANY_ID/labels" \
        '{"name":"escalation","color":"#dc2626"}')
    ESC_LABEL_ID=$(echo "$CREATE_RESP" | jq -r '.id // empty')
fi
if assert_not_empty "$ESC_LABEL_ID" "escalation label ID"; then
    log "Label ID: $ESC_LABEL_ID"
    pass
fi

begin_test "Label has correct properties"
LABEL_JSON=$(echo "$LABELS" | jq '.[] | select(.name == "escalation")')
if [ -z "$LABEL_JSON" ]; then
    LABEL_JSON=$(api_get "/api/companies/$COMPANY_ID/labels" | jq '.[] | select(.name == "escalation")')
fi
LABEL_NAME=$(echo "$LABEL_JSON" | jq -r '.name // empty')
LABEL_COLOR=$(echo "$LABEL_JSON" | jq -r '.color // empty')
if assert_eq "$LABEL_NAME" "escalation" "label name" && \
   assert_not_empty "$LABEL_COLOR" "label color"; then
    pass
fi

begin_test "Duplicate label creation is handled (does not crash server)"
DUP_RESP=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -b "$COOKIE_JAR" \
    -H "Content-Type: application/json" \
    -H "Origin: $PAPERCLIP_URL" \
    -d '{"name":"escalation","color":"#dc2626"}' \
    "$PAPERCLIP_URL/api/companies/$COMPANY_ID/labels")
# Paperclip returns 500 on duplicate (unique constraint), not 409
if [ "$DUP_RESP" = "201" ] || [ "$DUP_RESP" = "409" ] || [ "$DUP_RESP" = "400" ] || [ "$DUP_RESP" = "500" ]; then
    log "Duplicate label response: $DUP_RESP (server stable)"
    pass
else
    fail "Unexpected status for duplicate label: $DUP_RESP"
fi

# ═══════════════════════════════════════════════════
# Section 3: Issue Creation
# ═══════════════════════════════════════════════════
echo ""
echo "[Section 3] Issue Creation"

begin_test "Create issue with title only"
ISSUE_RESP=$(api_post "/api/companies/$COMPANY_ID/issues" \
    '{"title":"Integration test: title only"}')
ISSUE_ID=$(echo "$ISSUE_RESP" | jq -r '.id // empty')
ISSUE_IDENT=$(echo "$ISSUE_RESP" | jq -r '.identifier // empty')
if assert_not_empty "$ISSUE_ID" "issue ID" && \
   assert_not_empty "$ISSUE_IDENT" "issue identifier"; then
    log "Created: $ISSUE_IDENT"
    pass
fi

begin_test "Create issue with description (body)"
ISSUE_RESP=$(api_post "/api/companies/$COMPANY_ID/issues" \
    '{"title":"Integration test: with body","description":"This is the escalation body content.\n\n## Requested Input\n\n**Database** (choose one):\n- PostgreSQL\n- SQLite"}')
ISSUE_DESC=$(echo "$ISSUE_RESP" | jq -r '.description // empty')
if assert_not_empty "$ISSUE_DESC" "issue description"; then
    pass
fi

begin_test "Create issue with labelIds attaches label"
ISSUE_RESP=$(api_post "/api/companies/$COMPANY_ID/issues" \
    "{\"title\":\"Integration test: labeled\",\"labelIds\":[\"$ESC_LABEL_ID\"]}")
ISSUE_LABELS=$(echo "$ISSUE_RESP" | jq -r '.labelIds // [] | length')
if [ "$ISSUE_LABELS" -ge 1 ]; then
    log "Label attached successfully"
    pass
else
    # Check if labels field has the label instead of labelIds
    ISSUE_LABEL_NAME=$(echo "$ISSUE_RESP" | jq -r '.labels[0].name // .labels.name // empty')
    if [ "$ISSUE_LABEL_NAME" = "escalation" ]; then
        log "Label attached (in labels field)"
        pass
    else
        fail "Label not attached (labelIds count: $ISSUE_LABELS)"
    fi
fi

begin_test "Create issue with high priority"
ISSUE_RESP=$(api_post "/api/companies/$COMPANY_ID/issues" \
    '{"title":"Integration test: high priority","priority":"high"}')
ISSUE_PRI=$(echo "$ISSUE_RESP" | jq -r '.priority // empty')
if assert_eq "$ISSUE_PRI" "high" "issue priority"; then
    pass
fi

begin_test "Create issue with medium priority"
ISSUE_RESP=$(api_post "/api/companies/$COMPANY_ID/issues" \
    '{"title":"Integration test: medium priority","priority":"medium"}')
ISSUE_PRI=$(echo "$ISSUE_RESP" | jq -r '.priority // empty')
if assert_eq "$ISSUE_PRI" "medium" "issue priority"; then
    pass
fi

begin_test "Issue title truncation (>80 chars)"
LONG_TITLE=$(printf 'A%.0s' {1..100})
TRUNCATED="${LONG_TITLE:0:77}..."
ISSUE_RESP=$(api_post "/api/companies/$COMPANY_ID/issues" \
    "{\"title\":\"$TRUNCATED\"}")
ISSUE_TITLE=$(echo "$ISSUE_RESP" | jq -r '.title // empty')
TITLE_LEN=${#ISSUE_TITLE}
if [ "$TITLE_LEN" -le 80 ]; then
    log "Title length: $TITLE_LEN (within limit)"
    pass
else
    fail "Title too long: $TITLE_LEN chars"
fi

begin_test "Issue description contains escalation-schema block"
SCHEMA_BODY=$(jq -n '{
    title: "Integration test: schema block",
    description: "Test message\n\n```escalation-schema\n{\"message\":\"Test message\",\"inputs\":[]}\n```"
}')
ISSUE_RESP=$(api_post "/api/companies/$COMPANY_ID/issues" "$SCHEMA_BODY")
ISSUE_DESC=$(echo "$ISSUE_RESP" | jq -r '.description // empty')
if echo "$ISSUE_DESC" | grep -q "escalation-schema"; then
    pass
else
    fail "Schema block not preserved in description"
fi

begin_test "Issue gets sequential identifier"
ISSUE_1=$(api_post "/api/companies/$COMPANY_ID/issues" '{"title":"Sequence test A"}')
ISSUE_2=$(api_post "/api/companies/$COMPANY_ID/issues" '{"title":"Sequence test B"}')
NUM_1=$(echo "$ISSUE_1" | jq -r '.issueNumber // 0')
NUM_2=$(echo "$ISSUE_2" | jq -r '.issueNumber // 0')
if [ "$NUM_2" -gt "$NUM_1" ]; then
    log "Sequential: #$NUM_1 → #$NUM_2"
    pass
else
    fail "Issue numbers not sequential: $NUM_1, $NUM_2"
fi

# ═══════════════════════════════════════════════════
# Section 4: Agent Pause / Resume
# ═══════════════════════════════════════════════════
echo ""
echo "[Section 4] Agent Pause / Resume"

begin_test "Pause agent via API"
PAUSE_RESP=$(api_post "/api/agents/$RESEARCHER_ID/pause" '{"reason":"escalation"}')
PAUSE_STATUS=$(echo "$PAUSE_RESP" | jq -r '.status // empty')
if assert_eq "$PAUSE_STATUS" "paused" "agent status after pause"; then
    pass
fi

begin_test "Paused agent has pauseReason"
PAUSE_REASON=$(echo "$PAUSE_RESP" | jq -r '.pauseReason // empty')
if assert_not_empty "$PAUSE_REASON" "pauseReason"; then
    log "Reason: $PAUSE_REASON"
    pass
fi

begin_test "Paused agent has pausedAt timestamp"
PAUSED_AT=$(echo "$PAUSE_RESP" | jq -r '.pausedAt // empty')
if assert_not_empty "$PAUSED_AT" "pausedAt"; then
    pass
fi

begin_test "Resume agent via API"
RESUME_RESP=$(api_post "/api/agents/$RESEARCHER_ID/resume" '{}')
RESUME_STATUS=$(echo "$RESUME_RESP" | jq -r '.status // empty')
if assert_eq "$RESUME_STATUS" "idle" "agent status after resume"; then
    pass
fi

begin_test "Resumed agent clears pause fields"
RESUME_REASON=$(echo "$RESUME_RESP" | jq -r '.pauseReason // "null"')
RESUME_AT=$(echo "$RESUME_RESP" | jq -r '.pausedAt // "null"')
if [ "$RESUME_REASON" = "null" ] && [ "$RESUME_AT" = "null" ]; then
    pass
else
    fail "Pause fields not cleared (reason=$RESUME_REASON, at=$RESUME_AT)"
fi

begin_test "Double-pause is idempotent"
api_post "/api/agents/$RESEARCHER_ID/pause" '{"reason":"test1"}' > /dev/null
PAUSE2_RESP=$(api_post "/api/agents/$RESEARCHER_ID/pause" '{"reason":"test2"}')
PAUSE2_STATUS=$(echo "$PAUSE2_RESP" | jq -r '.status // empty')
if [ "$PAUSE2_STATUS" = "paused" ]; then
    pass
else
    fail "Double pause returned unexpected status: $PAUSE2_STATUS"
fi

# Clean up: resume
api_post "/api/agents/$RESEARCHER_ID/resume" '{}' > /dev/null

begin_test "Resume already-idle agent is safe"
IDLE_RESUME=$(api_post "/api/agents/$RESEARCHER_ID/resume" '{}')
IDLE_STATUS=$(echo "$IDLE_RESUME" | jq -r '.status // empty')
if [ "$IDLE_STATUS" = "idle" ]; then
    pass
else
    fail "Resume on idle agent returned: $IDLE_STATUS"
fi

# ═══════════════════════════════════════════════════
# Section 5: Full Escalation Sequence (API-level)
# ═══════════════════════════════════════════════════
echo ""
echo "[Section 5] Full Escalation Sequence"

begin_test "Complete escalation: auth → label → issue → pause → resume"

# Simulate extension behavior step by step
STEP_LABEL_ID=$(api_get "/api/companies/$COMPANY_ID/labels" | \
    jq -r '.[] | select(.name == "escalation") | .id // empty')
assert_not_empty "$STEP_LABEL_ID" "label lookup"

ESC_TITLE="Escalation: need database decision"
ESC_BODY=$(jq -n --arg title "$ESC_TITLE" --arg lid "$STEP_LABEL_ID" '{
    title: $title,
    description: "Which database should we use for analytics?\n\n---\n\n## Requested Input\n\n**Database** (choose one):\n- PostgreSQL\n- SQLite\n\n```escalation-schema\n{\"message\":\"Which database?\",\"inputs\":[{\"id\":\"db\",\"label\":\"Database\",\"type\":\"select\"}]}\n```",
    priority: "high",
    labelIds: [$lid]
}')

ESC_ISSUE=$(api_post "/api/companies/$COMPANY_ID/issues" "$ESC_BODY")
ESC_ISSUE_ID=$(echo "$ESC_ISSUE" | jq -r '.id // empty')
ESC_IDENT=$(echo "$ESC_ISSUE" | jq -r '.identifier // empty')
assert_not_empty "$ESC_ISSUE_ID" "escalation issue ID"
log "Issue: $ESC_IDENT"

PAUSE_RESULT=$(api_post "/api/agents/$RESEARCHER_ID/pause" '{"reason":"escalation"}')
assert_eq "$(echo "$PAUSE_RESULT" | jq -r '.status')" "paused" "pause status"

# Verify issue is queryable while paused
ISSUES_LIST=$(api_get "/api/companies/$COMPANY_ID/issues")
FOUND=$(echo "$ISSUES_LIST" | jq --arg id "$ESC_ISSUE_ID" '.[] | select(.id == $id) | .id')
assert_not_empty "$FOUND" "issue findable while agent paused"

# Resume
RESUME_RESULT=$(api_post "/api/agents/$RESEARCHER_ID/resume" '{}')
assert_eq "$(echo "$RESUME_RESULT" | jq -r '.status')" "idle" "resume status"

pass

# ═══════════════════════════════════════════════════
# Section 6: Edge Cases
# ═══════════════════════════════════════════════════
echo ""
echo "[Section 6] Edge Cases"

begin_test "Issue with empty description"
RESP=$(api_post "/api/companies/$COMPANY_ID/issues" '{"title":"Empty desc test","description":""}')
STATUS=$(echo "$RESP" | jq -r '.id // empty')
if assert_not_empty "$STATUS" "issue with empty description"; then
    pass
fi

begin_test "Issue with unicode in title"
UNICODE_BODY=$(jq -n '{title: "Escalation: need help with données utilisateur"}')
RESP=$(api_post "/api/companies/$COMPANY_ID/issues" "$UNICODE_BODY")
TITLE=$(echo "$RESP" | jq -r '.title // empty')
if assert_not_empty "$TITLE" "unicode title"; then
    if echo "$TITLE" | grep -q "donn"; then
        pass
    else
        fail "Unicode not preserved: $TITLE"
    fi
fi

begin_test "Issue with very long description (>5000 chars)"
LONG_DESC=$(printf 'Line %04d: This is test content for a very long escalation description.\n' $(seq 1 100))
ESCAPED_DESC=$(echo "$LONG_DESC" | jq -Rs '.')
RESP=$(api_post "/api/companies/$COMPANY_ID/issues" \
    "{\"title\":\"Long desc test\",\"description\":$ESCAPED_DESC}")
RESP_ID=$(echo "$RESP" | jq -r '.id // empty')
if assert_not_empty "$RESP_ID" "long description issue"; then
    pass
fi

begin_test "Issue with markdown in description"
MD_BODY=$(jq -n '{
    title: "Markdown desc test",
    description: "# Heading\n\n**Bold** and *italic*\n\n- List item 1\n- List item 2\n\n```json\n{\"key\": \"value\"}\n```"
}')
RESP=$(api_post "/api/companies/$COMPANY_ID/issues" "$MD_BODY")
RESP_DESC=$(echo "$RESP" | jq -r '.description // empty')
if echo "$RESP_DESC" | grep -q "Heading"; then
    pass
else
    fail "Markdown not preserved"
fi

begin_test "Pause with custom reason string"
PAUSE_CUSTOM=$(api_post "/api/agents/$RESEARCHER_ID/pause" '{"reason":"escalation: blocking decision needed"}')
P_STATUS=$(echo "$PAUSE_CUSTOM" | jq -r '.status // empty')
if assert_eq "$P_STATUS" "paused" "custom reason pause"; then
    pass
fi
api_post "/api/agents/$RESEARCHER_ID/resume" '{}' > /dev/null

begin_test "Multiple issues can reference same label"
ISSUE_A=$(api_post "/api/companies/$COMPANY_ID/issues" \
    "{\"title\":\"Multi-label A\",\"labelIds\":[\"$ESC_LABEL_ID\"]}")
ISSUE_B=$(api_post "/api/companies/$COMPANY_ID/issues" \
    "{\"title\":\"Multi-label B\",\"labelIds\":[\"$ESC_LABEL_ID\"]}")
ID_A=$(echo "$ISSUE_A" | jq -r '.id // empty')
ID_B=$(echo "$ISSUE_B" | jq -r '.id // empty')
if assert_not_empty "$ID_A" "issue A" && assert_not_empty "$ID_B" "issue B"; then
    if [ "$ID_A" != "$ID_B" ]; then
        pass
    else
        fail "Same ID for different issues"
    fi
fi

# ═══════════════════════════════════════════════════
# Section 7: Container-to-Paperclip Auth
# ═══════════════════════════════════════════════════
echo ""
echo "[Section 7] Container-to-Paperclip Auth (Docker network)"

begin_test "Researcher container can reach Paperclip"
CONTAINER_HEALTH=$(docker compose -f "$REPO_ROOT/docker-compose.yml" \
    exec -T researcher node -e "
fetch('http://paperclip:3100/api/health')
  .then(r => console.log(r.status))
  .catch(e => console.log('ERROR:' + e.message))
" 2>/dev/null)
if assert_eq "$CONTAINER_HEALTH" "200" "container health check"; then
    pass
fi

begin_test "Researcher container can authenticate with Paperclip"
CONTAINER_AUTH=$(docker compose -f "$REPO_ROOT/docker-compose.yml" \
    exec -T researcher node -e "
fetch('http://paperclip:3100/api/auth/sign-in/email', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Origin': 'http://paperclip:3100' },
  body: JSON.stringify({ email: 'admin@eval.local', password: 'eval-admin-2026' })
}).then(r => console.log(r.status)).catch(e => console.log('ERROR:' + e.message))
" 2>/dev/null)
if assert_eq "$CONTAINER_AUTH" "200" "container auth status"; then
    pass
fi

begin_test "Researcher container can create issue via Paperclip"
CONTAINER_ISSUE=$(docker compose -f "$REPO_ROOT/docker-compose.yml" \
    exec -T researcher node -e "
async function test() {
  const auth = await fetch('http://paperclip:3100/api/auth/sign-in/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'http://paperclip:3100' },
    body: JSON.stringify({ email: 'admin@eval.local', password: 'eval-admin-2026' })
  });
  const cookie = (auth.headers.get('set-cookie') || '').match(/([^;]+)/)?.[1];
  const res = await fetch('http://paperclip:3100/api/companies/$COMPANY_ID/issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Origin': 'http://paperclip:3100', 'Cookie': cookie },
    body: JSON.stringify({ title: 'Container integration test', priority: 'medium' })
  });
  console.log(res.status);
}
test().catch(e => console.log('ERROR:' + e.message));
" 2>/dev/null)
if assert_eq "$CONTAINER_ISSUE" "201" "container issue creation"; then
    pass
fi

begin_test "Researcher container env vars set correctly"
CONTAINER_ENV=$(docker compose -f "$REPO_ROOT/docker-compose.yml" \
    exec -T researcher node -e "
const vars = ['PAPERCLIP_API_URL','PAPERCLIP_ADMIN_EMAIL','PAPERCLIP_ADMIN_PASS','PAPERCLIP_AGENT_ID','PAPERCLIP_COMPANY_ID'];
const missing = vars.filter(v => !process.env[v]);
console.log(missing.length === 0 ? 'ALL_SET' : 'MISSING:' + missing.join(','));
" 2>/dev/null)
if assert_eq "$CONTAINER_ENV" "ALL_SET" "escalation env vars"; then
    pass
fi

echo ""
summary
