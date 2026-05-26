#!/usr/bin/env bash
# E2E-10: Social Media Research Workflow (manual orchestration, no Paperclip)
#
# End-to-end pipeline test:
#   1. Researcher discovers faceless tech channels on Instagram (max 10)
#   2. Researcher discovers faceless tech channels on TikTok (max 10)
#   3. Data agent scrapes channel profiles & metrics via Apify
#   4. Writer compiles findings into a summary report
#
# Uses Apify actors for Instagram/TikTok data. Requires APIFY_API_TOKEN in .env.
# Limits: 10 results per platform, last 30 days.

set -euo pipefail

# Ensure jq is on PATH (winget installs to WinGet/Links on Windows)
_WINUSER="${USER:-${USERNAME:-evano}}"
if [ -d "/c/Users/$_WINUSER/AppData/Local/Microsoft/WinGet/Links" ]; then
    export PATH="$PATH:/c/Users/$_WINUSER/AppData/Local/Microsoft/WinGet/Links"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

# --- Config ---
RESEARCHER_URL="${RESEARCHER_BRIDGE_URL:-http://localhost:8082}"
DATA_URL="${DATA_BRIDGE_URL:-http://localhost:8083}"
WRITER_URL="${WRITER_BRIDGE_URL:-http://localhost:8084}"
RUN_ID="social-$(date +%Y%m%d-%H%M%S)"
ARTIFACTS_DIR="/artifacts/$RUN_ID"
RESULTS_DIR="$SCRIPT_DIR/../results/$RUN_ID"
TIMEOUT=600

echo ""
echo "══════════════════════════════════════════════════════════════════"
echo "[E2E-10] Social Media Research Workflow"
echo "  Run ID:  $RUN_ID"
echo "  Results: $RESULTS_DIR"
echo "══════════════════════════════════════════════════════════════════"
echo ""

mkdir -p "$RESULTS_DIR"

# --- Helper: invoke agent, discard response body, check status only ---
# Bridge responses are 100-400KB JSON (full JSONL event stream). Too large for
# shell variable capture. We only need the HTTP status — artifacts are pulled
# directly from containers afterward.
#
# Usage: invoke_agent <url> <prompt>
# Returns 0 on success (HTTP 200), 1 on error/timeout
invoke_agent() {
    local url="$1"
    local prompt="$2"

    local body
    body=$(jq -n --arg p "$prompt" '{prompt: $p, workspace: "/workspace"}')

    local http_code
    http_code=$(curl -s -o /dev/null -w "%{http_code}" \
        --max-time "$TIMEOUT" \
        -X POST \
        -H "Content-Type: application/json" \
        -d "$body" \
        "$url/invoke" 2>/dev/null) || http_code="000"

    echo "  HTTP: $http_code"

    if [ "$http_code" = "200" ]; then
        return 0
    elif [ "$http_code" = "000" ]; then
        echo "  curl timeout or connection failed"
        return 1
    else
        echo "  Agent returned error status"
        return 1
    fi
}

# --- Preflight ---
echo "Checking agent health..."
for svc in "$RESEARCHER_URL" "$DATA_URL" "$WRITER_URL"; do
    if ! wait_healthy "$svc/health" 15; then
        echo "[FATAL] Agent not healthy at $svc"
        exit 1
    fi
done
echo "  All agents healthy."
echo ""

# Create artifacts dir in all agent containers
for ctr in agents-researcher-1 agents-data-1 agents-writer-1; do
    docker exec "$ctr" sh -c "mkdir -p $ARTIFACTS_DIR" 2>/dev/null || true
done

# ─────────────────────────────────────────────────────────────────────
# STEP 1: Researcher — Discover Instagram faceless tech channels
# ─────────────────────────────────────────────────────────────────────
begin_test "Researcher: Discover Instagram faceless tech channels"
echo "  Invoking Researcher for Instagram discovery..."

IG_PROMPT="You are researching faceless tech content channels on Instagram. Your task:

1. Use web_search to find faceless/anonymous tech content accounts on Instagram. Search for:
   - faceless tech Instagram accounts
   - anonymous tech content creators Instagram
   - tech education Instagram no face
   Focus on accounts posting about: AI/ML, cybersecurity, developer tools, tech news, fintech, vendor-specific (Claude, OpenAI, etc).

2. Compile up to 10 channels. For each provide:
   - Instagram handle
   - Estimated follower count
   - Primary niche/topic
   - Content format (carousels, reels, static)
   - Posting frequency if known

3. Score each finding with ADMIRALTY grading (source A-F, credibility 1-6, e.g. B2).

4. Write findings to $ARTIFACTS_DIR/instagram-channels.md as structured markdown with a table.

Limit to 10 channels maximum."

if invoke_agent "$RESEARCHER_URL" "$IG_PROMPT"; then
    docker cp "agents-researcher-1:$ARTIFACTS_DIR/instagram-channels.md" "$RESULTS_DIR/instagram-channels.md" 2>/dev/null
    if [ -f "$RESULTS_DIR/instagram-channels.md" ]; then
        echo "  Saved: instagram-channels.md ($(wc -c < "$RESULTS_DIR/instagram-channels.md") bytes)"
        pass
    else
        echo "  WARNING: Agent returned 200 but no artifact file found"
        fail "No instagram-channels.md artifact"
    fi
else
    # Check if artifact exists despite HTTP error (agent may have written before timeout)
    docker cp "agents-researcher-1:$ARTIFACTS_DIR/instagram-channels.md" "$RESULTS_DIR/instagram-channels.md" 2>/dev/null
    if [ -f "$RESULTS_DIR/instagram-channels.md" ]; then
        echo "  Agent timed out but artifact exists — partial success"
        echo "  Saved: instagram-channels.md ($(wc -c < "$RESULTS_DIR/instagram-channels.md") bytes)"
        pass
    else
        fail "Researcher Instagram discovery failed"
    fi
fi

echo ""

# ─────────────────────────────────────────────────────────────────────
# STEP 2: Researcher — Discover TikTok faceless tech channels
# ─────────────────────────────────────────────────────────────────────
begin_test "Researcher: Discover TikTok faceless tech channels"
echo "  Invoking Researcher for TikTok discovery..."

TT_PROMPT="You are researching faceless tech content channels on TikTok. Your task:

1. Use web_search to find faceless/anonymous tech content accounts on TikTok. Search for:
   - faceless tech TikTok accounts
   - anonymous tech content creators TikTok
   - tech education TikTok no face
   Focus on accounts posting about: AI/ML, cybersecurity, developer tools, tech news, fintech, vendor-specific (Claude, OpenAI, etc).

2. Compile up to 10 channels. For each provide:
   - TikTok handle
   - Estimated follower count
   - Primary niche/topic
   - Content style (voiceover, text overlay, screen recording, animation)
   - Posting frequency if known

3. Score each finding with ADMIRALTY grading (source A-F, credibility 1-6, e.g. C3).

4. Write findings to $ARTIFACTS_DIR/tiktok-channels.md as structured markdown with a table.

Limit to 10 channels maximum."

if invoke_agent "$RESEARCHER_URL" "$TT_PROMPT"; then
    docker cp "agents-researcher-1:$ARTIFACTS_DIR/tiktok-channels.md" "$RESULTS_DIR/tiktok-channels.md" 2>/dev/null
    if [ -f "$RESULTS_DIR/tiktok-channels.md" ]; then
        echo "  Saved: tiktok-channels.md ($(wc -c < "$RESULTS_DIR/tiktok-channels.md") bytes)"
        pass
    else
        fail "No tiktok-channels.md artifact"
    fi
else
    docker cp "agents-researcher-1:$ARTIFACTS_DIR/tiktok-channels.md" "$RESULTS_DIR/tiktok-channels.md" 2>/dev/null
    if [ -f "$RESULTS_DIR/tiktok-channels.md" ]; then
        echo "  Agent timed out but artifact exists — partial success"
        pass
    else
        fail "Researcher TikTok discovery failed"
    fi
fi

echo ""

# ─────────────────────────────────────────────────────────────────────
# STEP 3: Data agent — Scrape channel profiles via Apify
# ─────────────────────────────────────────────────────────────────────
begin_test "Data: Scrape channel profiles via Apify"
echo "  Invoking Data agent for profile scraping..."

# Copy researcher artifacts to data container
for f in instagram-channels.md tiktok-channels.md; do
    if [ -f "$RESULTS_DIR/$f" ]; then
        docker cp "$RESULTS_DIR/$f" "agents-data-1:$ARTIFACTS_DIR/$f" 2>/dev/null || true
    fi
done

DATA_PROMPT="You have research findings about faceless tech channels at:
- $ARTIFACTS_DIR/instagram-channels.md (Instagram channels)
- $ARTIFACTS_DIR/tiktok-channels.md (TikTok channels)

Your task: scrape public profile data for these channels using Apify.

1. Read both files to get channel handles.

2. For Instagram: use scrape_apify with actor apify/instagram-profile-scraper, max_results 10. When it returns a dataset ID, use apify_save_dataset to stream results to $ARTIFACTS_DIR/raw-instagram.json.

3. For TikTok: use list_actors to find best TikTok profile scraper, then scrape_apify, max_results 10. Use apify_save_dataset to save to $ARTIFACTS_DIR/raw-tiktok.json.

4. Read the saved JSON files, then compile scraped data into $ARTIFACTS_DIR/channel-profiles.md with:
   - One section per platform
   - Table: handle, followers, engagement rate, post count, bio excerpt
   - Note which channels could not be scraped

Important: always use apify_save_dataset to save actor results to a file instead of reading them inline. This keeps responses small. Be pragmatic — if an actor takes too long, note it and move on."

if invoke_agent "$DATA_URL" "$DATA_PROMPT"; then
    for f in channel-profiles.md raw-instagram.json raw-tiktok.json; do
        docker cp "agents-data-1:$ARTIFACTS_DIR/$f" "$RESULTS_DIR/$f" 2>/dev/null || true
    done
    if [ -f "$RESULTS_DIR/channel-profiles.md" ]; then
        echo "  Saved: channel-profiles.md ($(wc -c < "$RESULTS_DIR/channel-profiles.md") bytes)"
    fi
    pass
else
    # Check for partial artifacts
    for f in channel-profiles.md raw-instagram.json raw-tiktok.json; do
        docker cp "agents-data-1:$ARTIFACTS_DIR/$f" "$RESULTS_DIR/$f" 2>/dev/null || true
    done
    if [ -f "$RESULTS_DIR/channel-profiles.md" ]; then
        echo "  Agent timed out but artifacts exist — partial success"
        pass
    else
        fail "Data agent scraping failed"
    fi
fi

echo ""

# ─────────────────────────────────────────────────────────────────────
# STEP 4: Writer — Compile findings into report
# ─────────────────────────────────────────────────────────────────────
begin_test "Writer: Compile research into summary report"
echo "  Invoking Writer for report generation..."

# Copy all artifacts to writer container
for f in instagram-channels.md tiktok-channels.md channel-profiles.md; do
    if [ -f "$RESULTS_DIR/$f" ]; then
        docker cp "$RESULTS_DIR/$f" "agents-writer-1:$ARTIFACTS_DIR/$f" 2>/dev/null || true
    fi
done

WRITER_PROMPT="You have research and data about faceless tech channels at:
- $ARTIFACTS_DIR/instagram-channels.md (Researcher — Instagram)
- $ARTIFACTS_DIR/tiktok-channels.md (Researcher — TikTok)
- $ARTIFACTS_DIR/channel-profiles.md (Data agent scraped profiles)

Generate a summary document (doc_style: summary) synthesizing all findings.

Include:
1. Overview: channels found, platforms, niches covered
2. Top channels table: handle, platform, followers, engagement, niche, ADMIRALTY grade
3. Key patterns: content formats, posting frequency, niche opportunities
4. Gaps: missing data, unverified channels

Write to $ARTIFACTS_DIR/research-summary.md

Summary style: 500-1000 words, concise and actionable. Trust ADMIRALTY grades — B3 or better is solid, C3/D2 gets hedging language, worse gets excluded."

if invoke_agent "$WRITER_URL" "$WRITER_PROMPT"; then
    docker cp "agents-writer-1:$ARTIFACTS_DIR/research-summary.md" "$RESULTS_DIR/research-summary.md" 2>/dev/null
    if [ -f "$RESULTS_DIR/research-summary.md" ]; then
        WORD_COUNT=$(wc -w < "$RESULTS_DIR/research-summary.md")
        echo "  Saved: research-summary.md ($WORD_COUNT words)"
        pass
    else
        fail "No research-summary.md artifact"
    fi
else
    docker cp "agents-writer-1:$ARTIFACTS_DIR/research-summary.md" "$RESULTS_DIR/research-summary.md" 2>/dev/null
    if [ -f "$RESULTS_DIR/research-summary.md" ]; then
        echo "  Agent timed out but artifact exists — partial success"
        pass
    else
        fail "Writer report generation failed"
    fi
fi

echo ""

# ─────────────────────────────────────────────────────────────────────
# RESULTS
# ─────────────────────────────────────────────────────────────────────
echo "══════════════════════════════════════════════════════════════════"
echo "Artifacts collected in: $RESULTS_DIR"
echo ""
ls -la "$RESULTS_DIR/" 2>/dev/null || true
echo ""
echo "──────────────────────────────────────────────────────────────────"

summary
