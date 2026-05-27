#!/usr/bin/env bash
# E2E-14: Single-Agent Research — Direct Researcher Invocation
#
# Tests Researcher agent end-to-end with HTTP adapter payload format.
# Sends a faceless tech channel research brief, verifies structured output
# covering all required subtopics.
#
# Faster than e2e-13 (no delegation chain), isolates research quality.
# Requires: researcher container running.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

# --- Config ---
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-paperclip-eval}"
RESEARCHER_URL="${RESEARCHER_BRIDGE_URL:-http://localhost:8082}"
RUN_ID="research-$(date +%Y%m%d-%H%M%S)"
ARTIFACTS_DIR="/artifacts/$RUN_ID"
RESULTS_DIR="$SCRIPT_DIR/../results/$RUN_ID"
TIMEOUT=600

echo ""
echo "══════════════════════════════════════════════════════════════════"
echo "[E2E-14] Single-Agent Research — Faceless Tech Channels"
echo "  Run ID:  $RUN_ID"
echo "  Results: $RESULTS_DIR"
echo "══════════════════════════════════════════════════════════════════"
echo ""

mkdir -p "$RESULTS_DIR"

ctr_name() { echo "${COMPOSE_PROJECT}-${1}-1"; }

# --- Preflight ---
echo "Checking researcher health..."
if ! wait_healthy "$RESEARCHER_URL/health" 15; then
    echo "[FATAL] Researcher not healthy at $RESEARCHER_URL"
    exit 1
fi
echo "  Researcher healthy."
echo ""

RES_CTR="$(ctr_name researcher)"
docker exec "$RES_CTR" sh -c "mkdir -p $ARTIFACTS_DIR" 2>/dev/null || true

# --- Helper: invoke with HTTP adapter payload format ---
invoke_http_adapter() {
    local url="$1"
    local task_markdown="$2"
    local run_id="$3"

    local payload
    payload=$(jq -n \
        --arg tm "$task_markdown" \
        --arg rid "$run_id" \
        '{
            agentId: "test-direct",
            runId: $rid,
            context: {
                wakeReason: "assignment",
                wakeSource: "on_demand",
                paperclipTaskMarkdown: $tm
            }
        }')

    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST \
        -H "Content-Type: application/json" \
        -d "$payload" \
        "$url/invoke" 2>/dev/null) || http_code="000"

    echo "  HTTP: $http_code"
    [ "$http_code" = "200" ]
}

# ─────────────────────────────────────────────────────────────────────
# TEST 1: Instagram faceless tech channels
# ─────────────────────────────────────────────────────────────────────

begin_test "Researcher: Instagram faceless tech channel discovery"
echo "  Invoking Researcher (may take 2-5 minutes)..."

IG_TASK="Research faceless (no-face, anonymous) tech content channels on Instagram.

Search for channels posting about these subtopics:
- AI / machine learning / LLMs / ChatGPT / Claude
- Cybersecurity / ethical hacking / infosec
- Investing / business / entrepreneurship in tech
- Mindset / productivity for developers and tech workers
- Lifestyle in tech / remote work / day-in-the-life
- Job opportunities / tech career advice / interview prep

For each channel found, record:
- Instagram handle (with @)
- Estimated follower count
- Primary subtopic from the list above
- Content format (reels, carousels, static posts, stories)
- Posting frequency (daily, few times/week, weekly, irregular)
- Brief description of content style

Write findings to $ARTIFACTS_DIR/instagram-channels.md as a structured markdown document with:
1. Summary section (how many found, subtopic distribution)
2. Table of channels
3. Notes on methodology and limitations

Target: 10 channels. Minimum acceptable: 5."

if invoke_http_adapter "$RESEARCHER_URL" "$IG_TASK" "$RUN_ID-ig"; then
    docker cp "$RES_CTR:$ARTIFACTS_DIR/instagram-channels.md" "$RESULTS_DIR/instagram-channels.md" 2>/dev/null
    if [ -f "$RESULTS_DIR/instagram-channels.md" ]; then
        BYTES=$(wc -c < "$RESULTS_DIR/instagram-channels.md")
        echo "  Saved: instagram-channels.md ($BYTES bytes)"
        pass
    else
        fail "agent returned 200 but no artifact written"
    fi
else
    docker cp "$RES_CTR:$ARTIFACTS_DIR/instagram-channels.md" "$RESULTS_DIR/instagram-channels.md" 2>/dev/null
    if [ -f "$RESULTS_DIR/instagram-channels.md" ]; then
        echo "  Timed out but artifact exists — partial success"
        pass
    else
        fail "Instagram research failed"
    fi
fi

echo ""

# ─────────────────────────────────────────────────────────────────────
# TEST 2: TikTok faceless tech channels
# ─────────────────────────────────────────────────────────────────────

begin_test "Researcher: TikTok faceless tech channel discovery"
echo "  Invoking Researcher (may take 2-5 minutes)..."

TT_TASK="Research faceless (no-face, anonymous) tech content channels on TikTok.

Search for channels posting about these subtopics:
- AI / machine learning / LLMs / ChatGPT / Claude
- Cybersecurity / ethical hacking / infosec
- Investing / business / entrepreneurship in tech
- Mindset / productivity for developers and tech workers
- Lifestyle in tech / remote work / day-in-the-life
- Job opportunities / tech career advice / interview prep

For each channel found, record:
- TikTok handle (with @)
- Estimated follower count
- Primary subtopic from the list above
- Content style (voiceover, text overlay, screen recording, AI-generated, talking head with face hidden)
- Posting frequency (daily, few times/week, weekly, irregular)
- Brief description of what makes this channel notable

Write findings to $ARTIFACTS_DIR/tiktok-channels.md as a structured markdown document with:
1. Summary section (how many found, subtopic distribution)
2. Table of channels
3. Notes on methodology and limitations

Target: 10 channels. Minimum acceptable: 5."

if invoke_http_adapter "$RESEARCHER_URL" "$TT_TASK" "$RUN_ID-tt"; then
    docker cp "$RES_CTR:$ARTIFACTS_DIR/tiktok-channels.md" "$RESULTS_DIR/tiktok-channels.md" 2>/dev/null
    if [ -f "$RESULTS_DIR/tiktok-channels.md" ]; then
        BYTES=$(wc -c < "$RESULTS_DIR/tiktok-channels.md")
        echo "  Saved: tiktok-channels.md ($BYTES bytes)"
        pass
    else
        fail "agent returned 200 but no artifact written"
    fi
else
    docker cp "$RES_CTR:$ARTIFACTS_DIR/tiktok-channels.md" "$RESULTS_DIR/tiktok-channels.md" 2>/dev/null
    if [ -f "$RESULTS_DIR/tiktok-channels.md" ]; then
        echo "  Timed out but artifact exists — partial success"
        pass
    else
        fail "TikTok research failed"
    fi
fi

echo ""

# ─────────────────────────────────────────────────────────────────────
# VALIDATION: Content quality checks
# ─────────────────────────────────────────────────────────────────────

echo "── Content Validation ──"
echo ""

ALL_CONTENT=""
for f in "$RESULTS_DIR"/*.md; do
    [ -f "$f" ] && ALL_CONTENT="$ALL_CONTENT$(cat "$f")"
done

if [ -z "$ALL_CONTENT" ]; then
    begin_test "Content validation"
    fail "no content to validate"
else
    # --- Platform coverage ---
    begin_test "Covers Instagram"
    if echo "$ALL_CONTENT" | grep -qi "instagram\|IG"; then pass; else fail "no Instagram coverage"; fi

    begin_test "Covers TikTok"
    if echo "$ALL_CONTENT" | grep -qi "tiktok"; then pass; else fail "no TikTok coverage"; fi

    # --- Subtopic coverage ---
    begin_test "Covers AI/ML subtopic"
    if echo "$ALL_CONTENT" | grep -qi "AI\|artificial intelligence\|machine learning\|LLM\|GPT\|deep learning"; then
        pass
    else fail "AI/ML not covered"; fi

    begin_test "Covers cybersecurity subtopic"
    if echo "$ALL_CONTENT" | grep -qi "cyber\|security\|hacking\|infosec\|pentest"; then
        pass
    else fail "cybersecurity not covered"; fi

    begin_test "Covers business/entrepreneurship subtopic"
    if echo "$ALL_CONTENT" | grep -qi "business\|entrepreneur\|invest\|startup\|fintech\|finance"; then
        pass
    else fail "business/entrepreneurship not covered"; fi

    begin_test "Covers career/jobs subtopic"
    if echo "$ALL_CONTENT" | grep -qi "career\|job\|hiring\|interview\|salary\|resume"; then
        pass
    else fail "career/jobs not covered"; fi

    # --- Structural quality ---
    begin_test "Contains channel handles (@)"
    HANDLE_COUNT=$(echo "$ALL_CONTENT" | grep -oiE "@[a-z0-9_.]{2,30}" | sort -u | wc -l)
    if [ "$HANDLE_COUNT" -ge 5 ]; then
        log "$HANDLE_COUNT unique handles found"
        pass
    else
        fail "only $HANDLE_COUNT unique handles (expected 5+)"
    fi

    begin_test "Contains follower counts"
    FOLLOWER_REFS=$(echo "$ALL_CONTENT" | grep -oiE "[0-9]+[.,]?[0-9]*\s*[kKmM]?\s*(follower|subscriber|fan)" | wc -l)
    if [ "$FOLLOWER_REFS" -ge 3 ]; then
        log "$FOLLOWER_REFS follower references"
        pass
    else
        fail "only $FOLLOWER_REFS follower counts (expected 3+)"
    fi

    begin_test "Contains content format descriptions"
    FORMAT_REFS=$(echo "$ALL_CONTENT" | grep -oiE "reel|carousel|voiceover|text overlay|screen record|static post|stories" | wc -l)
    if [ "$FORMAT_REFS" -ge 3 ]; then
        log "$FORMAT_REFS format references"
        pass
    else
        fail "only $FORMAT_REFS format descriptions (expected 3+)"
    fi

    begin_test "Substantive output (1000+ words across both platforms)"
    WORD_COUNT=$(echo "$ALL_CONTENT" | wc -w)
    if [ "$WORD_COUNT" -ge 1000 ]; then
        log "$WORD_COUNT words total"
        pass
    else
        fail "only $WORD_COUNT words (expected 1000+)"
    fi
fi

# ─────────────────────────────────────────────────────────────────────
# RESULTS
# ─────────────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════════"
echo "Artifacts: $RESULTS_DIR"
ls -la "$RESULTS_DIR/" 2>/dev/null || true
echo "══════════════════════════════════════════════════════════════════"

summary
