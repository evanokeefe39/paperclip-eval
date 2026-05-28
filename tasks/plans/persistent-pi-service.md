# Persistent Pi Service — Subagent Execution Plan

Spec: `tasks/specs/persistent-pi-service.md`

## Key findings from exploration

1. Pi's RPC mode supports persistent multi-prompt sessions. `agent_end` means "prompt done", not "process done." Sending `{"type":"new_session"}` resets conversation context. Process stays alive until stdin is closed.

2. bridge.mjs (v1.2.0) has a FIFO queue at lines 79-81 and processInvocation function at lines 85-325. Pi is spawned at line 145 and killed via `pi.stdin.end()` at line 265. All processing logic is inside processInvocation — refactoring to persistent Pi means extracting the spawn/lifecycle out of that function.

3. E2E-18 (bridge-contention.sh) currently validates 503 rejection behavior — must be updated to validate queue behavior instead. E2E-2, E2E-13, E2E-14 may see timing improvements but their assertions don't depend on spawn-per-request.

4. docs/bridge-design.md lines 159-160 are critically wrong ("no queue or backpressure mechanism"). docs/pi-rpc-protocol.md line 27 says "only one prompt per process lifecycle" — wrong. docs/architecture.md line 86 says "stateless per-request" — will be wrong after this change.

## Wave 1 — 1 subagent (sequential: everything depends on final bridge shape)

### W1-A: Refactor bridge.mjs to persistent Pi process
- **Files:** `src/agents/bridge.mjs`
- **Depends on:** none
- **Changes:**
  - Extract Pi lifecycle out of processInvocation into module-level persistent state
  - Add `spawnPi()` function that spawns Pi once with current args (provider, model, skills)
  - Add `ensurePi()` that spawns if not running, returns existing if alive
  - Add crash detection: `pi.on("close")` when not processing → auto-respawn with exponential backoff (max 3 retries, delays 1s/2s/4s)
  - Add `piState` object: `{ process, ready, restarts, startedAt, lastCrashAt }`
  - Call `spawnPi()` at module level after server.listen
  - In processInvocation: remove spawn() call, replace with `ensurePi()` → send `new_session` → wait for response ack → send prompt → collect events as before → do NOT close stdin at agent_end
  - On error paths: kill Pi, clear piState, let next request trigger respawn via ensurePi
  - Update health endpoint: add `pi_uptime_s`, `pi_restarts`, `pi_status` (starting/ready/crashed)
  - Update metrics endpoint: add `cold_start_ms` (first request latency)
  - Bump version to 2.0.0
  - Handle edge case: /invoke arrives before Pi ready at startup → queue it (existing queue handles this naturally if `processing` is initially true until Pi is ready, or ensurePi awaits readiness)
  - Graceful shutdown: `process.on("SIGTERM")` → drain current request, close stdin, wait for Pi exit

## Wave 2 — 4 parallel subagents (all disjoint files)

### W2-A: Update E2E-18 bridge contention test
- **Files:** `tests/e2e/e2e-18-bridge-contention.sh`
- **Depends on:** W1-A
- **Changes:**
  - Currently tests: second /invoke returns 503 immediately
  - New behavior: second /invoke queues and eventually returns 200
  - Update test to: send two concurrent /invoke requests, verify both return 200, verify health shows queue_depth during processing, verify sequential execution (second response arrives after first)
  - Add assertion: health endpoint shows `pi_restarts: 0` and `pi_status: "ready"`
  - Add assertion: version is "2.0.0"

### W2-B: Update lessons.md and issue doc
- **Files:** `tasks/lessons.md`, `tasks/issues/bridge-contention-503.md`
- **Depends on:** W1-A
- **Changes:**
  - lessons.md: Add new entry "2026-05-28: Pi RPC mode is persistent — stop killing the process"
    - What happened: Bridge spawned new Pi per request, killed via stdin.end() after agent_end. 1.7-2.6s cold start on every invocation. Discovered Pi supports multi-prompt sessions — new_session command resets context, process stays alive.
    - Root cause: Misunderstanding of Pi's RPC lifecycle. agent_end = "prompt done", not "process done". The --no-session flag only affects disk persistence, not in-memory state.
    - Rule: Pi's RPC mode is a persistent service. Spawn once, send new_session between independent invocations, never close stdin unless shutting down. This eliminates cold-start overhead entirely.
  - bridge-contention-503.md: Add "Resolution v2.0.0" section noting the persistent Pi eliminates spawn overhead entirely, queue now only serializes prompt execution not spawn+execution

### W2-C: Update bridge and architecture docs
- **Files:** `docs/bridge-design.md`, `docs/pi-rpc-protocol.md`, `docs/architecture.md`
- **Depends on:** W1-A
- **Changes:**
  - bridge-design.md: Rewrite lines 159-160 to describe FIFO queue + persistent Pi. Add section on Pi lifecycle management (spawn at startup, new_session between requests, crash recovery with backoff). Update event catalog with new events (pi_persistent_ready, pi_crash, pi_respawn, queue_enqueue, queue_dequeue).
  - pi-rpc-protocol.md: Fix line 27 ("only one prompt per process lifecycle" → "supports multiple prompts via new_session command between invocations"). Add section on persistent mode commands: new_session, the prompt/agent_end cycle, crash recovery.
  - architecture.md: Update line 86 ("stateless per-request" → "persistent Pi process, stateless between invocations via new_session"). Note queue serializes access to single Pi process.

### W2-D: Update CLAUDE.md bridge section
- **Files:** `CLAUDE.md`
- **Depends on:** W1-A
- **Changes:**
  - Update "Working with the bridge" section:
    - Add: "Pi runs as a persistent process per container — spawned once at bridge startup, reused across all /invoke requests"
    - Add: "Bridge sends new_session RPC command between independent invocations to reset conversation context"
    - Add: "Bridge auto-respawns Pi on crash with exponential backoff (max 3 retries)"
    - Update version reference if any
    - Add BRIDGE_QUEUE_DEPTH to env var list
  - Update "Known issues" if any spawn-related issues are listed

## Verification

After all waves:
```bash
# Bridge syntax check (Node.js parse)
docker compose exec ceo node --check /app/bridge.mjs

# Health endpoint shows persistent Pi fields
curl -s http://localhost:8081/health | grep -E "pi_uptime|pi_restarts|pi_status|version.*2.0.0"

# Queue test: two concurrent requests both succeed
curl -s -X POST http://localhost:8082/invoke -H "Content-Type: application/json" -d '{"prompt":"Say A"}' &
curl -s -X POST http://localhost:8082/invoke -H "Content-Type: application/json" -d '{"prompt":"Say B"}' &
wait  # both should return 200

# E2E-18 passes
bash tests/e2e/e2e-18-bridge-contention.sh

# Full E2E suite
bash tests/e2e/run-e2e.sh
```

## Subagent count: 5 (1 in wave 1, 4 in wave 2)

## Execution Log

- [x] W1-A: bridge.mjs refactored to persistent Pi (v2.0.0)
- [x] W2-A: E2E-18 updated for queue behavior (11/11 passing)
- [x] W2-B: lessons.md + issue doc updated
- [x] W2-C: bridge-design.md, pi-rpc-protocol.md, architecture.md updated
- [x] W2-D: CLAUDE.md bridge section updated
- [x] jq boolean parsing fix in E2E-18 (`.busy // empty` → `.busy | tostring`)
- [x] Health endpoint restored `busy`, `queue_depth`, `queue_max` fields (dropped during W1-A)
