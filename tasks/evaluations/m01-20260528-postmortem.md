# M0.1 Postmortem — 2026-05-28 Run

Run ID: `m01-20260528-222242`
Duration: 1669s (27m 49s) — parent reached `done`
Wall-clock including settle: ~30 min

## Timeline

| Time | Elapsed | Event |
|------|---------|-------|
| 20:22:45 | 0s | Parent EVA-11 created, CEO invoked |
| 20:23:23 | 34s | CEO creates EVA-12 (TikTok research) + EVA-13 (Instagram research) |
| 20:25:09 | 141s | CEO creates EVA-14, EVA-15, EVA-16 (researcher, data, writer tasks) |
| 20:25:45 | 177s | First child done |
| 20:27:34 | 284s | Parent goes `blocked` — stays blocked for ~7 min |
| 20:32:44 | 593s | 3/5 done |
| 20:35:16 | 746s | 4/5 done |
| 20:39:40 | 1012s | CEO creates EVA-17 (self-assigned "Review productivity") — 6th child |
| 20:44:35 | 1304s | 5/6 done, stall begins (1 blocked, 0 in_progress) |
| 20:47:35 | 1484s | 6/6 done, but parent NOT done — CEO can't close |
| 20:50:40 | 1669s | Parent finally reaches `done` |

## Final Issue State

| Issue | Title | Status | Assignee |
|-------|-------|--------|----------|
| EVA-11 | Parent: Faceless Tech Channel Analysis | done | CEO |
| EVA-12 | Research: Faceless Tech Channels on TikTok | done | **Data** (was Researcher) |
| EVA-13 | Research: Faceless Tech Channels on Instagram | done | **Data** (was Researcher) |
| EVA-14 | Researcher: Platform-Specific Analysis | **cancelled** | Researcher |
| EVA-15 | Data: Cross-Platform Comparison | done | Data |
| EVA-16 | Writer: Final Synthesis Report | done | **CEO** (should be Writer) |
| EVA-17 | Review productivity for EVA-11 | done | **CEO** (self-assigned) |

## Invocations During Run

| Agent | Completions | Longest Request | Notes |
|-------|-------------|-----------------|-------|
| CEO | 22 | 290s (4.8 min) | Many short idle cycles post-stall |
| Researcher | 11 | 163s (2.7 min) | 5 completions were idle |
| Writer | 10 | 496s (8.3 min) | Single synthesis request = 8 min |
| Data | 14 | 340s (5.7 min) | Took over EVA-12/13 from Researcher |

## Idle Heartbeat Waste (Pre-Run)

All agents were idle before the M01 run started. Paperclip timer fired every ~150s, each agent woke, found no work, went back to sleep.

| Agent | Pre-run heartbeats | Idle (< 15s) |
|-------|-------------------|--------------|
| CEO | 31 | 20 |
| Researcher | 23 | 21 |
| Writer | 25 | 17 |
| Data | 26 | 25 |
| **Total** | **105** | **83** |

83 wasted invocations before any real work started.

---

## Root Cause Analysis

### Defect 1: AGENT_NAME Not Set

**Symptom:** `[workproduct] writer extension loaded in wrong agent: unknown`

Every agent's workproduct extension checks `process.env.AGENT_NAME` to gate registration. AGENT_NAME is never set anywhere — not in docker-compose.yml, not in per-agent `.env` files, not in Dockerfiles.

Result: `AGENT_NAME` falls back to `"unknown"`, workproduct extensions skip registration in all agents. Writer can't use `record_report`. Researcher can't use `record_finding`. Data can't use `record_data_product`.

**Five Whys:**

1. Why did workproduct tools not register? — AGENT_NAME env var is "unknown"
2. Why is AGENT_NAME "unknown"? — It's not set in any env file or docker-compose
3. Why isn't it set? — It was never added when workproduct extensions were created
4. Why wasn't the gap caught? — No startup validation or e2e test checks for tool availability
5. Why is there no startup validation? — **server.mjs treats extension loading as fire-and-forget with no post-load verification**

**Root cause:** Missing poka-yoke. Extensions silently degrade instead of failing loud. The line should have stopped here — an agent that can't record work products is fundamentally broken. Instead it ran for 28 minutes producing unstructured output.

### Defect 2: CEO Self-Assignment

**Symptom:** EVA-16 (Writer task) and EVA-17 (Review) assigned to CEO

CEO has `paperclip_create_issue` and `paperclip_update_issue` allowed. Nothing prevents it from setting `assigneeAgentId` to its own ID. The triage workflow gates *when* CEO can create issues (READY phase only) but not *who* it assigns them to.

EVA-16 "Writer: Final Synthesis Report" ended up assigned to CEO (75a3af08). This is a coordination agent doing execution work — exactly what the pi-permissions deny list was designed to prevent, but the deny list only blocks execution tools (bash, write, edit), not issue self-assignment.

**Five Whys:**

1. Why did CEO do work it shouldn't? — It self-assigned EVA-16 and EVA-17
2. Why could it self-assign? — `paperclip_update_issue` allows setting any assigneeAgentId
3. Why isn't self-assignment blocked? — The triage workflow only gates phase transitions, not assignee values
4. Why was this missed? — The permission model treats "can't run bash/write" as sufficient to prevent work, but CEO can still "do work" via comments and issue body text
5. Why is there no invariant check? — **No tool_call hook validates that CEO never appears as assignee on child issues**

**Root cause:** Incomplete enforcement. CEO is blocked from execution tools but not from claiming ownership via the coordination tools it legitimately needs.

### Defect 3: Task Reassignment — Researcher Work Went to Data

**Symptom:** EVA-12 and EVA-13 (research tasks) ended up assigned to Data agent, not Researcher

EVA-14 (the "proper" Researcher task) was cancelled. Meanwhile EVA-12/13 — originally created with Researcher as assignee — were reassigned to Data. This means Data did research work AND its own analysis work. Researcher did almost nothing useful during the run.

**Five Whys:**

1. Why did Data do Researcher's work? — EVA-12/13 were reassigned to Data's agent ID
2. Why were they reassigned? — CEO used `paperclip_update_issue` to change the assignee
3. Why did CEO reassign? — Likely because Researcher was slow/stuck and CEO decided to reroute
4. Why was Researcher slow? — Its workproduct extension failed to load (AGENT_NAME missing), and it may have been unable to complete structured outputs
5. Why didn't CEO escalate instead of reassigning? — **No guardrail prevents CEO from changing assignees on in-flight tasks, and no escalation trigger fires when an agent underperforms**

**Root cause:** CEO has unconstrained ability to mutate issue assignments. Combined with Defect 1 (broken Researcher), CEO made a "rational" but architecturally wrong decision.

### Defect 4: 10-Minute Stall With No Circuit Breaker

**Symptom:** From 20:44 (stall_polls=15) to 20:50 (parent done), ~6 minutes where parent was blocked/in_progress, all children done, and CEO kept cycling heartbeats doing nothing useful.

The eval script detected the stall (stall_warning events), but the system itself had no mechanism to break out. CEO kept getting invoked by Paperclip's heartbeat timer, consuming tokens on 5-10 second "nothing to do" cycles.

After all 6 children were done (20:47:35), it took another 3 minutes for CEO to finally mark parent done. During this time CEO completed 3 requests consuming tokens for no reason.

**Five Whys:**

1. Why did the system stall for 6+ minutes? — Parent was blocked but CEO couldn't resolve the block
2. Why couldn't CEO resolve it? — The blocked child (EVA-17, self-assigned review) was stuck
3. Why didn't the stall trigger an automatic stop? — The eval script logs warnings but takes no action
4. Why doesn't the server have a circuit breaker? — server.mjs processes every heartbeat equally, no "progress required" check
5. Why is there no progress-required check? — **The heartbeat protocol has no concept of "futile cycle" — if Paperclip says wake, the agent wakes, period**

**Root cause:** Missing jidoka. The andon cord exists (stall_warning) but nobody pulls it. In TPS terms: the machine detected the defect, displayed the warning light, but the line kept running.

### Defect 5: Idle Heartbeat Waste

**Symptom:** 83 wasted invocations (< 15s each) before the M01 run even started

Paperclip fires heartbeat timers on a fixed schedule (~150s). Agents wake, check inbox, find nothing, go back to sleep. Each wake costs a DeepSeek API call (token burn).

**Five Whys:**

1. Why do agents wake when there's no work? — Paperclip heartbeat timer fires regardless of inbox state
2. Why does the timer fire regardless? — Heartbeat timer is the primary coordination mechanism, no "inbox has items" gate
3. Why is there no "inbox has items" gate? — Paperclip's HTTP adapter fires `/invoke` on every timer tick, the adapter can't check inbox before firing
4. Why can't the adapter check inbox? — The adapter just POSTs to the webhook URL, it's fire-and-forget by design
5. Why accept fire-and-forget for a system that runs 24/7? — **The heartbeat interval config treats all states equally — no quiescent mode for idle agents**

**Root cause:** No idle detection. Paperclip config has `heartbeatIntervalMinutes` but no way to say "only wake me if there's work."

---

## Toyota Way Violations

### Jidoka (Autonomation — Stop and Fix)

**Violation:** The system detected problems at multiple levels and continued running:

1. `[workproduct] writer extension loaded in wrong agent: unknown` — logged at boot, not treated as fatal
2. `[workproduct] Skipping researcher workproduct extension` — logged per-request, not treated as fatal
3. `[workproduct] data extension loaded in wrong agent: unknown` — same
4. Stall warnings (stall_polls 15-32) — logged by eval script, no action taken
5. CEO self-assigned work — no invariant violation raised

In TPS: if a part doesn't fit, the line stops. Our agents logged "part doesn't fit" and kept assembling.

**Required fix:** Extensions that fail to load must cause server.mjs to exit nonzero. Docker healthcheck will detect the exit, the container stays down, and `docker compose` logs show the real error. This is the andon cord — a broken agent should not accept work.

### Heijunka (Level Loading)

**Violation:** Researcher did almost no useful work. Data did 3 agents' worth (its own + 2 research tasks). Writer had a single 8-minute request that blocked its queue. No load leveling.

### Muda (Waste)

Three forms of waste observed:

1. **Waiting waste:** 83 idle heartbeats before real work, 6+ minute stall after all children done
2. **Overprocessing waste:** CEO spent 22 invocations coordinating 6 issues — ratio of ~3.7 invocations per issue created
3. **Defect waste:** EVA-14 created then cancelled, EVA-12/13 reassigned — rework

### Genchi Genbutsu (Go See)

**Violation:** This postmortem is the first time anyone looked at the actual container logs. The eval script monitored issue status via API polling but never checked:
- Whether extensions loaded correctly
- Whether agents could actually use their tools
- Whether heartbeats produced meaningful output vs. idle cycles

The eval script needs a preflight that queries each agent's `/health` or `/tools` endpoint to verify tool availability before starting.

---

## Action Items

| Priority | Action | Defect |
|----------|--------|--------|
| P0 | Add `AGENT_NAME` env var to docker-compose.yml for each service | #1 |
| P0 | Make server.mjs fail-fast if critical extensions don't register | #1, Jidoka |
| P1 | Add tool_call hook: reject `create_issue`/`update_issue` where assignee = CEO self | #2 |
| P1 | Add circuit breaker: after N futile heartbeats (no status change), auto-escalate | #4 |
| P1 | Add preflight to e2e test: verify tool list per agent before creating work | Genchi Genbutsu |
| P2 | Cap CEO comments per issue per heartbeat cycle | #4 |
| P2 | Add idle detection: skip invoke if agent inbox empty for N consecutive cycles | #5 |
| P3 | Track reassignment as an event — log when CEO changes assignee, flag if to self | #3 |
