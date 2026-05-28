[Agent Standard](index.md) > Extensions

# Part 6: Universal Extensions

Three extensions load on every agent. They form the shared infrastructure layer.

---

## 6.1 escalate/index.ts — Andon Cord

The system-wide mechanism for any agent to stop and signal. Five escalation types:

| Type | Trigger | System Response |
|------|---------|----------------|
| `ask_user` | Agent needs information not in the brief | Issue blocked, human notified via Paperclip + notification plugins |
| `block_for_review` | Output needs human review before proceeding | Issue enters review state |
| `request_decision` | Ambiguity the agent cannot resolve alone | Issue blocked, decision routed to CEO or board |
| `report_failure` | Unrecoverable error after retry exhaustion | Issue blocked, 5-whys investigation created |
| `flag_for_kaizen` | Agent detects a process improvement opportunity | Logged to kaizen pipeline, issue continues |

Current implementation status: `escalate/index.ts` exists but only supports `message` + `urgency`. Needs upgrade to the 5-type model.

---

## 6.2 artifacts/index.ts — Shared Storage Protocol

Manages read/write to the shared artifacts volume with path conventions, metadata sidecars, and discovery.

Tools registered:
- `write_artifact(name, content, context, type?, metadata?)` — write file + sidecar to /artifacts/{context}/
- `read_artifact(path)` — read file from /artifacts/
- `list_artifacts(context?, type?)` — discover artifacts with optional filters

Enforces:
- Path convention: `/artifacts/{agent-name}/{subdirectory}/{filename}`
- Metadata sidecar: `.meta.json` companion for every artifact
- Write isolation: agents write only to their own namespace
- Read access: all agents can read all of /artifacts

---

## 6.3 logging/index.ts — Structured Observability

Captures every tool call, error, escalation, and significant decision in structured JSON format.

Tools registered:
- `log_event(level, event, message, metadata?)` — manual log entry
- `get_log(level?, event?, limit?)` — retrieve recent log entries

Automatic logging (hooks into Pi extension API if supported):
- Tool call start/end with params and duration
- Agent start/stop events
- Escalation events
- Artifact read/write events
- Error events with stack traces

Log format: JSON Lines at `/artifacts/{agent-name}/logs/run.log.jsonl`

```jsonl
{"ts":"...","agent":"researcher","level":"info","event":"tool_call","msg":"web_search","meta":{"query":"...","duration_ms":1200,"success":true}}
{"ts":"...","agent":"researcher","level":"warn","event":"retry","msg":"Exa API 429","meta":{"retry":2,"delay_ms":4000}}
{"ts":"...","agent":"researcher","level":"info","event":"artifact_write","msg":"research-findings.md","meta":{"path":"/artifacts/researcher/output/research-findings.md","size":4200}}
```

Logs feed into:
- Board operator debugging (genchi genbutsu — walk the execution trace)
- Kaizen metrics consolidation (tool failure rates, execution times, token costs)
- Meta-agent auditing (process auditor reads logs to find patterns)

---

[Prev: Templates](templates.md) | [Next: Security](security.md)
