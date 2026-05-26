#!/usr/bin/env bash
# E2E-9: Scraping extension smoke test.
# Verifies scrape_static works via researcher bridge against fixture server.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo "=== E2E-9: Scraping Extension ==="
require_stack

# Start fixture server
node "$SCRIPT_DIR/../scraping/fixtures/static-server.mjs" &
FIXTURE_PID=$!
trap 'kill $FIXTURE_PID 2>/dev/null; rm -f "$COOKIE_JAR"' EXIT

# Wait for fixture server to be ready
DEADLINE=$((SECONDS + 10))
while [ "$SECONDS" -lt "$DEADLINE" ]; do
    if curl -sf "http://localhost:9999/health" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

FIXTURE_URL="${FIXTURE_URL:-http://host.docker.internal:9999}"

begin_test "E2E-9.1: scrape_static via researcher bridge"
RESULT=$(bridge_post "$RESEARCHER_BRIDGE_URL" "{\"prompt\": \"Use scrape_static to scrape $FIXTURE_URL/ with selector .product and extract fields name from .name and price from .price\"}" 120) || true
if echo "$RESULT" | grep -qi "widget"; then
    pass
else
    fail "scrape_static did not return product data"
fi

summary
