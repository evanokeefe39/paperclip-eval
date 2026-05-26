# Agent: Analyst

## Status

Stub. Empty directory at src/agents/analyst/.

## Intent

Data analysis and insight extraction agent. Takes raw research findings, scraped data, and organizational datasets, then produces quantitative analysis, pattern detection, trend identification, and data-backed recommendations. The team's analytical engine — turns data into insight.

Distinct from Data Engineer (who builds and maintains data pipelines). Analyst consumes structured data and produces analysis artifacts.

## Upstream / Downstream

- Upstream: CEO (analysis briefs), Researcher (raw findings), Data Engineer (curated datasets)
- Downstream: Writer (analysis for content), CEO (insights for decisions), QA (analysis for review)
- Produces: trend reports, comparative analyses, statistical summaries, data visualizations (text/table format), pattern libraries
- Consumes: research findings, scraped datasets, organizational data

## Capabilities

- Quantitative analysis of structured data
- Trend detection and pattern recognition
- Comparative analysis across datasets
- Statistical summary generation
- Data quality assessment
- Taxonomy and categorization (e.g., account classification for M1)

## Extensions

- `org-data-query.ts` — read access to curated datasets from Data Engineer
- `artifacts` (artifacts.ts) — read/write analysis outputs to shared storage
- Future: data visualization helpers (table/chart generation in markdown)

## Model Configuration

TBD — likely same provider set as CEO/Researcher. Analytical tasks benefit from reasoning models:
- Default: nvidia/meta/llama-4-maverick-17b-128e-instruct
- Analysis/reasoning: deepseek/deepseek-reasoner
- Smol: groq/llama-3.1-8b-instant

## Security / Permissions

| Capability | Allowed |
|-----------|---------|
| Code execution | No |
| Web egress | No |
| File delete | Workspace only |
| Publish | No |
| HITL required | No |

Read from /artifacts (all agents). Write to /artifacts/analyst/. No web access — works from pre-gathered material. No SQL execution (that's Data Engineer).

## Behavioral Contracts

GIVEN a dataset and analysis brief
WHEN Analyst executes
THEN produce structured analysis with: methodology, findings, confidence intervals where applicable, limitations

GIVEN multiple data sources on the same topic
WHEN cross-referencing
THEN identify agreements, contradictions, and gaps explicitly

GIVEN a categorization task (e.g., account taxonomy)
WHEN producing categories
THEN provide clear criteria for each category, examples, and edge case handling

GIVEN analysis results that contradict prior findings
WHEN conflict detected
THEN flag explicitly with supporting data for both positions, escalate if consequential

## Constraints

- Do not gather data — request it from Researcher or Data Engineer
- Do not make strategic decisions — provide analysis, let CEO decide
- Do not write prose content — provide structured findings for Writer
- All claims must be data-backed — no unsupported assertions
- Methodology must be stated for every analysis

## Files Needed

```
src/agents/analyst/
  agent.json              Registration metadata
  AGENTS.md               System prompt / role instructions
  .pi/agent/config.yml    Model roles, retry, compaction
  .pi/agent/models.json   Provider configs
  .pi/agent/settings.json Extensions, defaults
  .pi/agent/auth.json     Provider API keys (gitignored, copy from root)
```

## Open Questions

- Should Analyst have direct SQL query access (overlap with Data Engineer)?
- What analysis output formats are needed beyond markdown tables?
- Does Analyst need web access for real-time data verification, or is all data pre-gathered?
- How does Analyst coordinate with Researcher on iterative analysis (ask for more data)?
