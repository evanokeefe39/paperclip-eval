#!/usr/bin/env bash
# Escalate extension test suite runner.
# Runs unit tests (mock server) and integration tests (live Paperclip).
#
# Usage:
#   ./tests/escalate/run-tests.sh              # all tests
#   ./tests/escalate/run-tests.sh unit         # unit only
#   ./tests/escalate/run-tests.sh integration  # integration only
#   ./tests/escalate/run-tests.sh e2e          # E2E only (through bridge)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

MODE="${1:-all}"
OVERALL_EXIT=0

echo "═══════════════════════════════════════════════════"
echo " Escalate Extension — Test Suite"
echo " Mode: $MODE"
echo " $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "═══════════════════════════════════════════════════"

run_unit() {
    echo ""
    echo "┌─────────────────────────────────────────────┐"
    echo "│  Unit Tests (mock server, no Docker needed)  │"
    echo "└─────────────────────────────────────────────┘"
    echo ""

    if ! command -v node &>/dev/null; then
        echo "[SKIP] Node.js not available"
        return 0
    fi

    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -lt 22 ]; then
        echo "[SKIP] Node 22+ required (have v$NODE_VERSION)"
        return 0
    fi

    set +e
    node --test "$SCRIPT_DIR/unit-test.mjs"
    local exit=$?
    set -e

    if [ "$exit" -ne 0 ]; then
        echo "[FAIL] Unit tests failed"
        OVERALL_EXIT=1
    else
        echo "[PASS] Unit tests passed"
    fi
}

run_integration() {
    echo ""
    echo "┌──────────────────────────────────────────────────────┐"
    echo "│  Integration Tests (live Paperclip API, Docker req)  │"
    echo "└──────────────────────────────────────────────────────┘"
    echo ""

    # Check Docker stack
    if ! curl -sf -o /dev/null "http://localhost:3100/api/health" 2>/dev/null; then
        echo "[SKIP] Paperclip not running at localhost:3100"
        return 0
    fi

    set +e
    bash "$SCRIPT_DIR/integration-test.sh"
    local exit=$?
    set -e

    if [ "$exit" -ne 0 ]; then
        echo "[FAIL] Integration tests failed"
        OVERALL_EXIT=1
    else
        echo "[PASS] Integration tests passed"
    fi
}

run_e2e() {
    echo ""
    echo "┌───────────────────────────────────────────────────────┐"
    echo "│  E2E Tests (full agent flow through bridge, slow)     │"
    echo "└───────────────────────────────────────────────────────┘"
    echo ""

    # Check full stack
    if ! curl -sf -o /dev/null "http://localhost:8082/health" 2>/dev/null; then
        echo "[SKIP] Researcher bridge not running at localhost:8082"
        return 0
    fi

    set +e
    bash "$REPO_ROOT/tests/e2e/e2e-8-escalate.sh"
    local exit=$?
    set -e

    if [ "$exit" -ne 0 ]; then
        echo "[FAIL] E2E tests failed"
        OVERALL_EXIT=1
    else
        echo "[PASS] E2E tests passed"
    fi
}

case "$MODE" in
    unit)
        run_unit
        ;;
    integration)
        run_integration
        ;;
    e2e)
        run_e2e
        ;;
    all)
        run_unit
        run_integration
        run_e2e
        ;;
    *)
        echo "Unknown mode: $MODE"
        echo "Usage: $0 [unit|integration|e2e|all]"
        exit 1
        ;;
esac

echo ""
echo "═══════════════════════════════════════════════════"
if [ "$OVERALL_EXIT" -eq 0 ]; then
    echo " ALL PASSED"
else
    echo " SOME TESTS FAILED"
fi
echo "═══════════════════════════════════════════════════"

exit $OVERALL_EXIT
