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

## Planned: Toyota Way integration

Implement TPS principles across the pipeline. Phased — each phase solves problems surfaced by the previous one.

### Phase 1 — Complete the agent roster

- Add QA agent (evaluative checks, pass/fail/escalate, never fixes work)
- Add Publisher agent (research → platform-specific content, one sub-issue per platform)
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

## Future considerations

- Artifact metadata index (what was produced, by whom, when)
- Artifact TTL / cleanup policy
- Large artifact streaming (if agents produce multi-MB outputs)
- Integration with Paperclip if/when they ship native file storage
