[Agent Standard](index.md) > Shared Resources

# Parts 8–9: Shared Resources and Management Principles

---

## Part 8: Shared Resources

### 8.1 Shared Docker Volume

`shared-artifacts` volume mounted at `/artifacts` in every container. The primary inter-agent communication channel. Managed by the artifacts extension.

### 8.2 Paperclip API

Every agent has Paperclip API access via env vars. Used for:
- Issue lifecycle (checkout, update status, comment, mark done/blocked)
- Reading briefs and task descriptions
- Posting handoff notes for downstream agents
- Escalation (creating escalation issues)

### 8.3 Provider API Keys

Shared pool of LLM providers. Every agent gets the same `auth.json` with keys for all 8 providers (nvidia, deepseek, cerebras, minimax, openrouter, mistral, groq). Model selection per-role is in `config.yml`, not in the keys.

### 8.4 Docker Network

All containers share the `agents_default` bridge network. Internal hostnames: `paperclip`, `ceo`, `researcher`, `analyst`, `data-engineer`, `dev`, `writer`, `qa`, `publisher`. Agents reach Paperclip at `http://paperclip:3100`. Paperclip reaches agents at `http://{name}:8080`.

### 8.5 Templates

Canonical templates at `src/agents/templates/` in the repo. Copied into every container at `/root/.pi/agent/extensions/workproduct/templates` during Docker build. Agents access them through the artifacts extension's `get_template()` tool.

```
/root/.pi/agent/extensions/workproduct/templates/
  briefs/             Issue templates (CEO creates work using these)
    research-brief.md
    analysis-brief.md
    content-brief.md
    publish-brief.md
    qa-review.md
  outputs/            Output templates (agents produce work in these formats)
    research-output.md
    analysis-output.md
    content-output.md
    qa-verdict.md
    publish-receipt.json
  workspace/          Workspace init files (copied to /artifacts/{agent}/ on first run)
    learnings.md
    meta.json.template
  meta/               Centralized meta-artifact templates
    agent-profile.md
    learnings-digest.md
```

Templates are read-only at runtime. Changes go through the repo and are picked up on next container build. The artifacts extension uses workspace templates for initialization and output templates for validation reference.

### 8.6 Learnings Corpus

The collection of all agents' `learnings.md` files across `/artifacts/*/learnings.md` and their machine-readable mirrors in `/artifacts/meta/agent/*/learnings-live.jsonl`. Two access patterns now, one deferred:

1. **Agent-to-agent** — QA reads Researcher's learnings to detect recurring rejection patterns. Uses `read_learnings(agent="researcher")` via artifacts extension.
2. **Board operator** — Reads learnings directly for genchi genbutsu.
3. **Drain process (deferred)** — Centralized pattern detection, digest generation, and archival. See ROADMAP.md.

The learnings corpus is the raw material for the kaizen feedback loop. Individual entries are written by agents via `append_learning`. Centralized pattern extraction and automated kaizen reporting come later.

### 8.7 Centralized Meta-Artifact Store

The `/artifacts/meta/` directory is the system-wide knowledge layer for agent health, patterns, and learnings. Not a separate service — just structured files on the shared volume, maintained by the learnings drain process.

```
/artifacts/meta/
  agent/
    ceo/
      profile.md                Agent profile (health metrics, patterns, skill history)
      learnings-digest.md       Distilled patterns from learnings
      learnings-live.jsonl      Machine-readable mirror of learnings.md entries
      learnings-archive/        Monthly archives of old learnings entries
        2026-05.md
    researcher/
      ...
    analyst/
      ...
    (one per agent)
  pipeline/
    kaizen-report-2026-05-26.md Weekly kaizen reports
```

Every agent writes to its own `/artifacts/meta/agent/{name}/learnings-live.jsonl` via the artifacts extension's `append_learning` tool. The drain process reads these, distills patterns, and maintains profiles and digests.

---

## Part 9: Toyota Management Principles — Organizational Application

Beyond TPS (the production system), the Toyota Way includes management principles that govern how the organization operates. These map to the relationship between the board operator, the CEO agent, and the system as a whole.

### 9.1 Respect for People

**In this system:** Agents are specialized. Each does one thing well. When an agent fails, the response is to improve its instructions (skill definitions, prompt engineering), not to replace it or hack around it. This mirrors Toyota's investment in worker development over worker replacement.

**Practical implication:** When Researcher consistently fails QA on source quality, the fix is a better research methodology section in Researcher's AGENTS.md — not assigning research to a different agent or adding a post-processing step.

### 9.2 Challenge

**In this system:** Every agent is expected to challenge its input. Researcher evaluates sources critically. QA challenges every output. CEO challenges whether a brief is worth creating. The escalate tool is the mechanism for challenging decisions that exceed an agent's authority.

**Practical implication:** An agent that accepts bad input silently is a worse failure than one that stops and complains. The stop-the-line protocol encodes this.

### 9.3 Kaizen (Management Level)

**In this system:** The board operator reviews kaizen reports, reads actual agent output (genchi genbutsu), approves skill updates, and continuously refines the system. The CEO agent proposes improvements; the board operator judges them. Neither operates alone.

**Practical implication:** The system does not self-modify autonomously. Every improvement flows through board approval. This prevents runaway optimization (agents optimizing for metrics rather than actual quality) and ensures human judgment remains in the loop.

### 9.4 Genchi Genbutsu (Management Level)

**In this system:** Dashboards and metrics are secondary. The primary management tool is reading actual agent output. When first-pass yield drops, the board operator reads the rejected work and the rejection feedback to understand why — not just the aggregated number.

**Practical implication:** The audit trail, execution logs, and artifact storage exist to support this. Every piece of work is traceable from brief to final output, with every intermediate step recorded.

### 9.5 Teamwork

**In this system:** Agents specialize and depend on each other. No agent is self-sufficient. The pipeline works because each agent trusts the upstream agent to meet the standard and the downstream agent to catch what was missed. This trust is earned through consistent standards (templates, verification) and continuous improvement (kaizen).

**Practical implication:** When adding a new agent, the question is not "what can it do?" but "what role does it fill that no other agent should?" Redundancy is waste. Overlap is a defect in the org chart.

---

[Prev: Security](security.md) | [Next: Implementation Checklist](implementation-checklist.md)
