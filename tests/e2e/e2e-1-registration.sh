#!/usr/bin/env bash
# E2E-1: Agent Registration Verification
# Verifies both agents are registered in Paperclip with correct config.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo ""
echo "[E2E-1] Agent Registration Verification"

require_stack

# --- Find company ---
begin_test "Company exists"
COMPANY_ID=$(find_company_id)
if assert_not_empty "$COMPANY_ID" "company ID"; then
    log "Company: $COMPANY_ID"
    pass
fi

# --- List agents ---
begin_test "CEO agent registered"
CEO_ID=$(find_agent_id "$COMPANY_ID" "CEO")
if assert_not_empty "$CEO_ID" "CEO agent ID"; then
    log "CEO: $CEO_ID"
    pass
fi

begin_test "Researcher agent registered"
RES_ID=$(find_agent_id "$COMPANY_ID" "Researcher")
if assert_not_empty "$RES_ID" "Researcher agent ID"; then
    log "Researcher: $RES_ID"
    pass
fi

# --- Verify agent details ---
begin_test "CEO adapter config correct"
CEO_JSON=$(api_get "/api/agents/$CEO_ID")
CEO_ADAPTER=$(echo "$CEO_JSON" | jq -r '.adapterType // empty')
CEO_URL=$(echo "$CEO_JSON" | jq -r '.adapterConfig.url // empty')
if assert_eq "$CEO_ADAPTER" "http" "CEO adapterType" && \
   assert_eq "$CEO_URL" "http://ceo:8080/invoke" "CEO adapter URL"; then
    pass
fi

begin_test "Researcher adapter config correct"
RES_JSON=$(api_get "/api/agents/$RES_ID")
RES_ADAPTER=$(echo "$RES_JSON" | jq -r '.adapterType // empty')
RES_URL=$(echo "$RES_JSON" | jq -r '.adapterConfig.url // empty')
if assert_eq "$RES_ADAPTER" "http" "Researcher adapterType" && \
   assert_eq "$RES_URL" "http://researcher:8080/invoke" "Researcher adapter URL"; then
    pass
fi

# --- Org tree ---
begin_test "Org tree shows hierarchy"
ORG=$(get_org_tree "$COMPANY_ID")
if [ -z "$ORG" ]; then
    fail "org tree response empty"
else
    ORG_CEO=$(echo "$ORG" | jq -r '.. | objects | select(.name == "CEO") | .name // empty' 2>/dev/null | head -1)
    ORG_RES=$(echo "$ORG" | jq -r '.. | objects | select(.name == "Researcher") | .name // empty' 2>/dev/null | head -1)
    if assert_not_empty "$ORG_CEO" "CEO in org tree" && \
       assert_not_empty "$ORG_RES" "Researcher in org tree"; then
        pass
    fi
fi

# --- Researcher reports to CEO ---
begin_test "Researcher reports to CEO"
RES_REPORTS_TO=$(echo "$RES_JSON" | jq -r '.reportsTo // empty')
if assert_eq "$RES_REPORTS_TO" "$CEO_ID" "Researcher.reportsTo"; then
    pass
fi

summary
