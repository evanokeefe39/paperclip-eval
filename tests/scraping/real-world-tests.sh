#!/usr/bin/env bash
# Real-world scraping test campaign.
#
# Tests 20 sites across 5 difficulty levels against our 4-tier scraping stack.
# Calls Python scripts directly in Docker containers for deterministic tier selection.
#
# Usage:
#   ./real-world-tests.sh                    # run all phases
#   ./real-world-tests.sh phase1             # baseline only (sites 1-4)
#   ./real-world-tests.sh phase2 phase3      # specific phases
#   ./real-world-tests.sh site hackernews    # single site
#
# Phases: phase1, phase2, phase3, phase4, all
# Sites:  hackernews, books, wikipedia, github, imdb, yelp, reddit, ebay,
#         amazon, indeed, zillow, booking, etsy, googlemaps, walmart

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESULTS_DIR="$REPO_ROOT/tests/results"
COMPOSE_DIR="$REPO_ROOT/src/agents"

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

# --- Tier execution helpers ---
# These call scripts directly in the data container for deterministic tier selection.

run_t1() {
    local url="$1" selector="$2" fields="$3" max_items="${4:-10}"
    # T1: cheerio via inline Node in data container
    local node_script
    node_script=$(cat <<'NODESCRIPT'
const cheerio = require("/usr/local/lib/node_modules/cheerio");
const params = JSON.parse(process.argv[1]);
(async () => {
    const start = Date.now();
    const items = [];
    const errors = [];
    try {
        const res = await fetch(params.url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            },
            signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) {
            errors.push("HTTP " + res.status);
        } else {
            const html = await res.text();
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
    console.log(JSON.stringify({items, pages_crawled: 1, duration_ms: Date.now() - start, errors}));
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
    local input
    input=$(jq -n \
        --arg url "$url" \
        --arg sel "$selector" \
        --argjson fields "$fields" \
        --argjson max "$max_items" \
        '{url: $url, selector: $sel, extract_fields: $fields, max_items: $max}')

    timeout "$T2_TIMEOUT" docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T data \
        python3 /app/scripts/scrape_stealth.py "$input" 2>/dev/null || echo '{"items":[],"pages_crawled":0,"duration_ms":0,"errors":["timeout or exec failed"]}'
}

run_t3() {
    local url="$1" selector="$2" fields="$3" max_items="${4:-10}" wait_for="${5:-}"
    local input
    input=$(jq -n \
        --arg url "$url" \
        --arg sel "$selector" \
        --argjson fields "$fields" \
        --argjson max "$max_items" \
        --arg wf "$wait_for" \
        '{url: $url, selector: $sel, extract_fields: $fields, max_items: $max, wait_for: (if $wf == "" then null else $wf end)}')

    timeout "$T3_TIMEOUT" docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T data \
        python3 /app/scripts/scrape_browser.py "$input" 2>/dev/null || echo '{"items":[],"pages_crawled":0,"duration_ms":0,"errors":["timeout or exec failed"]}'
}

run_t4() {
    local actor_id="$1" actor_input="$2" max_results="${3:-10}"
    if [ -z "$APIFY_API_TOKEN" ]; then
        echo '{"items":[],"errors":["APIFY_API_TOKEN not set"],"cost":"N/A","status":"SKIP"}'
        return 0
    fi

    # Start actor run
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

    # Poll for completion
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

        # Get usage/cost
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
    local json="$1"
    echo "$json" | jq '.items | length // 0' 2>/dev/null || echo 0
}

get_duration() {
    local json="$1"
    echo "$json" | jq '.duration_ms // 0' 2>/dev/null || echo 0
}

get_errors() {
    local json="$1"
    echo "$json" | jq -r '.errors | length // 0' 2>/dev/null || echo 0
}

# --- Site test functions ---
# Each function tests one site through applicable tiers and records results.

test_hackernews() {
    begin_test "RW-1: Hacker News (news.ycombinator.com)"
    local url="https://news.ycombinator.com"
    local selector=".titleline"
    local fields='{"title": "a"}'

    local r1 r2 r3 s1 s2 s3

    log "  T1: cheerio..."
    r1=$(run_t1 "$url" "$selector" "$fields")
    s1=$(classify_result "$r1")
    sleep "$SAME_SITE_DELAY"

    log "  T2: stealth..."
    r2=$(run_t2 "$url" "$selector" "$fields")
    s2=$(classify_result "$r2")
    sleep "$SAME_SITE_DELAY"

    log "  T3: browser..."
    r3=$(run_t3 "$url" "$selector" "$fields")
    s3=$(classify_result "$r3")

    local items=$(get_item_count "$r1")
    local dur=$(get_duration "$r1")
    add_result "Hacker News" "$s1" "$s2" "$s3" "SKIP" "$items" "$(get_errors "$r1")" "${dur}ms" "N/A" "Level 1 baseline"

    if [ "$s1" = "PASS" ]; then pass; else fail "T1=$s1 T2=$s2 T3=$s3"; fi
}

test_books() {
    begin_test "RW-2: Books to Scrape (books.toscrape.com)"
    local url="https://books.toscrape.com"
    local selector="article.product_pod"
    local fields='{"title": "h3 a", "price": ".price_color"}'

    local r1 s1
    log "  T1: cheerio..."
    r1=$(run_t1 "$url" "$selector" "$fields" 20)
    s1=$(classify_result "$r1")

    local items=$(get_item_count "$r1")
    local dur=$(get_duration "$r1")
    add_result "Books to Scrape" "$s1" "SKIP" "SKIP" "SKIP" "$items" "$(get_errors "$r1")" "${dur}ms" "N/A" "Sandbox — T1 sufficient"

    if [ "$s1" = "PASS" ]; then pass; else fail "T1=$s1 items=$items"; fi
}

test_wikipedia() {
    begin_test "RW-3: Wikipedia (en.wikipedia.org)"
    local url="https://en.wikipedia.org/wiki/Web_scraping"
    local selector="#mw-content-text .mw-parser-output > p"
    local fields='{}'

    local r1 s1
    log "  T1: cheerio..."
    r1=$(run_t1 "$url" "$selector" "$fields" 5)
    s1=$(classify_result "$r1")

    local items=$(get_item_count "$r1")
    local dur=$(get_duration "$r1")
    add_result "Wikipedia" "$s1" "SKIP" "SKIP" "SKIP" "$items" "$(get_errors "$r1")" "${dur}ms" "N/A" "Level 1 — complex DOM"

    if [ "$s1" = "PASS" ]; then pass; else fail "T1=$s1"; fi
}

test_github() {
    begin_test "RW-4: GitHub Trending (github.com/trending)"
    local url="https://github.com/trending"
    local selector="article.Box-row"
    local fields='{"repo": "h2 a", "description": "p"}'

    local r1 r2 s1 s2
    log "  T1: cheerio..."
    r1=$(run_t1 "$url" "$selector" "$fields")
    s1=$(classify_result "$r1")
    sleep "$SAME_SITE_DELAY"

    log "  T2: stealth..."
    r2=$(run_t2 "$url" "$selector" "$fields")
    s2=$(classify_result "$r2")

    local items=$(get_item_count "$r1")
    if [ "$items" -eq 0 ]; then items=$(get_item_count "$r2"); fi
    local dur=$(get_duration "$r1")
    add_result "GitHub Trending" "$s1" "$s2" "SKIP" "SKIP" "$items" "$(get_errors "$r1")" "${dur}ms" "N/A" "May rate-limit"

    if [ "$s1" = "PASS" ] || [ "$s2" = "PASS" ]; then pass; else fail "T1=$s1 T2=$s2"; fi
}

test_imdb() {
    begin_test "RW-5: IMDb Top 250 (imdb.com/chart/top)"
    local url="https://www.imdb.com/chart/top/"
    local selector=".ipc-metadata-list-summary-item"
    local fields='{"title": ".ipc-title__text"}'

    local r1 r2 r3 s1 s2 s3
    log "  T1: cheerio..."
    r1=$(run_t1 "$url" "$selector" "$fields")
    s1=$(classify_result "$r1")
    sleep "$SAME_SITE_DELAY"

    log "  T2: stealth..."
    r2=$(run_t2 "$url" "$selector" "$fields")
    s2=$(classify_result "$r2")
    sleep "$SAME_SITE_DELAY"

    log "  T3: browser..."
    r3=$(run_t3 "$url" "$selector" "$fields" 10 ".ipc-metadata-list-summary-item")
    s3=$(classify_result "$r3")

    local best_items=0
    for r in "$r1" "$r2" "$r3"; do
        local c=$(get_item_count "$r")
        if [ "$c" -gt "$best_items" ]; then best_items=$c; fi
    done
    add_result "IMDb Top 250" "$s1" "$s2" "$s3" "SKIP" "$best_items" "$(get_errors "$r1")" "$(get_duration "$r1")ms" "N/A" "SSR + JS mix"

    if [ "$s1" = "PASS" ] || [ "$s2" = "PASS" ] || [ "$s3" = "PASS" ]; then pass; else fail "T1=$s1 T2=$s2 T3=$s3"; fi
}

test_yelp() {
    begin_test "RW-6: Yelp (yelp.com)"
    local url="https://www.yelp.com/search?find_desc=restaurants&find_loc=New+York"
    local selector="[data-testid='serp-ia-card']"
    local fields='{"name": "a h3", "rating": "div[aria-label]"}'

    local r1 r2 r3 s1 s2 s3
    log "  T1: cheerio..."
    r1=$(run_t1 "$url" "$selector" "$fields")
    s1=$(classify_result "$r1")
    sleep "$SAME_SITE_DELAY"

    log "  T2: stealth..."
    r2=$(run_t2 "$url" "$selector" "$fields")
    s2=$(classify_result "$r2")
    sleep "$SAME_SITE_DELAY"

    log "  T3: browser..."
    r3=$(run_t3 "$url" "$selector" "$fields" 10 "[data-testid='serp-ia-card']")
    s3=$(classify_result "$r3")

    local best_items=0
    for r in "$r1" "$r2" "$r3"; do
        local c=$(get_item_count "$r")
        if [ "$c" -gt "$best_items" ]; then best_items=$c; fi
    done
    add_result "Yelp" "$s1" "$s2" "$s3" "SKIP" "$best_items" "" "" "N/A" "Apify alternative is expensive"

    if [ "$s2" = "PASS" ] || [ "$s3" = "PASS" ]; then pass
    elif [ "$s1" = "PASS" ]; then pass
    else fail "T1=$s1 T2=$s2 T3=$s3"; fi
}

test_reddit() {
    begin_test "RW-7: Reddit Old (old.reddit.com/r/programming)"
    local url="https://old.reddit.com/r/programming"
    local selector=".thing .title"
    local fields='{"title": "a.title"}'

    local r1 r2 r3 s1 s2 s3
    log "  T1: cheerio..."
    r1=$(run_t1 "$url" "$selector" "$fields")
    s1=$(classify_result "$r1")
    sleep "$SAME_SITE_DELAY"

    log "  T2: stealth..."
    r2=$(run_t2 "$url" "$selector" "$fields")
    s2=$(classify_result "$r2")
    sleep "$SAME_SITE_DELAY"

    log "  T3: browser..."
    r3=$(run_t3 "$url" "$selector" "$fields")
    s3=$(classify_result "$r3")

    local best_items=0
    for r in "$r1" "$r2" "$r3"; do
        local c=$(get_item_count "$r")
        if [ "$c" -gt "$best_items" ]; then best_items=$c; fi
    done
    add_result "Reddit (old)" "$s1" "$s2" "$s3" "SKIP" "$best_items" "" "" "N/A" "Cloudflare — key self-scrape target"

    if [ "$s2" = "PASS" ] || [ "$s3" = "PASS" ]; then pass
    elif [ "$s1" = "PASS" ]; then pass
    else fail "T1=$s1 T2=$s2 T3=$s3 — all tiers blocked"; fi
}

test_ebay() {
    begin_test "RW-8: eBay (ebay.com)"
    local url="https://www.ebay.com/sch/i.html?_nkw=vintage+watches"
    local selector=".s-item"
    local fields='{"title": ".s-item__title", "price": ".s-item__price"}'

    local r1 r2 s1 s2
    log "  T1: cheerio..."
    r1=$(run_t1 "$url" "$selector" "$fields")
    s1=$(classify_result "$r1")
    sleep "$SAME_SITE_DELAY"

    log "  T2: stealth..."
    r2=$(run_t2 "$url" "$selector" "$fields")
    s2=$(classify_result "$r2")

    local best_items=0
    for r in "$r1" "$r2"; do
        local c=$(get_item_count "$r")
        if [ "$c" -gt "$best_items" ]; then best_items=$c; fi
    done
    add_result "eBay" "$s1" "$s2" "SKIP" "SKIP" "$best_items" "" "" "N/A" "Apify actors poor quality"

    if [ "$s1" = "PASS" ] || [ "$s2" = "PASS" ]; then pass; else fail "T1=$s1 T2=$s2"; fi
}

test_amazon() {
    begin_test "RW-9: Amazon Product (amazon.com)"
    local url="https://www.amazon.com/dp/B0D1XD1ZV3"
    local selector="#productTitle"
    local fields='{}'

    local r1 r2 r3 s1 s2 s3
    log "  T1: cheerio (expect block)..."
    r1=$(run_t1 "$url" "$selector" "$fields" 1)
    s1=$(classify_result "$r1")
    sleep "$RISKY_SITE_DELAY"

    log "  T2: stealth (expect block)..."
    r2=$(run_t2 "$url" "$selector" "$fields" 1)
    s2=$(classify_result "$r2")
    sleep "$RISKY_SITE_DELAY"

    log "  T3: browser (might work)..."
    r3=$(run_t3 "$url" "$selector" "$fields" 1 "#productTitle")
    s3=$(classify_result "$r3")

    add_result "Amazon" "$s1" "$s2" "$s3" "SKIP" "$(get_item_count "$r3")" "" "" "N/A" "AWS WAF — single request only"

    # Amazon blocking is expected — log status, don't fail the suite
    log "  Results: T1=$s1 T2=$s2 T3=$s3"
    if [ "$s3" = "PASS" ]; then pass
    else skip "Amazon blocked all local tiers (expected) — T1=$s1 T2=$s2 T3=$s3"; fi
}

test_indeed() {
    begin_test "RW-10: Indeed (indeed.com)"
    local url="https://www.indeed.com/jobs?q=software+engineer&l=remote"
    local selector=".job_seen_beacon"
    local fields='{"title": ".jobTitle a", "company": ".companyName"}'

    local r1 r2 r3 s1 s2 s3
    log "  T1: cheerio (expect block)..."
    r1=$(run_t1 "$url" "$selector" "$fields")
    s1=$(classify_result "$r1")
    sleep "$SAME_SITE_DELAY"

    log "  T2: stealth..."
    r2=$(run_t2 "$url" "$selector" "$fields")
    s2=$(classify_result "$r2")
    sleep "$SAME_SITE_DELAY"

    log "  T3: browser..."
    r3=$(run_t3 "$url" "$selector" "$fields" 10 ".job_seen_beacon")
    s3=$(classify_result "$r3")

    add_result "Indeed" "$s1" "$s2" "$s3" "SKIP" "" "" "" "N/A" "Cloudflare"

    log "  Results: T1=$s1 T2=$s2 T3=$s3"
    if [ "$s2" = "PASS" ] || [ "$s3" = "PASS" ]; then pass
    else skip "Indeed Cloudflare blocked local tiers — T1=$s1 T2=$s2 T3=$s3"; fi
}

test_zillow() {
    begin_test "RW-11: Zillow (zillow.com)"
    local url="https://www.zillow.com/homes/San-Francisco,-CA_rb/"
    local selector="article"
    local fields='{"address": "address"}'

    local r1 r3 s1 s3
    log "  T1: cheerio (expect block)..."
    r1=$(run_t1 "$url" "$selector" "$fields" 5)
    s1=$(classify_result "$r1")
    sleep "$RISKY_SITE_DELAY"

    log "  T3: browser (expect block — PerimeterX)..."
    r3=$(run_t3 "$url" "$selector" "$fields" 5 "article")
    s3=$(classify_result "$r3")

    add_result "Zillow" "$s1" "SKIP" "$s3" "SKIP" "$(get_item_count "$r3")" "" "" "N/A" "PerimeterX — single request"

    log "  Results: T1=$s1 T3=$s3"
    skip "Zillow PerimeterX — T1=$s1 T3=$s3 (blocking expected)"
}

test_booking() {
    begin_test "RW-12: Booking.com"
    local url="https://www.booking.com/searchresults.html?ss=London"
    local selector="[data-testid='property-card']"
    local fields='{"name": "[data-testid=title]"}'

    local r1 r3 s1 s3
    log "  T1: cheerio (expect block)..."
    r1=$(run_t1 "$url" "$selector" "$fields" 5)
    s1=$(classify_result "$r1")
    sleep "$RISKY_SITE_DELAY"

    log "  T3: browser..."
    r3=$(run_t3 "$url" "$selector" "$fields" 5 "[data-testid='property-card']")
    s3=$(classify_result "$r3")

    add_result "Booking.com" "$s1" "SKIP" "$s3" "SKIP" "$(get_item_count "$r3")" "" "" "N/A" "PerimeterX"

    log "  Results: T1=$s1 T3=$s3"
    skip "Booking.com PerimeterX — T1=$s1 T3=$s3"
}

test_etsy() {
    begin_test "RW-13: Etsy (DataDome)"
    local url="https://www.etsy.com/search?q=handmade+jewelry"
    local selector=".v2-listing-card"
    local fields='{"title": "h3"}'

    local r1 r2 r3 s1 s2 s3
    log "  T1: cheerio (expect block)..."
    r1=$(run_t1 "$url" "$selector" "$fields" 5)
    s1=$(classify_result "$r1")
    sleep "$RISKY_SITE_DELAY"

    log "  T2: stealth (expect block)..."
    r2=$(run_t2 "$url" "$selector" "$fields" 5)
    s2=$(classify_result "$r2")
    sleep "$RISKY_SITE_DELAY"

    log "  T3: browser (DataDome intent analysis)..."
    r3=$(run_t3 "$url" "$selector" "$fields" 5 ".v2-listing-card")
    s3=$(classify_result "$r3")

    add_result "Etsy" "$s1" "$s2" "$s3" "SKIP" "" "" "" "N/A" "DataDome — gap analysis target"

    log "  Results: T1=$s1 T2=$s2 T3=$s3"
    skip "Etsy DataDome — T1=$s1 T2=$s2 T3=$s3 (blocking expected)"
}

test_googlemaps() {
    begin_test "RW-14: Google Maps"
    local s4="SKIP"
    local items=0 cost="N/A"

    log "  T1-T3: SKIP (full SPA + Google protection)"

    if [ -n "$APIFY_API_TOKEN" ]; then
        log "  T4: Apify (compass/crawler-google-places)..."
        local input='{"searchStringsArray":["restaurants in San Francisco"],"maxCrawledPlacesPerSearch":5,"language":"en"}'
        local r4
        r4=$(run_t4 "compass/crawler-google-places" "$input" 5)
        s4=$(echo "$r4" | jq -r '.status // "FAIL"')
        items=$(echo "$r4" | jq '.item_count // 0')
        cost=$(echo "$r4" | jq -r '.cost // "unknown"')
        if [ "$s4" = "SUCCEEDED" ]; then s4="PASS"; fi
    fi

    add_result "Google Maps" "SKIP" "SKIP" "SKIP" "$s4" "$items" "" "" "$cost" "Best Apify actor (413K users)"

    if [ "$s4" = "PASS" ]; then pass
    else skip "Google Maps — Apify T4=$s4"; fi
}

test_walmart() {
    begin_test "RW-15: Walmart (PerimeterX)"
    local url="https://www.walmart.com/search?q=laptop"
    local selector="[data-testid='list-view']"
    local fields='{"title": "[data-automation-id=product-title]"}'

    local r1 r3 s1 s3
    log "  T1: cheerio (expect block)..."
    r1=$(run_t1 "$url" "$selector" "$fields" 5)
    s1=$(classify_result "$r1")
    sleep "$RISKY_SITE_DELAY"

    log "  T3: browser (PerimeterX, variable aggressiveness)..."
    r3=$(run_t3 "$url" "$selector" "$fields" 5)
    s3=$(classify_result "$r3")

    add_result "Walmart" "$s1" "SKIP" "$s3" "SKIP" "$(get_item_count "$r3")" "" "" "N/A" "PerimeterX — variable difficulty"

    log "  Results: T1=$s1 T3=$s3"
    skip "Walmart PerimeterX — T1=$s1 T3=$s3"
}

# =========================================================================
#  Phase orchestration
# =========================================================================

run_phase1() {
    echo ""
    echo "=== Phase 1: Baseline — Static / No Protection (Sites 1-4) ==="
    echo "  Expect: T1 pass on all sites"
    echo ""

    test_hackernews
    sleep "$INTER_SITE_DELAY"
    test_books
    sleep "$INTER_SITE_DELAY"
    test_wikipedia
    sleep "$INTER_SITE_DELAY"
    test_github
}

run_phase2() {
    echo ""
    echo "=== Phase 2: Tier Escalation — JS / Light Protection (Sites 5-8) ==="
    echo "  Expect: T1 partial/fail, T2/T3 pass"
    echo ""

    test_imdb
    sleep "$INTER_SITE_DELAY"
    test_yelp
    sleep "$INTER_SITE_DELAY"
    test_reddit
    sleep "$INTER_SITE_DELAY"
    test_ebay
}

run_phase3() {
    echo ""
    echo "=== Phase 3: Anti-Bot Probing — Moderate Protection (Sites 9-12) ==="
    echo "  Expect: T1-T2 fail, T3 uncertain, some need T4"
    echo "  WARNING: Using extended delays between requests"
    echo ""

    test_amazon
    sleep "$INTER_SITE_DELAY"
    test_indeed
    sleep "$INTER_SITE_DELAY"
    test_zillow
    sleep "$INTER_SITE_DELAY"
    test_booking
}

run_phase4() {
    echo ""
    echo "=== Phase 4: Stress / Gap Analysis — Extreme Protection (Sites 13-15) ==="
    echo "  Testing our stack ceiling. Extended delays."
    echo ""

    test_etsy
    sleep "$INTER_SITE_DELAY"
    test_googlemaps
    sleep "$INTER_SITE_DELAY"
    test_walmart
}

# =========================================================================
#  Suite/site selection
# =========================================================================

PHASES_TO_RUN=()
SINGLE_SITE=""

if [ $# -eq 0 ]; then
    PHASES_TO_RUN=(phase1 phase2 phase3 phase4)
elif [ "$1" = "site" ] && [ $# -ge 2 ]; then
    SINGLE_SITE="$2"
else
    for arg in "$@"; do
        case "$arg" in
            phase1|phase2|phase3|phase4)
                PHASES_TO_RUN+=("$arg")
                ;;
            all)
                PHASES_TO_RUN=(phase1 phase2 phase3 phase4)
                ;;
            *)
                echo "[ERROR] Unknown phase: $arg"
                echo "Valid: phase1, phase2, phase3, phase4, all"
                echo "Single site: site <name> (hackernews|books|wikipedia|github|imdb|yelp|reddit|ebay|amazon|indeed|zillow|booking|etsy|googlemaps|walmart)"
                exit 1
                ;;
        esac
    done
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
echo "  Apify token: $([ -n "$APIFY_API_TOKEN" ] && echo "set" || echo "NOT SET")"
echo "  Inter-site delay: ${INTER_SITE_DELAY}s"
echo "  Risky-site delay: ${RISKY_SITE_DELAY}s"
echo "════════════════════════════════════════════════════════════════"

# Pre-flight: verify data container is running
if ! docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T data echo "ok" >/dev/null 2>&1; then
    echo "[FATAL] Data container not running. Start with: docker compose up -d"
    exit 1
fi
echo "  Data container: OK"

if [ -n "$SINGLE_SITE" ]; then
    case "$SINGLE_SITE" in
        hackernews)  test_hackernews ;;
        books)       test_books ;;
        wikipedia)   test_wikipedia ;;
        github)      test_github ;;
        imdb)        test_imdb ;;
        yelp)        test_yelp ;;
        reddit)      test_reddit ;;
        ebay)        test_ebay ;;
        amazon)      test_amazon ;;
        indeed)      test_indeed ;;
        zillow)      test_zillow ;;
        booking)     test_booking ;;
        etsy)        test_etsy ;;
        googlemaps)  test_googlemaps ;;
        walmart)     test_walmart ;;
        *)
            echo "[ERROR] Unknown site: $SINGLE_SITE"
            exit 1
            ;;
    esac
else
    for phase in "${PHASES_TO_RUN[@]}"; do
        "run_${phase}"
        echo ""
        echo "--- Phase complete. Cooling down ${INTER_SITE_DELAY}s ---"
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
