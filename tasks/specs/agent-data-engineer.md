# Agent: Data Engineer

## Status

Stub. Empty directory at src/agents/data-engineer/.

## Intent

Data pipeline and infrastructure agent. Builds, maintains, and operates the team's data layer. Executes web scraping, manages structured datasets, runs ETL transformations, and curates organizational data that other agents query. The team's data plumber — ensures clean, accessible, well-organized data.

Distinct from Analyst (who interprets data). Data Engineer acquires, cleans, structures, and serves data.

## Upstream / Downstream

- Upstream: CEO (data acquisition tasks), Researcher (raw findings needing structuring)
- Downstream: Analyst (curated datasets), Researcher (org data for context), Writer (org data for reference)
- Produces: structured datasets, scraped data, cleaned/transformed data, dataset schemas
- Consumes: scraping targets, raw data dumps, ETL specifications

## Capabilities

- Web scraping via dual-mode extension (Apify for structured sites, custom for ad-hoc)
- SQL execution against sandboxed databases (read by default, write to staging)
- Data transformation and ETL
- Dataset curation and schema management
- Data quality validation

## Extensions

- `web_scrape` (web-scrape.ts) — dual-mode scraping (Apify + custom/Scrapling)
- `artifacts` (artifacts.ts) — read/write datasets to shared storage
- `org-data-query.ts` — manage and serve organizational data
- Future: DB query tools (SQL execution against sandboxed read replicas)

## Model Configuration

TBD — same provider set. Data tasks are more mechanical than analytical:
- Default: nvidia/meta/llama-4-maverick-17b-128e-instruct
- Agentic (scraping orchestration): minimax/MiniMax-M2.7
- Smol: groq/llama-3.1-8b-instant

## Security / Permissions

| Capability | Allowed |
|-----------|---------|
| Code execution | SQL only |
| Web egress | Yes (scraping targets) |
| File delete | Workspace only |
| Publish | No |
| HITL required | No |

Read/write to /artifacts. SQL query access to designated databases (read-only by default, write to staging tables only). Web egress for scraping targets. No general code execution beyond SQL.

## Behavioral Contracts

GIVEN a scraping target and desired data schema
WHEN Data Engineer executes
THEN produce structured dataset conforming to schema, with metadata (source, timestamp, row count, quality score)

GIVEN raw unstructured data
WHEN ETL transformation requested
THEN produce clean, typed, deduplicated dataset with transformation log

GIVEN a dataset query from another agent
WHEN serving data via org-data-query
THEN return results within configured row limits, with schema documentation

GIVEN a scraping job that fails or returns partial results
WHEN error occurs
THEN log failure with diagnostics, return partial results with completeness indicator, escalate if blocking

## Constraints

- Do not interpret data — provide it to Analyst for interpretation
- Do not make strategic decisions — execute data tasks as assigned
- Respect rate limits on scraping targets
- Never store credentials in datasets
- All datasets must have schema documentation
- Scraping budget limits enforced (see web-scraping-tiers.md)

## Files Needed

```
src/agents/data-engineer/
  agent.json              Registration metadata
  AGENTS.md               System prompt / role instructions
  .pi/agent/config.yml    Model roles, retry, compaction
  .pi/agent/models.json   Provider configs
  .pi/agent/settings.json Extensions, defaults
  .pi/agent/auth.json     Provider API keys (gitignored, copy from root)
```

## Open Questions

- What database backend for structured data storage? (SQLite for eval, PostgreSQL for prod per deep-research-store.md)
- Should Data Engineer manage the findings store from deep-research-store.md, or does Researcher own that?
- What's the scraping budget cap for eval stage?
- How does Data Engineer signal dataset readiness to downstream agents?
