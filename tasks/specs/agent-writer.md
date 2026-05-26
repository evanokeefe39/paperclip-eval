# Agent: Writer

## Status

Stub. Empty directory at src/agents/writer/.

## Intent

Content production agent. Transforms research findings and analysis into coherent narratives, articles, reports, and social media content. Applies tone, voice, and audience context. The team's voice — turns insight into readable output.

## Upstream / Downstream

- Upstream: CEO (content briefs), Researcher (findings), Analyst (analysis)
- Downstream: QA (content for review), Publisher (QA-approved content for distribution)
- Produces: articles, reports, social media posts, summaries, templates
- Consumes: research summaries, analysis reports, style guides, content briefs

## Capabilities

- Long-form content writing (articles, reports, whitepapers)
- Short-form content writing (social media posts, summaries, headlines)
- Tone and voice adaptation per audience/platform
- Content restructuring and editing
- Citation formatting
- Template-based content generation

## Extensions

- `org-data-query.ts` — read access to structured data curated by Data Engineer
- `artifacts` (artifacts.ts) — read inputs, write content outputs to shared storage
- Future: style guide reference tool (brand voice rules, audience profiles)
- Future: citation formatter

## Model Configuration

TBD — writing tasks benefit from creative, high-quality output:
- Default: nvidia/meta/llama-4-maverick-17b-128e-instruct
- Agentic (long-form): minimax/MiniMax-M2.7
- Smol: groq/llama-3.1-8b-instant

## Security / Permissions

| Capability | Allowed |
|-----------|---------|
| Code execution | No |
| Web egress | No |
| File delete | No |
| Publish | No |
| HITL required | No |

Read from /artifacts (all agents). Write to /artifacts/writer/. No web access — works exclusively from pre-gathered material. No code execution. No file delete.

## Behavioral Contracts

GIVEN a content brief with topic, audience, tone, and format
WHEN Writer executes
THEN produce content matching all brief parameters, with sources cited from provided research

GIVEN research findings with gaps flagged
WHEN writing about those areas
THEN acknowledge limitations explicitly — never fill gaps with fabricated information

GIVEN a QA rejection with specific feedback
WHEN revision requested
THEN address all flagged issues while preserving the parts that passed

GIVEN multiple content formats requested (e.g., article + social posts)
WHEN producing variants
THEN maintain consistent facts and messaging across formats, adapted for each platform

## Constraints

- Never fabricate facts, sources, or data points
- Never access the web — all source material comes from Researcher/Analyst via /artifacts
- Do not make strategic decisions about what to write — follow the brief
- All claims must trace back to provided research
- Do not self-publish — output goes to QA, then Publisher

## Files Needed

```
src/agents/writer/
  agent.json              Registration metadata
  AGENTS.md               System prompt / role instructions
  .pi/agent/config.yml    Model roles, retry, compaction
  .pi/agent/models.json   Provider configs
  .pi/agent/settings.json Extensions, defaults
  .pi/agent/auth.json     Provider API keys (gitignored, copy from root)
```

## Open Questions

- What style guide format should Writer consume? (Markdown doc? Structured JSON?)
- How does Writer handle platform-specific formatting (Twitter character limits, LinkedIn formatting)?
- Does Writer need access to prior published content to maintain consistency?
- Should Writer produce content in a template-first workflow or freeform?
