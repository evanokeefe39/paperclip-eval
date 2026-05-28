#!/usr/bin/env bash
set -euo pipefail

echo "=== F5: run_id env fallback ==="

# Test 1: Code contains the env fallback
if grep -q 'PAPERCLIP_RUN_ID' src/agents/extensions/artifacts/index.ts; then
  echo "PASS: PAPERCLIP_RUN_ID referenced in artifacts extension"
else
  echo "FAIL: PAPERCLIP_RUN_ID not found in artifacts extension"
  exit 1
fi

# Test 2: Verify the fallback pattern exists
if grep -q 'process.env.PAPERCLIP_RUN_ID' src/agents/extensions/artifacts/index.ts; then
  echo "PASS: process.env.PAPERCLIP_RUN_ID fallback present"
else
  echo "FAIL: process.env.PAPERCLIP_RUN_ID fallback missing"
  exit 1
fi

echo "All F5 tests passed."
