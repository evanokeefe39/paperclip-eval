# Gap Analysis — Specs, Docs, Plans, Code

Generated 2026-05-26. Covers all agents, extensions, and supporting infrastructure.

---

## 1. Spec Coverage

### Agents

| Agent | Spec | Code | agent.json | AGENTS.md | Pi Config | Status |
|-------|------|------|-----------|-----------|-----------|--------|
| CEO | agent-ceo.md | bridge.mjs | Y | Y | Y | Implemented |
| Researcher | agent-researcher.md | bridge.mjs | Y | Y | Y | Implemented |
| Analyst | agent-analyst.md | — | — | — | — | Stub (empty dir) |
| Data Engineer | agent-data-engineer.md | — | — | — | — | Stub (empty dir) |
| Dev | agent-dev.md | — | — | — | — | Stub (empty dir) |
| Writer | agent-writer.md | — | — | — | — | Stub (empty dir) |
| QA | agent-qa.md | — | — | — | — | Stub (empty dir) |
| Publisher | agent-publisher.md | — | — | — | — | Stub (empty dir) |

### Extensions

| Extension | Spec | Code | Plan | Status |
|-----------|------|------|------|--------|
| escalate | escalate.md | escalate.ts (246 lines) | — | Implemented |
| web-search | ext-web-search.md | web-search.ts (68 lines) | — | Implemented |
| web-fetch | ext-web-fetch.md | web-fetch.ts (165 lines) | — | Implemented |
| artifacts | ext-artifacts.md | artifacts.ts (0 bytes) | — | Stub |
| deep-research | ext-deep-research.md | deep-research.ts (0 bytes) | 3 plans (engine, store, graph) | Stub |
| logging | ext-logging.md | logging.ts (0 bytes) | — | Stub |
| web-scrape | ext-web-scrape.md | web-scrape.ts (0 bytes) | 3 plans (apify, gateway, tiers) | Stub |

---

## 2. Spec-to-Code Gaps (Implemented Components)

### escalate.ts vs escalate.md

| Spec Says | Code Does | Gap |
|-----------|-----------|-----|
| Env: PAPERCLIP_API_KEY | Code uses PAPERCLIP_ADMIN_EMAIL + PAPERCLIP_ADMIN_PASS (session auth) | Spec outdated — auth mechanism differs |
| Env: PAPERCLIP_RUN_ID | Code does not use run ID | Spec lists unused env var |
| Conditional registration if env vars missing | Code registers unconditionally | Missing guard |
| Labels as strings: `["escalation"]` | Code uses label IDs (LEARNING.md: "labels are IDs not strings") | Spec not updated with learning |
| File structure: pi-escalate/package.json | Code is a single file in extensions/ | Spec describes package structure, code is flat file |

### web-search.ts vs ext-web-search.md

| Spec Says | Code Does | Gap |
|-----------|-----------|-----|
| Conditional registration if EXA_API_KEY missing | Not verified in code | Potential gap — tool may register without valid key |
| 5 results hardcoded | Confirmed in code | Spec documents limitation, no fix planned |

### web-fetch.ts vs ext-web-fetch.md

| Spec Says | Code Does | Gap |
|-----------|-----------|-----|
| Regex-based HTML parsing | Confirmed | Known fragility documented |
| No caching | Confirmed | Same URL re-fetched every call |

### CEO/Researcher agent.json vs agent specs

| Spec Says | Code Does | Gap |
|-----------|-----------|-----|
| CEO has no extensions | CEO container loads web-search, web-fetch, escalate (via bridge.mjs -e flags) | Need to verify docker-compose extension loading per agent |
| Researcher uses web_search, web_fetch, escalate | Confirmed in docker-compose | Aligned |

---

## 3. Plan-to-Spec Gaps (Stub Components with Plans)

### deep-research: 3 plans exist, spec created

| Plan | Covered in Spec | Remaining Gap |
|------|----------------|---------------|
| deep-research-engine.md | Architecture, file structure, config knobs, context budgets | LLM client implementation details (retry, structured output parsing) |
| deep-research-store.md | Referenced as dependency | Full store schema not in spec — lives only in plan |
| deep-research-graph.md | Not in spec (deferred to Phase 5) | Correct — graph is post-MinIO |

**Key gap:** Findings store (SQLite schema, insertion flow, query interface) has detailed plan but no spec. Needs spec or incorporation into ext-deep-research.md.

### web-scrape: 3 plans exist, spec created

| Plan | Covered in Spec | Remaining Gap |
|------|----------------|---------------|
| web-scraping-apify.md | Apify integration, actor API, tool definitions | Implementation details (API client code, error recovery) |
| web-scraping-gateway.md | Gateway routing concept, tier selection | Gateway is a separate service (server.mjs), not just an extension — architectural decision needed |
| web-scraping-tiers.md | Tier model, cost structure, known actors | Budget tracking implementation not designed |

**Key gap:** Plans describe gateway as a separate Node server (server.mjs), but spec describes a Pi extension. These are different architectures. Need decision: is web-scrape a Pi extension that calls Apify directly, or a gateway service that the extension calls?

---

## 4. Documentation Gaps

### Existing docs (docs/) vs current state

| Doc | Current Accuracy | Gap |
|-----|-----------------|-----|
| architecture.md | Partially stale | Only covers CEO + Researcher; no mention of 6 new agents |
| bridge-design.md | Accurate | Protocol description matches bridge.mjs |
| paperclip-integration.md | Accurate | Auth, registration flow correct |
| pi-rpc-protocol.md | Accurate | JSONL protocol matches implementation |
| toyota-way/principles-integration.md | Aspirational | Describes future phases, not current state |
| toyota-way/principles-reference.md | Reference material | Not project-specific, always accurate |

### Missing docs

- No doc describing the agent roster and pipeline flow (who hands off to whom)
- No doc describing the extension loading mechanism (how bridge.mjs loads extensions per agent)
- No doc describing the artifact storage protocol (path conventions, metadata)
- No doc for the QA standards that QA agent will evaluate against
- No doc for content style guide that Writer agent will follow

### CLAUDE.md vs current state

- Repo layout section lists only CEO and Researcher — needs 6 new agents
- Extensions section lists only web-search, web-fetch — needs 4 new extensions
- No mention of tasks/specs/ directory

### ROADMAP.md vs current state

- Agent roster section describes "Data/Analyst" as single role — codebase splits into analyst/ and data-engineer/
- Coder → dev rename not reflected
- Phase 1 task list needs updating now that stubs exist

---

## 5. Infrastructure Gaps

### docker-compose.yml

- Only defines 3 services: paperclip, ceo, researcher
- Needs 6 new service definitions (analyst, data-engineer, dev, writer, qa, publisher)
- Dev agent needs special security config (non-root, resource limits, network policy) per ROADMAP.md
- Extension loading per agent needs definition (which agent gets which extensions)

### setup.sh

- Only registers CEO and Researcher agents
- Needs registration logic for 6 new agents
- Agent IDs need .env variables for escalation extension

### Dockerfile

- Shared image works for all agents (same base + Pi CLI)
- May need variant for Dev agent (additional runtimes, security hardening)

### .env.example

- Missing APIFY_API_TOKEN (needed for web-scrape)
- Missing agent ID variables for new agents (*_AGENT_ID)

---

## 6. Cross-Cutting Gaps

### Extension-to-Agent Assignment

No single document maps which extensions load into which agent container. Current state:

| Agent | Extensions (confirmed/planned) |
|-------|-------------------------------|
| CEO | escalate |
| Researcher | web-search, web-fetch, escalate, deep-research (future) |
| Analyst | artifacts, org-data-query (future) |
| Data Engineer | web-scrape, artifacts, org-data-query (future) |
| Dev | artifacts, escalate |
| Writer | artifacts, org-data-query (future) |
| QA | artifacts, escalate |
| Publisher | artifacts, escalate |

**Need:** Extension assignment matrix as a definitive reference, reflected in docker-compose.yml build args or bridge.mjs spawn flags.

### Artifact Storage Protocol

Shared volume pattern (Option A) is implemented but undocumented. Path conventions exist in code but not in any spec or doc. The artifacts extension spec (ext-artifacts.md) defines conventions, but the bridge.mjs and docker-compose.yml don't enforce them.

### Agent Communication Protocol

How agents hand off work is implicit via Paperclip wake/invoke. No spec defines:
- What payload format agents expect in wake messages
- How artifact references are passed between agents
- How the pipeline sequence is enforced (CEO → Researcher → Analyst → Writer → QA → Publisher)

### Quality Standards

QA agent spec references "quality standards" but none exist. Before QA can operate, need:
- Content quality standards (for Writer output)
- Research quality standards (for Researcher output)
- Code quality standards (for Dev output)
- Data quality standards (for Data Engineer output)

---

## 7. TPS Integration Gaps

The agent-template.md defines universal TPS behavioral contracts for all agents. Current state vs. required state:

### Jidoka (Stop the Line)

| Component | Required | Current State | Gap |
|-----------|----------|--------------|-----|
| Mandatory stop conditions in AGENTS.md | All agents | Only QA discusses quality gating | Every AGENTS.md needs TPS stop-the-line contracts |
| Self-verification before handoff | All agents | Not implemented anywhere | Need verification checklist per role |
| escalate tool on all agents | All agents | Only Researcher + CEO load it | docker-compose needs escalate on all containers |

### Poka-Yoke (Mistake-Proofing)

| Component | Required | Current State | Gap |
|-----------|----------|--------------|-----|
| Input validation on every agent | All agents | No agent validates input | Need input validation in AGENTS.md behavioral contracts |
| Output templates per role | All agents | No templates defined | Need template specs for each agent's output format |
| Issue templates (brief, review, publish) | Orchestration layer | Not implemented | Need Paperclip issue template definitions |

### Kaizen (Continuous Improvement)

| Component | Required | Current State | Gap |
|-----------|----------|--------------|-----|
| learnings.md per agent | All agents | No agent workspace has this | Need filesystem layout + logging extension |
| Rejection → learning loop | All agents | Not implemented | Need behavioral contract in AGENTS.md |
| Pattern detection across rejections | QA + meta-agents | Not implemented | Phase 3+ (kaizen subsystem) |
| 5-whys investigations | CEO + meta-agents | Not implemented | Phase 4+ |

### Standardized Work

| Component | Required | Current State | Gap |
|-----------|----------|--------------|-----|
| Workspace filesystem layout | All agents | No standard layout | Need /artifacts/{agent}/current/, output/, logs/ |
| Artifact metadata protocol | All agents | No metadata standard | Need artifacts extension implementation |
| Communication protocol (artifact refs) | All agents | Ad-hoc path passing | Need standardized handoff format |

### Andon (Signaling)

| Component | Required | Current State | Gap |
|-----------|----------|--------------|-----|
| Escalation types (5 types) | All agents | escalate.ts has message+urgency only | escalate.ts needs type parameter (ask_user, block_for_review, etc.) |
| Escalation routing by type | Orchestration | Not implemented | Escalate creates generic issue, no type-based routing |

### Flow

| Component | Required | Current State | Gap |
|-----------|----------|--------------|-----|
| Pipeline controller | Orchestration | Not implemented | Phase 2 (Paperclip plugin) |
| WIP limits | CEO planning | Not implemented | CEO skill needs WIP check |
| Heartbeat staggering | All agents | Not configured | docker-compose needs staggered wake config |

### Summary

TPS principles are thoroughly documented (docs/toyota-way-principles-*.md) but minimally implemented in actual agent code. The biggest gaps:

1. **No agent embeds TPS behavioral contracts in its AGENTS.md** — the system prompt is where these behaviors get enforced at the LLM level
2. **escalate.ts lacks type-based escalation** — spec and code only have message+urgency, not the 5 escalation types from the TPS docs
3. **No standardized workspace layout** — agents write to /artifacts ad-hoc
4. **No learnings.md / kaizen loop** — the continuous improvement mechanism has no implementation
5. **No self-verification before handoff** — agents mark done without checking their own output

---

## 8. Priority Ranking

Ordered by blocking impact on M1 (Social Media Trend Analysis) and Phase 1 (agent roster):

### Tier 1 — Blocking (agents cannot function without these)

1. **Agent template finalization** — confirm agent-template.md TPS contracts with board, then bake into every AGENTS.md. This is the foundation — all downstream scaffolding depends on it.
2. **Agent scaffolding** — populate 6 empty agent dirs with agent.json, AGENTS.md (embedding TPS template), Pi config
3. **docker-compose.yml expansion** — add 6 new service definitions with correct extension loading per agent-template.md matrix
4. **setup.sh expansion** — register new agents with Paperclip

### Tier 2 — Required for inter-agent work

5. **artifacts extension** — implement shared storage protocol with metadata, path conventions, filesystem layout per template
6. **logging extension** — implement structured logging (enables learnings.md, kaizen data collection, traceability)
7. **escalate.ts upgrade** — add type parameter (ask_user, block_for_review, request_decision, report_failure, flag_for_kaizen) per TPS docs. Current version only has message+urgency.
8. **escalate.md spec update** — align with actual code (auth method, label IDs) and new type parameter

### Tier 3 — Required for M1 milestone

9. **deep-research extension** — implement for Researcher (M1 needs iterative research)
10. **web-scrape extension** — implement for Data Engineer (M1 needs social media data)

### Tier 4 — Quality and process (Phase 2+)

11. **Quality standards docs** — define standards per output type before QA can operate
12. **Issue templates** — research brief, QA review, publish brief (poka-yoke layer)
13. **Output format templates** — per-role output schemas

### Tier 5 — Housekeeping

14. **CLAUDE.md update** — reflect new agents, extensions, specs directory
15. **architecture.md update** — reflect full agent roster and TPS integration
16. **ROADMAP.md alignment** — fix Analyst/Data Engineer split, Coder→Dev rename
17. **Extension assignment matrix** — formalized in agent-template.md, needs reflection in docker-compose.yml
