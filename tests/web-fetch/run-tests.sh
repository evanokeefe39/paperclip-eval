#!/usr/bin/env bash
# Web-fetch extension test suite runner.
#
# Usage:
#   ./tests/web-fetch/run-tests.sh          # unit tests (no Docker, no API key)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "═══════════════════════════════════════════════════"
echo " Web Fetch Extension — Test Suite"
echo " $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "═══════════════════════════════════════════════════"
echo ""

if ! command -v node &>/dev/null; then
    echo "[SKIP] Node.js not available"
    exit 0
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
    echo "[SKIP] Node 22+ required (have v$NODE_VERSION)"
    exit 0
fi

echo "Running unit tests..."
echo ""

set +e
node --test "$SCRIPT_DIR/unit-test.mjs"
EXIT=$?
set -e

echo ""
echo "═══════════════════════════════════════════════════"
if [ "$EXIT" -eq 0 ]; then
    echo " ALL PASSED"
else
    echo " SOME TESTS FAILED"
fi
echo "═══════════════════════════════════════════════════"

exit $EXIT
