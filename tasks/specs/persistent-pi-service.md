# Persistent Pi Service — Bridge Architecture Rework

## Intent

Eliminate the spawn-per-request pattern in bridge.mjs. Pi's RPC mode supports
persistent multi-prompt sessions — the bridge currently kills the process after
every request, paying 1.7-2.6s cold-start on every invocation. Change the bridge
to spawn Pi once at startup and reuse the process across all /invoke requests.

## Context Package

### Relevant existing code

- `src/agents/bridge.mjs` — HTTP bridge, spawns Pi per request, kills on agent_end
- `src/agents/logger.mjs` — shared structured logger
- `tests/e2e/run-e2e.sh` — E2E test runner
- `tests/e2e/e2e-*.sh` — individual E2E tests (18 scripts)
- `tasks/lessons.md` — lessons learned log
- `tasks/issues/bridge-contention-503.md` — issue doc for the queue fix
- `CLAUDE.md` — project docs (bridge section)
- `LEARNING.md` — running issues/workarounds log

### Architectural constraints

- Zero npm dependencies in bridge.mjs (design principle)
- Pi's RPC protocol: JSONL over stdin/stdout, supports `new_session` command
- FIFO queue (just added in v1.2.0) serializes requests — no concurrent Pi access
- Bridge runs inside Docker containers, one per agent
- Each agent has its own Pi config (provider, model, skills, extensions)

### Prior decisions

- Queue replaces 503 rejection (v1.2.0, this session)
- Pi spawned with --mode rpc --no-session (stateless between requests)
- Extensions discovered by Pi natively from ~/.pi/agent/extensions/
- Skills passed via --skill flags at spawn time

## Behavioral Contracts

GIVEN the bridge starts up
WHEN Pi process is spawned at startup
THEN bridge logs pi_spawn event with spawn args, waits for extensions to load,
     and logs pi_persistent_ready with startup duration

GIVEN a persistent Pi process is running
WHEN /invoke arrives with a prompt
THEN bridge sends new_session command, waits for success response,
     sends prompt, collects events through agent_end, returns HTTP 200

GIVEN a persistent Pi process is running and busy (queue non-empty)
WHEN /invoke arrives
THEN request is queued (existing FIFO behavior), processed when Pi is idle

GIVEN the persistent Pi process crashes or exits unexpectedly
WHEN the bridge detects process exit
THEN bridge logs pi_crash event, respawns Pi automatically,
     and any in-flight request gets a 503 with restart context

GIVEN a queued request's Pi process crashes mid-execution
WHEN the bridge respawns Pi
THEN the failed request returns 503, queued requests proceed on new process

GIVEN the bridge receives SIGTERM
WHEN shutting down
THEN bridge drains current request (if any), closes Pi stdin, waits for exit

GIVEN /health is called
WHEN Pi is persistent
THEN response includes pi_uptime_s, pi_restarts count, queue state

## Edge Case Inventory

1. Pi process crashes during extension loading at startup — bridge should retry
   with backoff (max 3 attempts), then exit with error if unrecoverable
2. Pi process hangs (no output for BRIDGE_TIMEOUT_MS) — kill and respawn
3. new_session command fails or times out — treat as crash, respawn
4. Bridge receives /invoke before Pi is ready at startup — queue the request
5. Pi exits with non-zero code between requests (idle crash) — respawn immediately
6. Multiple rapid crashes (crash loop) — exponential backoff, log clearly

## Definition of Done

- [ ] Bridge spawns Pi once at startup, reuses across requests
- [ ] new_session sent between independent invocations
- [ ] Crash detection and auto-respawn with backoff
- [ ] /health exposes Pi process uptime and restart count
- [ ] /metrics exposes queue stats (already done) plus cold_start_ms
- [ ] E2E tests pass (run-e2e.sh)
- [ ] E2E-18 (bridge contention) validates queue + persistent process
- [ ] tasks/lessons.md updated with persistent Pi learning
- [ ] tasks/issues/bridge-contention-503.md updated
- [ ] CLAUDE.md bridge section updated
- [ ] LEARNING.md updated
- [ ] Version bumped to 2.0.0

## Negative Space

- NOT changing the FIFO queue — it stays as-is for serialization
- NOT implementing concurrent Pi processes (one process per container)
- NOT switching to in-process library import (Option B) — too coupled
- NOT changing extension loading, skill discovery, or Pi config
- NOT touching agent Dockerfiles or docker-compose.yml
- NOT changing the /invoke HTTP contract (same request/response shape)

## Open Questions

(none)
