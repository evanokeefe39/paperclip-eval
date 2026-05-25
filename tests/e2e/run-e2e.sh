#!/usr/bin/env bash
# E2E test runner for Paperclip agent stack.
# Runs all E2E tests in order, reports results, exits non-zero on failure.
#
# Usage:
#   ./run-e2e.sh              # run all tests
#   ./run-e2e.sh 1 3          # run only E2E-1 and E2E-3
#   ./run-e2e.sh --fail-fast  # stop on first failure

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RESULTS_DIR="$REPO_ROOT/tests/results"

FAIL_FAST=false
TESTS_TO_RUN=()

for arg in "$@"; do
    case "$arg" in
        --fail-fast) FAIL_FAST=true ;;
        [1-4]) TESTS_TO_RUN+=("$arg") ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

if [ ${#TESTS_TO_RUN[@]} -eq 0 ]; then
    TESTS_TO_RUN=(1 2 3 4)
fi

# --- Prerequisite check ---
for cmd in curl jq bash; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "[FATAL] Required: $cmd"
        exit 1
    fi
done

echo "========================================"
echo "  Paperclip E2E Test Suite"
echo "  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "========================================"

OVERALL_PASS=0
OVERALL_FAIL=0
OVERALL_SKIP=0
SUITE_START=$SECONDS
FAILED_SUITES=()

for num in "${TESTS_TO_RUN[@]}"; do
    SCRIPT="$SCRIPT_DIR/e2e-${num}-*.sh"
    MATCH=$(ls $SCRIPT 2>/dev/null | head -1)

    if [ -z "$MATCH" ]; then
        echo "[WARN] No test script for E2E-$num"
        continue
    fi

    echo ""
    echo "--- Running: $(basename "$MATCH") ---"
    TEST_START=$SECONDS

    set +e
    bash "$MATCH"
    EXIT=$?
    set -e

    DURATION=$((SECONDS - TEST_START))
    echo "  Duration: ${DURATION}s"

    if [ "$EXIT" -eq 0 ]; then
        ((OVERALL_PASS++)) || true
    else
        ((OVERALL_FAIL++)) || true
        FAILED_SUITES+=("E2E-$num")
        if $FAIL_FAST; then
            echo ""
            echo "[FAIL-FAST] Stopping after E2E-$num failure."
            break
        fi
    fi
done

TOTAL_DURATION=$((SECONDS - SUITE_START))

echo ""
echo "========================================"
echo "  E2E Suite Results"
echo "  Suites: $((OVERALL_PASS + OVERALL_FAIL)) run, $OVERALL_PASS passed, $OVERALL_FAIL failed"
if [ ${#FAILED_SUITES[@]} -gt 0 ]; then
    echo "  Failed: ${FAILED_SUITES[*]}"
fi
echo "  Duration: ${TOTAL_DURATION}s"
echo "========================================"

# --- Write results file ---
mkdir -p "$RESULTS_DIR"
RESULTS_FILE="$RESULTS_DIR/e2e-$(date +%Y%m%d-%H%M%S).md"
cat > "$RESULTS_FILE" <<REPORT
# E2E Test Results

**Date:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
**Duration:** ${TOTAL_DURATION}s
**Suites:** $((OVERALL_PASS + OVERALL_FAIL)) run, $OVERALL_PASS passed, $OVERALL_FAIL failed

| Suite | Status |
|-------|--------|
$(for num in "${TESTS_TO_RUN[@]}"; do
    if printf '%s\n' "${FAILED_SUITES[@]}" | grep -qF "E2E-$num" 2>/dev/null; then
        echo "| E2E-$num | FAIL |"
    else
        echo "| E2E-$num | PASS |"
    fi
done)
REPORT

echo "Results written to: $RESULTS_FILE"

if [ "$OVERALL_FAIL" -gt 0 ]; then
    exit 1
fi
exit 0
