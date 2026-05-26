# wakeOnDemand not triggering on issue assignment for HTTP adapter agents

**Severity:** Critical (blocks multi-agent orchestration)
**Component:** Paperclip runtime, agent runtimeConfig
**Found:** 2026-05-26

## Problem

When CEO creates a child issue assigned to Researcher via `POST /api/companies/{cid}/issues` with `assigneeAgentId` set, Paperclip does not auto-invoke the Researcher agent. Researcher container shows zero invocations — only the startup log.

All agents have `wakeOnDemand: true` and `heartbeat.enabled: false` in their runtimeConfig.

## Expected behavior

Per the Paperclip skill docs (`/app/skills/paperclip/SKILL.md`), the platform supports automatic wakes:

- `issue_blockers_resolved` — wakes assignee when all blockedBy issues reach done
- `issue_children_completed` — wakes parent assignee when all children reach terminal state

Step 9 says "prefer child issues over polling" and "rely on Paperclip wake events or comments for completion." This implies creating a child issue with an assignee should trigger an invocation of that agent.

## What we observed

- CEO created EVA-2, EVA-3, EVA-4 as child issues of EVA-1 with correct `parentId` and `assigneeAgentId`
- Issues appear in Paperclip with correct assignments (verified via API)
- Researcher container received zero POST /invoke requests after issue creation
- Only the manual `POST /api/agents/{id}/heartbeat/invoke` triggers agent execution

## Possible causes

1. **`wakeOnDemand` only applies to specific wake reasons** (blockers_resolved, children_completed, comment mentions) — not to initial issue assignment. New assignment may require heartbeat polling or an explicit invoke.

2. **HTTP adapter wake behavior differs from local adapters.** Local adapters run as managed subprocesses — Paperclip can spawn them directly. HTTP adapters are external services that Paperclip POSTs to. The wake dispatch might not be implemented for HTTP adapters, or might need additional config.

3. **Issue status matters.** CEO created sub-issues in `todo` status. Paperclip might only wake agents when issues transition to a specific status, or when triggered by the checkout flow.

4. **Missing `PAPERCLIP_RUN_ID` header.** The skill docs say agents MUST include `X-Paperclip-Run-Id` on all API requests that modify issues. CEO's sub-issue creation via our paperclip-tools extension doesn't send this header. Paperclip might reject the wake trigger silently when the creating request lacks a run context.

5. **Heartbeat needs to be enabled** even for on-demand agents. `wakeOnDemand` might supplement heartbeat, not replace it — agents might need at least one heartbeat cycle to pick up assigned work.

## Investigation steps

- Check Paperclip logs for any wake dispatch attempts after sub-issue creation
- Try enabling `heartbeat.enabled: true` with a long interval on Researcher and see if it picks up EVA-2
- Check if adding a comment with `resume: true` on EVA-2 triggers a Researcher wake
- Check Paperclip source for HTTP adapter wake dispatch code
- Test whether local adapters (if available) get auto-woken on assignment

## Resolution (2026-05-26)

**Root cause:** Cause 1 confirmed. `wakeOnDemand` only applies to specific lifecycle events (blockers_resolved, children_completed, comment mentions, approval resolution). Issue assignment is NOT a wake trigger. Paperclip uses a poll-plus-event hybrid model — heartbeat polling is the primary work-intake mechanism, wakeOnDemand supplements it with reactive signals.

**Systemic issues found:**
- `client.ts` missing `X-Paperclip-Run-Id` header on all mutating requests (cause 4 was also real)
- No tool for CEO to explicitly invoke agents after delegation

**Fixes applied:**
1. All 7 agent.json files: `heartbeat.enabled: true, intervalMs: 120000` (2min poll + wakeOnDemand for events)
2. `client.ts`: sends `X-Paperclip-Run-Id` header on non-GET requests when `PAPERCLIP_RUN_ID` env var is set
3. `paperclip-tools.ts`: added `paperclip_invoke_agent` tool wrapping `POST /api/agents/{id}/heartbeat/invoke`
4. `bridge.mjs`: added wake context logging (reason, taskId, commentId, approvalId, runId)

**Re-registration required:** Existing agents in Paperclip still have the old runtimeConfig. Either re-run `setup.sh` against a fresh instance or PATCH each agent's runtimeConfig via the API.

**Status:** Fixed
