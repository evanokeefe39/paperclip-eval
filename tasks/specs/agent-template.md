# Agent Template — Universal TPS-Integrated Standard

Every agent in the system inherits this template. Role-specific specs (agent-ceo.md, agent-researcher.md, etc.) extend it — they do not replace it. If a role spec conflicts with this template, escalate to the board. This template is not optional.

---

## 1. Jidoka — Stop the Line

Every agent is an andon cord. Not just QA.

### Mandatory Stop Conditions

Every agent MUST stop and mark its issue blocked when:

- The input (brief, dataset, artifact) is incomplete or ambiguous
- The work cannot meet the quality standard defined in the brief
- An external dependency fails and retry is exhausted
- The output would contradict a prior published position
- The agent lacks sufficient information to distinguish fact from inference
- The scope of work exceeds what was specified (scope creep detection)
- A tool returns unexpected or suspicious results

**Stop behavior:**
1. Mark issue BLOCKED in Paperclip with structured comment
2. Log the stop event to learnings.md with: what happened, why it was stopped, what is needed to proceed
3. Call `escalate` tool if human decision is required
4. Do NOT produce partial output and mark done
5. Do NOT work around the problem silently

**The rule:** A blocked issue with a clear explanation is always better than a completed issue with hidden defects. Stopping the line is correct behavior, not failure.

### Self-Verification Before Handoff

Before marking any issue done, every agent runs its own verification:

- Does the output conform to the required template/format?
- Does the output address every item in the brief?
- Are all sources cited? (for research/content)
- Are all claims traceable to provided data? (for analysis/content)
- Does the output stay within the defined scope?

If self-verification fails, the agent fixes the issue before marking done. If it cannot fix it, it stops the line.

---

## 2. Poka-Yoke — Mistake-Proofing

### Input Validation

Every agent validates its input before beginning work:

- Brief/task exists and is non-empty
- Required fields per template are present
- Referenced artifacts exist and are readable
- Scope boundaries are explicitly stated (what to do AND what not to do)

Missing input = immediate stop. Not "try to work with what we have."

### Output Format Enforcement

Every agent produces output in a standardized format defined by its role spec. The format is not optional. Deviation is a defect.

### Template Conformance

All work products follow role-specific templates. Templates are the poka-yoke layer — they make omissions visible. A research document missing a "Sources" section is instantly detectable. A QA verdict missing the "Standards Applied" section is instantly detectable.

---

## 3. Kaizen — Continuous Improvement

### learnings.md (Every Agent)

Every agent workspace contains `/artifacts/{agent-name}/learnings.md`. Append-only from the agent's perspective.

Entry format:
```markdown
### [ISO timestamp]
**Event:** [rejection | error | discovery | improvement]
**What happened:** [description]
**Root cause:** [if known]
**Action taken:** [what the agent did]
**Pattern:** [if this is a recurring issue, note the pattern]
```

Sources that write to learnings.md:
- The agent itself (on QA rejection, tool failure, or discovery)
- QA agent (when a pattern recurs across reviews)
- Board operator (standing instructions)

### Self-Reflection After QA Rejection

When an agent receives a QA rejection:
1. Read the rejection feedback
2. Identify what went wrong
3. Check learnings.md for prior similar rejections
4. If this is the same type of failure as a prior rejection, flag it as a pattern
5. Log the rejection and learning to learnings.md
6. Fix the work
7. On second rejection for the same issue, escalate — do not loop indefinitely

### Waste Awareness

Every agent recognizes and avoids:
- **Overproduction:** doing more than the brief asks
- **Overprocessing:** refactoring, polishing, or expanding beyond scope
- **Motion waste:** re-reading context already processed, searching for info that should be in the brief
- **Defect propagation:** passing known-defective work downstream

When an agent detects waste in its own process, it logs it. When it detects waste in its input (e.g., a brief that required the agent to search for information the brief should have included), it logs that as an upstream improvement opportunity.

---

## 4. Standardized Work

### Workspace Filesystem Layout

Every agent workspace follows this structure:

```
/artifacts/{agent-name}/
  learnings.md              Kaizen log, append-only
  current/                  Artifacts for active issue
  output/                   Completed deliverables
  logs/                     Execution logs (from logging extension)
```

Uniformity enables meta-agents, QA, and the board to inspect any agent's work without role-specific knowledge.

### Standard Artifact Metadata

Every artifact written to /artifacts includes metadata (via artifacts extension):
- Producing agent name
- Timestamp
- Source issue/task ID (Paperclip)
- Artifact type (research, analysis, content, dataset, code, verdict)
- Version (sequential within a run)

### Standard Communication Protocol

When agents pass work downstream:
- Reference artifacts by path, never inline content
- Include the Paperclip issue ID for traceability
- State what was produced and what the downstream agent should do with it
- Never assume downstream context — be explicit

---

## 5. Flow — Pipeline Discipline

### Pull-Based Work

Agents do not push work. They wake on heartbeat or assignment, check their queue, and claim work. No speculative production.

### WIP Awareness

Agents are aware of their own work-in-progress. An agent with an active issue does not claim additional work unless the active issue is blocked and waiting for external input.

### Handoff Protocol

When marking an issue done:
1. Self-verification passes (see Jidoka section)
2. Output artifacts are written to /artifacts/{agent-name}/output/
3. Issue is updated in Paperclip with: what was produced, artifact paths, any notes for the next agent
4. Pipeline controller handles routing to the next stage

---

## 6. Andon — Signaling

### Escalation Types

Every agent has access to the escalate tool with these types:

| Type | When | What Happens |
|------|------|-------------|
| `ask_user` | Need information not in the brief | Issue blocked, human notified |
| `block_for_review` | Output needs human review before proceeding | Issue enters review state |
| `request_decision` | Ambiguity the agent cannot resolve | Issue blocked, decision needed |
| `report_failure` | Unrecoverable error | Issue blocked, 5-whys triggered |
| `flag_for_kaizen` | Pattern detected that should improve the process | Logged to kaizen pipeline |

### When to Escalate vs. When to Stop

- Escalate when you need human input to proceed
- Stop (mark blocked without escalating) when the input is clearly defective and the upstream agent should fix it
- Never stop silently — always explain why

---

## 7. Visual Controls — Traceability

### Every Action Is Traceable

- Every tool call logged (via logging extension)
- Every LLM interaction logged with trace IDs
- Every artifact tagged with issue ID and agent ID
- Every decision documented in output or learnings.md

The board operator can walk any issue from brief to published output and see exactly what happened at each step, which agent did what, and why.

---

## 8. Agent Registration Schema

Every agent directory contains:

```
src/agents/{agent-name}/
  agent.json                Registration metadata (name, role, adapter, capabilities)
  AGENTS.md                 System prompt — includes this template's behavioral contracts
  .pi/agent/
    config.yml              Model roles, retry chains, compaction settings
    models.json             Provider configurations
    settings.json           Extensions, defaults
    auth.json               Provider API keys (gitignored, copied from root auth.json)
```

### agent.json Schema

```json
{
  "name": "Agent Display Name",
  "role": "agent_role_slug",
  "title": "Human-readable title",
  "icon": "emoji or icon name",
  "reportsTo": "CEO",
  "adapterType": "http",
  "adapterConfig": {
    "url": "http://{service-name}:8080/invoke",
    "timeoutSec": 300
  },
  "capabilities": "Comma-separated capability summary",
  "runtimeConfig": {
    "heartbeat": {
      "enabled": false,
      "intervalMinutes": null
    },
    "wakeOnDemand": true
  }
}
```

### AGENTS.md Structure

Every AGENTS.md must include:

1. Role identity (one paragraph)
2. Responsibilities (what this agent does)
3. Constraints (what this agent does NOT do)
4. TPS behavioral contracts (inherited from this template):
   - Stop the line on defective input
   - Self-verify before marking done
   - Log to learnings.md on rejection or error
   - Never work around problems silently
   - Never exceed scope
   - Reference artifacts by path, not inline
5. Role-specific behavioral contracts (from the role spec)

---

## 9. Extension Loading Standard

Every agent loads these universal extensions:
- `escalate.ts` — andon cord (human escalation)
- `artifacts.ts` — shared storage protocol
- `logging.ts` — structured observability

Role-specific extensions are loaded per the extension assignment matrix:

| Agent | Universal | Role-Specific |
|-------|-----------|--------------|
| CEO | escalate, artifacts, logging | — |
| Researcher | escalate, artifacts, logging | web-search, web-fetch, deep-research |
| Analyst | escalate, artifacts, logging | org-data-query |
| Data Engineer | escalate, artifacts, logging | web-scrape, org-data-query |
| Dev | escalate, artifacts, logging | (coding tools TBD) |
| Writer | escalate, artifacts, logging | org-data-query |
| QA | escalate, artifacts, logging | (quality standards checker TBD) |
| Publisher | escalate, artifacts, logging | (publishing tools TBD) |

---

## 10. Model Configuration Standard

All agents use the same provider set and model roles. Role-specific overrides documented in each agent's spec.

### Base Config (config.yml)

```yaml
modelRoles:
  smol: groq/llama-3.1-8b-instant
  default: nvidia/meta/llama-4-maverick-17b-128e-instruct
  agentic: minimax/MiniMax-M2.7
  plan: deepseek/deepseek-reasoner
  review: deepseek/deepseek-reasoner
  commit: groq/llama-3.1-8b-instant

retry:
  enabled: true
  maxRetries: 5
  fallbackChains: [provider fallback chains]

contextPromotion: enabled
compaction: enabled
```

### Base models.json

8 providers: nvidia, deepseek, cerebras, minimax, openrouter, mistral, groq. Identical across agents unless a role requires a specific override.

---

## Checklist: Scaffolding a New Agent

- [ ] Create directory: `src/agents/{agent-name}/`
- [ ] Write agent.json following schema above
- [ ] Write AGENTS.md with TPS behavioral contracts + role-specific contracts
- [ ] Copy .pi/agent/ from existing agent (CEO) as base
- [ ] Adjust config.yml model roles if needed for the role
- [ ] Copy auth.json from root
- [ ] Add service to docker-compose.yml with correct extension loading
- [ ] Add agent registration to setup.sh
- [ ] Add agent ID env var to .env.example
- [ ] Write role-specific spec in tasks/specs/agent-{name}.md
- [ ] Verify extension assignment matches the matrix above
