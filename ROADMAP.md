# Roadmap

This project is in **evaluation stage**. The goal is to validate Paperclip + Pi agent orchestration patterns before committing to production infrastructure.

---

## Done: Artifact Store v2 (MinIO + Postgres metastore)

Replaced the shared Docker volume with a full artifact service: MinIO for blob storage, Postgres for metadata (JSONB), RBAC for per-agent access control. Implemented per plan `tasks/plans/artifact-store-v2.md`.

### Architecture

- `artifact-service` (Bun, port 8090): HTTP API for write/read/list/update artifacts
- `postgres` (17-alpine): metastore with JSONB metadata column, GIN index
- `minio`: S3-compatible blob storage, 3 buckets (artifacts, logs, state)
- `artifact-client.ts`: shared HTTP client used by all extensions
- `rbac.json`: per-agent read/write access control with glob patterns
- Artifacts referenced by `artifact://` URIs, not filesystem paths
- All JSONL walk/scan/filter logic replaced by Postgres queries

---

## Planned: Agent Roster

Full agent lineup. Each agent runs in its own Docker container via bridge.mjs, registered to Paperclip via HTTP adapter.

### Existing agents

| Agent | Role | Extensions |
|-------|------|-----------|
| CEO | Strategic leadership, task decomposition, orchestration | — |
| Researcher | Information gathering, structured research, source analysis | web_search, web_fetch |

### New agents

#### Coder

Code execution, analysis, implementation tasks. Pi coding agent in container provides base isolation.

**Extensions (later):**
- Specialized coding skills TBD (linting, test generation, refactoring tools)
- File system tools scoped to /workspace and /artifacts only

**Security guardrails:**
- Container runs as non-root user (no `--privileged`)
- Read-only filesystem except `/workspace` (working dir) and `/artifacts` (shared output)
- Resource limits: CPU (2 cores), memory (4GB), no swap
- Network: egress restricted to internal Docker network + specific allowlisted domains (package registries)
- No host volume mounts beyond workspace and artifacts
- Execution timeout per invocation (configurable, default 5min)
- No `docker.sock` access — cannot spawn sibling containers
- `/workspace` wiped between invocations (ephemeral)
- Stdout/stderr size cap to prevent memory exhaustion in bridge

**Permissions:** read, write, execute within workspace. Read from /artifacts. Write to /artifacts/{own-context}/. No delete outside workspace.

#### Data / Analyst

Database operations, SQL queries, data management, web scraping, organizational data curation.

**Extensions:**
- `web-scraping.ts` — dual-mode: Apify CLI API for structured scraping (actor-based), Scrapling for custom/ad-hoc scraping
- DB query tools (SQL execution against sandboxed read replicas)
- Data transformation / ETL helpers

**Permissions:** read/write to /artifacts. Query access to designated databases (read-only by default, write to staging tables only). Web egress for scraping targets. No code execution beyond SQL.

**Responsibility:** Organizes and maintains structured data that other agents query. Owns the canonical data layer.

#### Writer

Transforms research findings into coherent narratives. Queries Researcher output, applies tone/voice/audience context.

**Extensions:**
- `org-data-query.ts` — read access to structured data curated by Data agent
- Style guide reference tool (retrieves brand voice rules, audience profiles)
- Citation formatter

**Permissions:** read from /artifacts. Write to /artifacts/{own-context}/. No web access (works from pre-gathered material). No code execution. No file delete.

**Pipeline position:** Downstream of Researcher. Upstream of QA.

#### QA

Evaluative gating agent. Never fixes work — only passes, fails, or escalates. Integrated with kaizen system.

**Extensions:**
- Branding guidelines checker (style, tone, formatting rules)
- Coding standards validator (linting rules, architectural constraints)
- Kaizen integration tool (logs rejections, tracks first-pass yield, triggers 5-whys on threshold breach)
- Template conformance checker (structural validation per output type)

**Permissions:** read from /artifacts (all agents' output). Write to /artifacts/qa/ (verdicts, rejection reports). No modify/delete of other agents' output. No web access. No code execution.

**Behavior contract:** Every review produces a structured verdict: PASS / FAIL(reasons) / ESCALATE(question). Rejections include specific line references and the violated standard. Never rewrites — only flags.

#### Publisher

Publishing agent with HITL (human-in-the-loop) gating. Holds tools and credentials for external platforms.

**Extensions:**
- Social media publishing tools (platform-specific: LinkedIn, Twitter/X, etc.)
- Email list integration (newsletter dispatch)
- HITL approval gate — all publish actions require explicit human confirmation before execution
- Scheduling tool (queue content for future publish times)
- Platform analytics query (read engagement metrics post-publish)

**Permissions:** read from /artifacts (QA-approved content only — checks QA verdict before proceeding). Write to /artifacts/publisher/ (publish receipts, analytics snapshots). External network egress to publishing platforms. No file delete. No code execution.

**Security:** All publish actions gated by HITL confirmation. No autonomous publishing without human approval. Credentials stored in agent-specific auth, never shared. Rate limits per platform enforced in extension.

---

### Extension Roadmap

#### deep-research.ts (Researcher) — DONE

Wave-based iterative research adapted from agent-researcher (LangGraph → Pi extension). Implemented at `src/agents/extensions/deep-research.ts` with a 15-file submodule at `src/agents/extensions/deep-research/`. Remediated with async I/O, semaphore-based concurrency control, validated LLM output, and shared utilities. Tests at `tests/deep-research/`.

**Architecture:**
1. Plan: decompose query into 3-6 non-overlapping sub-queries
2. Search: execute sub-queries concurrently (snippet-level, 10 results each)
3. Rank: score snippets, keep top-K for deep extraction
4. Deep extract: fetch full pages for top-ranked URLs, chunk, extract findings
5. Reflect: evaluate coverage, decide continue or finalize
6. Loop (max 3 iterations) or finalize with structured findings collection

**Key design decisions (from agent-researcher learnings):**
- Structured output for all LLM extraction calls (reliable JSON)
- Retry with jitter on all external calls (5 attempts)
- Cache search results and page content (7-day TTL) for idempotent retries
- Never silently embed errors — fail loud, let retry layers handle
- Conservative iteration: reflect prompt biases toward termination after 1-2 waves
- Model stratification: cheap model for ranking volume, mid for extraction, smart for plan/reflect
- Semaphore concurrency caps on LLM calls and page fetches (added in remediation)
- Validator callbacks on all structured LLM output (added in remediation)
- Async I/O throughout store, checkpoint, and query modules (added in remediation)

**Config knobs:** max_iterations (3), max_sub_queries (6), snippet_results_per_query (10), top_k_urls_after_rank (5), max_concurrent_llm, max_concurrent_fetch, min_content_length, snippet_cap_for_llm, min_chunk_length, key_claims_cap, claim_preview_length

#### web-scraping.ts (Data agent)

Dual-mode scraping extension.

**Mode 1 — Apify (structured):**
- Actor-based: select actor by target site type, pass config, poll for results
- Good for: social media, e-commerce, search engines, maps — anything with existing actors
- Returns structured data (JSON arrays)

**Mode 2 — Scrapling (custom):**
- For sites without Apify actors or needing custom extraction logic
- CSS/XPath selectors, pagination handling, JS rendering via headless browser
- Returns extracted data in agent-specified schema

**Tools registered:** `scrape_structured` (Apify path), `scrape_custom` (Scrapling path), `list_available_scrapers` (actor discovery)

#### org-data-query.ts (Researcher, Writer)

Query interface to organizational data maintained by Data agent.

**Tools registered:** `query_org_data` (structured query against curated datasets), `list_datasets` (discover available data), `get_dataset_schema` (inspect structure before querying)

**Security:** Read-only. No mutations. Results capped at configurable row limit.

---

### Security Model Summary

| Agent | Code exec | Web egress | File delete | Publish | HITL required |
|-------|-----------|-----------|-------------|---------|---------------|
| CEO | No | No | No | No | No |
| Researcher | No | Yes (search/fetch) | No | No | No |
| Coder | Yes (sandboxed) | Limited (allowlist) | Workspace only | No | No |
| Data | SQL only | Yes (scraping) | Workspace only | No | No |
| Writer | No | No | No | No | No |
| QA | No | No | No | No | No |
| Publisher | No | Yes (platforms) | No | Yes | Yes |

**Principle:** Least privilege. Each agent gets exactly the capabilities its role requires. Dangerous operations (publish, delete, external write) require either sandboxing or human approval. No agent can escalate its own permissions.

---

## Planned: Toyota Way integration

Implement TPS principles across the pipeline. Phased — each phase solves problems surfaced by the previous one.

### Phase 1 — Stand up agent roster

- Stub all agent directories (agent.json, .pi/agent/ configs, AGENTS.md)
- Implement Coder container security (non-root, resource limits, network policy)
- ~~Build deep-research.ts extension for Researcher~~ (done — 15-file submodule, remediated)
- Build web-scraping.ts extension for Data agent
- Build org-data-query.ts extension for Researcher and Writer
- Issue templates: research brief, QA review, publish brief (poka-yoke layer)
- Goal hierarchy: company goal → research / content / distribution sub-goals
- Pipeline operations project for meta-work and process improvements

### Phase 2 — Pipeline automation (jidoka + flow)

- Pipeline controller plugin: ordered agent path (CEO → Researcher → QA → Publisher → QA → CEO), auto-handoffs, stuck detection with per-stage thresholds
- Verification plugin: deterministic pre-QA checks (template conformance, source attribution, length bounds, hallucination detection). Pass / fail / warn verdicts
- Escalate tool (Pi extension): replaces ask_user. Types: `ask_user`, `block_for_review`, `request_decision`, `report_failure`, `flag_for_kaizen`. Local TUI in dev, Discord webhook in prod
- Standardized workspace layout per agent (`learnings.md`, `current-work/`, `output/`, `context/`)

### Phase 3 — Observability + kaizen

- Instrument tool calls and LLM invocations with trace IDs correlated to Paperclip issue IDs
- Kaizen metrics: first-pass yield, cycle time, rework volume, cost per unit, escalation rate
- Consolidation job merging verification logs, observability data, and Paperclip activity
- Weekly kaizen report as pipeline-ops issue, reviewed by CEO agent

### Phase 4 — Continuous improvement loop

- Meta-agents: process auditor (read-only workspace visits, audit reports) and skill optimizer (drafts skill revisions from kaizen data, board-approved)
- 5 whys investigations: auto-created when rejection count per failure category exceeds threshold
- learnings.md compaction: recurring themes → skill definition updates, raw entries archived
- Heijunka: staggered heartbeats (researcher first, CEO delayed, QA/publisher wake-on-assignment)

### Phase 5 — Knowledge graph (deferred)

- Cognee or Graphiti on top of MinIO
- Start signal: CEO assigns briefs on already-covered topics, or publisher contradicts prior content

### Blocked on

- ~~MinIO (Phase 3+ needs artifact storage for metrics and audit trails)~~ — done (artifact store v2)
- Eval runs with current two-agent setup to identify actual failure modes before building automation

---

## Planned: Git-Managed Agent Workspaces

Version-control the shared artifacts volume so learnings, outputs, QA verdicts, and publish receipts have full audit history. Board operator can clone, diff, and `git log --author=researcher` to review any agent's work over time.

### Design (from [agent-standard](docs/agent-standard/shared-resources.md), deferred)

Two options explored:

- **Option A (recommended for eval):** Single git repo at `/artifacts/.git/`, all agents as subdirectories, single branch. Commits attributed via `GIT_AUTHOR_NAME`. Simple to clone and browse. Downside: interleaved history.
- **Option B:** Same repo, per-agent branches (`agent/ceo`, `agent/researcher`, etc.). Meta directory on `meta/learnings` branch. Cleaner per-agent history, more complex merge operations.

Sync runs as a post-invocation hook in bridge.mjs or a sidecar container. Commit after each invocation, push to remote. Env vars: `ARTIFACTS_GIT_REMOTE`, `ARTIFACTS_GIT_ENABLED`, `ARTIFACTS_GIT_PUSH`.

### Blocked on

- Artifacts extension implementation (agents need to be writing to /artifacts/ first)
- Enough eval runs to justify the overhead

---

## Planned: Learnings Drain Process

Centralization mechanism that reads raw `learnings.md` from every agent, detects patterns, maintains per-agent profiles and digests at `/artifacts/meta/agent/{name}/`, archives old entries, and generates kaizen reports.

### Design (from [agent-standard](docs/agent-standard/shared-resources.md), deferred)

- Runs as a sidecar container (`src/agents/drain/`) on a weekly schedule
- Reads `learnings.md` + `learnings-live.jsonl` per agent
- Pattern detection: tokenize root_cause fields, Jaccard similarity > 0.6, groups with ≥3 entries = pattern
- Cross-agent pattern detection: same failure across multiple agents = systemic issue
- Outputs: `learnings-digest.md` (per agent), `profile.md` (per agent), `kaizen-report-{date}.md` (pipeline-wide)
- Archives entries older than 30 days to `learnings-archive/{YYYY-MM}.md`
- If git sync enabled, commits and pushes after each drain

### Directory structure produced

```
/artifacts/meta/
  agent/{name}/
    profile.md              Health metrics, recurring patterns, skill update history
    learnings-digest.md     Distilled patterns from raw learnings
    learnings-live.jsonl    Machine-readable mirror of learnings.md
    learnings-archive/      Monthly archives
  pipeline/
    kaizen-report-{date}.md Weekly kaizen reports
    systemic-patterns.md    Cross-agent patterns
```

### Blocked on

- Agents writing to learnings.md (requires artifacts extension + TPS-integrated AGENTS.md)
- Enough accumulated learnings to make pattern detection meaningful
- Git workspace (optional, for versioned drain output)

---

## Planned: Docker image size optimization

Current image sizes are dominated by Pi extension packages:

| Image | Size | Breakdown |
|-------|------|-----------|
| CEO (base) | 1.5GB | node:22-slim ~500MB, Pi CLI 187MB, `shitty-extensions` + `@ifi/pi-extension-subagents` **689MB** |
| Researcher | 1.87GB | base + scrapling[fetchers] ~370MB |
| Data | 3.28GB | base + scrapling[fetchers] + Chromium/Playwright ~1.8GB |

Pi extension install (`npm:shitty-extensions npm:@ifi/pi-extension-subagents`) is 689MB alone — nearly half the CEO image. CEO probably doesn't need subagent extensions at all since Paperclip handles orchestration.

### Actions

- Audit which Pi extensions each agent actually uses — remove unused ones per agent
- Consider agent-specific extension installs (CEO gets none, researcher gets subagents only, etc.)
- Multi-stage builds to reduce layer bloat
- Pin scrapling version to avoid pulling unnecessary transitive deps
- Evaluate if `shitty-extensions` is used by any agent — name suggests experimental, may be removable
- For data image: investigate slim Chromium alternatives or shared browser cache volume

### Blocked on

- Understanding which Pi extensions are actually invoked during eval runs (need telemetry first)

---

## In Progress: Discord integration via paperclip-plugin-discord

Use the community `paperclip-plugin-discord` plugin (mvanhorn, v0.7.3) for bidirectional Discord integration. Replaces the planned custom adapter approach.

### Why

- Paperclip has a full plugin system (69 capabilities, event subscriptions, webhooks, outbound HTTP)
- Community plugin already provides everything we need: `escalate_to_human`, interactive approvals, reply routing, slash commands, daily digests
- Shared `PlatformAdapter` abstraction (`paperclip-plugin-chat-core`) means Telegram and Slack plugins follow the same pattern
- Building custom adapters was reinventing what the platform already supports

### Status

- Plugin installed in Paperclip instance (status: `ready`)
- Placeholder config set — needs real Discord bot token, channel ID, guild ID
- Custom `escalate.ts` disabled in bridge.mjs (retained for potential future fork/extension)

### Remaining

- Create Discord server and bot application (operator task)
- Create Paperclip secrets for bot token and board API key
- Configure plugin with real values
- Verify escalation loop end-to-end
- Evaluate whether Telegram/Slack plugins should be added alongside

### Spec

`tasks/specs/discord-plugin-setup.md`

---

## Planned: Extension and agent hardening pass

Define and enforce a standard for resilience, reliability, and robustness across all extensions, tools, skills, and agents. The goal is a repeatable quality bar — every component passes the same class of verification before it ships, and regressions are caught automatically.

### Scope

- Extensions (Pi extensions registered via bridge.mjs)
- Agent-level behavior (task completion, escalation, checkpoint/resume)
- Tools registered by extensions (individual tool contracts)
- Skills and composed pipelines (multi-tool workflows like deep-research)
- Inter-agent handoffs (artifact passing, wake/sleep, payload integrity)

### What the standard covers

- Transient failure handling (retry, backoff, circuit breaking)
- Graceful degradation (partial results vs. hard failure)
- Checkpoint and resume (interrupted work recoverable without data loss)
- Input validation at system boundaries (malformed payloads, missing env vars, bad API responses)
- Output contracts (structured, verifiable, no silent corruption)
- Concurrency safety (resource exhaustion, thundering herd, deadlock)
- Abort/cancellation propagation (AbortSignal honored end-to-end)
- Idempotency where applicable (safe to re-run after crash)

### How to test each component type

The standard defines a tiered test methodology per component type — what must be verified, at what level, and what tooling supports it. This includes both the test patterns (fake servers, checkpoint manipulation, fault injection) and the pass/fail criteria for each tier.

### Blocked on

- Enough extensions and agents implemented to identify common failure patterns across component types
- Deep-research integration tests (done) serve as the reference implementation for the testing methodology

---

## In Progress: Cost tracking pipeline

Part of the logging extension work. Spec: `tasks/specs/ext-logging.md` (Phase 4). Plan: `tasks/plans/logging-otel.md`.

Pi emits token usage on `turn_end` events. Paperclip accepts cost data via `POST /api/companies/{cid}/cost-events`. Bridge aggregates and reports. DeepSeek returns real counts; MiniMax returns zeros (provider limitation). Spikes verified both sides — see `spikes/RESULTS.md`.

---

## Planned: Langfuse (LLM-native observability)

Production upgrade from Aspire Dashboard. Purpose-built for agentic workflows: per-model cost tracking, eval scores, prompt versioning, session threading. Same pi-otel export, different sink — no code changes needed. 7-service compose stack (~2-4GB RAM). Blocked on: completing OTel logging extension, enough eval runs to justify weight, MinIO (shared dependency).

---

## Planned: Data integration (ELT for agents)

Data agent needs to pull from structured APIs (Crunchbase, HubSpot, etc.) without us building a custom extension per provider. This section lays out the progression from eval-stage lightweight to production-ready.

### Design principle

The agent shouldn't know provider-specific APIs. It should say "sync Crunchbase companies" and get structured data back. The integration layer handles auth, pagination, rate limits, schema mapping, and incremental sync.

### Stage 1: DLT scripts (eval — no infrastructure)

[DLT (data load tool)](https://dlthub.com/) is a Python library, not a platform. `pip install dlt`, write a script, run it. No server, no workers, no database. Output lands in DuckDB, Parquet, or JSON files.

```
Data agent calls: python3 /app/pipelines/crunchbase.py --query "series A San Francisco"
DLT script: authenticates, paginates, normalizes schema, writes to /artifacts/data/crunchbase/
Other agents: read structured files from /artifacts/data/
```

Why DLT for eval:
- Zero infrastructure — just Python scripts in the data container
- Runs inside existing Docker setup, no new containers
- DuckDB as destination gives SQL queryability with zero server overhead
- Built-in schema inference, incremental loading, and retry
- Connector = a Python function. Crunchbase connector is ~50 lines wrapping their REST API.
- Pipeline-as-code — version controlled, testable, agent-triggerable via CLI

What it looks like in the container:
```
/app/pipelines/
  crunchbase.py      # DLT source + pipeline, loads to /artifacts/data/crunchbase.duckdb
  github_stars.py    # DLT source for GitHub, loads to /artifacts/data/github.duckdb
  ...
/artifacts/data/     # DuckDB files, Parquet, or JSON — queryable by other agents
```

Extension: thin `data-pipelines.ts` that wraps `execFileSync("python3", ["/app/pipelines/...", args])`. Lists available pipelines, triggers runs, returns output paths.

### Stage 2: Airbyte (growth — when connector count justifies the weight)

When the number of sources exceeds what's comfortable to maintain as DLT scripts (~10+), switch to Airbyte OSS. 600+ prebuilt connectors, managed via API. Data agent triggers syncs via `airbyte.ts` extension.

Airbyte adds infrastructure: ~4GB RAM, Postgres for state, worker containers. Worth it when you're pulling from many sources regularly, not worth it for 2-3 pipelines at eval.

```
Data agent → Airbyte API (trigger syncs, check status, list connections)
Airbyte → Source connectors → Destination (DuckDB, Postgres, or /artifacts)
Other agents → query destination via org-data-query or SQL tools
```

#### Airbyte Connector Builder (CDK)

Airbyte has a framework for building custom source connectors without writing Python:

- **Low-code Builder** (UI-based): define API endpoints, authentication, pagination, and schema in YAML via Airbyte's web UI. Handles OAuth, API keys, cursor-based and offset pagination, response filtering, error handling. No code — just configuration. Good for straightforward REST APIs like Crunchbase.
- **Python CDK**: for sources that need custom logic (websockets, GraphQL, non-standard auth). Scaffold with `airbyte-cdk`, implement `streams()` method, deploy as Docker image.
- **Connector Marketplace**: publish custom connectors for reuse or contribute back to community catalog.

A Crunchbase connector via the low-code Builder would be: define base URL, API key auth header, streams for `/organizations`, `/funding_rounds`, `/people`, `/acquisitions`, pagination config, and field mappings. Airbyte handles the rest.

#### Connector status for known needs

| Source | Airbyte connector | DLT source | Notes |
|--------|-------------------|------------|-------|
| Crunchbase | None — build via CDK | Write ~50 line script | User has subscription |
| GitHub | Official | `dlt.sources.github` | Built-in DLT source |
| Google Sheets | Official | `dlt.sources.google_sheets` | Built-in |
| HubSpot | Official | `dlt.sources.hubspot` | Built-in |
| Notion | Official | Community | Built-in Airbyte, community DLT |
| Slack | Official | Community | Built-in Airbyte |
| PostgreSQL | Official | `dlt.sources.sql_database` | Built-in both |

### Stage 3: Orchestration (production — if pipelines need scheduling/monitoring)

If pipelines need scheduling beyond "agent triggers when needed", add a lightweight orchestrator. Options from lightest to heaviest:

| Tool | Weight | How it works | When to use |
|------|--------|--------------|-------------|
| Cron + DLT | Zero | Cron in container, DLT scripts | Scheduled pulls, no dependency graph |
| Dagster | Light (~1GB) | Python-native, asset-based | Complex dependencies between pipelines |
| Prefect | Medium (~2GB) | Python-native, flow-based | Need retries, notifications, observability |
| Airflow | Heavy (~4GB+) | DAG-based, kitchen sink | Enterprise, many teams, complex scheduling |

For this project, orchestration probably stays at cron or agent-triggered for a long time. The agents themselves are the orchestration layer — CEO assigns data tasks, Data agent runs pipelines. Adding Prefect/Dagster only makes sense if pipelines run independently of agent tasks.

### Recommendation for now

Start with Stage 1 (DLT scripts). Build a Crunchbase pipeline as the first one. If it works well, add more sources as DLT scripts. Revisit Airbyte when maintaining individual scripts becomes painful. Skip dedicated orchestration until there's a clear need for scheduled pipelines running outside of agent control.

### Blocked on

- Deciding which data sources agents actually need during eval runs
- DLT + DuckDB added to data container (pip install dlt[duckdb], small footprint)

---

## Planned: Repo layout reorg + per-agent extension loading

Current state: everything under `src/agents/` — shared code (bridge, extensions, skills, data, vale) mixed with per-agent identity (config, prompts, auth). Docker build context is `src/agents/`, which forces all shared resources there. Extensions are hardcoded in bridge.mjs — every agent loads all 8, conditional registration silently no-ops for missing deps.

### Target layout

```
src/
  lib/                              # shared code + data, COPY'd into containers
    bridge.mjs
    extensions/                     # Pi extensions (TypeScript)
    skills/                         # Paperclip platform tools + behavioral skills
    data/                           # static config (style/, templates/)
    vale/                           # Vale linter config + rules
  agents/                           # per-agent identity (not code)
    Dockerfile                      # shared base image
    .dockerignore
    ceo/
    writer/
      Dockerfile                    # bespoke (adds Vale)
    researcher/
      Dockerfile                    # bespoke (adds Python/scrapling)
    data/
      Dockerfile                    # bespoke (adds Chromium/duckdb)
    qa/
    coder/
    publisher/
  setup/
    setup.sh
    setup.ps1
    bootstrap-invite.cjs
    paperclip-config.json
```

Docker build context moves to `src/`. Dockerfiles COPY from `lib/` and `agents/{name}/`.

### Per-agent extension mapping

bridge.mjs reads extensions from agent.json (or env var) instead of hardcoded list.

| Extension | CEO | Researcher | Data | Writer | QA | Coder |
|---|---|---|---|---|---|---|
| paperclip-tools | yes | yes | yes | yes | yes | yes |
| artifacts | yes | yes | yes | yes | yes | yes |
| logging | yes | yes | yes | yes | yes | yes |
| escalate | yes | yes | yes | yes | yes | yes |
| web-search | yes | yes | yes | - | - | - |
| web-fetch | - | yes | yes | - | yes | - |
| web-scrape | - | yes | yes | - | - | - |
| deep-research | - | yes | yes | - | - | - |
| duckdb | - | - | yes | - | - | - |
| style-profile | - | - | - | yes | - | - |
| style-lint | - | - | - | yes | - | - |

Core 4 everywhere. Everything else role-specific. Coder handled separately (bash/curl/MCP tools).

### Migration steps

1. Create `src/lib/` and `src/setup/`, move files
2. Add `extensions` array to each agent's agent.json
3. Update bridge.mjs to read per-agent extension list
4. Update all Dockerfiles (COPY paths, build context to `src/`)
5. Update docker-compose.yml (context: `src/`)
6. Update setup.sh paths
7. Verify tests still pass

### Blocked on

- Not critical — current layout works, just messy
- Should batch with Docker image size optimization (shared concern with Dockerfile changes)

---

## Done: Docs Restructure

Split `agent-operating-standard.md` (1260 LOC) into 7 focused pages under `docs/agent-standard/`. Grouped Toyota docs into `docs/toyota-way/`. Added `docs/index.md` hub page.

Plan: `tasks/plans/docs-restructure.md`

---

## Future considerations

- Artifact metadata index (what was produced, by whom, when)
- Artifact TTL / cleanup policy
- Large artifact streaming (if agents produce multi-MB outputs)
- Integration with Paperclip if/when they ship native file storage
