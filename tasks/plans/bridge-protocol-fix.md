# Bridge Protocol Fix

## Problem

bridge.mjs waits for first stdout event before sending prompt to Pi. With oh-my-pi extensions installed, Pi emits `extension_ui_request` events (not `ready`) before processing. The 5-second fallback timeout works but is fragile and adds unnecessary latency.

## Root Cause

The original protocol assumption: Pi emits a "ready" event on startup. Reality: Pi accepts input immediately after spawn. The stdout wait was a workaround for a race condition that doesn't exist — Pi's stdin buffer accepts writes before any stdout is produced.

## Fix

1. Remove the "wait for first stdout" block entirely
2. Send prompt to stdin immediately after spawn
3. Keep the existing agent_start wait as the confirmation that Pi is processing
4. Add prompt rejection detection (response event with success: false)
5. Update pi_ready log to include extensions_active flag

## Files Changed

- `src/agents/bridge.mjs` — protocol fix
- `tests/hurl/tier2-contracts.hurl` — test 2.7 assertion updated (ready → agent_start/agent_end/message_update)
- `tests/run-all.ps1` — test name mapping aligned with actual hurl tests

## Verification

1. Rebuild: `docker compose -f src/agents/docker-compose.yml up -d --build`
2. Health: `curl http://localhost:8081/health`
3. Invoke: `curl -X POST http://localhost:8081/invoke -H "Content-Type: application/json" -d '{"prompt":"Say hello."}'`
4. Confirm events array has agent_start and agent_end, no ready event
5. Tests: `.\tests\run-all.ps1 -Tier 2`

## Status

- [x] Plan written
- [x] bridge.mjs fixed
- [x] Tests updated
- [x] Docs written
- [x] Verified end-to-end (protocol flow confirmed, API key placeholder causes 401 but lifecycle correct)
