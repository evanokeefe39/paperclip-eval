#!/usr/bin/env bash
# Data-driven real-world scraping test campaign.
#
# Reads site configs from sites.json. One generic runner for all sites.
# T1 uses cheerio in-container. T2/T3 use Python fetch-only scripts + cheerio parse.
#
# Usage:
#   ./real-world-tests.sh                    # run all phases
#   ./real-world-tests.sh phase1             # baseline only
#   ./real-world-tests.sh phase2 phase3      # specific phases
#   ./real-world-tests.sh site hackernews    # single site
#   ./real-world-tests.sh all                # all phases

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESULTS_DIR="$REPO_ROOT/tests/results"
COMPOSE_DIR="$REPO_ROOT/src/agents"
SITES_FILE="$SCRIPT_DIR/sites.json"

source "$REPO_ROOT/tests/e2e/helpers.sh"

# --- Config ---

APIFY_API_TOKEN="${APIFY_API_TOKEN:-}"
INTER_SITE_DELAY="${INTER_SITE_DELAY:-5}"
SAME_SITE_DELAY="${SAME_SITE_DELAY:-5}"
RISKY_SITE_DELAY="${RISKY_SITE_DELAY:-30}"
T2_TIMEOUT="${T2_TIMEOUT:-60}"
T3_TIMEOUT="${T3_TIMEOUT:-120}"
APIFY_POLL_TIMEOUT="${APIFY_POLL_TIMEOUT:-60}"

# --- Results matrix ---

declare -a MATRIX_ROWS=()

add_result() {
    local site="$1" t1="$2" t2="$3" t3="$4" t4="$5"
    local items="$6" errors="$7" duration="$8" cost="$9" notes="${10:-}"
    MATRIX_ROWS+=("| $site | $t1 | $t2 | $t3 | $t4 | $items | $errors | $duration | $cost | $notes |")
}

# --- Shared cheerio parse script (inline Node) ---
# All local tiers pipe raw HTML through this for extraction.

CHEERIO_PARSE_SCRIPT=$(cat <<'NODESCRIPT'
const fs = require("fs");
const cheerio = require("/usr/local/lib/node_modules/cheerio");
const params = JSON.parse(fs.readFileSync("/dev/stdin", "utf-8"));
const html = params.html;
const selector = params.selector;
const fields = params.extract_fields || {};
const maxItems = params.max_items || 100;
const keys = Object.keys(fields);
const items = [];
const $ = cheerio.load(html);
$(selector).each((i, el) => {
    if (items.length >= maxItems) return false;
    if (keys.length > 0) {
        const rec = {};
        for (const [k, v] of Object.entries(fields)) {
            rec[k] = $(el).find(v).text().trim() || $(el).find(v).attr("href") || "";
        }
        items.push(rec);
    } else {
        const t = $(el).text().trim();
        if (t) items.push({text: t});
    }
});
console.log(JSON.stringify({items, matchCount: $(selector).length}));
NODESCRIPT
)

# Parse raw HTML with cheerio inside the data container.
# $1=html_json (full fetch result JSON), $2=selector, $3=fields_json, $4=max_items
# All large data piped via stdin to avoid ARG_MAX limits.
cheerio_parse() {
    local html_json="$1" selector="$2" fields="$3" max_items="${4:-10}"

    local html_len
    html_len=$(echo "$html_json" | jq '.html | length // 0' 2>/dev/null) || html_len=0
    if [ "$html_len" -eq 0 ]; then
        echo '{"items":[],"matchCount":0}'
        return 0
    fi

    echo "$html_json" | \
        jq --arg sel "$selector" --argjson fields "$fields" --argjson max "$max_items" \
            '{html: .html, selector: $sel, extract_fields: $fields, max_items: $max}' | \
        docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T data \
            node -e "$CHEERIO_PARSE_SCRIPT" 2>/dev/null || echo '{"items":[],"matchCount":0}'
}

# --- Tier execution helpers ---
# T1: Node fetch + cheerio parse (all in one inline script for speed)
# T2/T3: Python fetch-only → cheerio parse

run_t1() {
    local url="$1" selector="$2" fields="$3" max_items="${4:-10}"
    local node_script
    node_script=$(cat <<'NODESCRIPT'
const cheerio = require("/usr/local/lib/node_modules/cheerio");
const params = JSON.parse(process.argv[1]);
(async () => {
    const start = Date.now();
    const items = [];
    const errors = [];
    let html = "";
    let statusCode = 0;
    try {
        const res = await fetch(params.url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            },
            signal: AbortSignal.timeout(15000)
        });
        statusCode = res.status;
        if (!res.ok) {
            errors.push("HTTP " + res.status);
        } else {
            html = await res.text();
            const $ = cheerio.load(html);
            const fields = params.extract_fields || {};
            const keys = Object.keys(fields);
            $(params.selector).each((i, el) => {
                if (items.length >= params.max_items) return false;
                if (keys.length > 0) {
                    const rec = {};
                    for (const [k, v] of Object.entries(fields)) {
                        rec[k] = $(el).find(v).text().trim() || $(el).find(v).attr("href") || "";
                    }
                    items.push(rec);
                } else {
                    const t = $(el).text().trim();
                    if (t) items.push({text: t});
                }
            });
        }
    } catch (e) {
        errors.push(e.message || String(e));
    }
    console.log(JSON.stringify({items, pages_crawled: 1, duration_ms: Date.now() - start, errors, status_code: statusCode, html_length: html.length}));
})();
NODESCRIPT
)
    local input
    input=$(jq -n \
        --arg url "$url" \
        --arg sel "$selector" \
        --argjson fields "$fields" \
        --argjson max "$max_items" \
        '{url: $url, selector: $sel, extract_fields: $fields, max_items: $max}')

    docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T data \
        node -e "$node_script" -- "$input" 2>/dev/null || echo '{"items":[],"pages_crawled":0,"duration_ms":0,"errors":["exec failed"]}'
}

run_t2() {
    local url="$1" selector="$2" fields="$3" max_items="${4:-10}"

    # Python fetches raw HTML
    local fetch_input
    fetch_input=$(jq -n --arg url "$url" '{url: $url}')

    local fetch_result
    fetch_result=$(timeout "$T2_TIMEOUT" docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T data \
        python3 /app/scripts/scrape_stealth.py "$fetch_input" 2>/dev/null) || {
        echo '{"items":[],"pages_crawled":0,"duration_ms":0,"errors":["timeout or exec failed"]}'
        return 0
    }

    # Check for fetch errors
    local fetch_errors
    fetch_errors=$(echo "$fetch_result" | jq '.errors | length // 0' 2>/dev/null) || fetch_errors=0
    local fetch_html_len
    fetch_html_len=$(echo "$fetch_result" | jq '.html | length // 0' 2>/dev/null) || fetch_html_len=0

    if [ "$fetch_html_len" -eq 0 ]; then
        local duration
        duration=$(echo "$fetch_result" | jq '.duration_ms // 0' 2>/dev/null) || duration=0
        local errs
        errs=$(echo "$fetch_result" | jq -c '.errors // []' 2>/dev/null) || errs="[]"
        echo "{\"items\":[],\"pages_crawled\":0,\"duration_ms\":$duration,\"errors\":$errs}"
        return 0
    fi

    # Cheerio parses the HTML
    local parse_result
    parse_result=$(cheerio_parse "$fetch_result" "$selector" "$fields" "$max_items")

    local items
    items=$(echo "$parse_result" | jq -c '.items // []' 2>/dev/null) || items="[]"
    local duration
    duration=$(echo "$fetch_result" | jq '.duration_ms // 0' 2>/dev/null) || duration=0
    local errs
    errs=$(echo "$fetch_result" | jq -c '.errors // []' 2>/dev/null) || errs="[]"

    echo "{\"items\":$items,\"pages_crawled\":1,\"duration_ms\":$duration,\"errors\":$errs}"
}

run_t3() {
    local url="$1" selector="$2" fields="$3" max_items="${4:-10}" wait_for="${5:-}"

    # Python fetches raw HTML with optional wait_for
    local fetch_input
    fetch_input=$(jq -n \
        --arg url "$url" \
        --arg wf "$wait_for" \
        '{url: $url, wait_for: (if $wf == "" then null else $wf end)}')

    local fetch_result
    fetch_result=$(timeout "$T3_TIMEOUT" docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T data \
        python3 /app/scripts/scrape_browser.py "$fetch_input" 2>/dev/null) || {
        echo '{"items":[],"pages_crawled":0,"duration_ms":0,"errors":["timeout or exec failed"]}'
        return 0
    }

    local fetch_html_len
    fetch_html_len=$(echo "$fetch_result" | jq '.html | length // 0' 2>/dev/null) || fetch_html_len=0

    if [ "$fetch_html_len" -eq 0 ]; then
        local duration
        duration=$(echo "$fetch_result" | jq '.duration_ms // 0' 2>/dev/null) || duration=0
        local errs
        errs=$(echo "$fetch_result" | jq -c '.errors // []' 2>/dev/null) || errs="[]"
        echo "{\"items\":[],\"pages_crawled\":0,\"duration_ms\":$duration,\"errors\":$errs}"
        return 0
    fi

    # Cheerio parses the HTML
    local parse_result
    parse_result=$(cheerio_parse "$fetch_result" "$selector" "$fields" "$max_items")

    local items
    items=$(echo "$parse_result" | jq -c '.items // []' 2>/dev/null) || items="[]"
    local duration
    duration=$(echo "$fetch_result" | jq '.duration_ms // 0' 2>/dev/null) || duration=0
    local errs
    errs=$(echo "$fetch_result" | jq -c '.errors // []' 2>/dev/null) || errs="[]"

    echo "{\"items\":$items,\"pages_crawled\":1,\"duration_ms\":$duration,\"errors\":$errs}"
}

run_t4() {
    local actor_id="$1" actor_input="$2" max_results="${3:-10}"
    if [ -z "$APIFY_API_TOKEN" ]; then
        echo '{"items":[],"errors":["APIFY_API_TOKEN not set"],"cost":"N/A","status":"SKIP"}'
        return 0
    fi

    local run_response
    run_response=$(curl -sf --max-time 30 \
        -X POST \
        -H "Content-Type: application/json" \
        -d "$actor_input" \
        "https://api.apify.com/v2/acts/${actor_id}/runs?token=${APIFY_API_TOKEN}" 2>/dev/null) || {
        echo '{"items":[],"errors":["Apify API call failed"],"cost":"N/A","status":"FAIL"}'
        return 0
    }

    local run_id dataset_id
    run_id=$(echo "$run_response" | jq -r '.data.id // empty')
    dataset_id=$(echo "$run_response" | jq -r '.data.defaultDatasetId // empty')

    if [ -z "$run_id" ]; then
        echo '{"items":[],"errors":["No run ID returned"],"cost":"N/A","status":"FAIL"}'
        return 0
    fi

    local deadline=$((SECONDS + APIFY_POLL_TIMEOUT))
    local status="RUNNING"
    while [ "$SECONDS" -lt "$deadline" ] && [ "$status" = "RUNNING" ] || [ "$status" = "READY" ]; do
        sleep 3
        local status_response
        status_response=$(curl -sf --max-time 10 \
            "https://api.apify.com/v2/actor-runs/${run_id}?token=${APIFY_API_TOKEN}" 2>/dev/null) || continue
        status=$(echo "$status_response" | jq -r '.data.status // "RUNNING"')
    done

    if [ "$status" = "SUCCEEDED" ] && [ -n "$dataset_id" ]; then
        local items_response
        items_response=$(curl -sf --max-time 30 \
            "https://api.apify.com/v2/datasets/${dataset_id}/items?token=${APIFY_API_TOKEN}&limit=${max_results}" 2>/dev/null) || items_response="[]"

        local item_count
        item_count=$(echo "$items_response" | jq 'length // 0')

        local usage_response
        usage_response=$(curl -sf --max-time 10 \
            "https://api.apify.com/v2/actor-runs/${run_id}?token=${APIFY_API_TOKEN}" 2>/dev/null) || usage_response="{}"
        local cost
        cost=$(echo "$usage_response" | jq -r '.data.usage.USD // "unknown"' 2>/dev/null) || cost="unknown"

        echo "{\"items\":$(echo "$items_response" | jq -c '.[0:5]'),\"item_count\":$item_count,\"errors\":[],\"cost\":\"$cost\",\"status\":\"SUCCEEDED\",\"run_id\":\"$run_id\"}"
    else
        echo "{\"items\":[],\"errors\":[\"Run status: $status\"],\"cost\":\"N/A\",\"status\":\"$status\",\"run_id\":\"$run_id\"}"
    fi
}

# --- Result classification ---

classify_result() {
    local json="$1"
    local item_count error_count
    item_count=$(echo "$json" | jq '.items | length // 0' 2>/dev/null) || item_count=0
    error_count=$(echo "$json" | jq '.errors | length // 0' 2>/dev/null) || error_count=0
    local first_error
    first_error=$(echo "$json" | jq -r '.errors[0] // ""' 2>/dev/null) || first_error=""

    if [ "$item_count" -gt 0 ] && [ "$error_count" -eq 0 ]; then
        echo "PASS"
    elif [ "$item_count" -gt 0 ] && [ "$error_count" -gt 0 ]; then
        echo "PARTIAL"
    elif echo "$first_error" | grep -qi "403\|forbidden\|blocked\|captcha\|challenge"; then
        echo "BLOCK"
    elif echo "$first_error" | grep -qi "timeout\|timed.out"; then
        echo "TIMEOUT"
    elif [ "$item_count" -eq 0 ] && [ "$error_count" -eq 0 ]; then
        echo "EMPTY"
    else
        echo "FAIL"
    fi
}

get_item_count() {
    echo "$1" | jq '.items | length // 0' 2>/dev/null || echo 0
}

get_duration() {
    echo "$1" | jq '.duration_ms // 0' 2>/dev/null || echo 0
}

get_errors() {
    echo "$1" | jq -r '.errors | length // 0' 2>/dev/null || echo 0
}

# --- Pre-flight readiness check ---

preflight() {
    echo "Pre-flight checks..."

    if ! docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T data echo "ok" >/dev/null 2>&1; then
        echo "[FATAL] Data container not running. Start with: docker compose up -d"
        exit 1
    fi
    echo "  Data container: OK"

    # Check tier capabilities based on sites to run
    local sites_json="$1"

    local needs_t2
    needs_t2=$(echo "$sites_json" | jq '[.[] | select(.tiers[] == "t2")] | length')
    if [ "$needs_t2" -gt 0 ]; then
        if docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T data \
            python3 -c "from scrapling import Fetcher" >/dev/null 2>&1; then
            echo "  T2 (scrapling Fetcher): OK"
        else
            echo "  [WARN] T2 requires scrapling — $needs_t2 sites will FAIL T2"
        fi
    fi

    local needs_t3
    needs_t3=$(echo "$sites_json" | jq '[.[] | select(.tiers[] == "t3")] | length')
    if [ "$needs_t3" -gt 0 ]; then
        if docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T data \
            test -f /app/.browsers-installed >/dev/null 2>&1; then
            echo "  T3 (browser): OK"
        else
            echo "  [WARN] T3 requires browser binaries — $needs_t3 sites will FAIL T3"
        fi
    fi

    local needs_t4
    needs_t4=$(echo "$sites_json" | jq '[.[] | select(.tiers[] == "t4")] | length')
    if [ "$needs_t4" -gt 0 ] && [ -z "$APIFY_API_TOKEN" ]; then
        echo "  [WARN] APIFY_API_TOKEN not set — $needs_t4 sites will SKIP T4"
    elif [ "$needs_t4" -gt 0 ]; then
        echo "  T4 (Apify): token set"
    fi

    echo "  Pre-flight: OK"
    echo ""
}

# --- Generic site runner ---
# Reads one site config object from sites.json and runs all its tiers.

run_site() {
    local config="$1"

    local name label url selector fields tiers risk max_items wait_for apify_actor apify_input notes
    name=$(echo "$config" | jq -r '.name')
    label=$(echo "$config" | jq -r '.label')
    url=$(echo "$config" | jq -r '.url // empty')
    selector=$(echo "$config" | jq -r '.selector // empty')
    fields=$(echo "$config" | jq -c '.extract_fields // {}')
    risk=$(echo "$config" | jq -r '.risk // "low"')
    max_items=$(echo "$config" | jq -r '.max_items // 10')
    wait_for=$(echo "$config" | jq -r '.wait_for // empty')
    apify_actor=$(echo "$config" | jq -r '.apify_actor // empty')
    apify_input=$(echo "$config" | jq -c '.apify_input // {}')
    notes=$(echo "$config" | jq -r '.notes // ""')

    local delay="$SAME_SITE_DELAY"
    if [ "$risk" = "high" ]; then delay="$RISKY_SITE_DELAY"; fi

    begin_test "$label ($name)"

    local s1="SKIP" s2="SKIP" s3="SKIP" s4="SKIP"
    local r1="" r2="" r3="" r4=""
    local best_items=0
    local best_dur=0

    # Read tier list
    local tier_list
    tier_list=$(echo "$config" | jq -r '.tiers[]')

    for tier in $tier_list; do
        case "$tier" in
            t1)
                if [ -z "$url" ] || [ -z "$selector" ]; then continue; fi
                log "  T1: cheerio..."
                r1=$(run_t1 "$url" "$selector" "$fields" "$max_items")
                s1=$(classify_result "$r1")
                local c=$(get_item_count "$r1")
                if [ "$c" -gt "$best_items" ]; then
                    best_items=$c
                    best_dur=$(get_duration "$r1")
                fi
                sleep "$delay"
                ;;
            t2)
                if [ -z "$url" ] || [ -z "$selector" ]; then continue; fi
                log "  T2: stealth..."
                r2=$(run_t2 "$url" "$selector" "$fields" "$max_items")
                s2=$(classify_result "$r2")
                local c=$(get_item_count "$r2")
                if [ "$c" -gt "$best_items" ]; then
                    best_items=$c
                    best_dur=$(get_duration "$r2")
                fi
                sleep "$delay"
                ;;
            t3)
                if [ -z "$url" ] || [ -z "$selector" ]; then continue; fi
                log "  T3: browser..."
                r3=$(run_t3 "$url" "$selector" "$fields" "$max_items" "$wait_for")
                s3=$(classify_result "$r3")
                local c=$(get_item_count "$r3")
                if [ "$c" -gt "$best_items" ]; then
                    best_items=$c
                    best_dur=$(get_duration "$r3")
                fi
                sleep "$delay"
                ;;
            t4)
                if [ -z "$apify_actor" ]; then continue; fi
                log "  T4: Apify ($apify_actor)..."
                r4=$(run_t4 "$apify_actor" "$apify_input" "$max_items")
                local t4_status
                t4_status=$(echo "$r4" | jq -r '.status // "FAIL"')
                if [ "$t4_status" = "SUCCEEDED" ]; then
                    s4="PASS"
                    local c
                    c=$(echo "$r4" | jq '.item_count // 0')
                    if [ "$c" -gt "$best_items" ]; then best_items=$c; fi
                elif [ "$t4_status" = "SKIP" ]; then
                    s4="SKIP"
                else
                    s4="$t4_status"
                fi
                ;;
        esac
    done

    local cost="N/A"
    if [ -n "$r4" ]; then
        cost=$(echo "$r4" | jq -r '.cost // "N/A"' 2>/dev/null) || cost="N/A"
    fi

    local err_count=0
    for r in "$r1" "$r2" "$r3"; do
        if [ -n "$r" ]; then
            local e
            e=$(get_errors "$r")
            err_count=$((err_count + e))
        fi
    done

    add_result "$label" "$s1" "$s2" "$s3" "$s4" "$best_items" "$err_count" "${best_dur}ms" "$cost" "$notes"

    # Determine pass/fail
    local any_pass=false
    for s in "$s1" "$s2" "$s3" "$s4"; do
        if [ "$s" = "PASS" ] || [ "$s" = "PARTIAL" ]; then any_pass=true; break; fi
    done

    # High-risk sites: blocking is expected, don't fail the suite
    if [ "$risk" = "high" ] && [ "$any_pass" = "false" ]; then
        skip "All tiers blocked/empty (expected for $risk-risk site) — T1=$s1 T2=$s2 T3=$s3 T4=$s4"
    elif [ "$any_pass" = "true" ]; then
        pass
    else
        fail "T1=$s1 T2=$s2 T3=$s3 T4=$s4"
    fi
}

# =========================================================================
#  Phase orchestration (data-driven from sites.json)
# =========================================================================

run_phase() {
    local phase_num="$1"
    local sites_json
    sites_json=$(jq -c "[.[] | select(.phase == $phase_num)]" "$SITES_FILE")

    local count
    count=$(echo "$sites_json" | jq 'length')
    if [ "$count" -eq 0 ]; then
        echo "No sites in phase $phase_num"
        return
    fi

    local phase_labels=("" "Baseline — Static / No Protection" "Tier Escalation — JS / Light Protection" "Anti-Bot Probing — Moderate Protection" "Stress / Gap Analysis — Extreme Protection")
    echo ""
    echo "=== Phase $phase_num: ${phase_labels[$phase_num]:-Phase $phase_num} ==="
    echo ""

    local i=0
    while [ "$i" -lt "$count" ]; do
        local site_config
        site_config=$(echo "$sites_json" | jq -c ".[$i]")
        run_site "$site_config"

        i=$((i + 1))
        if [ "$i" -lt "$count" ]; then
            sleep "$INTER_SITE_DELAY"
        fi
    done
}

# =========================================================================
#  Suite/site selection
# =========================================================================

PHASES_TO_RUN=()
SINGLE_SITE=""

if [ $# -eq 0 ]; then
    PHASES_TO_RUN=(1 2 3 4)
elif [ "$1" = "site" ] && [ $# -ge 2 ]; then
    SINGLE_SITE="$2"
else
    for arg in "$@"; do
        case "$arg" in
            phase1) PHASES_TO_RUN+=(1) ;;
            phase2) PHASES_TO_RUN+=(2) ;;
            phase3) PHASES_TO_RUN+=(3) ;;
            phase4) PHASES_TO_RUN+=(4) ;;
            all)    PHASES_TO_RUN=(1 2 3 4) ;;
            *)
                echo "[ERROR] Unknown argument: $arg"
                echo "Valid: phase1, phase2, phase3, phase4, all"
                echo "Single site: site <name>"
                echo "Available sites: $(jq -r '.[].name' "$SITES_FILE" | tr '\n' ' ')"
                exit 1
                ;;
        esac
    done
fi

# =========================================================================
#  Validate sites.json exists
# =========================================================================

if [ ! -f "$SITES_FILE" ]; then
    echo "[FATAL] sites.json not found at $SITES_FILE"
    exit 1
fi

# =========================================================================
#  Execution
# =========================================================================

echo "════════════════════════════════════════════════════════════════"
echo "  Real-World Scraping Test Campaign"
echo "  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ -n "$SINGLE_SITE" ]; then
    echo "  Mode: single site ($SINGLE_SITE)"
else
    echo "  Phases: ${PHASES_TO_RUN[*]}"
fi
echo "  Sites config: $SITES_FILE ($(jq 'length' "$SITES_FILE") sites)"
echo "  Apify token: $([ -n "$APIFY_API_TOKEN" ] && echo "set" || echo "NOT SET")"
echo "  Inter-site delay: ${INTER_SITE_DELAY}s"
echo "  Risky-site delay: ${RISKY_SITE_DELAY}s"
echo "════════════════════════════════════════════════════════════════"

# Determine which sites will run (for preflight)
if [ -n "$SINGLE_SITE" ]; then
    ACTIVE_SITES=$(jq -c "[.[] | select(.name == \"$SINGLE_SITE\")]" "$SITES_FILE")
    if [ "$(echo "$ACTIVE_SITES" | jq 'length')" -eq 0 ]; then
        echo "[ERROR] Unknown site: $SINGLE_SITE"
        echo "Available: $(jq -r '.[].name' "$SITES_FILE" | tr '\n' ' ')"
        exit 1
    fi
else
    phases_json=$(printf '%s\n' "${PHASES_TO_RUN[@]}" | jq -R -s 'split("\n") | map(select(. != "") | tonumber)')
    ACTIVE_SITES=$(jq -c --argjson phases "$phases_json" '[.[] | select(.phase as $p | $phases | index($p))]' "$SITES_FILE")
fi

preflight "$ACTIVE_SITES"

if [ -n "$SINGLE_SITE" ]; then
    site_config=$(echo "$ACTIVE_SITES" | jq -c '.[0]')
    run_site "$site_config"
else
    for phase in "${PHASES_TO_RUN[@]}"; do
        run_phase "$phase"
        echo ""
        echo "--- Phase $phase complete. Cooling down ${INTER_SITE_DELAY}s ---"
        sleep "$INTER_SITE_DELAY"
    done
fi

# =========================================================================
#  Results matrix
# =========================================================================

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  RESULTS MATRIX"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "| Site | T1 | T2 | T3 | T4 | Items | Errors | Duration | Cost | Notes |"
echo "|------|----|----|----|----|-------|--------|----------|------|-------|"
for row in "${MATRIX_ROWS[@]}"; do
    echo "$row"
done

# Write results file
mkdir -p "$RESULTS_DIR"
RESULTS_FILE="$RESULTS_DIR/real-world-$(date +%Y%m%d-%H%M%S).md"

cat > "$RESULTS_FILE" <<REPORT
# Real-World Scraping Test Results

**Date:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
**Phases:** ${PHASES_TO_RUN[*]:-$SINGLE_SITE}
**Passed:** $_PASS
**Failed:** $_FAIL
**Skipped:** $_SKIP

## Results Matrix

| Site | T1 | T2 | T3 | T4 | Items | Errors | Duration | Cost | Notes |
|------|----|----|----|----|-------|--------|----------|------|-------|
REPORT

for row in "${MATRIX_ROWS[@]}"; do
    echo "$row" >> "$RESULTS_FILE"
done

cat >> "$RESULTS_FILE" <<LEGEND

## Status Legend

- **PASS**: Data extracted successfully
- **PARTIAL**: Some data extracted, some errors
- **BLOCK**: 403 / captcha / challenge page returned
- **EMPTY**: Page loaded but selector matched nothing
- **TIMEOUT**: Request timed out
- **FAIL**: Other error
- **SKIP**: Tier not attempted for this site

## Key Findings

_Fill in after reviewing results:_

1. T1 vs T2 gap (where does TLS fingerprinting matter?):
2. T2 vs T3 gap (where does browser rendering matter?):
3. T3 ceiling (what blocks even our browser?):
4. Self-scrape wins over Apify:
5. Apify-only sites:
6. Neither works well:
LEGEND

echo ""
echo "Results written to: $RESULTS_FILE"
echo ""

summary
