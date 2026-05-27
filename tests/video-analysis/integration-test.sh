#!/usr/bin/env bash
#
# Integration tests for video & audio analysis tools (T5).
# Requires: running data agent container, GROQ_API_KEY, NVIDIA_NIM_API_KEY, APIFY_API_TOKEN.
#
# Usage:  bash tests/video-analysis/integration-test.sh [data_url]
#         data_url defaults to http://localhost:8083
#
set -euo pipefail

DATA_URL="${1:-http://localhost:8083}"
PASS=0
FAIL=0
SKIP=0

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

invoke() {
  local agent_url="$1"
  local prompt="$2"
  local timeout="${3:-120}"

  curl -s -X POST "${agent_url}/invoke" \
    -H "Content-Type: application/json" \
    -d "{
      \"agentId\": \"test\",
      \"runId\": \"integration-$(date +%s)\",
      \"context\": {
        \"paperclipTaskMarkdown\": $(printf '%s' "$prompt" | jq -Rs .)
      }
    }" \
    --max-time "$timeout" 2>/dev/null || echo '{"error":"curl_failed"}'
}

check_tool_registered() {
  local agent_url="$1"
  local tool_name="$2"
  # Hit health endpoint — if container is up, tools are registered
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" "${agent_url}/health" 2>/dev/null || echo "000")
  if [ "$status" = "200" ]; then
    return 0
  fi
  return 1
}

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
skip() { echo "  SKIP: $1"; SKIP=$((SKIP + 1)); }

# --------------------------------------------------------------------------
# Pre-flight
# --------------------------------------------------------------------------

echo "=== Video & Audio Analysis Integration Tests ==="
echo "Data agent: ${DATA_URL}"
echo ""

if ! check_tool_registered "$DATA_URL" "transcribe_audio"; then
  echo "ERROR: Data agent not reachable at ${DATA_URL}. Start with: docker compose up -d data"
  exit 1
fi

# Check env vars
for var in GROQ_API_KEY NVIDIA_NIM_API_KEY APIFY_API_TOKEN; do
  if [ -z "${!var:-}" ]; then
    echo "WARNING: ${var} not set — some tests will be skipped"
  fi
done
echo ""

# --------------------------------------------------------------------------
# Test 1: analyze_video with known video URL
# --------------------------------------------------------------------------

echo "--- Test 1: analyze_video (NIM Nemotron) ---"

if [ -n "${NVIDIA_NIM_API_KEY:-}" ]; then
  # Use the spike test video (CNN TikTok via Apify KVS)
  VIDEO_URL="https://api.apify.com/v2/key-value-stores/i3u0wh6guXXuV0khk/records/video-cnn-20260525141037-7643831428689546510.mp4"

  RESULT=$(invoke "$DATA_URL" "Use the analyze_video tool with video_url: ${VIDEO_URL}" 180)

  if echo "$RESULT" | grep -qi "summary"; then
    pass "analyze_video returned analysis with summary"
  elif echo "$RESULT" | grep -qi "error"; then
    fail "analyze_video returned error: $(echo "$RESULT" | head -c 200)"
  else
    fail "analyze_video returned unexpected response: $(echo "$RESULT" | head -c 200)"
  fi
else
  skip "analyze_video — NVIDIA_NIM_API_KEY not set"
fi

# --------------------------------------------------------------------------
# Test 2: transcribe_audio with a short video
# --------------------------------------------------------------------------

echo "--- Test 2: transcribe_audio (Groq Whisper) ---"

if [ -n "${GROQ_API_KEY:-}" ]; then
  VIDEO_URL="https://api.apify.com/v2/key-value-stores/i3u0wh6guXXuV0khk/records/video-cnn-20260525141037-7643831428689546510.mp4"

  RESULT=$(invoke "$DATA_URL" "Use the transcribe_audio tool with video_url: ${VIDEO_URL}" 180)

  if echo "$RESULT" | grep -qi "transcript"; then
    pass "transcribe_audio returned transcript"
  elif echo "$RESULT" | grep -qi "ffmpeg"; then
    fail "transcribe_audio ffmpeg error: $(echo "$RESULT" | head -c 200)"
  elif echo "$RESULT" | grep -qi "error"; then
    fail "transcribe_audio returned error: $(echo "$RESULT" | head -c 200)"
  else
    fail "transcribe_audio unexpected response: $(echo "$RESULT" | head -c 200)"
  fi
else
  skip "transcribe_audio — GROQ_API_KEY not set"
fi

# --------------------------------------------------------------------------
# Test 3: enrich_video composite pipeline
# --------------------------------------------------------------------------

echo "--- Test 3: enrich_video (composite) ---"

if [ -n "${NVIDIA_NIM_API_KEY:-}" ]; then
  VIDEO_URL="https://api.apify.com/v2/key-value-stores/i3u0wh6guXXuV0khk/records/video-cnn-20260525141037-7643831428689546510.mp4"

  RESULT=$(invoke "$DATA_URL" "Use the enrich_video tool with video_url: ${VIDEO_URL}, platform: tiktok, subtitle_text: 'AI needs to be disarmed.'" 180)

  if echo "$RESULT" | grep -qi "enriched\|visual_analysis\|transcript"; then
    pass "enrich_video returned enriched content"
  elif echo "$RESULT" | grep -qi "error"; then
    fail "enrich_video returned error: $(echo "$RESULT" | head -c 200)"
  else
    fail "enrich_video unexpected response: $(echo "$RESULT" | head -c 200)"
  fi
else
  skip "enrich_video — NVIDIA_NIM_API_KEY not set"
fi

# --------------------------------------------------------------------------
# Test 4: Rate limiter behavior (fire 5 rapid requests)
# --------------------------------------------------------------------------

echo "--- Test 4: Rate limiter (5 rapid analyze_video calls) ---"

if [ -n "${NVIDIA_NIM_API_KEY:-}" ]; then
  VIDEO_URL="https://api.apify.com/v2/key-value-stores/i3u0wh6guXXuV0khk/records/video-cnn-20260525141037-7643831428689546510.mp4"
  START=$(date +%s)
  SUCCESSES=0

  for i in $(seq 1 5); do
    RESULT=$(invoke "$DATA_URL" "Use the analyze_video tool with video_url: ${VIDEO_URL}" 180)
    if echo "$RESULT" | grep -qi "summary\|analysis"; then
      SUCCESSES=$((SUCCESSES + 1))
    fi
  done

  ELAPSED=$(($(date +%s) - START))

  if [ "$SUCCESSES" -ge 3 ]; then
    pass "Rate limiter: ${SUCCESSES}/5 succeeded in ${ELAPSED}s"
  else
    fail "Rate limiter: only ${SUCCESSES}/5 succeeded in ${ELAPSED}s"
  fi
else
  skip "Rate limiter — NVIDIA_NIM_API_KEY not set"
fi

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------

echo ""
echo "=== Results ==="
echo "PASS: ${PASS}  FAIL: ${FAIL}  SKIP: ${SKIP}"
echo ""

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
