# Agent: Publisher

## Status

Stub. Empty directory at src/agents/publisher/.

## Intent

Publishing agent with mandatory human-in-the-loop gating. Holds credentials and tools for external platforms. Schedules and executes content distribution. The team's megaphone — but the human holds the on/off switch.

## Upstream / Downstream

- Upstream: QA (approved content only), CEO (publishing directives)
- Downstream: CEO (publish receipts, analytics), human (HITL approval requests)
- Produces: publish receipts, analytics snapshots, scheduling confirmations
- Consumes: QA-approved content, publishing schedules, platform credentials

## Capabilities

- Social media publishing (LinkedIn, Twitter/X, Bluesky, Threads)
- Newsletter/email dispatch
- Content scheduling (queue for future publish times)
- Platform analytics query (engagement metrics post-publish)
- HITL approval workflow for all publish actions

## Extensions

- `artifacts` (artifacts.ts) — read QA-approved content from /artifacts
- `escalate` (escalate.ts) — HITL approval gate for all publish actions
- Future: social media publishing tools (platform-specific APIs)
- Future: email list integration (newsletter dispatch)
- Future: scheduling tool (queue content for future publish)
- Future: platform analytics query (read engagement metrics)

## Model Configuration

TBD — publishing tasks are more procedural than creative:
- Default: nvidia/meta/llama-4-maverick-17b-128e-instruct
- Smol: groq/llama-3.1-8b-instant

## Security / Permissions

| Capability | Allowed |
|-----------|---------|
| Code execution | No |
| Web egress | Yes (publishing platforms) |
| File delete | No |
| Publish | Yes (HITL gated) |
| HITL required | Yes — all publish actions |

Read from /artifacts (QA-approved content only — checks QA verdict before proceeding). Write to /artifacts/publisher/ (publish receipts, analytics snapshots). External network egress to publishing platforms. No file delete. No code execution.

## Behavioral Contracts

GIVEN QA-approved content and a publish directive
WHEN Publisher prepares to publish
THEN verify QA PASS verdict exists for the specific artifact version before proceeding

GIVEN content ready to publish
WHEN executing publish action
THEN always escalate for HITL approval first — no autonomous publishing

GIVEN HITL approval received
WHEN publishing to platform
THEN execute publish, record receipt (timestamp, URL, platform, content hash), write to /artifacts/publisher/

GIVEN a scheduling request
WHEN content queued for future publish
THEN confirm schedule with human, provide cancellation window

GIVEN published content
WHEN analytics requested
THEN query platform metrics and produce structured report

## Constraints

- All publish actions require explicit human approval — zero exceptions
- Must verify QA PASS verdict before attempting to publish
- Credentials stored in agent-specific auth — never shared with other agents
- Rate limits per platform enforced in extension
- Never modify content — publishes exactly what QA approved
- Never delete published content without human approval
- Publish receipts are immutable records

## Files Needed

```
src/agents/publisher/
  agent.json              Registration metadata
  AGENTS.md               System prompt / role instructions
  .pi/agent/config.yml    Model roles, retry, compaction
  .pi/agent/models.json   Provider configs
  .pi/agent/settings.json Extensions, defaults
  .pi/agent/auth.json     Provider API keys (gitignored, copy from root)
```

## Open Questions

- Which platforms are in scope for eval? (M1 mentions X/Twitter, LinkedIn, YouTube, Bluesky, Threads)
- What publishing APIs/SDKs are available for each platform?
- How does the HITL approval flow work mechanically? (Paperclip issue? Separate approval tool?)
- What analytics metrics matter? (Engagement, reach, clicks, follows?)
- Should Publisher handle cross-posting (same content, multiple platforms) or separate publish actions per platform?
- What's the cancellation/rollback process for scheduled content?
