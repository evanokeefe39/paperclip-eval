#!/usr/bin/env bash
# Shared helpers for E2E tests against Paperclip + agent stack.
# Source this file; do not execute directly.

set -euo pipefail

# --- Config (override via env) ---
PAPERCLIP_URL="${PAPERCLIP_URL:-http://localhost:3100}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@eval.local}"
ADMIN_PASS="${ADMIN_PASS:-eval-admin-2026}"
CEO_BRIDGE_URL="${CEO_BRIDGE_URL:-http://localhost:8081}"
RESEARCHER_BRIDGE_URL="${RESEARCHER_BRIDGE_URL:-http://localhost:8082}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-60}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-120}"

# --- State ---
COOKIE_JAR=$(mktemp)
trap 'rm -f "$COOKIE_JAR"' EXIT

# Counters
_PASS=0
_FAIL=0
_SKIP=0
_TEST_NAME=""

# --- Output ---
log()  { echo "  $*"; }
pass() { echo "  [PASS] $_TEST_NAME"; ((_PASS++)) || true; }
fail() { echo "  [FAIL] $_TEST_NAME — $*"; ((_FAIL++)) || true; }
skip() { echo "  [SKIP] $_TEST_NAME — $*"; ((_SKIP++)) || true; }

begin_test() {
    _TEST_NAME="$1"
    echo "  ▸ $1"
}

summary() {
    local total=$((_PASS + _FAIL + _SKIP))
    echo ""
    echo "──────────────────────────────────────"
    echo "Results: $_PASS/$total passed, $_FAIL failed, $_SKIP skipped"
    if [ "$_FAIL" -gt 0 ]; then
        return 1
    fi
    return 0
}

# --- HTTP helpers ---

wait_healthy() {
    local url="$1"
    local timeout="${2:-$HEALTH_TIMEOUT}"
    local deadline=$((SECONDS + timeout))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if curl -sf -o /dev/null "$url"; then
            return 0
        fi
        sleep 2
    done
    return 1
}

api_get() {
    local path="$1"
    curl -sf \
        -b "$COOKIE_JAR" \
        -H "Origin: $PAPERCLIP_URL" \
        "$PAPERCLIP_URL$path"
}

api_post() {
    local path="$1"
    local body="${2:-}"
    if [ -n "$body" ]; then
        curl -sf \
            -X POST \
            -b "$COOKIE_JAR" \
            -c "$COOKIE_JAR" \
            -H "Content-Type: application/json" \
            -H "Origin: $PAPERCLIP_URL" \
            -d "$body" \
            "$PAPERCLIP_URL$path"
    else
        curl -sf \
            -X POST \
            -b "$COOKIE_JAR" \
            -c "$COOKIE_JAR" \
            -H "Origin: $PAPERCLIP_URL" \
            "$PAPERCLIP_URL$path"
    fi
}

api_post_file() {
    local path="$1"
    local file="$2"
    curl -sf \
        -X POST \
        -b "$COOKIE_JAR" \
        -c "$COOKIE_JAR" \
        -H "Content-Type: application/json" \
        -H "Origin: $PAPERCLIP_URL" \
        -d @"$file" \
        "$PAPERCLIP_URL$path"
}

# Returns HTTP status code, body goes to stdout
api_post_status() {
    local path="$1"
    local body="${2:-}"
    local args=(-s -w "\n%{http_code}" -X POST \
        -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
        -H "Content-Type: application/json" \
        -H "Origin: $PAPERCLIP_URL")
    if [ -n "$body" ]; then
        args+=(-d "$body")
    fi
    local response
    response=$(curl "${args[@]}" "$PAPERCLIP_URL$path")
    local status
    status=$(echo "$response" | tail -1)
    echo "$response" | sed '$d'
    return "$((status < 200 || status >= 300 ? 1 : 0))" 2>/dev/null || true
}

bridge_post() {
    local url="$1"
    local body="$2"
    local timeout="${3:-$REQUEST_TIMEOUT}"
    curl -sf \
        --max-time "$timeout" \
        -X POST \
        -H "Content-Type: application/json" \
        -d "$body" \
        "$url/invoke"
}

# --- Auth ---

authenticate() {
    local signin_body
    signin_body=$(jq -n --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASS" \
        '{email: $e, password: $p}')

    # Try signin first (fast path for existing instance)
    if curl -sf -o /dev/null \
        -X POST \
        -c "$COOKIE_JAR" \
        -H "Content-Type: application/json" \
        -H "Origin: $PAPERCLIP_URL" \
        -d "$signin_body" \
        "$PAPERCLIP_URL/api/auth/sign-in/email" 2>/dev/null; then
        return 0
    fi

    # Fall back to signup
    local signup_body
    signup_body=$(jq -n --arg n "Eval Admin" --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASS" \
        '{name: $n, email: $e, password: $p}')
    curl -sf -o /dev/null \
        -X POST \
        -c "$COOKIE_JAR" \
        -H "Content-Type: application/json" \
        -H "Origin: $PAPERCLIP_URL" \
        -d "$signup_body" \
        "$PAPERCLIP_URL/api/auth/sign-up/email"
}

# --- Discovery ---

find_company_id() {
    api_get "/api/companies" | jq -r '.[0].id // empty'
}

find_agent_id() {
    local company_id="$1"
    local agent_name="$2"
    api_get "/api/companies/$company_id/agents" | \
        jq -r --arg name "$agent_name" '.[] | select(.name == $name) | .id // empty'
}

get_org_tree() {
    local company_id="$1"
    api_get "/api/companies/$company_id/org"
}

# --- Assertions ---

assert_eq() {
    local actual="$1"
    local expected="$2"
    local msg="${3:-values}"
    if [ "$actual" = "$expected" ]; then
        return 0
    fi
    fail "expected $msg = '$expected', got '$actual'"
    return 1
}

assert_not_empty() {
    local value="$1"
    local msg="${2:-value}"
    if [ -n "$value" ]; then
        return 0
    fi
    fail "$msg is empty"
    return 1
}

assert_contains() {
    local haystack="$1"
    local needle="$2"
    local msg="${3:-output}"
    if echo "$haystack" | grep -qiF "$needle"; then
        return 0
    fi
    fail "$msg does not contain '$needle'"
    return 1
}

assert_not_contains() {
    local haystack="$1"
    local needle="$2"
    local msg="${3:-output}"
    if echo "$haystack" | grep -qiF "$needle"; then
        fail "$msg unexpectedly contains '$needle'"
        return 1
    fi
    return 0
}

assert_json_field() {
    local json="$1"
    local field="$2"
    local expected="$3"
    local actual
    actual=$(echo "$json" | jq -r "$field // empty")
    assert_eq "$actual" "$expected" "$field"
}

assert_json_not_empty() {
    local json="$1"
    local field="$2"
    local actual
    actual=$(echo "$json" | jq -r "$field // empty")
    assert_not_empty "$actual" "$field"
}

# --- Prerequisite gate ---

require_stack() {
    echo "Checking prerequisites..."

    for cmd in curl jq; do
        if ! command -v "$cmd" &>/dev/null; then
            echo "[FATAL] Required command not found: $cmd"
            exit 1
        fi
    done

    if ! wait_healthy "$PAPERCLIP_URL/api/health" 10; then
        echo "[FATAL] Paperclip not healthy at $PAPERCLIP_URL"
        exit 1
    fi

    if ! wait_healthy "$CEO_BRIDGE_URL/health" 10; then
        echo "[FATAL] CEO bridge not healthy at $CEO_BRIDGE_URL"
        exit 1
    fi

    if ! wait_healthy "$RESEARCHER_BRIDGE_URL/health" 10; then
        echo "[FATAL] Researcher bridge not healthy at $RESEARCHER_BRIDGE_URL"
        exit 1
    fi

    echo "  Stack healthy."

    echo "Authenticating..."
    if ! authenticate; then
        echo "[FATAL] Authentication failed"
        exit 1
    fi
    echo "  Authenticated."
}
