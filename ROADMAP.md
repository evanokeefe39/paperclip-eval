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

## Planned: Escalation notification adapters (Discord first)

Close the notification gap in the escalation system. Agents escalate via Paperclip issues today, but humans only see them if they're watching the Paperclip UI. Notification adapters deliver escalations to where humans already are.

### Why

- Agents sit idle until a human notices the Paperclip issue
- The escalate spec was designed for this: the tool creates the issue, and downstream notification is handled by Paperclip's plugin system or external adapters
- Paperclip's community notification plugins are not available in eval — we build adapters ourselves
- Discord is the first adapter; the same pattern supports Telegram, Slack, or a local TUI later

### Architecture

The escalate tool (Pi extension) creates a Paperclip issue and pauses the agent. That's where its responsibility ends. Notification delivery is a separate concern handled by adapter services. Paperclip is the bus — the issue system is the shared interface between the escalate tool and all notification adapters. Human responses flow back as Paperclip issue comments. Paperclip wakes the agent via `PAPERCLIP_WAKE_REASON` / `PAPERCLIP_WAKE_COMMENT_ID` env vars on the next heartbeat.

### Blocked on

- Discord server setup (operator task)
- Validating escalation patterns with current two-agent setup first

### Spec

`tasks/specs/discord-bridge.md`

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

## Planned: Cost tracking pipeline

Bridge.mjs already captures Pi's full JSONL event stream including token usage from `message_end` events, but does not extract or aggregate it. Paperclip has a cost dashboard but the HTTP adapter doesn't feed it.

### Phase 1 — Extract token usage in bridge

Parse `message_end` events from Pi stdout for `usage` fields (prompt_tokens, completion_tokens, model). Aggregate per request. Include in /metrics endpoint and response JSON.

### Phase 2 — Feed Paperclip cost dashboard

When Paperclip exposes a cost/usage API endpoint, POST aggregated token counts per invocation. Map to agent ID, model, timestamp. Use `paperclip_api_request` escape hatch if no dedicated endpoint exists.

### Phase 3 — OTel cost correlation

pi-otel `pi.llm_request` spans already carry token counts and model info. If Langfuse is adopted (see below), cost tracking comes free via its model pricing database. Otherwise, extract from Aspire spans via a lightweight aggregation job.

### Blocked on

- Verifying Pi's JSONL event schema for token usage fields (quick spike)
- Paperclip cost API availability (check upstream)

---

## Planned: Langfuse (LLM-native observability)

Replace or augment Aspire Dashboard with Langfuse for LLM-specific analytics: per-model cost tracking, eval scores, prompt versioning, session threading, token usage dashboards.

### Why

Aspire shows raw OTel spans — good for debugging, bad for LLM analytics. Langfuse is purpose-built for agentic workflows and provides cost-per-run, evaluation pipelines, and prompt iteration history that a generic span viewer cannot.

### What it looks like

- 7-service compose stack: Langfuse web + worker, ClickHouse, Postgres, Redis, MinIO, OTel Collector
- OTel Collector bridges pi-otel gRPC → Langfuse OTLP/HTTP endpoint
- ~2-4GB RAM total
- UI at :3000

### When

After eval stage validates the basic OTel pipeline (Aspire). Langfuse is the production upgrade path — same pi-otel export, different sink. No changes to logging.ts or bridge.mjs.

### Blocked on

- Completing OTel logging extension with Aspire (current work)
- Enough eval runs to justify the infrastructure weight
- MinIO deployment (Langfuse self-hosted uses MinIO anyway — shared dependency)

---

## Future considerations

- Artifact metadata index (what was produced, by whom, when)
- Artifact TTL / cleanup policy
- Large artifact streaming (if agents produce multi-MB outputs)
- Integration with Paperclip if/when they ship native file storage
