# Agent Profile: {{agent_name}}

Centralized profile maintained at `/artifacts/meta/agent/{{agent_name}}/profile.md`. Updated by the learnings-drain process and meta-agents.

## Identity

- **Name:** {{display name}}
- **Role:** {{role slug}}
- **Extensions:** {{list}}
- **Model config:** {{primary model role}}
- **Wake strategy:** {{heartbeat | wake-on-demand}}

## Health

- **First-pass yield (30d):** {{percentage}}
- **Avg cycle time:** {{duration}}
- **Escalation rate (30d):** {{percentage}}
- **Rework rate (30d):** {{percentage}}
- **Total issues completed:** {{count}}
- **Last active:** {{ISO 8601}}

## Recurring Patterns

<!-- Distilled from learnings-digest.md. Updated by drain process. -->

### Pattern: {{name}}
- **Frequency:** {{count}} occurrences in last 30d
- **Category:** {{rejection | error | waste | discovery}}
- **Root cause:** {{summary}}
- **Status:** {{open | mitigated | resolved}}
- **Mitigation:** {{what was changed — skill update, template fix, etc.}}

## Skill Update History

<!-- Log of changes to this agent's AGENTS.md / config driven by kaizen findings -->

| Date | Change | Triggered By | Kaizen Issue |
|------|--------|-------------|-------------|
| {{date}} | {{what changed}} | {{pattern or finding}} | {{issue ID}} |

## Notes

<!-- Board operator notes about this agent's performance, quirks, known limitations -->
