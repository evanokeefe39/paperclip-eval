# Extension: Logging (OTel-backed Observability)

## Status

Spec draft. Extension stub at src/agents/extensions/logging.ts (empty).

## Intent

Observable agent execution. Every tool call, decision, error, and agent lifecycle event gets a structured span exportable to an OTel-compatible backend. Developers inspect traces per-request through a browser UI (Jaeger) running alongside the stack. No guessing what happened inside a Pi agent run.

## Context Package

### Relevant existing code

- `src/agents/bridge.mjs` — HTTP-to-Pi RPC bridge. Already has structured JSON logging (stdout), /metrics, /health. Zero npm deps by design. Bridge stays untouched; tracing lives in the extension.
- `src/agents/extensions/logging.ts` — empty stub, this is what we implement.
- `src/agents/extensions/types/pi-coding-agent.d.ts` — ExtensionAPI only exposes `registerTool`. No lifecycle hooks, no tool-call interception.
- `src/agents/docker-compose.yml` — current stack: paperclip + ceo + researcher + data. We add a jaeger service.
- `src/agents/Dockerfile` — shared image. Extensions copied to /app/extensions/. Currently zero npm deps in extensions (all use node builtins + fetch).

### Architectural constraints

- Pi ExtensionAPI cannot intercept other tools' calls. Only `registerTool` is available. Automatic tool-call interception is not possible at the extension level.
- bridge.mjs is zero-dep. OTel SDK must not be added to the bridge.
- Extensions run inside the Pi process (Node 22, ESM). They can import npm packages if installed in the container image.
- All agents share the same base Dockerfile (except researcher/data which have bespoke ones). OTel packages must be added to all images.
- Agent containers have 512MB memory limit (data: 2GB). OTel SDK overhead must be minimal.

### Prior decisions

- Structured JSON logging in bridge.mjs writes to stdout. Docker captures this.
- Artifacts volume at /artifacts/{agent}/ used for persistent agent output.
- Existing spec proposed JSONL log files at /artifacts/{agent}/run.log.jsonl.

### Anti-patterns to avoid

- Adding OTel SDK to bridge.mjs (breaks zero-dep constraint).
- Heavyweight collectors (Grafana Alloy, OTel Collector) — unnecessary for eval stage.
- Synchronous blocking on trace export (must not slow tool execution).
- Storing traces in SQLite or custom DB (use standard OTLP export).

## Architecture

### Two-layer approach

**Layer 1: Extension-level spans (logging.ts)**
The extension registers tools that agents call explicitly (log_event, get_log) and exports spans to Jaeger via OTLP HTTP. Each tool invocation creates a span. The extension also provides a `trace_tool_call` wrapper other extensions can optionally use to create child spans.

**Layer 2: Bridge-level correlation**
bridge.mjs already logs structured JSON with request lifecycle events. We add a `trace_id` to the bridge's log entries (generated per /invoke request, passed as env var to Pi process). The extension reads this trace_id and uses it as the parent trace, connecting bridge request → Pi agent execution → individual tool spans.

### Data flow

```
Paperclip POST /invoke
  → bridge.mjs generates trace_id, logs request_received
    → Pi process spawned with TRACE_ID env var
      → logging.ts reads TRACE_ID, creates root span "agent_run"
        → Agent calls log_event / trace_tool_call → child spans
        → Other extensions call traceToolCall() → child spans
      → logging.ts exports spans via OTLP HTTP to jaeger:4318
    → bridge.mjs logs request_complete with trace_id
  → Response includes trace_id for correlation
```

### Jaeger deployment

Single container, all-in-one mode. Receives OTLP, stores in memory (eval stage — no persistence needed). Web UI for trace inspection.

```yaml
jaeger:
  image: jaegertracing/jaeger:2
  ports:
    - "16686:16686"   # UI
    - "4318:4318"     # OTLP HTTP
  environment:
    COLLECTOR_OTLP_ENABLED: "true"
  deploy:
    resources:
      limits:
        memory: 256M
```

## Tool Definitions

```typescript
// Explicit logging — agents call these directly
log_event({
  level: "debug" | "info" | "warn" | "error",
  event: string,        // e.g. "decision", "progress", "rate_limit"
  message: string,
  metadata?: object
})
// Returns: confirmation with span_id

get_log({
  level?: string,
  event?: string,
  since?: string,       // ISO 8601
  limit?: number        // default 50
})
// Returns: recent log entries from in-memory buffer + JSONL file

get_trace_id()
// Returns: current trace_id for this agent run (for cross-agent correlation)
```

## Behavioral Contracts

### BC-1: Trace ID propagation
GIVEN a POST /invoke request to bridge.mjs
WHEN the request is processed
THEN bridge generates a UUID trace_id, includes it in log entries, passes it to Pi as TRACE_ID env var, and returns it in the response JSON

### BC-2: Root span creation
GIVEN a Pi process starts with TRACE_ID env var set
WHEN the logging extension initializes
THEN it creates an OTel root span named "{agent_name}.agent_run" using TRACE_ID as the trace ID

### BC-3: log_event creates child span
GIVEN the logging extension is initialized with a root span
WHEN an agent calls log_event with level, event, message
THEN a child span is created under the root span with span name = event, attributes include level, message, agent_name, and any metadata keys

### BC-4: log_event writes to JSONL
GIVEN the logging extension is initialized
WHEN an agent calls log_event
THEN the entry is appended to /artifacts/{agent_name}/run.log.jsonl in the format: {"ts","agent","level","event","message","trace_id","span_id","meta"}

### BC-5: get_log reads buffered entries
GIVEN log entries have been written during this run
WHEN an agent calls get_log with optional filters
THEN entries matching the filters are returned, most recent first, up to limit

### BC-6: OTLP export to Jaeger
GIVEN the OTEL_EXPORTER_OTLP_ENDPOINT env var is set (default: http://jaeger:4318)
WHEN spans are created
THEN they are batched and exported via OTLP HTTP (POST /v1/traces) asynchronously
AND export failures do not block or crash the extension

### BC-7: Graceful degradation
GIVEN OTEL_EXPORTER_OTLP_ENDPOINT is unset or Jaeger is unreachable
WHEN the extension initializes
THEN it still registers tools and writes JSONL logs
AND OTLP export is silently disabled (log once at startup, no repeated errors)

### BC-8: get_trace_id returns correlation ID
GIVEN the extension is initialized
WHEN an agent calls get_trace_id
THEN it returns the current trace_id string for use in cross-agent artifact metadata or Paperclip issue comments

### BC-9: trace_tool_call helper for other extensions
GIVEN another extension imports traceToolCall from logging
WHEN it wraps a tool execution with traceToolCall(name, params, fn)
THEN a child span is created for the tool call duration, with attributes for params (sanitized) and result status

## Edge Case Inventory

1. **No Jaeger running**: Extension works in log-only mode. OTLP export disabled after first connection failure. JSONL logging still works.
2. **No TRACE_ID env var**: Extension generates its own UUID. Bridge correlation still works via returned trace_id in response.
3. **Rapid log_event calls**: In-memory buffer capped at 1000 entries (ring buffer). JSONL file unbounded but append-only.
4. **Pi process killed mid-run**: Batched spans may be lost. JSONL file has partial data. Acceptable for eval stage.
5. **Large metadata objects**: Truncate metadata values over 4KB in spans. Full data in JSONL.
6. **Multiple concurrent requests to same agent**: Each gets unique trace_id. Spans are independent traces.
7. **/artifacts volume not mounted**: JSONL write fails silently. In-memory buffer and OTLP export still work.
8. **Extension loaded but agent never calls log_event**: Root span still exported on process exit (via shutdown hook). Shows agent_run duration even without explicit logs.

## Implementation

### Dependencies (npm)

Minimal OTel surface:
- `@opentelemetry/api` — trace API (context, spans)
- `@opentelemetry/sdk-trace-node` — NodeTracerProvider, BatchSpanProcessor
- `@opentelemetry/exporter-trace-otlp-http` — OTLP HTTP exporter
- `@opentelemetry/resources` — resource attributes (service.name)
- `@opentelemetry/semantic-conventions` — standard attribute names

Install in Dockerfile:
```dockerfile
RUN npm install -g @opentelemetry/api @opentelemetry/sdk-trace-node \
    @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources \
    @opentelemetry/semantic-conventions
```

Estimated image size increase: ~5MB (pure JS packages, no native deps).

### File structure

```
src/agents/extensions/
  logging.ts              Main extension — registers tools, manages trace lifecycle
  logging/
    tracer.ts             OTel setup: provider, exporter, resource, shutdown
    spans.ts              Span creation helpers, traceToolCall export
    buffer.ts             Ring buffer for in-memory log entries
    jsonl.ts              JSONL file writer (append, read with filters)
    types.ts              Shared types (LogEntry, LogLevel, etc.)
```

### Bridge changes (minimal)

bridge.mjs gets two small additions (no new deps):
1. Generate `trace_id` (crypto.randomUUID) per /invoke request
2. Pass as `TRACE_ID` env var to Pi spawn
3. Include `trace_id` in response JSON

### Docker compose changes

Add jaeger service. Add OTEL_EXPORTER_OTLP_ENDPOINT to x-agent anchor env.

### Env vars

| Var | Default | Purpose |
|-----|---------|---------|
| TRACE_ID | (generated) | Per-request trace correlation ID |
| OTEL_EXPORTER_OTLP_ENDPOINT | http://jaeger:4318 | OTLP receiver |
| OTEL_SERVICE_NAME | {AGENT_NAME}-agent | Service name in traces |
| LOG_BUFFER_SIZE | 1000 | In-memory ring buffer capacity |
| LOG_JSONL_ENABLED | true | Write JSONL files |

## Definition of Done

- [ ] logging.ts registers log_event, get_log, get_trace_id tools
- [ ] OTel tracer initialized with OTLP HTTP exporter pointing at Jaeger
- [ ] Root span created per agent run, child spans per log_event call
- [ ] JSONL log file written to /artifacts/{agent}/run.log.jsonl
- [ ] In-memory ring buffer serves get_log queries
- [ ] bridge.mjs generates and propagates trace_id
- [ ] Response JSON includes trace_id field
- [ ] Jaeger service added to docker-compose.yml
- [ ] OTel packages installed in Dockerfile
- [ ] Graceful degradation when Jaeger unavailable (log-only mode)
- [ ] traceToolCall helper exported for other extensions
- [ ] Bespoke Dockerfiles (researcher, data) updated with OTel packages
- [ ] Unit tests for buffer, jsonl, span creation
- [ ] Integration test: invoke agent, verify trace appears in Jaeger API
- [ ] .env.example updated with new env vars
- [ ] tasks/todo.md updated

## Negative Space

What must not change:
- bridge.mjs dependency count (stays at zero npm deps)
- Existing extension behavior (web-search, escalate, artifacts, etc.)
- Agent memory limits (OTel overhead must be negligible)
- Pi spawn args structure in bridge.mjs (logging.ts added alongside existing -e flags)

Out of scope:
- Metrics (Prometheus/OTLP metrics) — bridge /metrics endpoint is sufficient for eval
- Log aggregation across agents (Jaeger traces serve this purpose)
- Persistent trace storage (Jaeger in-memory is fine for eval)
- Auto-instrumentation of other extensions (opt-in via traceToolCall helper only)
- Dashboard/alerting (Jaeger UI is the dashboard)

Decisions reserved for human review:
- Whether to adopt traceToolCall in existing extensions now or later
- Whether Jaeger persistence (Badger/Cassandra) is needed before production
- Whether to replace JSONL with pure OTel logs (OTLP log signal) in future

## Open Questions

1. Should existing extensions (web-search, escalate, artifacts, deep-research) be retrofitted with traceToolCall now, or deferred to a follow-up? Recommendation: defer, ship logging.ts standalone first.
2. The OTel packages need to be importable from Pi's extension runtime. Pi extensions run as ESM TypeScript compiled on-the-fly. Need to verify `@opentelemetry/*` packages resolve correctly when installed globally via npm. If not, may need a local node_modules in /app/.
3. Should trace_id be exposed in Paperclip issue comments for human-visible correlation? Recommendation: yes, via get_trace_id tool — agents can include it in escalation messages.
