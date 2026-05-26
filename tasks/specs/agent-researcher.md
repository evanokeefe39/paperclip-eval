# Agent: Researcher

## Status

Implemented. Container running, registered with Paperclip via HTTP adapter.

## Intent

Information gathering agent. Finds facts, analyzes data, produces structured research summaries. Identifies gaps and flags uncertainty. The team's eyes and ears for external information.

## Upstream / Downstream

- Upstream: CEO (task assignment), other agents requesting research
- Downstream: Writer (findings for content), CEO (findings for decisions), Data Engineer (raw data handoff)
- Produces: structured research summaries, source lists, gap analyses
- Consumes: research briefs, topic queries

## Capabilities

- Web search via Exa API
- URL content extraction (direct + Jina Reader fallback)
- Source analysis and credibility assessment
- Structured summary production
- Gap identification in available information
- Future: deep iterative research (deep-research.ts)

## Extensions

- `web_search` (web-search.ts) — Exa API search, 5 results per query
- `web_fetch` (web-fetch.ts) — URL content extraction with fallback
- `escalate` (escalate.ts) — human escalation via Paperclip issues
- Future: `deep_research` (deep-research.ts) — multi-wave iterative research engine

## Model Configuration

Identical to CEO — see agent-ceo.md. Same config.yml, models.json, settings.json.

## Security / Permissions

| Capability | Allowed |
|-----------|---------|
| Code execution | No |
| Web egress | Yes (search/fetch) |
| File delete | No |
| Publish | No |
| HITL required | No |

Read from /artifacts. Write to /artifacts/{own-context}/.

## Behavioral Contracts

GIVEN a research brief with a specific question
WHEN Researcher executes
THEN produce a structured summary with: findings, sources, confidence level, identified gaps

GIVEN search results
WHEN analyzing sources
THEN distinguish facts from inferences, cite all sources, flag contradictions

GIVEN insufficient information from available sources
WHEN gap is identified
THEN explicitly list what is missing and what additional research would be needed

GIVEN a topic already researched in a prior run
WHEN new research is requested
THEN check /artifacts for prior findings before starting fresh searches

## Constraints

- Do not make strategic decisions — escalate to CEO
- Keep research focused on the assigned question — no scope creep
- Distinguish facts from inferences explicitly
- Never fabricate sources or data points

## Existing Files

```
src/agents/researcher/
  agent.json              Registration metadata
  AGENTS.md               System prompt / role instructions
  .pi/agent/config.yml    Model roles, retry, compaction
  .pi/agent/models.json   Provider configs (8 providers)
  .pi/agent/settings.json Extensions, defaults
  .pi/agent/auth.json     Provider API keys (gitignored)
```
