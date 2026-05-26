# Roadmap

This project is in **evaluation stage**. The goal is to validate Paperclip + Pi agent orchestration patterns before committing to production infrastructure.

---

## Planned: MinIO artifact storage (Option B)

Replace the shared Docker volume with MinIO (S3-compatible object storage) for inter-agent artifact handoff.

### Why

- HTTP-accessible from inside and outside Docker
- Bucket policies for per-agent access control (security boundary between agents)
- S3 URIs as artifact references — portable, standard
- Web console (`:9001`) for inspecting agent output during eval
- No SDK dependency — agents use `curl` with presigned URLs

### What it looks like

- MinIO container in docker-compose (`minio/minio`, ~150MB)
- Bucket per run or per agent (TBD based on eval findings)
- Agents upload via presigned PUT URL, return `s3://artifacts/...` reference in text output
- Consuming agent receives reference in wake payload, fetches via presigned GET URL
- Bridge or a thin sidecar handles presigned URL generation

### Blocked on

- Validating the shared volume pattern first (Option A, currently implemented)
- Understanding what artifact types agents actually produce during eval runs
- Deciding access control model: per-agent buckets vs. per-run prefixes

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

- MinIO (Phase 3+ needs artifact storage for metrics and audit trails)
- Eval runs with current two-agent setup to identify actual failure modes before building automation

---

## Planned: Git-Managed Agent Workspaces

Version-control the shared artifacts volume so learnings, outputs, QA verdicts, and publish receipts have full audit history. Board operator can clone, diff, and `git log --author=researcher` to review any agent's work over time.

### Design (from agent-operating-standard.md, deferred)

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

### Design (from agent-operating-standard.md, deferred)

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

## Future considerations

- Artifact metadata index (what was produced, by whom, when)
- Artifact TTL / cleanup policy
- Large artifact streaming (if agents produce multi-MB outputs)
- Integration with Paperclip if/when they ship native file storage
