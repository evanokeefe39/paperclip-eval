# Agent: CEO

## Status

Implemented. Container running, registered with Paperclip via HTTP adapter.

## Intent

Strategic leadership agent. Decomposes high-level goals into delegated tasks, coordinates cross-agent work, synthesizes outputs into decisions. The orchestration brain — never executes directly, always delegates.

## Upstream / Downstream

- Upstream: human (via Paperclip issues/tasks), milestone briefs
- Downstream: all other agents (task assignment via Paperclip wake)
- Receives: synthesized outputs from Researcher, Writer, QA, Publisher
- Escalations: receives escalation issues from any agent needing decisions

## Capabilities

- Task decomposition and prioritization
- Cross-agent coordination and sequencing
- Decision-making when agents conflict or need direction
- Output synthesis into coherent plans and summaries
- Goal tracking against milestones

## Extensions

None currently. Future:
- `org-data-query.ts` — read access to structured data for informed decisions

## Model Configuration

- Primary: nvidia/meta/llama-4-maverick-17b-128e-instruct (default)
- Agentic: minimax/MiniMax-M2.7
- Planning: deepseek/deepseek-reasoner
- Smol tasks: groq/llama-3.1-8b-instant
- Retry chains with provider fallbacks (max 5)

## Security / Permissions

| Capability | Allowed |
|-----------|---------|
| Code execution | No |
| Web egress | No |
| File delete | No |
| Publish | No |
| HITL required | No |

Read from /artifacts (all agents). No write to /artifacts (delegates production to other agents).

## Behavioral Contracts

GIVEN a milestone brief or goal
WHEN CEO receives it
THEN decompose into discrete tasks with clear ownership, success criteria, and sequencing

GIVEN outputs from multiple agents
WHEN all subtasks for a goal complete
THEN synthesize into a coherent summary with decision recommendations

GIVEN an escalation from any agent
WHEN the escalation is type "request_decision"
THEN provide a clear decision with rationale within the agent's next wake cycle

GIVEN conflicting outputs from two agents
WHEN CEO reviews them
THEN resolve with explicit reasoning, never silently prefer one

## Constraints

- Never write code, data queries, or content directly
- Never bypass QA — all publishable output routes through QA first
- Keep responses focused and actionable — no filler
- Communicate decisions with rationale

## Existing Files

```
src/agents/ceo/
  agent.json              Registration metadata
  AGENTS.md               System prompt / role instructions
  .pi/agent/config.yml    Model roles, retry, compaction
  .pi/agent/models.json   Provider configs (8 providers)
  .pi/agent/settings.json Extensions, defaults
  .pi/agent/auth.json     Provider API keys (gitignored)
```
