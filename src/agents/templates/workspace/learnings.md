# Learnings

Append-only kaizen log. Do not edit or delete prior entries. New entries go at the bottom.

Compaction: when this file exceeds 200 entries, the learnings-drain process archives entries older than 30 days to `/artifacts/meta/agent/{agent-name}/learnings-archive/` and distills recurring patterns into `/artifacts/meta/agent/{agent-name}/learnings-digest.md`.

## Entry Format

```
### YYYY-MM-DDTHH:MM:SSZ
**Event:** rejection | error | discovery | waste | pattern
**Issue:** [Paperclip issue ID]
**What happened:** [one paragraph, factual]
**Root cause:** [if identifiable]
**Action taken:** [what you did]
**Pattern:** [if recurring, reference prior entry timestamp]
**Upstream improvement:** [if root cause is in your input, note what should change]
```

---

<!-- entries below this line -->
