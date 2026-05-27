#!/usr/bin/env bash
# E2E-11: Writer style engine smoke test.
# Verifies style validation and fixing via writer bridge.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

WRITER_BRIDGE_URL="${WRITER_BRIDGE_URL:-http://localhost:8084}"

echo "=== E2E-11: Writer Style Engine ==="
require_stack

# Place fixture style profile in artifacts
FIXTURE_PROFILE='{
  "name": "test-profile",
  "version": 1,
  "tone": { "formality": 0.7, "humor": 0.1, "enthusiasm": 0.4, "irreverence": 0.1 },
  "readability": { "target_grade": 10, "max_grade": 14 },
  "rhythm": { "burstiness_target": 0.55, "min_sentence_words": 3, "max_sentence_words": 45, "paragraph_length_variance": "high" },
  "voice": { "active_ratio": 0.85, "contractions": true, "first_person": false, "sentence_fragments": true },
  "vocabulary": {
    "blocklist_strict": ["delve", "tapestry", "multifaceted", "utilize", "harness", "leverage", "furthermore", "moreover"],
    "blocklist_soft": ["innovative", "cutting-edge", "seamless", "robust"],
    "preferred_alternatives": { "utilize": "use", "leverage": "use", "delve": "explore" }
  },
  "structure": { "max_em_dashes_per_1000": 3, "max_semicolons_per_1000": 2, "rule_of_three_cap": 0.3, "no_compulsive_summary": true },
  "platform": null,
  "citation_style": null,
  "copy_formula": null,
  "few_shot_samples": []
}'

mkdir -p ./artifacts/styles
echo "$FIXTURE_PROFILE" > ./artifacts/styles/test-profile.json

# --- Test 1: validate_style detects AI text ---
begin_test "E2E-11.1: validate_style flags AI-heavy text"
AI_TEXT="In today's rapidly evolving digital landscape, it is crucial to delve into the multifaceted nature of artificial intelligence. Furthermore, organizations must leverage cutting-edge technologies to harness the transformative potential. In conclusion, the comprehensive adoption will reshape everything."
RESULT=$(bridge_post "$WRITER_BRIDGE_URL" "{\"prompt\": \"Use the validate_style tool on this text: $AI_TEXT\"}" 120) || true
if echo "$RESULT" | grep -qi "violation\|excess_word\|fail"; then
    pass
else
    fail "validate_style did not detect violations in AI text"
fi

# --- Test 2: fix_violations replaces blocklist words ---
begin_test "E2E-11.2: fix_violations replaces excess words"
RESULT=$(bridge_post "$WRITER_BRIDGE_URL" "{\"prompt\": \"First validate_style on this text: 'Organizations must utilize innovative solutions and leverage robust frameworks.' Then fix_violations on the result.\"}" 120) || true
if echo "$RESULT" | grep -qi "use\|replace\|change"; then
    pass
else
    fail "fix_violations did not report word replacements"
fi

# --- Test 3: load_style_profile with test profile ---
begin_test "E2E-11.3: load_style_profile loads from path"
RESULT=$(bridge_post "$WRITER_BRIDGE_URL" "{\"prompt\": \"Use load_style_profile with path /artifacts/styles/test-profile.json\"}" 120) || true
if echo "$RESULT" | grep -qi "test-profile\|formality\|burstiness"; then
    pass
else
    fail "load_style_profile did not return profile contents"
fi

# --- Test 4: get_style_instructions generates instruction block ---
begin_test "E2E-11.4: get_style_instructions returns instructions"
RESULT=$(bridge_post "$WRITER_BRIDGE_URL" "{\"prompt\": \"Use load_style_profile with path /artifacts/styles/test-profile.json, then use get_style_instructions with that profile and platform=blog\"}" 120) || true
if echo "$RESULT" | grep -qi "tone\|heading\|scannable\|rhythm\|sentence"; then
    pass
else
    fail "get_style_instructions did not return style guidance"
fi

# --- Test 5: Vale lint availability ---
begin_test "E2E-11.5: Vale binary available in writer container"
VALE_OUT=$(docker compose exec -T writer vale --version 2>&1) || true
if echo "$VALE_OUT" | grep -qi "vale\|3\."; then
    pass
else
    skip "Vale not available in container (may not be built yet)"
fi

# Cleanup
rm -f ./artifacts/styles/test-profile.json

summary
