# Extension: Logging (OTel-backed Observability)

## Status

Spec draft v2. Extension stub at src/agents/extensions/logging.ts (empty).

## Intent

Observable agent execution. Every LLM call, tool invocation, decision, and error gets a structured span viewable in a browser UI alongside the stack. Developers inspect per-request traces across all agents without guessing. Built on pi-otel (existing Pi extension) for automatic instrumentation, with logging.ts providing explicit agent-level logging, JSONL persistence, and cross-agent correlation.

## Context Package

### Relevant existing code

- `src/agents/bridge.mjs` — HTTP-to-Pi RPC bridge. Structured JSON logging (stdout), /metrics, /health. Zero npm deps by design.
- `src/agents/extensions/logging.ts` — empty stub, this is what we implement.
- `src/agents/extensions/types/pi-coding-agent.d.ts` — ExtensionAPI only exposes `registerTool`. No lifecycle hooks, no tool-call interception.
- `src/agents/docker-compose.yml` — current stack: paperclip + ceo + researcher + data.
- `src/agents/Dockerfile` — shared image. Extensions copied to /app/extensions/. Pi installed globally.
- `src/agents/researcher/Dockerfile`, `src/agents/data/Dockerfile` — bespoke images.

### Key discovery: pi-otel

`pi-otel` is a community Pi extension (published May 2026) that provides automatic OTel instrumentation of the Pi agent runtime. It emits one trace tree per prompt with this span hierarchy:

- `pi.interaction` — root span per user prompt
- `pi.turn` — one span per agent turn
- `pi.llm_request` — LLM API calls (token counts, model, finish reason)
- `pi.tool.<name>` — individual tool executions (params, duration, success/failure)

Signals: traces (default on), metrics (opt-in: LLM latency histograms, token usage), logs (opt-in: lifecycle events).

Install: `pi install npm:pi-otel`. Configure via `.pi/settings.json`. Default backend: Aspire Dashboard.

This means we do NOT need to build custom tool-call interception or traceToolCall helpers. pi-otel already instruments everything at the Pi runtime level.

### Architectural constraints

- Pi ExtensionAPI cannot intercept other tools' calls. Only `registerTool`. But pi-otel hooks in at the runtime level, bypassing this limitation.
- bridge.mjs is zero-dep. OTel SDK must not be added to the bridge.
- Extensions run inside Pi process (Node 22, ESM). Can import npm packages installed in container.
- Agent containers: 512MB memory (data: 2GB). OTel overhead must be minimal.
- Pi runs in `--mode rpc` inside containers. Need to verify pi-otel works in RPC mode.

### Prior decisions

- Structured JSON logging in bridge.mjs writes to stdout.
- Artifacts volume at /artifacts/{agent}/ for persistent output.
- Earlier spec proposed JSONL log files at /artifacts/{agent}/run.log.jsonl.

### Anti-patterns to avoid

- Adding OTel SDK to bridge.mjs (breaks zero-dep constraint).
- Building custom tool-call tracing when pi-otel already does it.
- Heavyweight collectors (Grafana Alloy, OTel Collector) — unnecessary for eval.
- Synchronous blocking on trace/log export.

## Architecture

### Three-layer approach

**Layer 1: Pi runtime instrumentation (pi-otel)**
Automatic. Instruments LLM calls, tool executions, agent turns. Zero code changes to existing extensions. Exports spans via OTLP to the dashboard.

**Layer 2: Agent-level explicit logging (logging.ts)**
Registers tools agents call explicitly: log_event (decisions, progress, errors), get_log (query recent entries), get_trace_id (correlation). Writes JSONL to /artifacts for persistence. Emits custom OTel log events via pi-otel's event bus for dashboard visibility.

**Layer 3: Bridge-level correlation**
bridge.mjs generates trace_id per /invoke request, passes as env var to Pi process. pi-otel picks this up as the parent trace context. Response includes trace_id for Paperclip-level correlation.

### Data flow

```
Paperclip POST /invoke
  → bridge.mjs generates trace_id, passes as TRACE_ID env var
    → Pi process spawned (--mode rpc)
      → pi-otel creates pi.interaction root span (linked to TRACE_ID)
        → pi.turn spans (automatic)
          → pi.llm_request spans (automatic)
          → pi.tool.web_search spans (automatic)
          → pi.tool.log_event spans (automatic)
            → logging.ts writes JSONL + emits OTel log
      → pi-otel exports via OTLP to dashboard:18889
    → bridge.mjs logs request_complete with trace_id
  → Response includes trace_id
```

### Dashboard deployment

Aspire Dashboard: single container, traces + logs + metrics, polished UI. pi-otel's default backend. Language-agnostic despite .NET branding — any OTLP sender works.

```yaml
dashboard:
  image: mcr.microsoft.com/dotnet/aspire-dashboard:9.0
  ports:
    - "18888:18888"   # UI
    - "18889:18889"   # OTLP gRPC receiver
  environment:
    DOTNET_DASHBOARD_UNSECURED_ALLOW_ANONYMOUS: "true"
  deploy:
    resources:
      limits:
        memory: 256M
```

UI at http://localhost:18888. Shows traces (waterfall), structured logs (filterable), metrics (if pi-otel metrics enabled).

### Alternative: Jaeger

If Aspire doesn't fit or you want traces-only with a more mature project:

```yaml
jaeger:
  image: jaegertracing/jaeger:2
  ports:
    - "16686:16686"   # UI
    - "4317:4317"     # OTLP gRPC
    - "4318:4318"     # OTLP HTTP
  environment:
    COLLECTOR_OTLP_ENABLED: "true"
  deploy:
    resources:
      limits:
        memory: 256M
```

pi-otel config would change endpoint to `http://jaeger:4317` and protocol to `grpc`.

## Tool Definitions

```typescript
log_event({
  level: "debug" | "info" | "warn" | "error",
  event: string,        // e.g. "decision", "progress", "rate_limit", "escalation"
  message: string,
  metadata?: object
})
// Returns: confirmation with span_id, trace_id

get_log({
  level?: string,
  event?: string,
  since?: string,       // ISO 8601
  limit?: number        // default 50
})
// Returns: recent log entries from in-memory buffer

get_trace_id()
// Returns: current trace_id for cross-agent correlation
```

## Behavioral Contracts

### BC-1: Trace ID propagation
GIVEN a POST /invoke request to bridge.mjs
WHEN the request is processed
THEN bridge generates a UUID trace_id, includes it in log entries, passes it to Pi as TRACE_ID env var, and returns it in the response JSON

### BC-2: pi-otel installed and configured
GIVEN the agent container image is built
WHEN Pi starts in RPC mode
THEN pi-otel is installed and configured to export traces to the dashboard service via OTLP gRPC

### BC-3: pi-otel trace hierarchy
GIVEN pi-otel is active and an agent receives a prompt
WHEN the agent executes tools and makes LLM calls
THEN spans appear in the dashboard as: pi.interaction → pi.turn → pi.llm_request / pi.tool.<name>

### BC-4: log_event writes to JSONL
GIVEN the logging extension is initialized
WHEN an agent calls log_event
THEN the entry is appended to /artifacts/{agent_name}/run.log.jsonl in the format: {"ts","agent","level","event","message","trace_id","span_id","meta"}

### BC-5: log_event emits OTel log
GIVEN pi-otel is active with logs signal enabled
WHEN an agent calls log_event
THEN a structured log event is emitted via pi-otel's event bus (pi.events.emit) so it appears in the dashboard's Structured Logs view

### BC-6: get_log reads buffered entries
GIVEN log entries have been written during this run
WHEN an agent calls get_log with optional filters
THEN entries matching the filters are returned, most recent first, up to limit

### BC-7: get_trace_id returns correlation ID
GIVEN the extension is initialized
WHEN an agent calls get_trace_id
THEN it returns the current trace_id string for use in cross-agent artifact metadata or Paperclip issue comments

### BC-8: Graceful degradation without pi-otel
GIVEN pi-otel is not installed or not active
WHEN the logging extension initializes
THEN it still registers all tools, writes JSONL, uses in-memory buffer
AND OTel log emission is silently skipped

### BC-9: Graceful degradation without dashboard
GIVEN the dashboard service is unreachable
WHEN pi-otel attempts to export
THEN export fails silently (pi-otel handles this internally)
AND JSONL logging in logging.ts continues unaffected

## Edge Case Inventory

1. **No dashboard running**: pi-otel export fails silently. JSONL logging unaffected. Tools still work.
2. **pi-otel not installed**: logging.ts works standalone — JSONL + in-memory buffer. No automatic tool/LLM spans.
3. **No TRACE_ID env var**: logging.ts generates its own UUID. pi-otel creates its own trace context.
4. **pi-otel in RPC mode**: Must verify pi-otel works with `--mode rpc`. If not, fall back to logging.ts-only mode. (See Open Question 1.)
5. **Rapid log_event calls**: In-memory buffer capped at 1000 entries (ring buffer). JSONL unbounded append-only.
6. **Pi process killed mid-run**: Batched spans may be lost (pi-otel). JSONL has partial data. Acceptable for eval.
7. **Large metadata objects**: Truncate metadata values over 4KB in JSONL entries.
8. **/artifacts volume not mounted**: JSONL write fails silently. In-memory buffer still works.
9. **Multiple concurrent requests**: Each gets unique trace_id. Independent trace trees.
10. **pi-otel content capture and sensitive data**: Use `metadata_only` capture mode (default). Avoids logging full prompt/response content which may contain API keys or PII passed in env.

## Implementation

### Phase 1: pi-otel setup (infrastructure)

**Dockerfile changes** (all three: shared, researcher, data):
```dockerfile
# After pi global install
RUN pi extensions install npm:pi-otel
```

**Pi settings** — add to each agent's `.pi/agent/settings.json`:
```json
{
  "otel": {
    "enabled": true,
    "endpoint": "http://dashboard:18889",
    "protocol": "grpc",
    "serviceName": "{AGENT_NAME}-agent",
    "captureContent": "metadata_only",
    "signals": { "traces": true, "metrics": false, "logs": true }
  }
}
```

Note: `serviceName` must be templated per agent. Options: hardcode per agent settings.json, or use env var substitution if pi-otel supports it. If not, each agent dir gets its own settings.json with the agent name baked in.

**docker-compose.yml changes**:
- Add dashboard service (Aspire)
- Add `OTEL_EXPORTER_OTLP_ENDPOINT: "http://dashboard:18889"` to x-agent anchor environment
- Dashboard does not need depends_on — agents retry export on connection failure

### Phase 2: logging.ts (extension)

**File structure**:
```
src/agents/extensions/
  logging.ts              Main extension — registers tools
  logging/
    buffer.ts             Ring buffer for in-memory log entries
    jsonl.ts              JSONL file writer (append, read with filters)
    otel.ts               pi-otel event bus integration (emit structured logs)
    types.ts              Shared types (LogEntry, LogLevel)
```

**No OTel npm packages needed in logging.ts.** pi-otel handles all OTLP export. logging.ts only needs to:
- Call `pi.events.emit("pi-otel:log", ...)` to send structured logs to dashboard
- Write JSONL to /artifacts (node:fs, already available)
- Maintain in-memory ring buffer (pure JS)

Zero new npm dependencies in the extension itself.

### Phase 3: Bridge changes (minimal)

bridge.mjs gets three additions (no new deps, uses existing `crypto.randomUUID`):
1. Generate trace_id + span_id per /invoke request
2. Pass as W3C `TRACEPARENT` env var to Pi spawn
3. Include `trace_id` in response JSON

```javascript
// In the POST /invoke handler, before spawn:
const traceId = randomUUID().replace(/-/g, "");
const spanId = randomUUID().replace(/-/g, "").slice(0, 16);
const traceparent = `00-${traceId}-${spanId}-01`;

// In spawn env:
env: { ...process.env, ...body.env, TRACEPARENT: traceparent },

// In response JSON:
res.end(JSON.stringify({ output, events, exitCode, trace_id: traceId }));
```

### Env vars

| Var | Default | Purpose |
|-----|---------|---------|
| TRACEPARENT | (generated per request) | W3C trace context — `00-{trace_id}-{span_id}-01` |
| OTEL_EXPORTER_OTLP_ENDPOINT | http://dashboard:18889 | OTLP receiver (pi-otel config) |
| OTEL_SERVICE_NAME | {AGENT_NAME}-agent | Service name in traces |
| LOG_BUFFER_SIZE | 1000 | In-memory ring buffer capacity |
| LOG_JSONL_ENABLED | true | Write JSONL files |

## Definition of Done

- [ ] pi-otel installed in all Dockerfiles (shared, researcher, data)
- [ ] Pi settings.json configured for OTel in each agent
- [ ] Aspire Dashboard service added to docker-compose.yml
- [ ] Traces visible in dashboard UI at http://localhost:18888
- [ ] pi-otel spans show: pi.interaction → pi.turn → pi.llm_request / pi.tool.*
- [ ] logging.ts registers log_event, get_log, get_trace_id tools
- [ ] log_event writes JSONL to /artifacts/{agent}/run.log.jsonl
- [ ] log_event emits structured log via pi-otel event bus
- [ ] In-memory ring buffer serves get_log queries
- [ ] bridge.mjs generates and propagates trace_id
- [ ] Response JSON includes trace_id field
- [ ] Graceful degradation: works without dashboard, works without pi-otel
- [ ] Unit tests for buffer, jsonl modules
- [ ] Integration test: invoke agent, verify trace appears in dashboard
- [ ] .env.example updated with new env vars
- [ ] tasks/todo.md updated

## Negative Space

What must not change:
- bridge.mjs dependency count (stays at zero npm deps)
- Existing extension behavior (web-search, escalate, artifacts, etc.)
- Agent memory limits (pi-otel + Aspire overhead must be negligible)
- Pi spawn args in bridge.mjs (logging.ts added as another -e flag)

Out of scope:
- Custom OTel SDK in bridge.mjs or logging.ts (pi-otel handles export)
- Metrics dashboards (pi-otel metrics opt-in, not needed for eval)
- Persistent trace storage (Aspire in-memory fine for eval)
- traceToolCall helper for other extensions (pi-otel instruments tools automatically)
- Log aggregation pipelines (dashboard UI is sufficient)
- `full` content capture mode (privacy/token concerns)

Decisions reserved for human review:
- Aspire Dashboard vs Jaeger (recommendation: Aspire, since pi-otel defaults to it)
- Whether to enable pi-otel metrics signal (recommendation: defer, traces + logs sufficient)
- Whether trace_id should appear in Paperclip issue comments
- `captureContent` level: `metadata_only` vs `no_tool_content` vs `full`

## Open Questions

All resolved via spikes. See `spikes/RESULTS.md`.

1. ~~**Does pi-otel work in `--mode rpc`?**~~ **RESOLVED: YES.** Spike passed. 3 spans (simple prompt), 6 spans (tool call). Full span hierarchy: pi.interaction → pi.turn → pi.llm_request / pi.tool.<name>.

2. ~~**TRACE_ID pickup**~~ **RESOLVED**: Use W3C `TRACEPARENT` env var (OTel standard). Format: `00-{trace_id_hex32}-{span_id_hex16}-01`. bridge.mjs generates this, pi-otel reads it per spec. No custom env var needed.

3. ~~**pi-otel event bus API**~~ **RESOLVED: YES.** `(pi as any).events.emit("pi-otel:log", { severityText, body, attributes })` works. Custom logs appear in Aspire Structured Logs tab. `@opentelemetry/api` is NOT importable from extensions — cannot create custom spans, only emit logs via event bus.

4. ~~**Settings.json per-agent**~~ **RESOLVED**: Each agent has own `.pi/agent/settings.json` copied to `/root/.pi/agent/settings.json` in container. Hardcode serviceName per agent. No templating needed.
