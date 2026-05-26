# Extension: logging

## Status

Stub. Empty file at src/agents/extensions/logging.ts.

## Intent

Structured logging extension for agent workspace activity. Captures tool calls, LLM interactions, decisions, and errors in a consistent format. Enables observability, debugging, and kaizen metrics collection. Each agent gets a structured log of what it did and why.

## Tool Definitions

```typescript
log_event({
  level: "debug" | "info" | "warn" | "error",
  event: string,           // required — event type (e.g., "tool_call", "decision", "error")
  message: string,         // required — human-readable description
  metadata?: object        // optional — structured data (tool params, timing, etc.)
})

get_log({
  level?: string,          // filter by level
  event?: string,          // filter by event type
  limit?: number           // max entries (default: 50)
})
```

## Behavior

### log_event
1. Construct log entry: timestamp, agent name, level, event, message, metadata
2. Append to agent's log file: `/artifacts/{agent-name}/run.log.jsonl`
3. If level is "error", also write to stderr for bridge.mjs to capture

### get_log
1. Read agent's log file
2. Filter by level/event if specified
3. Return most recent entries up to limit

## Automatic Logging (if feasible)

Beyond explicit tool calls, the extension should hook into Pi's extension API to automatically log:
- Every tool call (name, params, duration, success/failure)
- Agent start/stop events
- Escalation events
- Artifact read/write operations

Whether Pi's extension API supports this kind of interception needs verification.

## Log Format

```jsonl
{"ts":"2026-05-26T12:00:00Z","agent":"researcher","level":"info","event":"tool_call","message":"web_search executed","meta":{"tool":"web_search","params":{"query":"..."},"duration_ms":1200,"success":true}}
{"ts":"2026-05-26T12:00:01Z","agent":"researcher","level":"warn","event":"rate_limit","message":"Exa API rate limit hit, retrying","meta":{"retry":1,"delay_ms":2000}}
```

## Dependencies

- Shared Docker volume (writes to /artifacts/{agent-name}/)
- No external APIs
- No npm dependencies (fs operations only)

## Integration with Observability

- Bridge.mjs already has /metrics endpoint (requests_total, active, failed, avg_duration_ms)
- Agent-level logging complements bridge-level metrics
- Future: correlate log entries with Paperclip issue/task IDs for trace correlation
- Future: aggregation job for kaizen metrics (first-pass yield, cycle time, rework volume)

## Loaded By

- All agents (universal extension)

## Gaps / Open Questions

- Can Pi's extension API intercept tool calls automatically, or only register new tools?
- Should logs persist across runs or be ephemeral per invocation?
- What's the log rotation/cleanup strategy?
- How do logs feed into kaizen metrics? (Direct consumption by QA? Aggregation job?)
- Should logging be synchronous (blocks tool return) or async (fire-and-forget)?
- JSON Lines vs. structured SQLite for log storage?
