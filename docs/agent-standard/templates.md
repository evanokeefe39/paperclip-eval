[Agent Standard](index.md) > Templates and Per-Agent Requirements

# Parts 4–5: Templates and Per-Agent Requirements

---

## Part 4: Templates

All templates live as files in `src/agents/templates/`. They are COPYed into containers at `/root/.pi/agent/extensions/workproduct/templates` during Docker build. Agents access them at runtime through the artifacts extension's `get_template()` tool.

### 4.1 Issue Brief Templates (Poka-Yoke Layer)

Used by CEO when creating Paperclip issues. Receiving agents validate input against these.

| Template | File | Used By | Validated By |
|----------|------|---------|-------------|
| Research Brief | `templates/briefs/research-brief.md` | CEO → Researcher | Researcher (input validation) |
| Analysis Brief | `templates/briefs/analysis-brief.md` | CEO → Analyst | Analyst (input validation) |
| Content Brief | `templates/briefs/content-brief.md` | CEO → Writer | Writer (input validation) |
| Publish Brief | `templates/briefs/publish-brief.md` | CEO → Publisher | Publisher (input validation) |
| QA Review | `templates/briefs/qa-review.md` | Pipeline controller → QA | QA (input validation) |

Every brief template enforces the poka-yoke principle: required sections make omissions visible. An agent receiving a brief missing a required section stops the line immediately (jidoka).

### 4.2 Output Templates

Agents produce work in these formats. QA validates output against the matching template. The verification plugin (Phase 2) enforces conformance mechanically.

| Template | File | Produced By | Validated By |
|----------|------|------------|-------------|
| Research Output | `templates/outputs/research-output.md` | Researcher | QA, verification plugin |
| Analysis Output | `templates/outputs/analysis-output.md` | Analyst | QA, verification plugin |
| Content Output | `templates/outputs/content-output.md` | Writer | QA, verification plugin |
| QA Verdict | `templates/outputs/qa-verdict.md` | QA | CEO, verification plugin |
| Publish Receipt | `templates/outputs/publish-receipt.json` | Publisher | CEO |

### 4.3 Workspace Templates

Copied into `/artifacts/{agent-name}/` by the artifacts extension on first run (init_workspace).

| Template | File | Purpose |
|----------|------|---------|
| Learnings Log | `templates/workspace/learnings.md` | Kaizen log with entry format instructions |
| Agent Metadata | `templates/workspace/meta.json.template` | Agent identity and runtime state |

### 4.4 Meta Templates

Used by the learnings drain process and meta-agents for centralized artifacts in `/artifacts/meta/`.

| Template | File | Purpose |
|----------|------|---------|
| Agent Profile | `templates/meta/agent-profile.md` | Per-agent health, patterns, skill history |
| Learnings Digest | `templates/meta/learnings-digest.md` | Distilled patterns from raw learnings |

### 4.5 How Templates Flow Through the System

```
src/agents/templates/        Source of truth (in repo, version controlled)
       │
       ▼  (Docker COPY at build time)
/root/.pi/agent/extensions/workproduct/templates    Read-only inside container
       │
       ├── artifacts extension: get_template() tool reads from here
       ├── artifacts extension: init_workspace() copies workspace/ templates to /artifacts/{agent}/
       ├── CEO: reads briefs/ templates when creating issues
       ├── Agents: read outputs/ templates to know what format to produce
       ├── QA: reads outputs/ templates to validate conformance
       └── Drain process: reads meta/ templates when generating profiles and digests
```

Changes to templates go through the repo (PR, review, merge) and take effect on next container build. Templates are never modified at runtime.

---

## Part 5: Per-Agent Requirements

### 5.1 CEO

**Role:** Strategic leadership, task decomposition, cross-agent coordination, output synthesis, quality review.

**Extensions:**

| Extension | Purpose |
|-----------|---------|
| escalate | Andon cord, board escalation |
| artifacts | Read all agent outputs, write plans and briefs |
| logging | Structured execution logs |

**System prompt additions beyond universal template:**
- WIP management rules (check pipeline capacity before creating new briefs)
- Brief-writing standards (use issue templates, enforce completeness)
- Review protocol (check for workarounds in completed work, verify template conformance)
- Kaizen report review process (what to look for, how to create improvement issues)
- Goal hierarchy awareness (every brief links to a goal)

**Model role overrides:** None. Uses base config. Planning and review on deepseek-reasoner.

**Wake strategy:** Heartbeat with delay after Researcher. Fires second.

**Security:**

| Permission | Setting |
|-----------|---------|
| Code execution | Denied |
| Web egress | Denied |
| File write | /artifacts/ceo/ only |
| File read | /artifacts/* (all agents) |
| Paperclip API | Full (issue CRUD, agent management, goal management) |

**Output types:** Research briefs, analysis briefs, content briefs, publish briefs, pipeline decisions, kaizen improvement issues.

---

### 5.2 Researcher

**Role:** Information gathering, structured research, source analysis, gap identification.

**Extensions:**

| Extension | Purpose |
|-----------|---------|
| escalate | Andon cord |
| artifacts | Read briefs, write research outputs |
| logging | Structured execution logs |
| web-search | Exa API search |
| web-fetch | URL content extraction |
| deep-research | Multi-wave iterative research (future) |

**System prompt additions beyond universal template:**
- Research methodology (search strategy, source evaluation criteria, when to go deeper)
- Source credibility framework (how to assess and rate sources)
- Structured output requirements (use research output template exactly)
- Citation standards (every claim needs a source, number all sources)
- Fact vs. inference distinction (explicit labeling required)
- Gap identification protocol (what counts as a gap, how to report it)

**Model role overrides:** None. Uses base config. Default model handles most research. Reasoner for complex synthesis.

**Wake strategy:** Heartbeat, fires first. Primary pipeline driver.

**Security:**

| Permission | Setting |
|-----------|---------|
| Code execution | Denied |
| Web egress | Allowed (search + fetch only) |
| File write | /artifacts/researcher/ only |
| File read | /artifacts/* (all agents) |
| Paperclip API | Issue updates, comments |

**Output types:** Research documents (structured per template), source lists, gap analyses.

---

### 5.3 Analyst

**Role:** Quantitative analysis, pattern detection, trend identification, data-backed recommendations.

**Extensions:**

| Extension | Purpose |
|-----------|---------|
| escalate | Andon cord |
| artifacts | Read datasets and research, write analysis outputs |
| logging | Structured execution logs |
| org-data-query | Query curated datasets from Data Engineer (future) |

**System prompt additions beyond universal template:**
- Analytical methodology requirements (state methodology for every analysis)
- Data quality assessment protocol (always assess source data before analyzing)
- Claim-to-data traceability (every assertion backed by specific data points)
- Taxonomy and categorization standards (clear criteria, examples, edge case handling)
- Cross-reference protocol (when multiple sources exist, compare explicitly)
- Limitation disclosure (always state what the analysis cannot tell you)

**Model role overrides:**
- `review` → `deepseek/deepseek-reasoner` (analytical reasoning)
- `plan` → `deepseek/deepseek-reasoner` (methodology planning)

**Wake strategy:** Wake-on-assignment.

**Security:**

| Permission | Setting |
|-----------|---------|
| Code execution | Denied |
| Web egress | Denied |
| File write | /artifacts/analyst/ only |
| File read | /artifacts/* (all agents) |
| SQL access | Read-only (future, when DB tools are added) |
| Paperclip API | Issue updates, comments |

**Output types:** Analysis documents (structured per template), trend reports, taxonomies, comparative analyses.

---

### 5.4 Data Engineer

**Role:** Data acquisition, pipeline operations, ETL, dataset curation, schema management.

**Extensions:**

| Extension | Purpose |
|-----------|---------|
| escalate | Andon cord |
| artifacts | Read tasks, write datasets and schemas |
| logging | Structured execution logs |
| web-scrape | Dual-mode scraping (Apify + custom) |
| org-data-query | Manage and serve organizational data (future) |

**System prompt additions beyond universal template:**
- Scraping ethics and compliance (robots.txt, rate limits, ToS awareness)
- Data quality standards (deduplication, type safety, schema documentation)
- Budget awareness (scraping costs tracked, escalate before exceeding budget)
- Schema documentation requirements (every dataset has a schema)
- Transformation logging (document every ETL step)
- Partial result handling (completeness indicator on every dataset)

**Model role overrides:**
- `agentic` → `minimax/MiniMax-M2.7` (multi-step scraping orchestration)

**Wake strategy:** Wake-on-assignment.

**Security:**

| Permission | Setting |
|-----------|---------|
| Code execution | SQL only (future) |
| Web egress | Allowed (scraping targets) |
| File write | /artifacts/data-engineer/ only |
| File read | /artifacts/* (all agents) |
| SQL access | Read-only default, write to staging tables |
| Paperclip API | Issue updates, comments |

**Output types:** Structured datasets (JSON/CSV), schemas, ETL transformation logs, data quality reports.

---

### 5.5 Dev

**Role:** Code execution, technical implementation, testing, tool building.

**Extensions:**

| Extension | Purpose |
|-----------|---------|
| escalate | Andon cord |
| artifacts | Read specs, write code outputs |
| logging | Structured execution logs |
| (coding tools) | TBD — linting, test generation, etc. |

**System prompt additions beyond universal template:**
- Sandboxed execution awareness (workspace is ephemeral, /workspace wiped between invocations)
- Security constraints (no network beyond allowlist, no docker.sock, no privilege escalation)
- Test-first protocol (tests required for every code output)
- Scope discipline (implement exactly what the spec says, nothing more)
- Technical decision escalation (architectural decisions go to CEO/board)

**Model role overrides:**
- `agentic` → `minimax/MiniMax-M2.7` (complex multi-file implementation)
- `plan` → `deepseek/deepseek-reasoner` (technical planning)

**Wake strategy:** Wake-on-assignment.

**Security (hardened container):**

| Permission | Setting |
|-----------|---------|
| Code execution | Yes, sandboxed |
| Web egress | Allowlisted package registries only |
| File write | /workspace (ephemeral) + /artifacts/dev/ |
| File read | /artifacts/* (all agents) |
| Container privileges | Non-root, no docker.sock, no --privileged |
| Resource limits | 2 CPU, 4GB RAM, no swap |
| Execution timeout | 5 min per invocation |
| Paperclip API | Issue updates, comments |

**Output types:** Code files, test suites, technical analyses, scripts.

---

### 5.6 Writer

**Role:** Content production, narrative construction, tone/voice adaptation, citation formatting.

**Extensions:**

| Extension | Purpose |
|-----------|---------|
| escalate | Andon cord |
| artifacts | Read research/analysis, write content outputs |
| logging | Structured execution logs |
| org-data-query | Reference organizational data (future) |

**System prompt additions beyond universal template:**
- No-fabrication rule (never invent facts, sources, quotes, or data points)
- Source-only writing (all material comes from provided research/analysis via /artifacts)
- Platform adaptation rules (per-platform formatting, constraints, conventions)
- Consistency across variants (when producing multiple formats, maintain consistent facts)
- Citation traceability (every claim maps to a source finding — include the mapping)
- Brief adherence (follow the content brief exactly — tone, audience, scope, CTA)

**Model role overrides:**
- `agentic` → `minimax/MiniMax-M2.7` (long-form creative production)

**Wake strategy:** Wake-on-assignment.

**Security:**

| Permission | Setting |
|-----------|---------|
| Code execution | Denied |
| Web egress | Denied |
| File write | /artifacts/writer/ only |
| File read | /artifacts/* (all agents) |
| Paperclip API | Issue updates, comments |

**Output types:** Articles, social media posts, reports, summaries, threads (all structured per content output template).

---

### 5.7 QA

**Role:** Quality gating, standards enforcement, structured verdicts, pattern detection.

**Extensions:**

| Extension | Purpose |
|-----------|---------|
| escalate | Andon cord + board escalation for judgment calls |
| artifacts | Read all agent outputs, write verdicts |
| logging | Structured execution logs |
| (quality-checker) | TBD — deterministic template/standard checks |

**System prompt additions beyond universal template:**
- Verdict protocol (PASS / FAIL / ESCALATE — never anything else)
- Never-fix rule (evaluate only, never rewrite or fix the work)
- Standard citation (every finding references a specific standard)
- Pattern tracking (note when the same agent makes the same type of error)
- Escalation criteria (when to escalate to board vs. when to FAIL back to agent)
- Version pinning (confirm the exact artifact version reviewed — no blanket approvals)
- Kaizen contribution (write to producing agent's learnings.md when patterns recur)

**Model role overrides:**
- `review` → `deepseek/deepseek-reasoner` (thorough critical evaluation)

**Wake strategy:** Wake-on-assignment. Fires whenever any agent marks done.

**Security:**

| Permission | Setting |
|-----------|---------|
| Code execution | Denied |
| Web egress | Denied |
| File write | /artifacts/qa/ (verdicts only) + other agents' learnings.md (pattern notes only) |
| File read | /artifacts/* (all agents) |
| File modify | Denied — cannot edit any agent's output |
| File delete | Denied |
| Paperclip API | Issue updates, comments |

**Output types:** QA verdicts (structured per QA verdict template), pattern reports.

---

### 5.8 Publisher

**Role:** Content distribution, HITL approval workflow, scheduling, analytics.

**Extensions:**

| Extension | Purpose |
|-----------|---------|
| escalate | HITL approval gate — mandatory for all publish actions |
| artifacts | Read QA-approved content, write publish receipts |
| logging | Structured execution logs |
| (publishing tools) | TBD — platform-specific APIs |
| (analytics tools) | TBD — engagement metrics |

**System prompt additions beyond universal template:**
- HITL-mandatory rule (every publish action requires human approval via escalate — zero exceptions)
- QA verification (must confirm QA PASS verdict exists for the specific artifact version before attempting)
- No-modification rule (publish exactly what QA approved — no edits, no additions, no formatting changes)
- Receipt protocol (write publish receipt with timestamp, URL, platform, content hash after every publish)
- Rate limit awareness (per-platform rate limits enforced, never retry aggressively)
- Credential isolation (platform credentials in own auth.json, never shared)

**Model role overrides:** None. Publishing is procedural — base config sufficient.

**Wake strategy:** Wake-on-assignment.

**Security:**

| Permission | Setting |
|-----------|---------|
| Code execution | Denied |
| Web egress | Allowed (publishing platforms only) |
| File write | /artifacts/publisher/ only |
| File read | /artifacts/* (all agents, but primarily /artifacts/qa/ and /artifacts/writer/) |
| File delete | Denied |
| External APIs | Publishing platforms (authenticated per-agent) |
| HITL gate | Mandatory on all publish actions |
| Paperclip API | Issue updates, comments |

**Output types:** Publish receipts, analytics snapshots.

---

[Prev: Workspace Structure](workspace-structure.md) | [Next: Extensions](extensions.md)
