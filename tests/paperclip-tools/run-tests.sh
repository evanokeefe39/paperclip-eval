#!/usr/bin/env bash
# Run all Paperclip tools extension tests.
#
# Usage:
#   bash tests/paperclip-tools/run-tests.sh           # unit + integration
#   bash tests/paperclip-tools/run-tests.sh unit       # unit only
#   bash tests/paperclip-tools/run-tests.sh integration # integration only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-all}"
EXIT_CODE=0

run_unit() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Unit Tests (fake server, no Docker)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    node "$SCRIPT_DIR/unit-test.mjs"
}

run_integration() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Integration Tests (live Paperclip stack)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    bash "$SCRIPT_DIR/integration-test.sh"
}

case "$MODE" in
    unit)
        run_unit || EXIT_CODE=1
        ;;
    integration)
        run_integration || EXIT_CODE=1
        ;;
    all)
        run_unit || EXIT_CODE=1
        echo ""
        run_integration || EXIT_CODE=1
        ;;
    *)
        echo "Usage: $0 [unit|integration|all]"
        exit 1
        ;;
esac

exit $EXIT_CODE
