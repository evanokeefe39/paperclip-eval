#!/usr/bin/env bash
# E2E-4: Character Limit Regression
# Verifies payloads above the old pi_local CLI arg limit (8,191 chars)
# produce coherent responses, not fragmented gibberish.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo ""
echo "[E2E-4] Character Limit Regression"

require_stack

LARGE_FIXTURE="$REPO_ROOT/tests/fixtures/large-payload.json"
if [ ! -f "$LARGE_FIXTURE" ]; then
    echo "[FATAL] Large payload fixture not found: $LARGE_FIXTURE"
    exit 1
fi

FIXTURE_SIZE=$(wc -c < "$LARGE_FIXTURE")
log "Fixture size: $FIXTURE_SIZE bytes"

SYSTEM_PROMPT_LEN=$(jq -r '.systemPrompt | length' < "$LARGE_FIXTURE")
log "systemPrompt length: $SYSTEM_PROMPT_LEN chars"

# --- Test: Large payload via direct bridge ---
begin_test "Large payload accepted by bridge ($SYSTEM_PROMPT_LEN chars)"
RESP=$(bridge_post "$CEO_BRIDGE_URL" "$(cat "$LARGE_FIXTURE")" 120)
OUTPUT=$(echo "$RESP" | jq -r '.output // empty')
EXIT_CODE=$(echo "$RESP" | jq -r '.exitCode // empty')

if assert_not_empty "$OUTPUT" "bridge output" && \
   assert_eq "$EXIT_CODE" "0" "exit code"; then
    pass
fi

# --- Test: Response is coherent, not fragmented ---
begin_test "Response coherent (not word-salad from fragmentation)"
# The prompt asks to "Acknowledge receipt of your instructions"
# A coherent response should contain words like "acknowledge", "received",
# "instructions", "contract", "CEO", or similar. Gibberish from fragmentation
# would be random word fragments.
COHERENCE_PATTERNS=("acknowledg" "receiv" "instruct" "understood" "contract" "CEO" "role" "ready")
MATCHES=0
for pattern in "${COHERENCE_PATTERNS[@]}"; do
    if echo "$OUTPUT" | grep -qiF "$pattern"; then
        ((MATCHES++)) || true
    fi
done

if [ "$MATCHES" -ge 2 ]; then
    log "Coherence check: $MATCHES/${#COHERENCE_PATTERNS[@]} patterns matched"
    pass
else
    fail "only $MATCHES/${#COHERENCE_PATTERNS[@]} coherence patterns found — possible fragmentation"
    log "Output preview: $(echo "$OUTPUT" | head -3 | cut -c1-120)"
fi

# --- Test: Above the 8,191-char threshold specifically ---
begin_test "Payload exceeds pi_local 8,191 char limit"
PI_LOCAL_LIMIT=8191
if [ "$SYSTEM_PROMPT_LEN" -gt "$PI_LOCAL_LIMIT" ]; then
    log "systemPrompt ($SYSTEM_PROMPT_LEN) > pi_local limit ($PI_LOCAL_LIMIT)"
    pass
else
    skip "systemPrompt ($SYSTEM_PROMPT_LEN) is below $PI_LOCAL_LIMIT — fixture too small"
fi

# --- Test: Exactly-at-boundary payload ---
begin_test "Boundary payload (8,192 chars systemPrompt)"
# Generate a systemPrompt of exactly 8,192 chars
BOUNDARY_PROMPT=$(python3 -c "
import json, sys
# Build a prompt that's exactly 8192 chars
base = 'You are a test agent. '
padding = 'x' * (8192 - len(base))
prompt = base + padding
assert len(prompt) == 8192, f'Got {len(prompt)}'
payload = {'prompt': 'Respond with exactly: BOUNDARY_OK', 'systemPrompt': prompt}
json.dump(payload, sys.stdout)
" 2>/dev/null) || true

if [ -z "$BOUNDARY_PROMPT" ]; then
    # Fallback without python
    BOUNDARY_PROMPT=$(jq -n --arg sp "$(printf 'You are a test agent. %8170s' | tr ' ' 'x')" \
        '{prompt: "Respond with exactly: BOUNDARY_OK", systemPrompt: $sp}')
fi

BOUND_RESP=$(bridge_post "$CEO_BRIDGE_URL" "$BOUNDARY_PROMPT" 120)
BOUND_OUTPUT=$(echo "$BOUND_RESP" | jq -r '.output // empty')
BOUND_EXIT=$(echo "$BOUND_RESP" | jq -r '.exitCode // empty')

if assert_not_empty "$BOUND_OUTPUT" "boundary output" && \
   assert_eq "$BOUND_EXIT" "0" "boundary exit code"; then
    if assert_contains "$BOUND_OUTPUT" "BOUNDARY_OK" "boundary coherence"; then
        pass
    fi
fi

# --- Test: Double the limit ---
begin_test "Double-limit payload (16,384 chars systemPrompt)"
DOUBLE_PROMPT=$(python3 -c "
import json, sys
base = 'You are a test agent verifying large payload handling. '
padding = 'x' * (16384 - len(base))
prompt = base + padding
payload = {'prompt': 'Respond with exactly: DOUBLE_OK', 'systemPrompt': prompt}
json.dump(payload, sys.stdout)
" 2>/dev/null) || true

if [ -z "$DOUBLE_PROMPT" ]; then
    DOUBLE_PROMPT=$(jq -n --arg sp "$(printf 'You are a test agent. %16362s' | tr ' ' 'x')" \
        '{prompt: "Respond with exactly: DOUBLE_OK", systemPrompt: $sp}')
fi

DOUBLE_RESP=$(bridge_post "$CEO_BRIDGE_URL" "$DOUBLE_PROMPT" 120)
DOUBLE_OUTPUT=$(echo "$DOUBLE_RESP" | jq -r '.output // empty')
DOUBLE_EXIT=$(echo "$DOUBLE_RESP" | jq -r '.exitCode // empty')

if assert_not_empty "$DOUBLE_OUTPUT" "double-limit output" && \
   assert_eq "$DOUBLE_EXIT" "0" "double-limit exit code"; then
    if assert_contains "$DOUBLE_OUTPUT" "DOUBLE_OK" "double-limit coherence"; then
        pass
    fi
fi

summary
