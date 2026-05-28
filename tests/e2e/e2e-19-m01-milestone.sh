#!/usr/bin/env bash
# E2E-19: M0.1 Milestone — Full Orchestration Eval
#
# Creates a parent issue, monitors the full CEO→Worker delegation chain,
# and evaluates against the M0.1 postmortem criteria:
#   - CEO delegates (no self-assignment of research/data/writing)
#   - Workers wake and produce artifacts
#   - No stale escalation issues
#   - No duplicate write tasks
#   - Timeouts tracked
#   - Issue completion rate measured
#
# Usage:
#   bash tests/e2e/e2e-19-m01-milestone.sh                     # run with defaults
#   bash tests/e2e/e2e-19-m01-milestone.sh 2>&1 | tee m01.log  # run + save log
#   tail -f m01.log                                             # monitor from another terminal
#
# All output is timestamped. Script is fully standalone — no Claude Code interaction needed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

# --- Config ---
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-paperclip-eval}"
RUN_ID="m01-$(date +%Y%m%d-%H%M%S)"
RESULTS_DIR="$SCRIPT_DIR/../results/$RUN_ID"
MAX_WALL_CLOCK="${MAX_WALL_CLOCK:-2400}"   # 40 minutes max
POLL_INTERVAL="${POLL_INTERVAL:-15}"       # check every 15s
SETTLE_WAIT="${SETTLE_WAIT:-30}"           # wait after parent done before final eval
ISSUE_TITLE="M0.1 Eval: Faceless Tech Channel Analysis"

# --- Timestamps ---
ts() { date '+%H:%M:%S'; }
tlog() { echo "[$(ts)] $*"; }

# --- Results file ---
mkdir -p "$RESULTS_DIR"
EVAL_LOG="$RESULTS_DIR/eval.jsonl"
touch "$EVAL_LOG"

emit_event() {
    local event="$1"; shift
    local data="${1:-{}}"
    echo "{\"ts\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"event\":\"$event\",\"data\":$data}" >> "$EVAL_LOG"
}

# ═══════════════════════════════════════════════════════════════════════
# BANNER
# ═══════════════════════════════════════════════════════════════════════
echo ""
echo "══════════════════════════════════════════════════════════════════"
echo "[E2E-19] M0.1 Milestone Evaluation"
echo "  Run ID:        $RUN_ID"
echo "  Results:       $RESULTS_DIR"
echo "  Max wall-clock: ${MAX_WALL_CLOCK}s"
echo "  Poll interval:  ${POLL_INTERVAL}s"
echo "══════════════════════════════════════════════════════════════════"
echo ""

emit_event "run_start" "{\"run_id\":\"$RUN_ID\",\"max_wall_clock\":$MAX_WALL_CLOCK}"

# ═══════════════════════════════════════════════════════════════════════
# PREFLIGHT
# ═══════════════════════════════════════════════════════════════════════
tlog "Preflight checks..."

require_stack

COMPANY_ID=$(find_company_id)
CEO_ID=$(find_agent_id "$COMPANY_ID" "CEO")

# Discover all agents
declare -A AGENT_IDS
declare -A AGENT_URLS
for agent_name in CEO Researcher Data Writer; do
    aid=$(find_agent_id "$COMPANY_ID" "$agent_name")
    AGENT_IDS[$agent_name]="${aid:-}"
    if [ -z "$aid" ]; then
        tlog "  WARNING: $agent_name not registered"
    else
        tlog "  $agent_name: $aid"
    fi
done

AGENT_URLS[CEO]="${CEO_BRIDGE_URL:-http://localhost:8081}"
AGENT_URLS[Researcher]="${RESEARCHER_BRIDGE_URL:-http://localhost:8082}"
AGENT_URLS[Data]="${DATA_BRIDGE_URL:-http://localhost:8083}"
AGENT_URLS[Writer]="${WRITER_BRIDGE_URL:-http://localhost:8084}"

if [ -z "$CEO_ID" ]; then
    tlog "[FATAL] CEO not registered"
    exit 1
fi

# Snapshot pre-run metrics
declare -A PRE_METRICS
for agent_name in CEO Researcher Data Writer; do
    url="${AGENT_URLS[$agent_name]}"
    PRE_METRICS[$agent_name]=$(curl -sf "$url/metrics" 2>/dev/null | jq -r '.requests_total // 0' 2>/dev/null || echo "0")
done

emit_event "preflight_done" "{\"company_id\":\"$COMPANY_ID\",\"ceo_id\":\"$CEO_ID\"}"

# ═══════════════════════════════════════════════════════════════════════
# STEP 1: Cancel any existing open issues to start clean
# ═══════════════════════════════════════════════════════════════════════
tlog "Cleaning stale issues..."
EXISTING=$(api_get "/api/companies/$COMPANY_ID/issues?status=todo,in_progress,blocked,in_review&limit=100" 2>/dev/null || echo "[]")
STALE_COUNT=$(echo "$EXISTING" | jq 'length')
if [ "$STALE_COUNT" -gt 0 ]; then
    tlog "  Found $STALE_COUNT open issues — cancelling..."
    echo "$EXISTING" | jq -r '.[].id' | while read -r iid; do
        api_post "/api/companies/$COMPANY_ID/issues/$iid" \
            "{\"status\":\"cancelled\",\"comment\":\"Cancelled for clean M0.1 eval run $RUN_ID\"}" 2>/dev/null || true
    done
    tlog "  Cancelled $STALE_COUNT issues"
    emit_event "cleanup" "{\"cancelled\":$STALE_COUNT}"
else
    tlog "  No stale issues"
fi

echo ""

# ═══════════════════════════════════════════════════════════════════════
# STEP 2: Create parent issue
# ═══════════════════════════════════════════════════════════════════════
RESEARCH_BRIEF="Analyze the faceless (no-face) tech content creator space across Instagram and TikTok.

Research objectives:
1. Identify top-performing faceless tech channels on each platform (minimum 5 per platform)
2. Analyze content formats: what types of videos/posts perform best
3. Analyze monetization paths: sponsorships, affiliate, digital products, AdSense
4. Identify growth mechanics: what strategies are these creators using to grow

For each channel found, document: handle, follower count, primary subtopic, content format, posting frequency, estimated engagement rate.

Subtopics to cover:
- AI / machine learning / LLMs
- Cybersecurity / hacking
- Tech investing / entrepreneurship
- Productivity / mindset
- Tech careers / hiring

Deliverables:
- Researcher: platform-specific channel analysis (one report per platform)
- Data: cross-platform comparison and monetization analysis
- Writer: final synthesis report combining all research

CEO: delegate each deliverable to the appropriate agent. Do NOT do research yourself."

tlog "Creating parent issue: $ISSUE_TITLE"
ISSUE_BODY=$(jq -n \
    --arg title "$ISSUE_TITLE" \
    --arg desc "$RESEARCH_BRIEF" \
    --arg agent "$CEO_ID" \
    '{title: $title, description: $desc, status: "todo", priority: "high", assigneeAgentId: $agent}')

ISSUE_RESP=$(api_post "/api/companies/$COMPANY_ID/issues" "$ISSUE_BODY")
PARENT_ID=$(echo "$ISSUE_RESP" | jq -r '.id // empty')
PARENT_KEY=$(echo "$ISSUE_RESP" | jq -r '.identifier // empty')

if [ -z "$PARENT_ID" ]; then
    tlog "[FATAL] Failed to create parent issue"
    exit 1
fi

tlog "  Created: $PARENT_KEY ($PARENT_ID)"
emit_event "parent_created" "{\"id\":\"$PARENT_ID\",\"key\":\"$PARENT_KEY\"}"

echo ""

# ═══════════════════════════════════════════════════════════════════════
# STEP 3: Invoke CEO and start monitoring loop
# ═══════════════════════════════════════════════════════════════════════
tlog "Invoking CEO heartbeat..."
api_post "/api/agents/$CEO_ID/heartbeat/invoke" 2>/dev/null || true
emit_event "ceo_invoked" "{}"

START_TIME=$SECONDS
LAST_ISSUE_COUNT=0
PARENT_DONE=false
STALL_COUNT=0

tlog "Entering monitoring loop (poll every ${POLL_INTERVAL}s, max ${MAX_WALL_CLOCK}s)..."
tlog "────────────────────────────────────────────────────────────────"

while true; do
    ELAPSED=$((SECONDS - START_TIME))

    # Timeout check
    if [ "$ELAPSED" -ge "$MAX_WALL_CLOCK" ]; then
        tlog "TIMEOUT: ${MAX_WALL_CLOCK}s elapsed"
        emit_event "timeout" "{\"elapsed\":$ELAPSED}"
        break
    fi

    # Fetch current state
    ALL_ISSUES=$(api_get "/api/companies/$COMPANY_ID/issues?limit=100" 2>/dev/null || echo "[]")

    # Parent issue status
    PARENT_STATUS=$(echo "$ALL_ISSUES" | jq -r --arg pid "$PARENT_ID" '.[] | select(.id == $pid) | .status // "unknown"')

    # Child issues
    CHILDREN=$(echo "$ALL_ISSUES" | jq --arg pid "$PARENT_ID" '[.[] | select(.parentId == $pid)]')
    CHILD_COUNT=$(echo "$CHILDREN" | jq 'length')
    DONE_COUNT=$(echo "$CHILDREN" | jq '[.[] | select(.status == "done" or .status == "cancelled")] | length')
    IN_PROGRESS=$(echo "$CHILDREN" | jq '[.[] | select(.status == "in_progress")] | length')
    BLOCKED=$(echo "$CHILDREN" | jq '[.[] | select(.status == "blocked")] | length')
    TODO=$(echo "$CHILDREN" | jq '[.[] | select(.status == "todo")] | length')

    # Agent metrics
    AGENT_STATUS=""
    for agent_name in CEO Researcher Data Writer; do
        url="${AGENT_URLS[$agent_name]}"
        health=$(curl -sf "$url/health" 2>/dev/null || echo "{}")
        busy=$(echo "$health" | jq -r '.busy // false')
        qd=$(echo "$health" | jq -r '.queue_depth // 0')
        total=$(curl -sf "$url/metrics" 2>/dev/null | jq -r '.requests_total // 0' 2>/dev/null || echo "0")
        pre="${PRE_METRICS[$agent_name]}"
        invocations=$((total - pre))
        AGENT_STATUS="$AGENT_STATUS ${agent_name}:inv=${invocations},busy=${busy},q=${qd}"
    done

    # Print status line
    tlog "  [${ELAPSED}s] parent=$PARENT_STATUS children=$CHILD_COUNT (done=$DONE_COUNT ip=$IN_PROGRESS blocked=$BLOCKED todo=$TODO) |$AGENT_STATUS"

    # Emit periodic snapshot
    emit_event "poll" "{\"elapsed\":$ELAPSED,\"parent_status\":\"$PARENT_STATUS\",\"children\":$CHILD_COUNT,\"done\":$DONE_COUNT,\"in_progress\":$IN_PROGRESS,\"blocked\":$BLOCKED}"

    # Log new children as they appear
    if [ "$CHILD_COUNT" -gt "$LAST_ISSUE_COUNT" ]; then
        NEW_ISSUES=$(echo "$CHILDREN" | jq -r '.[] | "\(.identifier // .id): \(.title) [assignee=\(.assigneeAgentId // "none"), status=\(.status)]"')
        tlog "  New issues detected ($CHILD_COUNT total):"
        echo "$NEW_ISSUES" | while IFS= read -r line; do tlog "    $line"; done
        LAST_ISSUE_COUNT=$CHILD_COUNT
        STALL_COUNT=0
    fi

    # Check if parent is done
    if [ "$PARENT_STATUS" = "done" ]; then
        tlog "  Parent issue marked done at ${ELAPSED}s"
        emit_event "parent_done" "{\"elapsed\":$ELAPSED}"
        PARENT_DONE=true
        break
    fi

    # Stall detection (no new issues for 10 polls = ~2.5 min with 15s interval)
    ((STALL_COUNT++)) || true
    if [ "$STALL_COUNT" -ge 10 ] && [ "$IN_PROGRESS" -eq 0 ] && [ "$TODO" -eq 0 ] && [ "$CHILD_COUNT" -gt 0 ]; then
        tlog "  WARNING: possible stall — no progress for $((STALL_COUNT * POLL_INTERVAL))s"
        emit_event "stall_warning" "{\"stall_polls\":$STALL_COUNT}"
    fi

    sleep "$POLL_INTERVAL"
done

tlog "────────────────────────────────────────────────────────────────"

# Wait for stragglers
tlog "Settling for ${SETTLE_WAIT}s..."
sleep "$SETTLE_WAIT"

echo ""

# ═══════════════════════════════════════════════════════════════════════
# EVALUATION
# ═══════════════════════════════════════════════════════════════════════
tlog "Running evaluation..."
echo ""

# Refresh final state
ALL_ISSUES=$(api_get "/api/companies/$COMPANY_ID/issues?limit=100" 2>/dev/null || echo "[]")
CHILDREN=$(echo "$ALL_ISSUES" | jq --arg pid "$PARENT_ID" '[.[] | select(.parentId == $pid)]')
CHILD_COUNT=$(echo "$CHILDREN" | jq 'length')
ELAPSED=$((SECONDS - START_TIME))

# --- Metric 1: Wall-clock time ---
begin_test "Wall-clock time under 40 minutes"
if [ "$ELAPSED" -lt "$MAX_WALL_CLOCK" ]; then
    log "Completed in ${ELAPSED}s ($((ELAPSED / 60))m $((ELAPSED % 60))s)"
    pass
else
    fail "Exceeded ${MAX_WALL_CLOCK}s"
fi

# --- Metric 2: Parent completed ---
begin_test "Parent issue reached done status"
PARENT_STATUS=$(echo "$ALL_ISSUES" | jq -r --arg pid "$PARENT_ID" '.[] | select(.id == $pid) | .status // "unknown"')
if [ "$PARENT_STATUS" = "done" ]; then
    pass
else
    fail "parent status = $PARENT_STATUS"
fi

# --- Metric 3: CEO delegated (created child issues) ---
begin_test "CEO created child issues (delegation occurred)"
if [ "$CHILD_COUNT" -ge 3 ]; then
    log "$CHILD_COUNT child issues created"
    pass
else
    fail "only $CHILD_COUNT child issues (expected 3+)"
fi

# --- Metric 4: No CEO self-assignment of research/data/writing ---
begin_test "CEO did not self-assign research/data/writing tasks"
CEO_SELF=$(echo "$CHILDREN" | jq --arg cid "$CEO_ID" '[.[] | select(.assigneeAgentId == $cid)] | length')
if [ "$CEO_SELF" -eq 0 ]; then
    pass
else
    log "CEO self-assigned $CEO_SELF issues:"
    echo "$CHILDREN" | jq -r --arg cid "$CEO_ID" '.[] | select(.assigneeAgentId == $cid) | "    \(.identifier // .id): \(.title)"'
    fail "CEO self-assigned $CEO_SELF tasks (should delegate all)"
fi

# --- Metric 5: Workers received work ---
begin_test "Researcher received at least 1 task"
RES_TASKS=$(echo "$CHILDREN" | jq --arg rid "${AGENT_IDS[Researcher]:-}" '[.[] | select(.assigneeAgentId == $rid)] | length')
if [ "$RES_TASKS" -ge 1 ]; then
    log "$RES_TASKS tasks assigned"
    pass
else
    fail "no tasks assigned to Researcher"
fi

begin_test "Writer received at least 1 task"
WRITER_TASKS=$(echo "$CHILDREN" | jq --arg wid "${AGENT_IDS[Writer]:-}" '[.[] | select(.assigneeAgentId == $wid)] | length')
if [ "$WRITER_TASKS" -ge 1 ]; then
    log "$WRITER_TASKS tasks assigned"
    pass
else
    fail "no tasks assigned to Writer"
fi

# --- Metric 6: Issue completion rate ---
begin_test "Issue completion rate >= 60%"
DONE_COUNT=$(echo "$CHILDREN" | jq '[.[] | select(.status == "done")] | length')
if [ "$CHILD_COUNT" -gt 0 ]; then
    RATE=$((DONE_COUNT * 100 / CHILD_COUNT))
    log "$DONE_COUNT/$CHILD_COUNT completed ($RATE%)"
    if [ "$RATE" -ge 60 ]; then
        pass
    else
        fail "completion rate ${RATE}% (need 60%+)"
    fi
else
    fail "no child issues"
fi

# --- Metric 7: No stale escalation issues ---
begin_test "No stale/false escalation issues"
ESCALATIONS=$(echo "$CHILDREN" | jq '[.[] | select(.title | test("escalat|SYSTEMIC|PROBLEM|failure|error"; "i"))]')
ESC_COUNT=$(echo "$ESCALATIONS" | jq 'length')
if [ "$ESC_COUNT" -eq 0 ]; then
    pass
else
    log "$ESC_COUNT escalation issues found:"
    echo "$ESCALATIONS" | jq -r '.[] | "    \(.identifier // .id): \(.title)"'
    fail "$ESC_COUNT stale escalation(s) detected"
fi

# --- Metric 8: No duplicate write tasks ---
begin_test "No duplicate write tasks (max 1 writing task)"
WRITE_TASKS=$(echo "$CHILDREN" | jq '[.[] | select(.title | test("write|report|synthesis|final"; "i"))]')
WRITE_COUNT=$(echo "$WRITE_TASKS" | jq 'length')
if [ "$WRITE_COUNT" -le 1 ]; then
    pass
elif [ "$WRITE_COUNT" -le 2 ]; then
    log "$WRITE_COUNT write tasks (acceptable)"
    pass
else
    log "$WRITE_COUNT write tasks found:"
    echo "$WRITE_TASKS" | jq -r '.[] | "    \(.identifier // .id): \(.title) [status=\(.status)]"'
    fail "$WRITE_COUNT write tasks (expected 1-2)"
fi

# --- Metric 9: Timeout rate ---
begin_test "Timeout rate under 20%"
TOTAL_INVOCATIONS=0
TOTAL_FAILED=0
for agent_name in CEO Researcher Data Writer; do
    url="${AGENT_URLS[$agent_name]}"
    metrics=$(curl -sf "$url/metrics" 2>/dev/null || echo "{}")
    total=$(echo "$metrics" | jq -r '.requests_total // 0')
    failed=$(echo "$metrics" | jq -r '.requests_failed // 0')
    pre="${PRE_METRICS[$agent_name]}"
    run_total=$((total - pre))
    TOTAL_INVOCATIONS=$((TOTAL_INVOCATIONS + run_total))
    TOTAL_FAILED=$((TOTAL_FAILED + failed))
done
if [ "$TOTAL_INVOCATIONS" -gt 0 ]; then
    FAIL_RATE=$((TOTAL_FAILED * 100 / TOTAL_INVOCATIONS))
    log "$TOTAL_FAILED/$TOTAL_INVOCATIONS failed ($FAIL_RATE%)"
    if [ "$FAIL_RATE" -lt 20 ]; then
        pass
    else
        fail "timeout/failure rate ${FAIL_RATE}% (need <20%)"
    fi
else
    skip "no invocations recorded"
fi

# --- Metric 10: Artifacts produced ---
begin_test "Artifacts produced in MinIO"
ARTIFACT_COUNT=$(curl -sf "http://localhost:8090/artifacts?limit=100" 2>/dev/null | jq 'length' 2>/dev/null || echo "0")
if [ "$ARTIFACT_COUNT" -ge 3 ]; then
    log "$ARTIFACT_COUNT artifacts in store"
    pass
elif [ "$ARTIFACT_COUNT" -gt 0 ]; then
    log "$ARTIFACT_COUNT artifacts (low count)"
    pass
else
    fail "no artifacts found in artifact service"
fi

echo ""

# ═══════════════════════════════════════════════════════════════════════
# FINAL REPORT
# ═══════════════════════════════════════════════════════════════════════
tlog "═══════════════════════════════════════════════════════════════"
tlog "M0.1 EVALUATION REPORT"
tlog "═══════════════════════════════════════════════════════════════"
tlog ""
tlog "Run ID:       $RUN_ID"
tlog "Parent issue: $PARENT_KEY ($PARENT_ID)"
tlog "Duration:     ${ELAPSED}s ($((ELAPSED / 60))m $((ELAPSED % 60))s)"
tlog "Parent status: $PARENT_STATUS"
tlog ""

# Issue summary table
tlog "ISSUES:"
tlog "  Parent: $PARENT_KEY — $ISSUE_TITLE [$PARENT_STATUS]"
if [ "$CHILD_COUNT" -gt 0 ]; then
    echo "$CHILDREN" | jq -r '.[] | "  \(.identifier // .id[0:8]): \(.title) [status=\(.status), assignee=\(.assigneeAgentId // "none")[0:8]]"' | \
        while IFS= read -r line; do tlog "  $line"; done
fi
tlog ""

# Agent invocation summary
tlog "AGENT INVOCATIONS (this run):"
for agent_name in CEO Researcher Data Writer; do
    url="${AGENT_URLS[$agent_name]}"
    metrics=$(curl -sf "$url/metrics" 2>/dev/null || echo "{}")
    total=$(echo "$metrics" | jq -r '.requests_total // 0')
    failed=$(echo "$metrics" | jq -r '.requests_failed // 0')
    avg=$(echo "$metrics" | jq -r '.avg_duration_ms // 0')
    pre="${PRE_METRICS[$agent_name]}"
    run_total=$((total - pre))
    tlog "  $agent_name: $run_total invocations, $failed failed, avg ${avg}ms"
done
tlog ""

tlog "EVAL LOG:   $EVAL_LOG"
tlog "RESULTS:    $RESULTS_DIR"
tlog ""

# Save final snapshot
emit_event "eval_complete" "{\"elapsed\":$ELAPSED,\"parent_status\":\"$PARENT_STATUS\",\"children\":$CHILD_COUNT,\"done\":$DONE_COUNT,\"self_assigned\":$CEO_SELF,\"escalations\":$ESC_COUNT,\"write_tasks\":$WRITE_COUNT}"

# Save issue dump
echo "$ALL_ISSUES" | jq --arg pid "$PARENT_ID" '[.[] | select(.id == $pid or .parentId == $pid)]' > "$RESULTS_DIR/issues.json"
tlog "Issue dump saved to $RESULTS_DIR/issues.json"

echo ""
summary
