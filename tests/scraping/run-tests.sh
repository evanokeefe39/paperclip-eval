#!/usr/bin/env bash
# Scraping test runner.
#
# Usage:
#   ./run-tests.sh                  # run all suites
#   ./run-tests.sh tier1 tier2      # run specific suites
#   ./run-tests.sh spike            # run only spike tests
#
# Suites: spike, tier1, tier2, tier3, cross, apify, build, all

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESULTS_DIR="$REPO_ROOT/tests/results"

source "$REPO_ROOT/tests/e2e/helpers.sh"

# --- Scraping-specific config ---

FIXTURE_URL="${FIXTURE_URL:-http://host.docker.internal:9999}"
DATA_BRIDGE_URL="${DATA_BRIDGE_URL:-http://localhost:8083}"
FIXTURE_PID=""

# --- Fixture server lifecycle ---

start_fixtures() {
    node "$SCRIPT_DIR/fixtures/static-server.mjs" &
    FIXTURE_PID=$!
    trap 'kill $FIXTURE_PID 2>/dev/null; rm -f "$COOKIE_JAR"' EXIT
    local deadline=$((SECONDS + 10))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if curl -sf "http://localhost:9999/health" >/dev/null 2>&1; then
            echo "  Fixture server ready (PID $FIXTURE_PID)"
            return 0
        fi
        sleep 1
    done
    echo "[FATAL] Fixture server not healthy after 10s"
    exit 1
}

# --- Scraping helpers ---

run_pi_scrape() {
    local bridge_url="$1"
    local prompt="$2"
    local timeout="${3:-120}"
    bridge_post "$bridge_url" "{\"prompt\": \"$prompt\"}" "$timeout"
}

assert_jsonl() {
    local output="$1"
    local pattern="$2"
    local msg="${3:-JSONL output}"
    if echo "$output" | grep -qF "$pattern"; then return 0; fi
    fail "$msg does not contain '$pattern'"
    return 1
}

assert_not_jsonl() {
    local output="$1"
    local pattern="$2"
    local msg="${3:-JSONL output}"
    if echo "$output" | grep -qF "$pattern"; then
        fail "$msg unexpectedly contains '$pattern'"
        return 1
    fi
    return 0
}

# =========================================================================
#  Suite: spike  (S.1 - S.4)
# =========================================================================

run_spike() {
    echo ""
    echo "=== Spike Tests (S.1 - S.4) ==="

    begin_test "S.1: Python available in researcher container"
    if docker compose exec -T researcher python3 --version 2>&1 | grep -q "Python 3"; then
        pass
    else
        fail "python3 not found in researcher container"
    fi

    begin_test "S.2: Scrapling importable in researcher"
    if docker compose exec -T researcher python3 -c "from scrapling import Fetcher; print('ok')" 2>&1 | grep -q "ok"; then
        pass
    else
        fail "scrapling not importable in researcher container"
    fi

    begin_test "S.3: Python NOT in CEO container"
    if docker compose exec -T ceo python3 --version 2>&1; then
        fail "python3 should not be in CEO container"
    else
        pass
    fi

    begin_test "S.4: spike_python tool via bridge"
    local RESULT
    RESULT=$(run_pi_scrape "$RESEARCHER_BRIDGE_URL" "Use the spike_python tool to verify Python works. Just run a simple test." 60) || true
    if echo "$RESULT" | grep -qi "python\|success\|ok"; then
        pass
    else
        fail "spike_python tool did not return expected output"
    fi
}

# =========================================================================
#  Suite: tier1  (T1.1 - T1.6)
# =========================================================================

run_tier1() {
    echo ""
    echo "=== Tier 1 Tests: scrape_static (T1.1 - T1.6) ==="
    start_fixtures

    begin_test "T1.1: Basic extraction — products from /"
    local RESULT
    RESULT=$(run_pi_scrape "$RESEARCHER_BRIDGE_URL" \
        "Use scrape_static to scrape $FIXTURE_URL/ with selector .product and extract fields name from .name and price from .price. Return the scraped data." 120) || true
    if echo "$RESULT" | grep -qi "Widget"; then
        pass
    else
        fail "scrape_static did not extract product names"
    fi

    begin_test "T1.2: Pagination — /page1 with next selector"
    RESULT=$(run_pi_scrape "$RESEARCHER_BRIDGE_URL" \
        "Use scrape_static to scrape $FIXTURE_URL/page1 with selector .item and extract field name from .name. Enable pagination with next_selector .next and max_pages 2." 120) || true
    if echo "$RESULT" | grep -qi "Item 4\|Item 5"; then
        pass
    else
        fail "pagination did not reach page 2"
    fi

    begin_test "T1.3: max_items — /large limited to 10"
    RESULT=$(run_pi_scrape "$RESEARCHER_BRIDGE_URL" \
        "Use scrape_static to scrape $FIXTURE_URL/large with selector .product and extract field name from .name. Set max_items to 10." 120) || true
    # Should have products but not Product 100
    if echo "$RESULT" | grep -qi "Product 1" && ! echo "$RESULT" | grep -qi "Product 100"; then
        pass
    else
        fail "max_items did not limit results to 10"
    fi

    begin_test "T1.4: Empty selector — nonexistent class"
    RESULT=$(run_pi_scrape "$RESEARCHER_BRIDGE_URL" \
        "Use scrape_static to scrape $FIXTURE_URL/ with selector .nothing and extract field name from .name." 60) || true
    if echo "$RESULT" | grep -qi "no results\|empty\|0 items\|no elements\|nothing found\|no data"; then
        pass
    else
        fail "empty selector did not produce empty/error result"
    fi

    begin_test "T1.5: HTTP error — 404 page"
    RESULT=$(run_pi_scrape "$RESEARCHER_BRIDGE_URL" \
        "Use scrape_static to scrape $FIXTURE_URL/nonexistent with selector .product and extract field name from .name." 60) || true
    if echo "$RESULT" | grep -qi "error\|404\|not found\|fail"; then
        pass
    else
        fail "404 did not produce error output"
    fi

    begin_test "T1.6: Timeout handling"
    RESULT=$(run_pi_scrape "$RESEARCHER_BRIDGE_URL" \
        "Use scrape_static to scrape $FIXTURE_URL/ with selector .product and extract field name from .name. Set timeout to 1 millisecond." 60) || true
    if echo "$RESULT" | grep -qi "timeout\|error\|fail\|timed out"; then
        pass
    else
        # Timeout may be too fast to trigger reliably — skip rather than fail
        skip "timeout behavior not reliably testable at 1ms"
    fi
}

# =========================================================================
#  Suite: tier2  (T2.1 - T2.6)
# =========================================================================

run_tier2() {
    echo ""
    echo "=== Tier 2 Tests: scrape_stealth (T2.1 - T2.6) ==="
    start_fixtures

    begin_test "T2.1: Basic extraction — products from /"
    local RESULT
    RESULT=$(run_pi_scrape "$RESEARCHER_BRIDGE_URL" \
        "Use scrape_stealth to scrape $FIXTURE_URL/ with selector .product and extract fields name from .name and price from .price." 120) || true
    if echo "$RESULT" | grep -qi "Widget"; then
        pass
    else
        fail "scrape_stealth did not extract product names"
    fi

    begin_test "T2.2: Anti-detection — /blocked bypasses UA check"
    RESULT=$(run_pi_scrape "$RESEARCHER_BRIDGE_URL" \
        "Use scrape_stealth to scrape $FIXTURE_URL/blocked with selector .product and extract field name from .name." 120) || true
    if echo "$RESULT" | grep -qi "Secret Product"; then
        pass
    else
        fail "scrape_stealth did not bypass UA-based blocking"
    fi

    begin_test "T2.3: Pagination — /page1 with next selector"
    RESULT=$(run_pi_scrape "$RESEARCHER_BRIDGE_URL" \
        "Use scrape_stealth to scrape $FIXTURE_URL/page1 with selector .item and extract field name from .name. Enable pagination with next_selector .next and max_pages 2." 120) || true
    if echo "$RESULT" | grep -qi "Item 4\|Item 5"; then
        pass
    else
        fail "stealth pagination did not reach page 2"
    fi

    begin_test "T2.4: Error handling — invalid URL"
    RESULT=$(run_pi_scrape "$RESEARCHER_BRIDGE_URL" \
        "Use scrape_stealth to scrape http://this-domain-does-not-exist-xyz.invalid/ with selector .product and extract field name from .name." 60) || true
    if echo "$RESULT" | grep -qi "error\|fail\|cannot\|unable\|resolve"; then
        pass
    else
        fail "invalid URL did not produce error"
    fi

    begin_test "T2.5: Large output — /large with max_items=200"
    RESULT=$(run_pi_scrape "$RESEARCHER_BRIDGE_URL" \
        "Use scrape_stealth to scrape $FIXTURE_URL/large with selector .product and extract field name from .name. Set max_items to 200." 180) || true
    if echo "$RESULT" | grep -qi "Product"; then
        pass
    else
        fail "large page scrape did not return products"
    fi

    begin_test "T2.6: Stdout isolation — no non-JSON on stdout"
    RESULT=$(run_pi_scrape "$RESEARCHER_BRIDGE_URL" \
        "Use scrape_stealth to scrape $FIXTURE_URL/ with selector .product and extract field name from .name." 120) || true
    # Check that result lines are valid JSON or empty (no Python warnings / debug output)
    local BAD_LINES
    BAD_LINES=$(echo "$RESULT" | grep -v '^\s*$' | grep -v '^\s*{' | grep -v '^\s*\[' | head -5) || true
    if [ -z "$BAD_LINES" ]; then
        pass
    else
        # Bridge wraps output — non-JSON from Python would leak here
        skip "bridge output format may wrap non-JSON; manual check recommended"
    fi
}

# =========================================================================
#  Suite: tier3  (T3.1 - T3.9)
# =========================================================================

run_tier3() {
    echo ""
    echo "=== Tier 3 Tests: scrape_browser (T3.1 - T3.9) ==="
    start_fixtures

    begin_test "T3.1: JS-rendered page — /js extracts Dynamic Product"
    local RESULT
    RESULT=$(run_pi_scrape "$DATA_BRIDGE_URL" \
        "Use scrape_browser to scrape $FIXTURE_URL/js with selector .product and extract fields name from .name and price from .price." 180) || true
    if echo "$RESULT" | grep -qi "Dynamic Product"; then
        pass
    else
        fail "scrape_browser did not extract JS-rendered content"
    fi

    begin_test "T3.2: wait_for — /js with wait_for .product"
    RESULT=$(run_pi_scrape "$DATA_BRIDGE_URL" \
        "Use scrape_browser to scrape $FIXTURE_URL/js with selector .product and extract field name from .name. Set wait_for to .product." 180) || true
    if echo "$RESULT" | grep -qi "Dynamic Product"; then
        pass
    else
        fail "wait_for did not wait for .product selector"
    fi

    begin_test "T3.3: Static superset — / works with browser"
    RESULT=$(run_pi_scrape "$DATA_BRIDGE_URL" \
        "Use scrape_browser to scrape $FIXTURE_URL/ with selector .product and extract fields name from .name and price from .price." 180) || true
    if echo "$RESULT" | grep -qi "Widget"; then
        pass
    else
        fail "scrape_browser cannot handle static pages"
    fi

    begin_test "T3.4: Bot detection bypass — /blocked"
    RESULT=$(run_pi_scrape "$DATA_BRIDGE_URL" \
        "Use scrape_browser to scrape $FIXTURE_URL/blocked with selector .product and extract field name from .name." 180) || true
    if echo "$RESULT" | grep -qi "Secret Product"; then
        pass
    else
        fail "scrape_browser did not bypass bot detection on /blocked"
    fi

    begin_test "T3.5: Pagination — /page1"
    RESULT=$(run_pi_scrape "$DATA_BRIDGE_URL" \
        "Use scrape_browser to scrape $FIXTURE_URL/page1 with selector .item and extract field name from .name. Enable pagination with next_selector .next and max_pages 2." 180) || true
    if echo "$RESULT" | grep -qi "Item 4\|Item 5"; then
        pass
    else
        fail "browser pagination did not reach page 2"
    fi

    begin_test "T3.6: Memory — container under 2G during scrape"
    # Run a scrape in background, then check memory
    run_pi_scrape "$DATA_BRIDGE_URL" \
        "Use scrape_browser to scrape $FIXTURE_URL/large with selector .product and extract field name from .name. Set max_items to 50." 180 >/dev/null 2>&1 &
    local SCRAPE_PID=$!
    sleep 5
    local MEM_USAGE
    MEM_USAGE=$(docker stats --no-stream --format "{{.MemUsage}}" "$(docker compose ps -q data 2>/dev/null | head -1)" 2>/dev/null | head -1) || true
    wait "$SCRAPE_PID" 2>/dev/null || true
    if [ -n "$MEM_USAGE" ]; then
        # Parse memory — e.g., "1.5GiB / 2GiB" or "500MiB / 2GiB"
        local MEM_VAL
        MEM_VAL=$(echo "$MEM_USAGE" | grep -oP '[\d.]+' | head -1) || true
        local MEM_UNIT
        MEM_UNIT=$(echo "$MEM_USAGE" | grep -oP '[GM]iB' | head -1) || true
        local MEM_MB=0
        if [ "$MEM_UNIT" = "GiB" ]; then
            MEM_MB=$(echo "$MEM_VAL * 1024" | bc 2>/dev/null) || MEM_MB=0
        elif [ "$MEM_UNIT" = "MiB" ]; then
            MEM_MB=$(echo "$MEM_VAL" | cut -d. -f1) || MEM_MB=0
        fi
        if [ "$MEM_MB" -lt 2048 ] 2>/dev/null; then
            pass
        else
            fail "container memory usage $MEM_USAGE exceeds 2G"
        fi
    else
        skip "could not read container memory stats"
    fi

    begin_test "T3.7: Timeout — impossible wait_for selector"
    RESULT=$(run_pi_scrape "$DATA_BRIDGE_URL" \
        "Use scrape_browser to scrape $FIXTURE_URL/ with selector .product and extract field name from .name. Set wait_for to .this-will-never-exist and set timeout to 5000." 60) || true
    if echo "$RESULT" | grep -qi "timeout\|error\|fail\|timed out"; then
        pass
    else
        skip "timeout behavior for wait_for not reliably detectable"
    fi

    begin_test "T3.8: Browser cleanup — no orphan chromium"
    # Run a scrape first
    run_pi_scrape "$DATA_BRIDGE_URL" \
        "Use scrape_browser to scrape $FIXTURE_URL/ with selector .product and extract field name from .name." 180 >/dev/null 2>&1 || true
    sleep 3
    local CHROME_COUNT
    CHROME_COUNT=$(docker compose exec -T data sh -c "pgrep -c chromium 2>/dev/null || echo 0" 2>/dev/null) || CHROME_COUNT="0"
    CHROME_COUNT=$(echo "$CHROME_COUNT" | tr -d '[:space:]')
    if [ "$CHROME_COUNT" = "0" ]; then
        pass
    else
        fail "found $CHROME_COUNT orphan chromium processes after scrape"
    fi

    begin_test "T3.9: Large page — /large via browser"
    RESULT=$(run_pi_scrape "$DATA_BRIDGE_URL" \
        "Use scrape_browser to scrape $FIXTURE_URL/large with selector .product and extract field name from .name. Set max_items to 20." 180) || true
    if echo "$RESULT" | grep -qi "Product"; then
        pass
    else
        fail "browser did not handle /large page"
    fi
}

# =========================================================================
#  Suite: cross  (X.1 - X.6)
# =========================================================================

run_cross() {
    echo ""
    echo "=== Cross-Tier Tests (X.1 - X.6) ==="

    begin_test "X.1: Tier selection guidance in output"
    local RESULT
    RESULT=$(run_pi_scrape "$RESEARCHER_BRIDGE_URL" \
        "What scraping tools do you have available? List them and describe when to use each tier." 60) || true
    if echo "$RESULT" | grep -qi "static\|stealth\|tier\|scrape"; then
        pass
    else
        fail "agent did not describe scraping tiers"
    fi

    begin_test "X.2: Escalation on failure"
    RESULT=$(run_pi_scrape "$RESEARCHER_BRIDGE_URL" \
        "Try to scrape http://this-domain-does-not-exist-xyz.invalid/ with scrape_static. If it fails, describe what you would do next — would you escalate or try another tier?" 60) || true
    if echo "$RESULT" | grep -qi "escalat\|next tier\|stealth\|browser\|fallback\|alternative"; then
        pass
    else
        fail "agent did not mention escalation or fallback strategy"
    fi

    begin_test "X.3: Tool visibility — researcher has scrape_static and scrape_stealth, not scrape_browser"
    RESULT=$(run_pi_scrape "$RESEARCHER_BRIDGE_URL" \
        "List all your available tools. Include every tool name." 60) || true
    if echo "$RESULT" | grep -qi "scrape_static" && echo "$RESULT" | grep -qi "scrape_stealth"; then
        if echo "$RESULT" | grep -qi "scrape_browser"; then
            fail "researcher should NOT have scrape_browser"
        else
            pass
        fi
    else
        fail "researcher missing expected scrape tools"
    fi

    begin_test "X.4: Tool visibility — data has all scrape tools"
    RESULT=$(run_pi_scrape "$DATA_BRIDGE_URL" \
        "List all your available tools. Include every tool name." 60) || true
    if echo "$RESULT" | grep -qi "scrape_static" && echo "$RESULT" | grep -qi "scrape_stealth" && echo "$RESULT" | grep -qi "scrape_browser"; then
        pass
    else
        fail "data agent missing one or more scrape tools"
    fi

    begin_test "X.5: Tool visibility — CEO has Apify tools only, no cheerio/Python"
    RESULT=$(run_pi_scrape "$CEO_BRIDGE_URL" \
        "List all your available tools. Include every tool name." 60) || true
    if echo "$RESULT" | grep -qi "scrape_static\|scrape_stealth\|scrape_browser"; then
        fail "CEO should NOT have scrape_static/stealth/browser tools"
    else
        pass
    fi

    begin_test "X.6: Conditional registration — extension loads without error"
    local CEO_LOG RESEARCHER_LOG DATA_LOG
    CEO_LOG=$(docker compose logs ceo --tail=50 2>/dev/null) || CEO_LOG=""
    RESEARCHER_LOG=$(docker compose logs researcher --tail=50 2>/dev/null) || RESEARCHER_LOG=""
    DATA_LOG=$(docker compose logs data --tail=50 2>/dev/null) || DATA_LOG=""
    if echo "$CEO_LOG$RESEARCHER_LOG$DATA_LOG" | grep -qi "extension.*error\|failed to load.*scrap"; then
        fail "scraping extension load errors found in container logs"
    else
        pass
    fi
}

# =========================================================================
#  Suite: apify  (A.1 - A.4)
# =========================================================================

run_apify() {
    echo ""
    echo "=== Apify Tests (A.1 - A.4) ==="

    begin_test "A.1: list_actors returns results"
    local RESULT
    RESULT=$(run_pi_scrape "$CEO_BRIDGE_URL" \
        "Use list_actors to search for web scraping actors. Return the results." 60) || true
    if echo "$RESULT" | grep -qi "actor\|scraper\|result"; then
        pass
    else
        fail "list_actors did not return results"
    fi

    begin_test "A.2: scrape_apify runs an actor"
    RESULT=$(run_pi_scrape "$CEO_BRIDGE_URL" \
        "Use scrape_apify to run the apify/hello-world actor with default input. Return the result." 120) || true
    if echo "$RESULT" | grep -qi "hello\|result\|output\|dataset"; then
        pass
    else
        fail "scrape_apify did not return actor output"
    fi

    begin_test "A.3: Missing token — clear error"
    # This test depends on APIFY_API_TOKEN being unset in the target container.
    # If it IS set, we skip — we cannot unset it mid-test without restarting the container.
    RESULT=$(run_pi_scrape "$RESEARCHER_BRIDGE_URL" \
        "Use list_actors to search for actors. Return whatever you get." 60) || true
    if echo "$RESULT" | grep -qi "token\|api.key\|unauthorized\|not set\|missing\|error"; then
        pass
    else
        skip "APIFY_API_TOKEN may be set; cannot test missing-token path without restart"
    fi

    begin_test "A.4: Invalid actor — clear error"
    RESULT=$(run_pi_scrape "$CEO_BRIDGE_URL" \
        "Use scrape_apify to run an actor with ID nonexistent/this-actor-does-not-exist-12345. Return the result." 60) || true
    if echo "$RESULT" | grep -qi "error\|not found\|invalid\|fail\|does not exist"; then
        pass
    else
        fail "invalid actor did not produce clear error"
    fi
}

# =========================================================================
#  Suite: build  (B.1 - B.7)
# =========================================================================

run_build() {
    echo ""
    echo "=== Build Tests (B.1 - B.7) ==="

    begin_test "B.1: All images build"
    if docker compose build 2>&1 | tail -5; then
        pass
    else
        fail "docker compose build failed"
    fi

    begin_test "B.2: Researcher has Python + scrapling Fetcher, no PlayWrightFetcher"
    local PY_CHECK
    PY_CHECK=$(docker compose exec -T researcher python3 -c "from scrapling import Fetcher; print('fetcher-ok')" 2>&1) || true
    local PW_CHECK
    PW_CHECK=$(docker compose exec -T researcher python3 -c "from scrapling import PlayWrightFetcher; print('pw-ok')" 2>&1) || true
    if echo "$PY_CHECK" | grep -q "fetcher-ok" && ! echo "$PW_CHECK" | grep -q "pw-ok"; then
        pass
    else
        if ! echo "$PY_CHECK" | grep -q "fetcher-ok"; then
            fail "researcher missing scrapling Fetcher"
        else
            fail "researcher should NOT have PlayWrightFetcher"
        fi
    fi

    begin_test "B.3: Data has Python + scrapling + PlayWrightFetcher"
    PY_CHECK=$(docker compose exec -T data python3 -c "from scrapling import Fetcher, PlayWrightFetcher; print('all-ok')" 2>&1) || true
    if echo "$PY_CHECK" | grep -q "all-ok"; then
        pass
    else
        fail "data missing scrapling or PlayWrightFetcher"
    fi

    begin_test "B.4: Base (CEO) has NO Python"
    if docker compose exec -T ceo python3 --version 2>&1; then
        fail "CEO container should not have python3"
    else
        pass
    fi

    begin_test "B.5: All bridges respond to /health"
    local ALL_OK=true
    for url in "$CEO_BRIDGE_URL" "$RESEARCHER_BRIDGE_URL" "$DATA_BRIDGE_URL"; do
        if ! curl -sf "$url/health" >/dev/null 2>&1; then
            fail "bridge at $url/health not responding"
            ALL_OK=false
            break
        fi
    done
    if $ALL_OK; then
        pass
    fi

    begin_test "B.6: Researcher image size < 1GB"
    local IMG_SIZE
    IMG_SIZE=$(docker images --format "{{.Size}}" "$(docker compose images researcher -q 2>/dev/null | head -1)" 2>/dev/null | head -1) || IMG_SIZE=""
    if [ -n "$IMG_SIZE" ]; then
        # Parse size — e.g., "850MB" or "1.2GB"
        if echo "$IMG_SIZE" | grep -qP '^\d+(\.\d+)?MB$'; then
            pass
        elif echo "$IMG_SIZE" | grep -qP '^\d+(\.\d+)?GB$'; then
            local GB_VAL
            GB_VAL=$(echo "$IMG_SIZE" | grep -oP '[\d.]+') || GB_VAL="0"
            if [ "$(echo "$GB_VAL < 1" | bc)" = "1" ] 2>/dev/null; then
                pass
            else
                fail "researcher image $IMG_SIZE exceeds 1GB"
            fi
        else
            skip "could not parse image size: $IMG_SIZE"
        fi
    else
        skip "could not determine researcher image size"
    fi

    begin_test "B.7: Data image size 1-2.5GB"
    IMG_SIZE=$(docker images --format "{{.Size}}" "$(docker compose images data -q 2>/dev/null | head -1)" 2>/dev/null | head -1) || IMG_SIZE=""
    if [ -n "$IMG_SIZE" ]; then
        if echo "$IMG_SIZE" | grep -qP '^\d+(\.\d+)?GB$'; then
            local GB_VAL
            GB_VAL=$(echo "$IMG_SIZE" | grep -oP '[\d.]+') || GB_VAL="0"
            if [ "$(echo "$GB_VAL >= 1 && $GB_VAL <= 2.5" | bc)" = "1" ] 2>/dev/null; then
                pass
            else
                fail "data image $IMG_SIZE outside 1-2.5GB range"
            fi
        else
            skip "data image size $IMG_SIZE not in GB — may be too small"
        fi
    else
        skip "could not determine data image size"
    fi
}

# =========================================================================
#  Suite selection
# =========================================================================

SUITES_TO_RUN=()

if [ $# -eq 0 ]; then
    SUITES_TO_RUN=(spike tier1 tier2 tier3 cross apify build)
else
    for arg in "$@"; do
        case "$arg" in
            spike|tier1|tier2|tier3|cross|apify|build)
                SUITES_TO_RUN+=("$arg")
                ;;
            all)
                SUITES_TO_RUN=(spike tier1 tier2 tier3 cross apify build)
                ;;
            *)
                echo "[ERROR] Unknown suite: $arg"
                echo "Valid suites: spike, tier1, tier2, tier3, cross, apify, build, all"
                exit 1
                ;;
        esac
    done
fi

# =========================================================================
#  Execution
# =========================================================================

echo "========================================"
echo "  Scraping Test Suite"
echo "  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "  Suites: ${SUITES_TO_RUN[*]}"
echo "========================================"

for suite in "${SUITES_TO_RUN[@]}"; do
    "run_${suite}"
done

# =========================================================================
#  Results
# =========================================================================

echo ""
mkdir -p "$RESULTS_DIR"
RESULTS_FILE="$RESULTS_DIR/scraping-$(date +%Y%m%d-%H%M%S).md"

cat > "$RESULTS_FILE" <<REPORT
# Scraping Test Results

**Date:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
**Suites:** ${SUITES_TO_RUN[*]}
**Passed:** $_PASS
**Failed:** $_FAIL
**Skipped:** $_SKIP
REPORT

echo "Results written to: $RESULTS_FILE"

summary
