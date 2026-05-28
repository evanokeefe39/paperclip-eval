# Async Server Refactor — Subagent Execution Plan

Spec: inline (async response pattern + heartbeat config update)

## Key findings from exploration

1. **17 e2e tests call `/invoke` directly** via `bridge_post()` and expect synchronous JSON response with `output` field. These tests AND the helper must be updated to work with async 202 + polling `/runs/:runId`.

2. **Paperclip HTTP adapter** sends POST to `/invoke` with `{ runId, agentId, context }`. Expects quick 2xx. Response body not consumed by Paperclip — work results flow through Paperclip API mutations.

3. **processInvocation** currently takes `(body, traceId, requestStart, res)` — the `res` parameter holds the connection. Removing it decouples response from processing.

4. **Run tracking**: Map stores run state. Cap at 100 entries to prevent memory leak.

## Status

- [x] W1-B: agent.json heartbeat config (merged)
- [x] W1-A: server.mjs async refactor (merged)
- [x] W2-A: test helpers update (applied)

## Wave 1 — server.mjs refactor (agent.json already done)

### W1-A: server.mjs — pure async response
- **Files:** `src/agents/server.mjs`
- **Depends on:** none
- **Changes:**
  - Add `runs` Map for tracking: `runId -> { status, startedAt, completedAt, wakeReason, output, error, usage }`
  - Add `MAX_RUN_HISTORY = 100` constant
  - POST /invoke: parse body, validate, create run entry as "queued", return 202 `{ runId, status: "accepted" }` immediately, queue work in background
  - `processInvocation(body, traceId, requestStart)` — no `res` param:
    - Update run in Map: "running" at start, "completed"/"failed"/"timeout" at end
    - Store output, error, usage in run entry
    - Keep all Pi SDK logic, cost reporting, logging unchanged
  - Add `GET /runs/:runId` endpoint: return run entry from Map or 404
  - Update `GET /health`: add `runs_active` count
  - Update `GET /metrics`: add `runs_completed`, `runs_active` counts
  - Evict oldest runs when Map exceeds MAX_RUN_HISTORY
  - Queue stores `{ body, traceId, requestStart }` objects

## Wave 2 — test updates (depends on W1-A)

### W2-A: Update ALL test helpers and tests that use bridge_post
- **Files:** `tests/e2e/helpers.sh`, `tests/e2e/e2e-18-bridge-contention.sh`, and all other e2e tests using `bridge_post`
- **Depends on:** W1-A
- **Changes:**
  - `helpers.sh`: rewrite `bridge_post()` to POST, get 202 with runId, poll `/runs/:runId` until completed/failed/timeout, return the output
  - `e2e-18-bridge-contention.sh`: update to test async 202 behavior and queue semantics
  - All other e2e tests: should work via updated `bridge_post()` without changes

## Verification

```bash
node --check src/agents/server.mjs
for f in src/agents/*/agent.json; do jq empty "$f"; done
grep -r "maxConcurrentRuns" src/agents/*/agent.json
```

## Subagent count: 2 (Wave 1: 1, Wave 2: 1)
