# Bridge HTTP Server Design (DEPRECATED)

> **Superseded by server.mjs (v3.0.0)** which uses Pi SDK's `AgentSession` API directly — no subprocess, no RPC, no JSONL parsing. See `docs/architecture.md` for the current design.

## Overview

`bridge.mjs` was a zero-dependency Node.js HTTP server that translated between Paperclip's HTTP adapter protocol and Pi's JSONL RPC protocol. One instance per agent container. The bridge maintained a single persistent Pi process and serialized requests through a FIFO queue.

## Endpoints

### GET /health

Returns server status and configuration. Used by Docker HEALTHCHECK and Paperclip agent heartbeat.

**Response (200):**

```json
{
  "status": "ok",
  "uptime_s": 3600,
  "version": "2.0.0",
  "pi_alive": true,
  "queue_depth": 0,
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
  "requests_queued": 2,
  "requests_failed": 3,
  "pi_respawns": 0,
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

## Request Lifecycle

```
1. Receive POST /invoke
2. Parse JSON body, extract prompt from context.paperclipTaskMarkdown (or fallback chain)
3. Enqueue request into FIFO queue
4. When dequeued (Pi is idle):
   a. Write {"type":"prompt","message":"..."}\n to persistent Pi's stdin
   b. Poll events[] every 50ms:
      - If response.success===false found: return 500
      - If agent_start found: proceed to step 5
      - If timeout (BRIDGE_TIMEOUT_MS): return 504
      - If Pi crashes: return 500, trigger respawn
5. Poll events[] every 100ms:
   - Accumulate message_update deltas into output string
   - If agent_end found: proceed to step 6
   - If timeout (BRIDGE_TIMEOUT_MS): return 504
6. Send {"type":"new_session"}\n to reset Pi context
7. Wait for new_session acknowledgement
8. Mark Pi as idle (next queued request can proceed)
9. Return 200 with {output, events, exitCode: 0}
```

## Environment Variables

| Variable         | Default   | Description                              |
|------------------|-----------|------------------------------------------|
| BRIDGE_PORT      | 8080      | HTTP listen port                         |
| PI_PROVIDER      | minimax   | LLM provider passed to Pi               |
| PI_MODEL         | MiniMax-M2.7 | Model identifier passed to Pi         |
| BRIDGE_TIMEOUT_MS| 120000    | Max wait time for agent_start/agent_end  |
| LOG_LEVEL        | info      | Minimum log level (debug/info/warn/error)|
| PAPERCLIP_SKILLS | paperclip,paperclip-converting-plans-to-tasks,para-memory-files | Comma-separated Paperclip skill names loaded via Pi's native `--skill` flag |

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

Event types: `server_start`, `request_received`, `pi_spawn`, `pi_prompt_sent`, `pi_ready`, `pi_persistent_ready`, `pi_raw_event` (debug), `pi_response`, `pi_error`, `pi_crash`, `pi_respawn_scheduled`, `pi_respawn_success`, `request_queued`, `queue_dequeue`, `new_session_sent`, `new_session_ack`, `request_complete`, `cost_reported`, `cost_report_failed`.

## Trace Propagation

Each /invoke request generates a W3C TRACEPARENT (`00-{trace_id}-{span_id}-01`) passed to Pi via environment variable. pi-otel inside Pi picks this up as the parent trace context, linking bridge requests to agent spans in the Aspire Dashboard.

Response JSON includes `trace_id` for external correlation with Paperclip issues or artifact metadata.

## Cost Reporting

Bridge extracts token usage from Pi's `turn_end` JSONL events (fields: `usage.input`, `usage.output`, `usage.cacheRead`, `provider`, `model`). Aggregates across all turns per request.

After Pi completes, POSTs to Paperclip's cost-events API: `POST /api/companies/{companyId}/cost-events` with `agentId`, `provider`, `model`, `inputTokens`, `outputTokens`, `cachedInputTokens`. Bearer token auth via per-agent `PAPERCLIP_API_KEY`.

Fire-and-forget — cost reporting failure does not affect the /invoke response. Skips POST when total tokens is zero (e.g. MiniMax which returns all-zero usage).

Response JSON includes `usage` summary object.

## Concurrency Model

- One persistent Pi process per bridge instance. The bridge spawns Pi at startup and reuses it across requests.
- Requests are serialized through an in-memory FIFO queue. Each incoming POST /invoke is enqueued; the bridge dequeues one at a time, sends it to Pi, waits for agent_end, then dequeues the next.
- Between requests, the bridge sends a `new_session` command to Pi, which resets the conversation context while keeping the process (and loaded extensions) alive.
- No concurrent Pi processes. The queue provides natural backpressure — requests wait their turn.
- Metrics counters and queue depth survive across requests.

## Pi Lifecycle Management

The bridge owns the Pi process lifecycle from server start to server stop.

### Startup

1. Bridge calls `spawnPi()` during server initialization, before accepting HTTP requests.
2. Pi spawns with `--mode rpc --no-session --provider X --model Y --skill ...` (same args as before).
3. Bridge waits for the `pi_persistent_ready` condition (Pi emits initial extension_ui_request events as extensions load, followed by readiness on stdout).
4. Health endpoint returns `"status": "ok"` only after Pi is ready. Docker HEALTHCHECK and Paperclip heartbeat see the bridge as healthy once Pi can accept prompts.

### Request cycle

```
1. POST /invoke arrives → enqueued (event: request_queued)
2. Dequeued when Pi is idle (event: queue_dequeue)
3. Write {"type":"prompt","message":"..."}\n to Pi stdin
4. Collect events until agent_end
5. Send {"type":"new_session"}\n to Pi stdin (event: new_session_sent)
6. Wait for new_session acknowledgement (event: new_session_ack)
7. Mark Pi as idle → dequeue next request
```

### Crash recovery

If Pi exits unexpectedly (crash, OOM, segfault):

1. Bridge emits `pi_crash` event with exit code and stderr.
2. Any in-flight request receives HTTP 500 with error `pi_crash`.
3. Bridge schedules a respawn with exponential backoff (event: `pi_respawn_scheduled`). Backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s. Resets after a successful request cycle.
4. During respawn backoff, queued requests wait. New requests are enqueued normally.
5. On successful respawn (event: `pi_respawn_success`), the bridge resumes processing the queue.
6. After 5 consecutive failed respawns, the bridge logs a fatal error and exits (container restart policy handles recovery).

### Shutdown

On SIGTERM/SIGINT, the bridge drains the current request (if any), sends stdin EOF to Pi, waits for process exit (up to 5s), then closes the HTTP server.
