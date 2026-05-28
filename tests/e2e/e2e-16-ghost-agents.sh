#!/usr/bin/env bash
# E2E-16: Ghost Agent Detection
# Validates that setup.sh will not register agents lacking a docker-compose service.
# Agents registered without a running container cause DNS failures (ENOTFOUND) when
# Paperclip dispatches work to them via HTTP adapter.
#
# No running stack required — this suite validates file structure only.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AGENTS_DIR="$REPO_ROOT/src/agents"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"

echo ""
echo "[E2E-16] Ghost Agent Detection"

# --- Prerequisites ---
for cmd in jq docker; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "[FATAL] Required: $cmd"
        exit 1
    fi
done

if [ ! -f "$COMPOSE_FILE" ]; then
    echo "[FATAL] docker-compose.yml not found at $COMPOSE_FILE"
    exit 1
fi

# --- Get compose service names ---
COMPOSE_SERVICES="$(cd "$REPO_ROOT" && docker compose -f docker-compose.yml config --services 2>/dev/null)"
if [ -z "$COMPOSE_SERVICES" ]; then
    echo "[FATAL] Could not parse compose services (is docker running?)"
    exit 1
fi

# --- Collect agent dirs that have agent.json ---
AGENT_DIRS=()
for dir in "$AGENTS_DIR"/*/; do
    [ -f "${dir}agent.json" ] && [ -f "${dir}.pi/agent/config.yml" ] && AGENT_DIRS+=("$dir")
done

begin_test "At least one agent directory found"
if [ ${#AGENT_DIRS[@]} -gt 0 ]; then
    pass
else
    fail "no agent directories with agent.json found in $AGENTS_DIR"
fi

# --- Every registrable agent dir must have a compose service ---
for dir in "${AGENT_DIRS[@]}"; do
    name="$(basename "$dir")"
    begin_test "$name has a matching docker-compose service"
    if echo "$COMPOSE_SERVICES" | grep -qx "$name"; then
        pass
    else
        fail "$name has agent.json but no compose service — would be a ghost agent"
    fi
done

# --- Known ghost agents must NOT be in compose services ---
KNOWN_GHOSTS=("coder" "publisher" "qa")
for ghost in "${KNOWN_GHOSTS[@]}"; do
    begin_test "$ghost is NOT a compose service (known ghost)"
    if echo "$COMPOSE_SERVICES" | grep -qx "$ghost"; then
        fail "$ghost is in compose services — remove this assertion if it now has a container"
    else
        pass
    fi
done

# --- Verify compose services that are agents all have agent.json ---
begin_test "All agent compose services have agent.json"
MISSING=""
for svc in $COMPOSE_SERVICES; do
    # Skip infrastructure services (not agents)
    [ -d "$AGENTS_DIR/$svc" ] || continue
    if [ ! -f "$AGENTS_DIR/$svc/agent.json" ]; then
        MISSING="$MISSING $svc"
    fi
done
if [ -n "$MISSING" ]; then
    fail "compose services missing agent.json:$MISSING"
else
    pass
fi

summary
