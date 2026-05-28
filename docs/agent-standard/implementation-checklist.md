[Agent Standard](index.md) > Implementation Checklist

# Part 10: Implementation Checklist and Appendices

---

## Implementation Checklist

For each new agent, complete every item:

### Directory and Config
- [ ] Create `src/agents/{name}/`
- [ ] Write `agent.json` per schema ([section 3.1](workspace-structure.md#31-agentjson--registration-metadata))
- [ ] Write `AGENTS.md` with all TPS sections + role-specific content ([section 3.2](workspace-structure.md#32-agentsmd--system-prompt))
- [ ] Copy `.pi/agent/` from CEO as base
- [ ] Apply model role overrides per [Part 5](templates.md#part-5-per-agent-requirements)
- [ ] Copy `auth.json` from root
- [ ] Verify `settings.json` extensions match the role

### Infrastructure
- [ ] Add service to `docker-compose.yml` and Dockerfile with correct extensions copied to `/root/.pi/agent/extensions/`
- [ ] Add agent registration to `setup.sh`
- [ ] Add `{NAME}_AGENT_ID` to `.env.example`
- [ ] Configure wake strategy (heartbeat vs. wake-on-demand)
- [ ] Configure resource limits and security ([section 7.3](security.md#73-container-security-all-agents))

### Templates
- [ ] Define input template in AGENTS.md
- [ ] Define output template in AGENTS.md
- [ ] Verify templates referenced in role spec (tasks/specs/)

### Workspace
- [ ] Verify `/artifacts/{name}/` directory creation on first run
- [ ] Verify `learnings.md` initialization
- [ ] Verify `meta.json` creation by artifacts extension
- [ ] Verify log file creation by logging extension

### Verification
- [ ] Agent responds to health check
- [ ] Agent validates input (reject a deliberately incomplete brief)
- [ ] Agent produces output conforming to template
- [ ] Agent writes to learnings.md on error
- [ ] Agent calls escalate on ambiguous input
- [ ] Agent refuses to write outside its /artifacts/{name}/ namespace
- [ ] Logging extension captures tool calls

---

## Appendix A: File Inventory Per Agent

```
src/agents/{name}/
  agent.json                    Required. Registration metadata.
  AGENTS.md                     Required. System prompt with TPS contracts.
  .pi/agent/
    config.yml                  Required. Model roles, retry, compaction.
    models.json                 Required. Provider registry.
    settings.json               Required. Runtime settings.
    auth.json                   Required. Gitignored. Copied from root.

/artifacts/{name}/              Created at runtime by artifacts extension.
  learnings.md                  Created at runtime. Append-only kaizen log.
  meta.json                     Created at runtime. Agent metadata.
  current/                      Work-in-progress directory.
  output/                       Completed deliverables.
  logs/                         Execution logs from logging extension.
    run.log.jsonl               Structured JSON Lines log.
```

---

## Appendix B: Extension Loading Matrix

Extensions are discovered natively by Pi from `/root/.pi/agent/extensions/`. Bridge no longer passes `-e` flags. The Dockerfile controls which extensions are present on disk per agent; Pi auto-discovers all `*.ts` files and `*/index.ts` subdirectories at startup.

```
CEO:          escalate/  artifacts/  logging/  paperclip/
Researcher:   escalate/  artifacts/  logging/  paperclip/  web-search/  web-fetch/
Analyst:      escalate/  artifacts/  logging/  paperclip/
Data Engineer:escalate/  artifacts/  logging/  paperclip/  web-scrape/
Dev:          escalate/  artifacts/  logging/  paperclip/
Writer:       escalate/  artifacts/  logging/  paperclip/  writing-style/
QA:           escalate/  artifacts/  logging/  paperclip/
Publisher:    escalate/  artifacts/  logging/  paperclip/
```

Future role-specific extensions (org-data-query, deep-research, quality-checker, publishing tools) added by copying them into the agent's Dockerfile COPY list.

---

[Prev: Shared Resources](shared-resources.md)
