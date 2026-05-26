# Bridge HTTP Server Design

## Overview

`bridge.mjs` is a zero-dependency Node.js HTTP server that translates between Paperclip's HTTP adapter protocol and Pi's JSONL RPC protocol. One instance per agent container.

## Endpoints

### GET /health

Returns server status and configuration. Used by Docker HEALTHCHECK and Paperclip agent heartbeat.

**Response (200):**

```json
{
  "status": "ok",
  "uptime_s": 3600,
  "version": "1.0.0",
  "config": {
    "provider": "minimax",
    "model": "MiniMax-M2.7",
    "port": 8080
  }
}
```

### GET /metrics

Returns request counters and performance stats.

**Response (200):**

```json
{
  "requests_total": 42,
  "requests_active": 1,
  "requests_failed": 3,
  "avg_duration_ms": 8500,
  "last_request_at": "2026-05-25T14:30:00.000Z"
}
```

### POST /invoke

Executes a prompt against Pi and returns the collected response.

**Request body:**

```json
{
  "prompt": "Research the topic...",
  "systemPrompt": "You are a research analyst.",
  "workspace": "/workspace",
  "env": {"EXTRA_VAR": "value"}
}
```

| Field        | Required | Default                       | Description                          |
|--------------|----------|-------------------------------|--------------------------------------|
| prompt       | No       | "Continue your work."         | The task prompt sent to Pi           |
| systemPrompt | No       | ""                            | Appended to Pi's system prompt       |
| workspace    | No       | "/workspace"                  | Working directory for Pi process     |
| env          | No       | {}                            | Extra environment variables for Pi   |

Note: `renderedPrompt` is accepted as an alias for `prompt` (Paperclip sends this field name).

**Response (200):**

```json
{
  "output": "Full concatenated response text...",
  "events": [
    {"type": "agent_start"},
    {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "Full "}},
    {"type": "agent_end"}
  ],
  "exitCode": 0
}
```

**Error responses:**

| Status | Error Type       | Condition                                  |
|--------|------------------|--------------------------------------------|
| 400    | invalid_json     | Empty body or malformed JSON               |
| 404    | -                | Any route other than the three above       |
| 500    | pi_spawn_failed  | Pi process failed to start or rejected prompt |
| 504    | timeout          | Pi did not respond within BRIDGE_TIMEOUT_MS |

## Spawn Lifecycle

```
1. Receive POST /invoke
2. Parse JSON body, extract prompt and systemPrompt
3. Build spawn args: --mode rpc --no-session --provider X --model Y -e extensions... -e skills/paperclip-tools.ts [--append-system-prompt Z]
4. Spawn pi process with cwd=workspace, env=process.env + body.env
5. Write {"type":"prompt","message":"..."}\n to stdin immediately
6. Poll events[] every 50ms:
   - If response.success===false found: kill, return 500
   - If agent_start found: proceed to step 7
   - If timeout (BRIDGE_TIMEOUT_MS): kill, return 504
   - If process exits without agent_start: return 500
7. Poll events[] every 100ms:
   - Accumulate message_update deltas into output string
   - If agent_end found: close stdin
   - If timeout (BRIDGE_TIMEOUT_MS): kill, return 504
8. Wait for process exit
9. Return 200 with {output, events, exitCode}
```

## Environment Variables

| Variable         | Default   | Description                              |
|------------------|-----------|------------------------------------------|
| BRIDGE_PORT      | 8080      | HTTP listen port                         |
| PI_PROVIDER      | minimax   | LLM provider passed to Pi               |
| PI_MODEL         | MiniMax-M2.7 | Model identifier passed to Pi         |
| BRIDGE_TIMEOUT_MS| 120000    | Max wait time for agent_start/agent_end  |
| LOG_LEVEL        | info      | Minimum log level (debug/info/warn/error)|

## Logging

Structured JSON to stdout, one entry per line. Fields:

```json
{
  "ts": "2026-05-25T14:30:00.000Z",
  "level": "info",
  "event": "request_received",
  "pid": 1,
  ...additional context fields
}
```

Event types: `server_start`, `request_received`, `pi_spawn`, `pi_prompt_sent`, `pi_ready`, `pi_raw_event` (debug), `pi_response`, `pi_error`, `request_complete`, `cost_reported`, `cost_report_failed`.

## Trace Propagation

Each /invoke request generates a W3C TRACEPARENT (`00-{trace_id}-{span_id}-01`) passed to Pi via environment variable. pi-otel inside Pi picks this up as the parent trace context, linking bridge requests to agent spans in the Aspire Dashboard.

Response JSON includes `trace_id` for external correlation with Paperclip issues or artifact metadata.

## Cost Reporting

Bridge extracts token usage from Pi's `turn_end` JSONL events (fields: `usage.input`, `usage.output`, `usage.cacheRead`, `provider`, `model`). Aggregates across all turns per request.

After Pi completes, POSTs to Paperclip's cost-events API: `POST /api/companies/{companyId}/cost-events` with `agentId`, `provider`, `model`, `inputTokens`, `outputTokens`, `cachedInputTokens`. Session-cookie auth (same pattern as escalate extension).

Fire-and-forget — cost reporting failure does not affect the /invoke response. Skips POST when total tokens is zero (e.g. MiniMax which returns all-zero usage).

Response JSON includes `usage` summary object.

## Concurrency Model

- One Pi process per request. No connection pooling, no process reuse.
- Fully stateless: no in-memory state survives between requests (metrics counters excepted).
- Multiple concurrent requests each spawn independent Pi processes.
- No queue or backpressure mechanism. The 512MB container memory limit is the practical concurrency bound.
