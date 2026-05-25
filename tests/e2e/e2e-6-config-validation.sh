#!/usr/bin/env bash
# E2E-6: Agent Configuration Validation
# Validates structural correctness of agent configs without needing running containers.
# Catches regressions from config edits (missing fields, invalid JSON/YAML, broken refs).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AGENTS_DIR="$REPO_ROOT/src/agents"

echo ""
echo "[E2E-6] Agent Configuration Validation"

# No stack required — this suite validates files only
for cmd in jq python3; do
    if ! command -v "$cmd" &>/dev/null; then
        # python3 needed for YAML validation; skip those tests if missing
        if [ "$cmd" = "python3" ]; then
            SKIP_YAML=true
        else
            echo "[FATAL] Required: $cmd"
            exit 1
        fi
    fi
done

SKIP_YAML="${SKIP_YAML:-false}"
AGENTS=("ceo" "researcher")

# --- Validate agent.json for each agent ---
for agent in "${AGENTS[@]}"; do
    AGENT_JSON="$AGENTS_DIR/$agent/agent.json"

    begin_test "$agent/agent.json exists and is valid JSON"
    if [ ! -f "$AGENT_JSON" ]; then
        fail "file not found: $AGENT_JSON"
        continue
    fi
    if ! jq empty "$AGENT_JSON" 2>/dev/null; then
        fail "invalid JSON in $AGENT_JSON"
        continue
    fi
    pass

    begin_test "$agent/agent.json has required fields"
    NAME=$(jq -r '.name // empty' "$AGENT_JSON")
    ROLE=$(jq -r '.role // empty' "$AGENT_JSON")
    ADAPTER_TYPE=$(jq -r '.adapterType // empty' "$AGENT_JSON")
    ADAPTER_URL=$(jq -r '.adapterConfig.url // empty' "$AGENT_JSON")
    TIMEOUT=$(jq -r '.adapterConfig.timeoutSec // empty' "$AGENT_JSON")

    MISSING=""
    [ -z "$NAME" ] && MISSING="$MISSING name"
    [ -z "$ROLE" ] && MISSING="$MISSING role"
    [ -z "$ADAPTER_TYPE" ] && MISSING="$MISSING adapterType"
    [ -z "$ADAPTER_URL" ] && MISSING="$MISSING adapterConfig.url"
    [ -z "$TIMEOUT" ] && MISSING="$MISSING adapterConfig.timeoutSec"

    if [ -n "$MISSING" ]; then
        fail "missing fields:$MISSING"
    else
        pass
    fi

    begin_test "$agent/agent.json adapterType is http"
    if assert_eq "$ADAPTER_TYPE" "http" "adapterType"; then
        pass
    fi

    begin_test "$agent/agent.json adapter URL uses Docker hostname"
    if echo "$ADAPTER_URL" | grep -qE "^http://$agent:"; then
        pass
    else
        fail "adapter URL '$ADAPTER_URL' should use Docker hostname '$agent'"
    fi
done

# --- Validate config.yml for each agent ---
for agent in "${AGENTS[@]}"; do
    CONFIG_YML="$AGENTS_DIR/$agent/.pi/agent/config.yml"

    begin_test "$agent/.pi/agent/config.yml exists"
    if [ ! -f "$CONFIG_YML" ]; then
        fail "file not found: $CONFIG_YML"
        continue
    fi
    pass

    if [ "$SKIP_YAML" = "true" ]; then
        begin_test "$agent/.pi/agent/config.yml valid YAML"
        skip "python3 not available for YAML validation"
        continue
    fi

    begin_test "$agent/.pi/agent/config.yml valid YAML"
    if python3 -c "import yaml; yaml.safe_load(open('$CONFIG_YML'))" 2>/dev/null; then
        pass
    else
        fail "invalid YAML in $CONFIG_YML"
    fi

    begin_test "$agent/.pi/agent/config.yml has model roles"
    ROLES_FOUND=$(python3 -c "
import yaml, sys
with open('$CONFIG_YML') as f:
    cfg = yaml.safe_load(f)
models = cfg.get('models', {}).get('roles', {})
required = ['default', 'agentic', 'plan']
missing = [r for r in required if r not in models]
if missing:
    print('missing:' + ','.join(missing))
    sys.exit(1)
print('ok')
" 2>/dev/null)
    if [ "$ROLES_FOUND" = "ok" ]; then
        pass
    else
        fail "$ROLES_FOUND"
    fi
done

# --- Validate models.json for each agent ---
for agent in "${AGENTS[@]}"; do
    MODELS_JSON="$AGENTS_DIR/$agent/.pi/agent/models.json"

    begin_test "$agent/.pi/agent/models.json exists and is valid JSON"
    if [ ! -f "$MODELS_JSON" ]; then
        fail "file not found: $MODELS_JSON"
        continue
    fi
    if ! jq empty "$MODELS_JSON" 2>/dev/null; then
        fail "invalid JSON in $MODELS_JSON"
        continue
    fi
    pass
done

# --- Validate AGENTS.md for each agent ---
for agent in "${AGENTS[@]}"; do
    AGENTS_MD="$AGENTS_DIR/$agent/AGENTS.md"

    begin_test "$agent/AGENTS.md exists and is non-empty"
    if [ ! -f "$AGENTS_MD" ]; then
        fail "file not found: $AGENTS_MD"
        continue
    fi
    if [ ! -s "$AGENTS_MD" ]; then
        fail "file is empty: $AGENTS_MD"
        continue
    fi
    pass
done

# --- Validate docker-compose.yml references match agent.json ---
begin_test "docker-compose.yml service names match agent directories"
COMPOSE="$AGENTS_DIR/docker-compose.yml"
if [ ! -f "$COMPOSE" ]; then
    fail "docker-compose.yml not found"
else
    ALL_MATCH=true
    for agent in "${AGENTS[@]}"; do
        if ! grep -q "^  $agent:" "$COMPOSE" 2>/dev/null && \
           ! grep -q "^    $agent:" "$COMPOSE" 2>/dev/null; then
            # Try with spaces (YAML indent varies)
            if ! grep -qE "^\s+$agent:" "$COMPOSE" 2>/dev/null; then
                fail "service '$agent' not found in docker-compose.yml"
                ALL_MATCH=false
            fi
        fi
    done
    if $ALL_MATCH; then
        pass
    fi
fi

# --- Validate extensions exist ---
begin_test "Extension files exist (web-search.ts, web-fetch.ts)"
EXT_DIR="$AGENTS_DIR/extensions"
MISSING_EXT=""
[ ! -f "$EXT_DIR/web-search.ts" ] && MISSING_EXT="$MISSING_EXT web-search.ts"
[ ! -f "$EXT_DIR/web-fetch.ts" ] && MISSING_EXT="$MISSING_EXT web-fetch.ts"
if [ -n "$MISSING_EXT" ]; then
    fail "missing extensions:$MISSING_EXT"
else
    pass
fi

# --- Validate bridge.mjs references correct extension paths ---
begin_test "bridge.mjs references all extension files"
BRIDGE="$AGENTS_DIR/bridge.mjs"
if [ ! -f "$BRIDGE" ]; then
    fail "bridge.mjs not found"
else
    MISSING_REF=""
    grep -q "web-search.ts" "$BRIDGE" || MISSING_REF="$MISSING_REF web-search.ts"
    grep -q "web-fetch.ts" "$BRIDGE" || MISSING_REF="$MISSING_REF web-fetch.ts"
    if [ -n "$MISSING_REF" ]; then
        fail "bridge.mjs missing -e refs:$MISSING_REF"
    else
        pass
    fi
fi

# --- Validate Dockerfile copies extensions ---
begin_test "Dockerfile copies extensions into image"
DOCKERFILE="$AGENTS_DIR/Dockerfile"
if [ ! -f "$DOCKERFILE" ]; then
    fail "Dockerfile not found"
else
    if grep -q "extensions" "$DOCKERFILE"; then
        pass
    else
        fail "Dockerfile does not copy extensions directory"
    fi
fi

# --- Cross-reference: reportsTo hierarchy ---
begin_test "Researcher reportsTo CEO (hierarchy valid)"
RES_REPORTS=$(jq -r '.reportsTo // empty' "$AGENTS_DIR/researcher/agent.json")
CEO_NAME=$(jq -r '.name // empty' "$AGENTS_DIR/ceo/agent.json")
if [ "$RES_REPORTS" = "$CEO_NAME" ]; then
    pass
else
    fail "Researcher reportsTo='$RES_REPORTS', expected='$CEO_NAME'"
fi

summary
