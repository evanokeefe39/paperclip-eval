# Spec: Local-First Extensions + Observability Cleanup

## Intent

Decouple extensions from the artifact service by making them work on local filesystem only. The artifact extension becomes the sole interface to the artifact service — the "exfil layer" that agents use explicitly when they want to share or persist work. Replace the custom logging extension with pi-otel (already installed). Swap Aspire Dashboard for OpenObserve.

## Why

Current state: 9 files across 6 extensions import artifact-client directly. Extensions are not standalone — they fail if the artifact service is unreachable. The custom logging extension duplicates what pi-otel already provides. Aspire is minimal; OpenObserve gives queryable logs, traces, and metrics.

After this change: extensions write to local workspace, artifact-client is private to the artifact extension, pi-otel handles all observability, and extensions work even if the artifact service is down.

## Architecture

```
Extension (workproduct, deep-research, duckdb, etc.)
    │
    ▼
Local filesystem (ctx.cwd / issue-scoped workspace)
    │
    ▼  (agent decides to share)
write_artifact / read_artifact / list_artifacts tools (artifacts.ts)
    │
    ▼
artifact-client.ts (private to artifacts extension)
    │
    ▼
Artifact service (HTTP → MinIO + Postgres)
```

pi-otel → OTLP → OpenObserve (replaces custom logging + Aspire)

## Workspace Partitioning

### Problem

Agents work on multiple issues concurrently. A flat `/workspace` means files from different tasks collide — e.g. a `/workspace/todos.md` gets overwritten when agent wakes for a different issue.

### Solution: bridge-level partitioning via issue ID

Pi's `ExtensionContext` passes `ctx.cwd` to every tool's `execute()` call. The bridge already receives `issueId` in the invoke payload. Change bridge to set Pi's working directory per-issue:

```javascript
// bridge.mjs — Pi spawn
cwd: `/workspace/${ctx.issueId || runId || "scratch"}`
```

Extensions use `ctx.cwd` (provided by Pi runtime) instead of hardcoded paths. Each invocation automatically gets its own scoped directory. No env vars needed — Pi injects this natively.

### Directory layout per invocation

```
/workspace/{issueId}/
  workproduct/
    findings/           ← researcher findings
    content/            ← writer output
    data/               ← data products
    assessments/        ← QA reviews
  deep-research/
    {session-id}/
      findings/
      pages/
      session-meta.json
  duckdb/
    state.sql
  triage/
    audit.jsonl
```

### Lifecycle

- Bridge creates the issue-scoped directory at spawn time (`fs.mkdirSync(cwd, { recursive: true })`)
- Extensions write relative to `ctx.cwd` — no absolute paths
- Named volumes persist across container restarts (dev convenience) but are treated as ephemeral
- Anything worth keeping gets published via `write_artifact` — that's the durable store
- `docker compose down -v` wipes workspace volumes — only artifact service data survives

### Ad-hoc invocations

Invocations without an `issueId` (direct bridge testing, heartbeat wakes) use `runId` as partition key. If neither exists, falls back to `scratch/`. This prevents ad-hoc work from colliding with task-scoped work.

## Changes

### 1. Delete: custom logging extension

**Remove entirely:**
- `src/agents/extensions/logging/index.ts`
- `src/agents/extensions/logging/jsonl.ts`
- `src/agents/extensions/logging/buffer.ts`
- `src/agents/extensions/logging/otel.ts`
- `src/agents/extensions/logging/types.ts`

pi-otel already captures LLM calls, tool executions, agent turns as structured spans. The custom extension's only unique value was `log_event` (agent-directed structured logging) and `get_trace_id`. Both are replaceable:

- `log_event` → agents can use pi-otel's built-in event emission; structured business events go to local JSONL via workproduct if needed
- `get_trace_id` → trace ID is in `TRACEPARENT` env var, readable by agent via bash or a trivial tool

**Impact:** triage-workflow.ts imports `JsonlWriter` from logging for audit trail. Refactor triage to write audit log to local filesystem instead.

### 2. Delete: shared lib directory

**Remove:**
- `src/agents/extensions/lib/artifact-client.ts`

The artifact-client module moves to be co-located with the artifact extension (see change 3).

### 3. Refactor: artifact extension (sole artifact-service consumer)

**`src/agents/extensions/artifacts.ts`** — becomes the only extension that talks to the artifact service.

Move `artifact-client.ts` to be a private sibling module:
- `src/agents/extensions/artifacts/index.ts` — tool registrations (from current artifacts.ts)
- `src/agents/extensions/artifacts/client.ts` — HTTP client (from lib/artifact-client.ts)

Pi discovers `artifacts/index.ts` correctly (subdirectory with index.ts pattern).

Tools stay the same: `write_artifact`, `read_artifact`, `list_artifacts`, `get_template`.

`get_template` currently reads from `/root/.pi/agent/extensions/workproduct-lib/templates`. This stays — templates are local filesystem, no coupling issue.

### 4. Refactor: per-agent workproduct extensions → local-first

**Files:** `src/agents/{researcher,data,writer,qa}/.pi/agent/extensions/workproduct.ts`

**Before:** Import artifact-client, write findings/products directly to artifact service.

**After:** Write to local filesystem relative to `ctx.cwd`. No artifact-client import.

Pattern for researcher's `record_finding`:
```
{ctx.cwd}/workproduct/findings/
  {ulid}-finding.json     ← structured finding with ADMIRALTY grades
```

Pattern for writer's `record_report`:
```
{ctx.cwd}/workproduct/content/
  {ulid}-report.md         ← finished document
```

Pattern for data's `record_dataset_ref`:
```
{ctx.cwd}/workproduct/data/
  {ulid}-dataset.json      ← dataset reference
```

Pattern for qa's `record_artifact_review`:
```
{ctx.cwd}/workproduct/assessments/
  {ulid}-review.json       ← QA assessment
```

Each workproduct extension:
- Receives `ctx.cwd` from Pi's `ExtensionContext` in every tool `execute()` call
- Generates ULID locally (workproduct-lib/ulid.ts already exists)
- Writes JSON/MD to `path.join(ctx.cwd, "workproduct", ...)` via `node:fs`
- Validation via workproduct-lib/validate.ts stays unchanged
- `query_*` tools scan local filesystem (`fs.readdirSync`) instead of calling `client.list()`
- `get_*` tools read local files (`fs.readFileSync`) instead of calling `client.read()`
- `add_source` (researcher only) reads local file, updates in place, writes back

When agent wants to share findings with downstream agents, it calls `write_artifact` explicitly. Agent prompt instructs this behavior.

### 5. Refactor: deep-research → local-first

**Files:**
- `src/agents/extensions/deep-research/store.ts`
- `src/agents/extensions/deep-research/query.ts`

**Before:** Import artifact-client, write findings/pages/sessions to artifact service.

**After:** Write to `{ctx.cwd}/deep-research/{session-id}/`:
```
{ctx.cwd}/deep-research/{session-id}/
  findings/
    finding-{id}.json
  pages/
    page-{hash}.md
  session-meta.json
  session-summary.md
```

- `store.ts`: replace `client.write()` with `fs.writeFileSync()` / `fs.mkdirSync()`
- `query.ts`: replace `client.list()` with `fs.readdirSync()` + filter; replace `client.read()` with `fs.readFileSync()`
- `initSession`: create local directory structure

**Context threading:** `store.ts` and `query.ts` functions need `basePath` parameter. The deep-research `index.ts` passes `ctx.cwd` from tool execute into store/query calls.

When deep-research completes, agent publishes summary via `write_artifact`.

### 6. Refactor: duckdb/session → local-first

**File:** `src/agents/extensions/duckdb/session.ts`

**Before:** Import artifact-client, read/write DuckDB state to artifact service.

**After:** Write to `{ctx.cwd}/duckdb/`:
```
{ctx.cwd}/duckdb/
  state.sql              ← SQL replay log
```

- `appendState`: read local file, check idempotency, append statement
- `restoreState`: read local file, replay SQL statements
- `writeState`: write full state to local file
- Functions receive `basePath` from tool execute's `ctx.cwd`

Session state is ephemeral to the container lifetime — acceptable since DuckDB state is reconstructible.

### 7. Refactor: triage-workflow → local audit log

**File:** `src/agents/extensions/triage-workflow.ts`

**Before:** Imports `JsonlWriter` from logging extension.

**After:** Write audit log to `{ctx.cwd}/triage/audit.jsonl` using `node:fs`:
```typescript
import * as fs from "node:fs";
import * as path from "node:path";

function auditLog(cwd: string, entry: Record<string, unknown>) {
  const dir = path.join(cwd, "triage");
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, "audit.jsonl"),
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"
  );
}
```

**Note:** triage-workflow uses `pi.on("tool_call", ...)` hook which receives event context, not tool execute's `ctx`. The hook handler has access to process.cwd() which Pi sets to the spawn cwd. Use `process.cwd()` in the hook, `ctx.cwd` in tool execute.

### 8. Bridge change: issue-scoped working directory

**File:** `src/agents/bridge.mjs`

**Before (line 212):**
```javascript
cwd: body.workspace || "/workspace"
```

**After:**
```javascript
const issueScope = ctx.issueId || runId || "scratch";
const workDir = `/workspace/${issueScope}`;
fs.mkdirSync(workDir, { recursive: true });
// ...
cwd: workDir
```

Add `import fs from "node:fs"` at top of bridge.mjs.

This is the only infrastructure change needed. All downstream partitioning happens automatically because Pi sets `process.cwd()` and passes `ctx.cwd` to extensions.

### 9. Swap: Aspire → OpenObserve

**docker-compose.yml changes:**

Remove:
```yaml
dashboard:
  image: mcr.microsoft.com/dotnet/aspire-dashboard:9.0
  ...
```

Add:
```yaml
openobserve:
  image: public.ecr.aws/zinclabs/openobserve:latest
  restart: unless-stopped
  ports:
    - "5080:5080"     # UI + API
  environment:
    ZO_ROOT_USER_EMAIL: "${ZO_ROOT_USER_EMAIL:-admin@example.com}"
    ZO_ROOT_USER_PASSWORD: "${ZO_ROOT_USER_PASSWORD:-paperclip-eval}"
    ZO_DATA_DIR: "/data"
  volumes:
    - openobserve-data:/data
  deploy:
    resources:
      limits:
        memory: 512M
```

OpenObserve accepts OTLP natively at `http://openobserve:5080/api/default/v1/traces` (HTTP) and logs at `http://openobserve:5080/api/default/v1/logs`.

Update all `OTEL_EXPORTER_OTLP_ENDPOINT` env vars to point to `http://openobserve:5080/api/default`.

Update pi-otel config in each agent's `settings.json`:
```json
"otel": {
  "enabled": true,
  "endpoint": "http://openobserve:5080/api/default",
  "protocol": "http",
  "serviceName": "{agent}-agent",
  "captureContent": "metadata_only",
  "signals": { "traces": true, "metrics": true, "logs": true }
}
```

Note: OpenObserve OTLP ingest requires basic auth header. Set via `OTEL_EXPORTER_OTLP_HEADERS` env var:
```yaml
OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Basic ${ZO_OTLP_AUTH}"
```
Where `ZO_OTLP_AUTH` is base64 of `email:password`.

### 10. Update: agent prompts (AGENTS.md)

Add to researcher AGENTS.md:
```
## Publishing findings

When your research is complete, publish your findings to the artifact store
so downstream agents (Writer) can access them:

1. Use write_artifact with the findings files from ./workproduct/findings/
2. Note the artifact URI returned — include it in your Paperclip issue comment
3. Downstream agents will use read_artifact with that URI to pull your work
```

Similar additions for writer (publish final report) and data (publish datasets).

### 11. Update: pi-permissions.jsonc

Remove `log_event`, `get_log`, `get_trace_id` from all agents' permission files.

### 12. Update: Dockerfiles

No Dockerfile changes needed for extension removal — `COPY extensions/` copies whatever is on disk. Removing files locally means they won't be in the image.

Ensure `/workspace` exists (already does — `RUN mkdir -p /workspace` in base stage).

### 13. Cleanup

- Delete `src/agents/extensions/lib/` directory entirely
- Update CLAUDE.md repo layout section
- Update LEARNING.md if it references logging extension
- Rename all references from `dashboard` to `openobserve` in docker-compose depends_on, env vars, docs

## Files changed

| Action | Path |
|--------|------|
| Delete | `extensions/logging/index.ts` |
| Delete | `extensions/logging/jsonl.ts` |
| Delete | `extensions/logging/buffer.ts` |
| Delete | `extensions/logging/otel.ts` |
| Delete | `extensions/logging/types.ts` |
| Delete | `extensions/lib/artifact-client.ts` |
| Move | `artifacts.ts` → `artifacts/index.ts` |
| Create | `artifacts/client.ts` (from lib/artifact-client.ts) |
| Rewrite | `deep-research/store.ts` (local fs, ctx.cwd) |
| Rewrite | `deep-research/query.ts` (local fs, ctx.cwd) |
| Rewrite | `duckdb/session.ts` (local fs, ctx.cwd) |
| Rewrite | `triage-workflow.ts` (local audit log, process.cwd()) |
| Rewrite | `researcher/.pi/agent/extensions/workproduct.ts` (local fs, ctx.cwd) |
| Rewrite | `data/.pi/agent/extensions/workproduct.ts` (local fs, ctx.cwd) |
| Rewrite | `writer/.pi/agent/extensions/workproduct.ts` (local fs, ctx.cwd) |
| Rewrite | `qa/.pi/agent/extensions/workproduct.ts` (local fs, ctx.cwd) |
| Edit | `bridge.mjs` (issue-scoped cwd) |
| Edit | `docker-compose.yml` (Aspire → OpenObserve, OTEL endpoints) |
| Edit | `*/settings.json` (pi-otel endpoint + protocol) |
| Edit | `*/pi-permissions.jsonc` (remove logging tools) |
| Edit | `*/AGENTS.md` (publish instructions) |
| Edit | `CLAUDE.md` (repo layout) |

## Behavioral contracts

GIVEN an extension (workproduct, deep-research, duckdb)
WHEN artifact service is unreachable
THEN extension operates normally on local filesystem — no errors, no degraded behavior

GIVEN bridge receives invoke with issueId "ISSUE-42"
WHEN Pi spawns
THEN process.cwd() is `/workspace/ISSUE-42` and ctx.cwd reflects the same
AND extensions write relative to that directory

GIVEN bridge receives invoke with no issueId and runId "run-xyz"
WHEN Pi spawns
THEN process.cwd() is `/workspace/run-xyz`

GIVEN bridge receives invoke with neither issueId nor runId
WHEN Pi spawns
THEN process.cwd() is `/workspace/scratch`

GIVEN agent is invoked for issue A, writes findings
WHEN agent is later invoked for issue B
THEN issue A's workspace is untouched — no file collisions

GIVEN researcher completes research and calls write_artifact
WHEN writer later calls read_artifact with returned URI
THEN writer receives researcher's findings content

GIVEN pi-otel is configured with OpenObserve endpoint
WHEN agent executes a turn with tool calls
THEN traces appear in OpenObserve UI within 30 seconds

GIVEN triage-workflow writes audit log
WHEN CEO goes through TRIAGE → GROUNDING → READY phases
THEN `{cwd}/triage/audit.jsonl` contains entries for each phase transition

GIVEN workproduct extension records a finding locally
WHEN agent queries findings
THEN query scans local filesystem under ctx.cwd and returns matching entries

## Edge cases

- Container restart clears /workspace (if tmpfs) or persists (if named volume). Either way, only write_artifact'd content is guaranteed durable. Extensions must not assume local files survive across invocations.
- Multiple invocations for same issue in same container — ULID monotonicity prevents filename collisions. workproduct query returns accumulated results from all invocations for that issue.
- Different issues in same container — fully isolated by directory. No cross-contamination.
- Deep-research session resume after container restart — session lost. Acceptable: deep-research is single-invocation by design.
- OpenObserve down — pi-otel drops telemetry silently (fire-and-forget). Agent operation unaffected.
- issueId contains special characters — bridge should sanitize (replace non-alphanumeric with `-`). Paperclip issue IDs are typically alphanumeric slugs like `PROJ-42`.

## Out of scope

- Retry/timeout in artifact-client (separate improvement, not blocking)
- Artifact service schema changes (write API stays same)
- Changes to artifact-service code
- Changes to MinIO/Postgres infrastructure
- New workproduct types or templates
- Persistent workspace strategy (if needed later, revisit with Paperclip workspace API integration)
