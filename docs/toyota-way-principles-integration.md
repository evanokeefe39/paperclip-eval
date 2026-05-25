# TPS Content Pipeline Architecture

An autonomous content research and publishing pipeline built on Paperclip, Pi agents, and Toyota Production System principles.

---

## System Overview

Three decoupled layers, each responsible for a distinct concern.

The agent harness is what each agent can do. It includes Pi extensions, skills, prompt templates, filesystem conventions, shared tools, security, and instrumentation. Every agent runs the same harness regardless of its role. The harness is portable — it works with or without Paperclip.

The orchestration layer is how agents coordinate. Paperclip manages the org chart, issue lifecycle, goal hierarchy, heartbeats, budgets, governance, and approval flows. It tracks what work exists, who owns it, and what state it's in. It does not observe agent internals — agents report their own state by calling the Paperclip API.

The process layer is how the system improves itself. A kaizen subsystem consolidates metrics from multiple sources, meta-agents analyze performance patterns, and improvement recommendations flow back into skill updates, template changes, and verification rules through board approval.

Each layer implements Toyota Way principles independently. No layer depends on another layer's implementation of a different principle.

---

## Org Chart

One company. One flat reporting tree. Four agents, all reporting to the CEO.

### CEO / Planner

No manager above it. The board operator (you) sits above as governance. The CEO holds domain knowledge, editorial standards, audience context, and content strategy. On each heartbeat it reviews the state of active issues, creates new work based on goals and research gaps, writes detailed briefs for downstream agents, and reviews completed work before advancing it through the pipeline. It never produces content directly — it only plans, delegates, and reviews. Uses the strongest reasoning model available since its job is judgment, decomposition, and quality assessment.

### Researcher

Reports to CEO. Given a research brief, it searches, reads, synthesizes, and produces a structured research document with sources, key findings, confidence levels, and open questions. Has access to search tools, web fetching, and domain-specific data sources. Does not make editorial decisions. Output is always a structured document following the research template.

### QA

Reports to CEO. Receives completed work from any agent and evaluates it against defined standards. Checks for hallucinated or unverifiable claims, source quality, completeness against the brief, tone and voice alignment, and structural requirements. Either passes the work, fails it with specific actionable feedback, or escalates to the board for judgment calls. Never fixes work itself.

### Publisher

Reports to CEO. Takes QA-approved research and converts it into platform-specific content. One research document may produce multiple platform outputs — each as a separate sub-issue for independent tracking. Knows platform constraints, formatting conventions, and optimal structures through its skill definitions.

### Heartbeat Staggering

The researcher fires first. The CEO fires after a delay sufficient for research completion — typically 1-2 hours later. QA fires on wake-on-assignment (triggered when work is assigned to it). The publisher fires on wake-on-assignment. This prevents the CEO from waking up with nothing new to review.

---

## Goal and Project Structure

### Goal Hierarchy

Company goal: the overarching objective the content operation exists to achieve. Example: "establish authority in [domain] and grow audience to [target] across [platforms] by [date]."

Three sub-goals, each long-lived with status "active":

- Research goal: "maintain comprehensive, current understanding of [domain] landscape"
- Content goal: "produce [n] pieces per [period] that meet editorial standards"
- Distribution goal: "maximize reach and engagement per piece across all target platforms"

Additional sub-goals can be added per theme or campaign as needed.

### Projects

One project per content workstream or theme — not per piece of content. Issues for individual content pieces live under the relevant project.

One operational project ("pipeline operations") for meta-work: process improvements, retrospectives, kaizen investigations, 5 whys analyses. This project has no goal link — it's operational.

Each project can carry workspace configuration (repo URL, working directory) so agents know where artifacts land.

### Issue Templates

Issue templates are the poka-yoke layer. The CEO's planning skill mandates these structures. QA rejects any issue that doesn't conform.

Research brief: topic, angle, target audience, scope (what to cover and explicitly what not to cover), priority sources, known context (what we already know or have published), success criteria, deadline or priority level.

QA review: issue ID of work being reviewed, checklist of criteria to evaluate, pass/fail for each criterion, overall verdict, actionable feedback if failed, escalation flag if needed.

Publish brief: source research issue ID, target platforms (list), key message per platform, call to action, constraints or things to avoid, reference to prior content on the same topic.

---

## Pipeline Workflow

Five stages. Each has a clear entry condition, owner, and exit condition. Nothing advances unless the exit condition is met.

### Stage 1: Planning

Owner: CEO. Wakes on heartbeat, reviews goal state, checks what's in progress and completed, identifies gaps. Creates research brief issues using the template, assigns to researcher, links to relevant project and goal. Exit condition: brief exists, conforms to template, is assigned.

### Stage 2: Research

Owner: Researcher. Triggered by issue assignment. Picks up brief, does the work, produces structured research document, writes it to local workspace (sidecar syncs to common storage), marks issue complete. Exit condition: research document exists, follows required output format, is attached to the issue. If stuck, marks issue blocked with explanation.

### Stage 3: QA on Research

Owner: QA. Pipeline controller auto-transitions ownership when researcher marks done. Verification plugin runs first (mechanical checks). If verification passes, QA runs evaluative checks. Three outcomes: pass (marks done, pipeline advances), fail with feedback (marks blocked, routes back to researcher), escalate to board (marks blocked, flags for human judgment). The fail-and-return loop is the core jidoka mechanism.

### Stage 4: Publishing

Owner: Publisher. CEO creates publish briefs (one sub-issue per target platform) after QA passes research. Publisher picks up each sub-issue, transforms research into platform-specific content, marks each done.

### Stage 5: QA on Published Content

Owner: QA. Same mechanics as Stage 3 but different criteria. Checks accuracy of representation, platform constraint compliance, voice and tone alignment, absence of claims not in source research. Only after QA passes does content reach "ready to publish" for final board review.

### Pipeline Controller

The pipeline controller plugin defines the ordered agent path on each issue: CEO → Researcher → QA → CEO → Publisher → QA → CEO. Handles handoffs automatically. Routes failures back to the responsible agent. Includes stuck detection with configurable per-stage thresholds.

---

## Agent Harness

The harness is the standard runtime environment every agent gets, regardless of role. It includes tools, filesystem conventions, skills, extensions, and infrastructure integrations. The harness is decoupled from Paperclip — it works independently and could be used with a different orchestrator.

### Standard Filesystem Layout

Every agent workspace follows the same structure:

```
/agent-workspace/
  learnings.md          — kaizen log, append-only from agent's perspective
  current-work/         — artifacts for the active issue
  output/               — completed deliverables
  context/              — injected context (skills, briefs, goal ancestry)
  logs/                 — execution logs
  .pending-escalation   — state file for async escalation/ask-user flows
  .workspace-meta       — agent ID, role, last heartbeat, current issue ID
```

Uniformity enables meta-agents to visit any workspace and know where to find learnings, output, logs, and metrics without agent-specific knowledge.

### Escalate Tool (Pi Extension)

A generic escalation tool replacing ask_user. Registered tool name: `escalate`. Parameters:

- `type` (required): one of `ask_user`, `block_for_review`, `request_decision`, `report_failure`, `flag_for_kaizen`
- `question` (required): the question or description
- `context` (optional): relevant context summary
- `options` (optional): structured choices
- `severity` (optional): `info`, `warning`, `critical`
- `allowFreeform` (optional, default true): whether freeform responses are accepted

Behavior depends on environment:

In local/dev mode (ASK_USER_MODE=local): renders the interactive TUI for ask_user type. Other types log to console and pause for confirmation.

In remote/prod mode (ASK_USER_MODE=remote): posts the escalation to Discord/Telegram via webhook (formatting varies by type). Calls Paperclip API to mark current issue blocked with a comment containing the escalation details. Writes pending state to `.pending-escalation` in workspace. Exits the heartbeat run. No process is held open.

Return path: when human responds (via Discord bot interaction), the bot posts the answer as a Paperclip issue comment, unblocks the issue, and the next heartbeat picks up the response from wake context.

The type parameter determines routing. `ask_user` goes to a Discord channel and waits for a response. `block_for_review` sets the issue to in_review in Paperclip. `report_failure` triggers creation of a 5 whys investigation issue. `flag_for_kaizen` writes to the kaizen metrics pipeline. Every type marks the issue blocked and exits the heartbeat.

### Paperclip Skill

Essential on every agent. Injected automatically by Paperclip's pi-local adapter via symlinks. Teaches agents the Paperclip API surface: how to check out issues, update statuses, post comments, create sub-tasks, report costs. Without this skill loaded, the agent works but never tells Paperclip about it. Agents report their own state — Paperclip does not observe agent internals.

Key environment variables available at runtime: PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID, PAPERCLIP_API_URL, PAPERCLIP_RUN_ID, PAPERCLIP_TASK_ID, PAPERCLIP_WAKE_REASON, PAPERCLIP_WAKE_COMMENT_ID.

### Common Storage Backend

Decoupled from Paperclip. Two components:

MinIO (or S3-compatible object store): durable artifact storage. One bucket per company, folders per project. Objects tagged with metadata: agent_id, issue_id, project_id, goal_id, pipeline_stage, artifact_type, version, parent_artifact_key. Versioning enabled at the bucket level so revisions are automatic. Runs as a Docker container alongside Paperclip.

Agent-side interface: agents do not call MinIO directly. They write files to their local workspace. A sidecar process (file watcher or git hook) syncs workspace outputs to MinIO, tagging objects with metadata from .workspace-meta and the current Paperclip environment variables.

Retrieval: a shared skill teaches agents how to query the storage backend (via a thin CLI wrapper around the S3 SDK) for prior artifacts — "what have we published about [topic]", "get the research doc for issue [id]", "list all artifacts from the last 7 days."

Git-controlled workspaces (optional): agent workspaces backed by git repos. Gives versioning, diffing, and attribution for free. Each agent writes to its own workspace so no merge conflicts. The sidecar commits and pushes on artifact completion.

### Knowledge Graph Layer (Deferred)

Not implemented initially. When needed (when agents need to traverse relationships between entities across documents), add Cognee or Graphiti on top of MinIO. The storage backend doesn't change — the knowledge layer indexes what's already in MinIO.

Start signal: when the CEO agent repeatedly assigns research briefs on topics that have already been covered, or when the publisher produces content that contradicts previously published positions. These are symptoms of missing relational context.

### Common Observability

Decoupled from Paperclip. Paperclip tracks issue-level events (what work happened). A separate system tracks execution-level events (how the work happened).

The agent harness instruments every tool call, every LLM invocation, every file write with trace IDs that include the Paperclip issue ID and agent ID. This correlation key lets you join the two systems when needed — "issue 412 took 45 minutes, let me look at the execution trace to see why."

Options: Langfuse for LLM-specific tracing (prompt/completion pairs, token usage, latency). OpenTelemetry for general instrumentation. Structured log files shipped to Loki/Grafana for lightweight setups.

The observability layer feeds metrics to the kaizen subsystem: token costs per step, tool call failure rates, execution times, retry frequency.

### Common Security

Decoupled from Paperclip. Lives in the harness layer. Includes:

Secrets management: shared secrets referenced through skills, not duplicated per agent. Skills reference environment variables or a local .env file. Any agent with the skill can access the secret without it being stored in multiple Paperclip agent configs.

Permission gates: Pi's permission-gate extension for dangerous operations. A standard security skill teaches agents what they're allowed to do — which directories they can write to, which APIs they can call, what data they can access.

Boundary: Paperclip's governance handles organizational permissions (can this agent hire other agents, approve strategy changes). The harness handles operational permissions (can this agent execute bash commands, access production credentials).

---

## Verification Plugin

The automated half of QA. Runs deterministic checks before the QA agent sees the work. Integrates with the pipeline controller's verify-task hook.

### Checks After Research Stage

- Attached document exists and is non-empty
- Document conforms to required template structure (all mandatory sections present)
- Every key finding has at least one source attribution
- Cited URLs are syntactically valid
- Document is within acceptable length bounds
- No self-referential or circular citations

### Checks After Publishing Stage

- Content exists for each platform sub-issue
- Each piece falls within platform character/word count constraints
- Content does not contain direct quotes or claims absent from source research (basic hallucination check)
- Each piece includes required structural elements per platform (hook, CTA, etc.)

### Verdict Types

Pass: pipeline advances to QA agent. Fail: pipeline stops, issue bounces back to owning agent with structured rejection (which check failed, expected value, actual value). Warn: pipeline advances but attaches flags the QA agent sees (soft signals like low source count or near-limit word count).

### Configuration

Rule set stored in plugin's database namespace. Configurable through a settings page in the Paperclip dashboard. Rules scoped per project so different content workstreams can have different standards. Rules can be updated without redeploying the plugin.

### State

Stores the verification rule set and a log of every verification run (verdict, checks passed/failed, issue ID). The run log is raw data for the kaizen metrics plugin.

---

## Kaizen Subsystem

A network of metrics sources, a consolidation layer, and meta-agents that analyze and recommend improvements.

### Metrics Sources

Verification plugin: structural pass/fail rates, which checks fail most often, warn frequency.

Observability layer: execution times per agent, token costs per step, tool call failure rates, retry frequency, prompt sizes over time.

Paperclip activity data: issue lifecycle times (how long each stage takes), escalation rates, rework counts, blocked issue frequency.

Sidecar-synced learnings files: qualitative patterns from agent self-reports.

### Five Metric Families

First-pass yield: percentage of issues passing each gate (verification and QA) on first attempt without rework. Tracked per agent, per stage, per project. Primary quality indicator.

Cycle time: time for an issue to move through each pipeline stage, and total end-to-end time. Tracked as median and outliers separately. Broken down by stage to find bottlenecks.

Rework volume: round trips between an agent and QA before passing. Categorized by failure type: structural failures, factual accuracy, source quality, tone mismatch, scope drift.

Cost per unit: total token spend to produce one completed published piece, including all rework cycles. The muda (waste) metric.

Escalation rate: percentage of issues QA escalates to the board. Tracks how well the system handles edge cases autonomously.

### Consolidation

A consolidation job (ETL process or lightweight agent) merges metrics from all sources into a unified time-series store. The store uses the kaizen plugin's database namespace (if inside Paperclip) or an external time-series database (if decoupled). Weekly aggregates retained indefinitely. Raw data retained for 90 days.

### Kaizen Reports

Generated on a configurable schedule (default: weekly) as an issue in the pipeline operations project. Contains: current values for all metrics, trend direction over the last period, top three failure modes by frequency, costliest issues of the period with links.

The CEO agent reviews kaizen issues as part of its heartbeat. When it sees that a specific failure mode dominates, it adjusts how it writes briefs. That adjustment flows into the next batch of briefs, and the following kaizen report shows whether the change helped.

### Meta-Agents

Process auditor: runs on a longer schedule (weekly). Visits each agent's workspace, reads learnings.md, checks output directories for patterns, produces an audit report. Goes to pipeline operations project for CEO and board review. Observes and reports only — does not change anything.

Skill optimizer: takes approved improvement proposals and drafts updated skill definitions. Reads current skill, reads the kaizen data and lessons that motivated the change, produces a proposed revision. Revision goes through board approval before being applied.

Both meta-agents need read access to other agents' workspaces. Neither has write access except to their own output.

### Agent-Level Kaizen (learnings.md)

Every agent's workspace contains learnings.md. Append-only from the agent's perspective. Each entry is timestamped and structured: what happened, what went wrong or was learned, what to do differently.

Three sources write to learnings.md: the agent itself (on QA rejection), the QA agent (when a pattern recurs), and the board operator (for standing instructions).

Compaction: periodically the CEO or a meta-agent reviews learnings files, distills recurring themes into updated skill definitions, and archives raw entries. Prevents unbounded context window growth.

### 5 Whys Investigations

When an agent accumulates more than N rejections on the same failure category (tracked by kaizen metrics), the system creates a "5 whys investigation" issue in pipeline operations and assigns it to the CEO.

The CEO traces the failure through the chain: reads the original brief, reads the agent's learnings.md, reads QA feedback history, produces a root cause analysis with a proposed countermeasure. The board reviews and approves the countermeasure before implementation.

For execution errors (tool failures, transient errors): agents do shallow self-diagnosis inline. Retry, use alternative approaches, or mark blocked if unrecoverable. Log what happened in learnings.md.

For quality errors (QA rejections, repeated failures): 5 whys is the planner's job. The planner has broader context to trace causation across the system.

---

## Toyota Way Principle Map

### The Two Pillars

Jidoka (stop the line on defects): verification plugin (mechanical detection) + QA agent (evaluative detection) + escalate tool (any agent can pull the andon cord). Work either meets the standard or goes back. No partial passes.

Just-in-Time (pull-based work): Paperclip's atomic issue checkout. Agents wake and claim work — they don't get pushed tasks. CEO controls the rate of new work entering the system by checking WIP before creating briefs.

### The 14 Principles

1. Long-term philosophy: company goal and goal hierarchy. Every issue traces back to a long-term objective. CEO weighs long-term authority building over short-term engagement chasing.

2. Create flow: five-stage pipeline with automated handoffs via pipeline controller. Stuck detection surfaces when flow stops. Cycle time metrics reveal bottlenecks.

3. Pull systems: agents pull work via atomic checkout. Publisher only creates content when QA-approved research exists. No speculative drafting.

4. Level the workload (heijunka): staggered routines and heartbeat intervals. CEO aims for steady issue creation rate, not batch dumps. Kaizen cycle time metrics reveal clumping.

5. Stop and fix (jidoka culture): encoded in every agent's skill definition — "if you encounter a problem you cannot resolve, mark the issue blocked and explain. Do not work around it. A blocked issue with a clear explanation is better than a completed issue with hidden defects."

6. Standardized work: issue templates, output format skills, filesystem layout conventions. Makes deviation visible. Makes improvement measurable.

7. Visual controls: Paperclip dashboard (pipeline status, stuck indicators), kaizen metrics dashboard (trends), budget utilization (per-agent spend). Andon signals: stuck detection alerts, budget warnings at 80%, QA escalation flags.

8. Proven technology: start with proven adapter types and established models. Add plugins and tools only when there's a demonstrated need. Don't add knowledge graph before hitting relational context limits. Don't add kaizen plugin before having enough data for trends.

9. Grow leaders: CEO agent improves over time through your refinement of its skills based on kaizen data. Philosophy propagates through skill inheritance if middle management agents are added later.

10. Develop exceptional people and teams: agent specialization (each agent does one thing well). When an agent consistently fails, improve its skill definition rather than replacing it.

11. Respect your network: research methodology skill instructs critical evaluation of sources. Publisher's platform knowledge stays current with platform changes. External service integrations have clear interface contracts and fallback procedures.

12. Go and see (genchi genbutsu): board operator reviews actual agent output, not just metrics. Audit trail and activity log provide complete history. Execution traces (via observability layer) show what happened inside a run.

13. Decide slowly, act quickly (nemawashi): strategic decisions go through board approval. Once approved, implementation is fast because the system absorbs new goals, projects, and templates without reconfiguration. CEO plans carefully before creating briefs.

14. Become a learning organization (hansei and kaizen): the kaizen subsystem measures, the CEO reflects on reports, you reflect on the CEO's effectiveness. The system never reaches a final state.

### Seven Wastes (Muda)

Overproduction: creating more research or content than can be reviewed. Addressed by WIP-aware planning and pull-based work.

Waiting: issues sitting idle between stages. Addressed by staggered heartbeats and stuck detection.

Transport: unnecessary handoffs between agents. Addressed by flat org chart — no middle management overhead at small scale.

Overprocessing: doing more work than the brief requires. Addressed by scoped briefs with explicit boundaries.

Inventory: backlog accumulation at any stage. Addressed by WIP limits and CEO planning logic.

Motion: agents spending tokens on non-productive work (re-reading context, searching for info that should be in the brief). Addressed by comprehensive skills that frontload context.

Defects: work that fails QA. Addressed by the full jidoka system: verification plugin, QA agent, structured feedback, kaizen-driven improvement.

---

## Quick Reference

| TPS Concept | Layer | Implementation |
|---|---|---|
| Jidoka | Harness + Orchestration | Verification plugin + QA agent + escalate tool |
| Poka-yoke | Harness | Issue templates, output format skills, verification rules |
| Andon | Orchestration + Process | Stuck detection, budget warnings, escalation flags |
| Kanban | Orchestration | Atomic issue checkout, heartbeat wake-and-claim |
| Heijunka | Orchestration | Staggered routines, WIP-aware planning |
| Kaizen | Process | Metrics consolidation + meta-agents + pipeline ops project |
| Hansei | Process | Periodic kaizen reports reviewed by CEO and board |
| Genchi genbutsu | Process | Board reviews actual output, walks audit trail + execution traces |
| Nemawashi | Orchestration | Board approval for strategic changes |
| Muda | Process | Cost per unit, rework volume, cycle time tracking |
| Standardized work | Harness | Templates, filesystem layout, common tool interfaces |
| Flow | Orchestration | Five-stage pipeline with automated handoffs |
| 5 Whys | Process | Investigation issues triggered by pattern detection |

---

## Implementation Sequence

Do not build everything at once. Each addition should solve a problem already experienced, not a problem imagined.

Phase 1: Set up Paperclip with the four agents (CEO, researcher, QA, publisher). Define the org chart, goals, and projects. Write the core skills for each agent. Run the pipeline manually — CEO creates briefs, researcher works them, you act as QA, publisher produces content. Identify where it breaks.

Phase 2: Add the pipeline controller plugin for automated handoffs. Add the verification plugin to catch recurring structural failures. Add the escalate tool with local mode only. Standardize the workspace filesystem layout.

Phase 3: Add MinIO for artifact storage. Set up the sidecar sync from agent workspaces to MinIO. Add the shared storage skill so agents can query prior artifacts. Add the Discord bridge for remote-mode escalation.

Phase 4: Add observability instrumentation. Start collecting execution-level metrics alongside Paperclip's issue-level data. Add the kaizen consolidation and reporting.

Phase 5: Add meta-agents (process auditor, skill optimizer). Implement 5 whys investigation flow. Add the learnings.md compaction cycle. Begin the continuous improvement loop.

Phase 6 (if needed): Add knowledge graph layer (Cognee or Graphiti) on top of MinIO. Only when agents demonstrably need relational context across documents.

Each phase can run for weeks before the next is needed. The system is useful from Phase 1. Everything after that is refinement.