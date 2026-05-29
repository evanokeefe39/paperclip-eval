# Server Endpoints Spec: /status, /result, /describe

## Intent

Add three standardized endpoints to server.mjs so pi-subagents-http (and any HTTP orchestrator) can discover agents, poll run status, and retrieve results. Also update POST /invoke to accept trace correlation fields.

## Context Package

### Relevant existing code

- `src/agents/server.mjs` — the agent HTTP server. Already has:
  - `runs` Map tracking run state (status, output, usage, error, startedAt, completedAt)
  - `trackRun(runId, data)` merges fields into run record
  - `GET /runs/:runId` returns raw run data (close to /status but non-standardized)
  - `POST /invoke` returns 202 `{ runId, status: "accepted" }`
  - `processInvocation()` collects events, extracts output text, tracks usage
  - Usage shape: `{ inputTokens, outputTokens, cachedInputTokens, provider, model, turns }`

### Architectural constraints

- Plain Node.js, no framework, no transpiler
- Single dependency: pino for logging
- Runs inside Docker containers
- Each container is one agent instance
- AGENT_NAME env var identifies the agent

## Behavioral Contracts

### GET /describe

```
GIVEN a running agent container with AGENT_NAME set
WHEN GET /describe is called
THEN respond 200 with agent metadata:
  {
    name: string (from AGENT_NAME),
    description: string (from agent.json if available, else ""),
    model: string (PI_PROVIDER/PI_MODEL),
    status: "ready" | "busy" | "starting"
  }
```

Status logic: "starting" if services not initialized, "busy" if processing queue full, "ready" otherwise.

### GET /status/:runId

```
GIVEN a tracked run
WHEN GET /status/:runId is called with a known runId
THEN respond 200 with:
  {
    runId: string,
    state: "queued" | "running" | "completed" | "failed" | "timeout",
    startedAt: string (ISO),
    durationMs: number (elapsed since start),
    progress?: { turnCount: number }
  }

GIVEN an unknown runId
WHEN GET /status/:runId is called
THEN respond 404 { error: "not_found" }
```

### GET /result/:runId

```
GIVEN a completed or failed run
WHEN GET /result/:runId is called
THEN respond 200 with:
  {
    runId: string,
    state: "completed" | "failed",
    output: string (final assistant text),
    error: string | null,
    usage: {
      input: number,
      output: number,
      cacheRead: number,
      cost: number (0 if unknown),
      turns: number
    },
    durationMs: number,
    model: string
  }

GIVEN a still-running or queued run
WHEN GET /result/:runId is called
THEN respond 409 { error: "still_running", state: "running"|"queued" }

GIVEN an unknown runId
WHEN GET /result/:runId is called
THEN respond 404 { error: "not_found" }
```

### POST /invoke (update)

```
GIVEN the existing /invoke endpoint
WHEN a request includes traceparent and/or correlationId fields
THEN store them in the run record
AND log them with the request
```

The body shape becomes:
```json
{
  "context": { ... },
  "traceparent": "00-abc123...-def456...-01",
  "correlationId": "uuid-string"
}
```

Both fields optional, backward compatible.

## Edge Case Inventory

1. Run completed but evicted from MAX_RUN_HISTORY — /status and /result return 404
2. Run timed out — /status returns state "timeout", /result returns state "failed" with timeout error
3. Services not initialized — /describe returns status "starting", /invoke returns 503 (existing)
4. agent.json missing — /describe returns description "" (graceful)
5. correlationId not provided — server generates one (same as current traceId behavior)
6. traceparent not provided — no W3C trace propagation (existing behavior)

## Definition of Done

- [ ] GET /describe returns agent metadata
- [ ] GET /status/:runId returns standardized run state
- [ ] GET /result/:runId returns output+usage on completion, 409 if running, 404 if unknown
- [ ] POST /invoke accepts and stores traceparent + correlationId
- [ ] Existing /health, /metrics, /runs/:runId endpoints unchanged
- [ ] trackRun stores turnCount for progress reporting
- [ ] No new dependencies

## Negative Space

Out of scope:
- Tool call tracking (nice-to-have, not v1)
- Streaming/SSE endpoints
- Authentication between orchestrator and agent
- Agent capability listing (tools, extensions) — future /describe enhancement
