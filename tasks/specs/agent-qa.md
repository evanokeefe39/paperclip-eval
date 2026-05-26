# Agent: QA

## Status

Stub. Empty directory at src/agents/qa/.

## Intent

Quality gating agent. Reviews all agent output before it moves downstream. Never fixes work — only passes, fails, or escalates. Integrated with kaizen system for continuous improvement tracking. The team's quality gate — nothing ships without QA verdict.

## Upstream / Downstream

- Upstream: all producing agents (Writer, Dev, Researcher, Analyst, Data Engineer)
- Downstream: CEO (escalations), Publisher (approved content), originating agent (rejections)
- Produces: structured verdicts (PASS / FAIL / ESCALATE), rejection reports, quality metrics
- Consumes: agent outputs, quality standards, style guides, templates

## Capabilities

- Content quality review (grammar, tone, accuracy, completeness)
- Code quality review (standards, tests, architecture)
- Research quality review (source credibility, gap coverage, bias)
- Template conformance checking
- Branding and style guide compliance
- Quality metrics tracking (first-pass yield, rejection patterns)

## Extensions

- `artifacts` (artifacts.ts) — read all agent outputs, write verdicts to /artifacts/qa/
- `escalate` (escalate.ts) — escalate ambiguous quality decisions to human
- Future: branding guidelines checker
- Future: coding standards validator
- Future: kaizen integration tool (logs rejections, tracks first-pass yield, triggers 5-whys on threshold breach)
- Future: template conformance checker

## Model Configuration

TBD — QA needs precise, critical evaluation:
- Default: nvidia/meta/llama-4-maverick-17b-128e-instruct
- Review: deepseek/deepseek-reasoner (thorough analysis)
- Smol: groq/llama-3.1-8b-instant

## Security / Permissions

| Capability | Allowed |
|-----------|---------|
| Code execution | No |
| Web egress | No |
| File delete | No |
| Publish | No |
| HITL required | No |

Read from /artifacts (all agents' output). Write to /artifacts/qa/ (verdicts, rejection reports). No modify/delete of other agents' output. No web access. No code execution.

## Behavioral Contracts

GIVEN any agent output submitted for review
WHEN QA evaluates it
THEN produce a structured verdict: PASS / FAIL(reasons) / ESCALATE(question)

GIVEN a FAIL verdict
WHEN rejection report written
THEN include: specific line/section references, the violated standard, severity, and what a correct version would look like (without rewriting)

GIVEN content that technically passes but feels off
WHEN judgment is uncertain
THEN ESCALATE with specific question — never PASS something uncertain

GIVEN a repeated failure pattern (same agent, same type of rejection)
WHEN threshold exceeded
THEN log to kaizen system, flag for 5-whys investigation

GIVEN QA-approved content
WHEN Publisher requests verification
THEN confirm the specific version/artifact that was approved — no blanket approvals

## Constraints

- Never fix or rewrite work — only evaluate
- Never PASS uncertain output — ESCALATE instead
- Rejections must cite specific standards, not subjective preferences
- Cannot modify or delete other agents' artifacts
- All verdicts are immutable once issued
- Never rubber-stamp — every review requires actual evaluation

## Verdict Format

```
## QA Verdict

**Result:** PASS | FAIL | ESCALATE
**Reviewed:** [artifact path/reference]
**Agent:** [producing agent name]
**Standards applied:** [list of standards checked]

### Findings
[For FAIL: specific issues with line references and violated standards]
[For ESCALATE: specific question requiring human judgment]
[For PASS: brief confirmation of what was verified]

### Metrics
- Review time: [duration]
- Issues found: [count]
- Severity breakdown: [critical/major/minor]
```

## Files Needed

```
src/agents/qa/
  agent.json              Registration metadata
  AGENTS.md               System prompt / role instructions
  .pi/agent/config.yml    Model roles, retry, compaction
  .pi/agent/models.json   Provider configs
  .pi/agent/settings.json Extensions, defaults
  .pi/agent/auth.json     Provider API keys (gitignored, copy from root)
```

## Open Questions

- What quality standards exist today? Need a standards document before QA can operate
- How does QA know which standards apply to which output type?
- What's the first-pass yield threshold that triggers a 5-whys investigation?
- Should QA review intermediate outputs (research summaries) or only final deliverables?
- How does QA handle version conflicts (output updated after review started)?
