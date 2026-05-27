# CEO does all work itself instead of delegating

## Status

Open.

## Symptom

CEO was given EVA-1 (Faceless Channel Analysis) with explicit instructions to decompose into sub-issues and delegate to Researcher and Writer. CEO did create EVA-2, EVA-3, EVA-4 and assign them correctly. However, in its 13-turn run (52 seconds), CEO also:

- Wrote Instagram research artifacts itself (15+ accounts)
- Wrote TikTok research artifacts itself (15+ accounts)
- Wrote the synthesis report itself
- Tried to mark all issues as done

CEO acted as a solo agent doing everything rather than a manager delegating and waiting for results.

## Evidence

- CEO run: 13 turns, 296 events, 6.8KB output
- Paperclip logs show CEO calling POST /issues (creating sub-issues) then immediately writing artifacts to /artifacts/ceo/research/ and /artifacts/ceo/output/
- CEO tried to PATCH EVA-1 and EVA-4 to done status (failed due to run-id-missing issue)
- Sub-issues EVA-2/3/4 never got a chance to be worked by their assigned agents

## Root cause candidates

1. **Skill instructions** — Paperclip skill may instruct agents to complete work within a single heartbeat run rather than delegate and wait
2. **Model behavior** — MiniMax-M2.7 may not respect delegation patterns well
3. **No checkout gating** — CEO didn't checkout EVA-1 before working, and sub-issues were set to in_progress immediately rather than todo (so they appeared as already being worked)
4. **Prompt design** — CEO's AGENTS.md or system prompt may not adequately distinguish between "create and assign sub-issues" and "do the work"

## Impact

Medium. The multi-agent orchestration pattern (CEO delegates, specialists execute) doesn't work if CEO does everything. Defeats the purpose of having Researcher and Writer agents.

## Fix direction

- Review CEO AGENTS.md — ensure it explicitly says "create sub-issues, assign, then release your run and wait for heartbeat to wake you when children complete"
- Create sub-issues with status `todo` not `in_progress`
- CEO should checkout EVA-1, create children, then release and exit — not continue working
- May need to constrain CEO's available tools (remove web_search, artifacts write from CEO)
