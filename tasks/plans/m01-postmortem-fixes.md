# M0.1 Postmortem Fixes — Subagent Execution Plan

Spec: `tasks/evaluations/m01-20260528-postmortem.md`

## Key findings from exploration

- `docker-compose.yml`: agent services at lines 153 (ceo), 176 (researcher), 200 (data), 229 (writer). Each has `environment:` block but no `AGENT_NAME`.
- `src/agents/{researcher,data,writer}/agent.json`: all have `"heartbeat": { "enabled": true, ... }` on line 14.
- `src/agents/extensions/triage-workflow.ts` line 75: `if (AGENT_NAME !== "ceo") return;` — once AGENT_NAME is set, this WILL activate. Must disable.
- `src/agents/extensions/paperclip/_client.ts`: `PAPERCLIP_AGENT_ID` at line 4, not exported. Need to add export.
- `src/agents/extensions/paperclip/index.ts`: `paperclip_create_issue` handler at line 155-159, `paperclip_update_issue` handler at line 178-181.
- `src/agents/server.mjs`: `initServices()` at line 100-108, startup at line 378-386. AGENT_NAME at line 25.
- `tests/e2e/helpers.sh`: `require_stack` at line 329-362.
- `tests/e2e/e2e-19-m01-milestone.sh`: preflight at line 66-104.

## Wave 1 — 4 parallel subagents

All files disjoint.

### W1-A: docker-compose + agent.json configs
- **Files:** `docker-compose.yml`, `src/agents/researcher/agent.json`, `src/agents/data/agent.json`, `src/agents/writer/agent.json`
- **Depends on:** none
- **Changes:**
  1. docker-compose.yml: add `AGENT_NAME: "ceo"` to ceo environment block (after line 165), `AGENT_NAME: "researcher"` to researcher (after line 188), `AGENT_NAME: "data"` to data (after line 213), `AGENT_NAME: "writer"` to writer (after line 241)
  2. researcher/agent.json line 14: change `"enabled": true` to `"enabled": false`
  3. data/agent.json line 14: change `"enabled": true` to `"enabled": false`
  4. writer/agent.json line 14: change `"enabled": true` to `"enabled": false`

### W1-B: Disable triage-workflow
- **Files:** `src/agents/extensions/triage-workflow.ts`
- **Depends on:** none
- **Changes:** At line 75, replace `if (AGENT_NAME !== "ceo") return;` with just `return;` so the extension never registers tools or hooks. Add a comment on line above: `// Disabled: running standard Paperclip heartbeat protocol without phase gates`

### W1-C: Self-assignment guard in paperclip extension
- **Files:** `src/agents/extensions/paperclip/_client.ts`, `src/agents/extensions/paperclip/index.ts`
- **Depends on:** none
- **Changes:**
  1. `_client.ts`: add `export const SELF_AGENT_ID = PAPERCLIP_AGENT_ID;` after line 5
  2. `index.ts` line 8: add `SELF_AGENT_ID` to the import from `./_client.js`
  3. `index.ts`: in the `paperclip_create_issue` handler (line 155-159), before `return ok(...)`, add a check: if `process.env.AGENT_NAME === "ceo"` AND `p.assigneeAgentId === SELF_AGENT_ID`, return an error object `{ content: [{ type: "text", text: "Self-assignment blocked: CEO must delegate to other agents, not self-assign." }] }`
  4. Same check in `paperclip_update_issue` handler (line 178-181) for `p.assigneeAgentId`

### W1-D: server.mjs startup validation + e2e preflight
- **Files:** `src/agents/server.mjs`, `tests/e2e/helpers.sh`, `tests/e2e/e2e-19-m01-milestone.sh`
- **Depends on:** none
- **Changes:**
  1. `server.mjs`: after line 382 (`log("info", "ready", ...)`), add validation block:
     - If `!AGENT_NAME`, log error "missing_agent_name" and `process.exit(1)`
     - Get extension count from `services.resourceLoader.getExtensions().extensions.length`
     - If count < 3, log error "insufficient_extensions" with count and `process.exit(1)`
     - Log the validated state: `log("info", "validated", { agent_name: AGENT_NAME, extensions: extCount })`
  2. `helpers.sh`: in `require_stack()` after the healthy checks (line 354), add verification that each agent returns `status: "ok"` from `/health` (not `"starting"`). Loop over CEO, Researcher, Data, Writer URLs.
  3. `e2e-19-m01-milestone.sh`: no changes needed — `require_stack` already called at line 69, the enhanced version handles it.

## Verification

After all subagents complete:
```bash
# Config changes
grep -c "AGENT_NAME" docker-compose.yml  # should be 4
grep '"enabled": false' src/agents/researcher/agent.json src/agents/data/agent.json src/agents/writer/agent.json  # 3 matches
grep '"enabled": true' src/agents/ceo/agent.json  # 1 match (CEO still polls)

# Triage disabled
grep -n "return;" src/agents/extensions/triage-workflow.ts | head -2  # line 75-76 area should show early return

# Self-assignment guard
grep -c "SELF_AGENT_ID" src/agents/extensions/paperclip/index.ts  # should be >= 2
grep "SELF_AGENT_ID" src/agents/extensions/paperclip/_client.ts  # should exist

# Startup validation
grep "missing_agent_name" src/agents/server.mjs  # should exist
grep "insufficient_extensions" src/agents/server.mjs  # should exist

# E2e preflight
grep "status.*ok" tests/e2e/helpers.sh  # should exist
```

## Subagent count: 4 (4 in wave 1)
