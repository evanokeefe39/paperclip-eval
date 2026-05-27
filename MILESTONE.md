# Milestones

## M0: Faceless Channel Analysis (Platform Proof-of-Concept)

### What

Small-scope analysis of faceless Instagram and TikTok content channels. CEO delegates research to Researcher, Researcher gathers data, Writer synthesizes a report. The analysis itself is useful but secondary — the primary goal is proving multi-agent orchestration works through Paperclip.

### Why

Before tackling M1 (full social media trend analysis across 5+ platforms), validate that the foundational plumbing works:

- Agents receive tasks from Paperclip, do work, and report back
- CEO can decompose a goal into sub-issues and delegate to specialized agents
- Agents use Paperclip skills to follow the heartbeat procedure (checkout, work, update, release)
- Inter-agent handoffs work (Researcher completes → Writer picks up)
- Artifacts flow between agents via shared volume
- The full cycle completes without manual intervention beyond the initial issue creation

### Scope

- 10-15 faceless Instagram accounts across niches (motivation, finance, AI art, tutorials, nature)
- 10-15 faceless TikTok accounts across similar niches
- Per account: follower count, posting frequency, content format, engagement patterns
- Cross-platform comparison and top 5 actionable insights

### Deliverables

- Structured data per account in `/artifacts/faceless-analysis/`
- Cross-platform comparison
- Recommended niche + content strategy

### Success criteria

- [x] CEO creates sub-issues and delegates without manual intervention
- [x] Researcher completes Instagram and TikTok research via Paperclip tools
- [ ] Writer synthesizes final report from Researcher output
- [x] All status transitions happen through Paperclip (checkout → in_progress → done)
- [x] Agents follow Paperclip skill conventions (heartbeat procedure, comments, status updates)

### Blockers resolved during execution

- Paperclip hostname rejection for Docker-internal requests (`tasks/issues/paperclip-hostname-rejection.md`) — workaround applied
- `wakeOnDemand` not auto-invoking agents on issue assignment (`tasks/issues/wake-on-demand-not-triggering.md`) — heartbeat polling used instead
- Paperclip skills not yet injected into HTTP adapter agents — bridge.mjs skill loading added
- HTTP adapter payload mismatch — bridge was reading wrong fields, fixed to read `body.context`
- CEO had work tools loaded — removed, now coordination-only

### Issues observed

These are agent behavior and subsystem wiring issues, not platform issues. The platform proof-of-concept succeeded.

1. **CEO doing work instead of delegating** — even after removing work tools, CEO sometimes attempted research directly rather than decomposing and assigning to specialists
2. **Researcher not writing structured findings** — Researcher did web research but didn't persist results using the findings/workproduct system, leaving output only in Paperclip issue comments
3. **Writer couldn't produce report** — without structured findings artifacts to consume, Writer had no usable input and couldn't synthesize a proper deliverable

These issues are addressed in M0.1.

### Status

Complete (with caveats). 2026-05-27. Platform orchestration validated — agents register, receive tasks, heartbeat, delegate, and transition status through Paperclip. Writer synthesis failed due to upstream findings format issues. See M0.1 for the subsystem-wiring follow-up.

---

## M0.1: Faceless Channel Analysis (Subsystems Wired)

### What

Same brief as M0 — faceless Instagram and TikTok channel analysis. But this time every subsystem is wired correctly: structured logging, standardized workproducts, proper artifact storage, permissions without the BRIDGE_EXTENSIONS hack, and full observability. The analysis should complete end-to-end with no manual intervention beyond the initial issue.

### Why

M0 proved the platform works. M0.1 proves the agents work as a system. The gap between "agents can talk to Paperclip" and "agents produce useful output" is subsystem integration: logging so we can debug, findings so researchers produce consumable output, artifacts so work products flow between agents, permissions so each agent has exactly the tools it needs.

### What changed since M0

- BRIDGE_EXTENSIONS env var replaced with 2-layer permissions model (agent config + bridge defaults)
- Findings extension writes ADMIRALTY-graded structured findings via workproduct system
- Logging extension emits structured logs to Aspire Dashboard via OTel
- Artifacts written to shared volume with standardized paths and metadata

### Scope

Same as M0:
- 10-15 faceless Instagram accounts across niches
- 10-15 faceless TikTok accounts across similar niches
- Per account: follower count, posting frequency, content format, engagement patterns
- Cross-platform comparison and top 5 actionable insights

### Success criteria

- [ ] CEO delegates all research work — zero direct work execution by CEO
- [ ] Researcher writes structured findings using workproduct/findings system (ADMIRALTY-graded, JSONL-persisted)
- [ ] Writer reads Researcher findings from artifacts and synthesizes report
- [ ] Final report delivered as artifact with cross-platform comparison and actionable insights
- [ ] All agents produce structured logs visible in Aspire Dashboard
- [ ] Permissions use 2-layer model — no BRIDGE_EXTENSIONS env var
- [ ] Workproducts follow standardized format (ULID, session ID, validated fields)
- [ ] Artifacts stored at standardized paths under `/artifacts/{agent}/`
- [ ] Full agent turn traces visible in Aspire Dashboard (LLM calls, tool executions, timing)
- [ ] No manual intervention beyond initial issue creation

### Prerequisites

- Logging extension operational (OTel → Aspire)
- Findings extension writes valid workproducts
- 2-layer permissions deployed (commit 85d6249)
- Agent prompts updated to enforce delegation (CEO) and findings output (Researcher)

### Status

Not started. Blocked on verifying all subsystems are individually functional before running the full brief.

---

## M1: Artifact Store v2 (Bun Service + Postgres + MinIO)

### What

Replace the bind-mounted `./artifacts` directory and `.meta.json` sidecar files with a proper artifact store: Bun-based REST service, MinIO for blob storage, Postgres for metadata. Agents interact over HTTP — no direct filesystem, database, or S3 connections from extensions.

### Why

Every downstream milestone depends on reliable, structured artifact storage. The current v1 approach (shared Docker volume, sidecar JSON files, filesystem walks) doesn't scale to multi-agent workflows with RBAC, cross-agent discovery, or durable storage that survives stack teardown. This is the infrastructure gate for M2 and beyond.

### Spec

`tasks/specs/artifact-store-v2.md`

### Scope

- Postgres container (shared instance for Paperclip + artifact metadata)
- MinIO container (S3-compatible blob storage)
- Bun artifact service (`src/artifact-service/`) with 4 routes: write, read, list, health
- RBAC via `rbac.json` (application-level, agent identity from X-Agent-Name header)
- `artifacts.ts` rewritten as thin HTTP client (~100 lines, down from 354)
- `artifact://` URI scheme for cross-agent references
- docker-compose updated with new containers, Paperclip on external Postgres
- Bind mount `./artifacts:/artifacts` removed from all agents

### Success criteria

- [ ] `docker compose up -d` brings up full stack from clean state (Postgres, MinIO, artifact service, Paperclip, agents)
- [ ] Paperclip runs correctly on external Postgres
- [ ] Agent writes artifact via `write_artifact` → gets `artifact://` URI back
- [ ] Another agent reads artifact via `read_artifact` with that URI
- [ ] `list_artifacts` returns filtered results from artifact service
- [ ] RBAC enforced (agent can't write outside own namespace, read rules respected)
- [ ] MinIO Console at :9001 shows stored blobs
- [ ] Existing tests updated for v2 behavior

### Status

Spec complete. Implementation not started.

---

## M2: Social Media Trend Analysis for the Developer Space

### What

Produce a thorough analysis of the developer / creator / indie dev / solopreneur space on social media. Cover four dimensions:

1. **Trends** — what topics, formats, and content strategies are gaining momentum across platforms (X/Twitter, LinkedIn, YouTube, Bluesky, Threads)
2. **Established growth accounts** — who has sustained growth, what patterns and templates they use
3. **Fast-rising new accounts** — who is new but growing disproportionately fast, what they are doing differently
4. **Legacy accounts** — long-established accounts, how their strategies have evolved or stagnated

### Why

Two reasons:

- **Platform proof** — this is the first real research task run through Paperclip with our agents. Completing it validates the orchestration pipeline end to end.
- **Content intelligence** — the findings directly inform content strategy when it is time to start posting. Knowing what works, what is saturated, and where the gaps are before entering the space.

### Deliverables

- Trend report with supporting data points
- Account taxonomy (established / fast-rising / legacy) with examples
- Pattern library of content templates and growth tactics
- Actionable recommendations for someone entering or scaling in this space

### Success criteria

- [ ] Agents can discover and profile accounts across at least two platforms
- [ ] Trend detection produces non-obvious insights (not just "AI is popular")
- [ ] Account categorization is defensible with data
- [ ] Pattern library contains at least 10 distinct, replicable templates
- [ ] Final report is useful to someone entering the space cold

### Status

Not started.
