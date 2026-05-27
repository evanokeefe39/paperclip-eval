# Heartbeat only invokes CEO

## Status

Open.

## Symptom

After fresh setup with heartbeat enabled on all 4 running agents (CEO, Researcher, Data, Writer), only CEO receives automatic heartbeat invocations from Paperclip. Researcher, Writer, and Data are never invoked by the scheduler despite having `heartbeat.enabled: true` in their registered runtimeConfig. Root cause: config used `intervalMs: 120000` but Paperclip reads `intervalSec`. Fixed to `intervalSec: 120`.

Researcher and Writer were only invoked reactively when CEO created issues assigned to them (wakeOnDemand trigger from issue creation), not by the periodic heartbeat scheduler.

## Evidence

- Paperclip log shows `Heartbeat enabled (30000ms)` at startup — this is Paperclip's internal scheduler interval, not per-agent
- CEO container logs show invocations every ~120s after manual trigger
- Researcher/Writer only show invocations at 22:32:39 (immediately after CEO created and assigned issues to them)
- No periodic heartbeat invocations to Researcher/Writer/Data in the logs

## Verified

- All agents have correct runtimeConfig registered (confirmed via `GET /api/agents/{id}`)
- Connectivity works: `curl http://researcher:8080/health` returns 200 from inside Paperclip container
- All agents show `status: idle` or `status: running` in Paperclip

## Hypothesis

Paperclip may only invoke agents via heartbeat when they have items in their inbox. If inbox is empty, heartbeat is skipped. This would explain why CEO (with EVA-1 in inbox) gets invoked but other agents (no assigned todo issues initially) don't.

Alternative: Paperclip heartbeat scheduler may only invoke one agent per cycle, round-robin or priority-based, and CEO is always first.

## Impact

High. Agents won't pick up work unless explicitly invoked or triggered by wakeOnDemand events. Breaks the autonomous heartbeat polling model.

## Workaround

Manual invocation via `POST /api/agents/{id}/heartbeat/invoke` or relying on wakeOnDemand triggers from issue assignment.
