# Local-First Extensions — Subagent Execution Plan

Spec: `tasks/specs/local-first-extensions.md`

## Key finding: no ctx.cwd in Pi

Pi's execute signature is `(toolCallId, params, signal?)` — no context parameter. All extensions use `process.cwd()` instead, which bridge sets at spawn time. No function signature changes or parameter threading needed.

## Wave 1 — 5 parallel worktree subagents (disjoint file sets)

### W1-A: Delete logging + fix triage-workflow
- DELETE `src/agents/extensions/logging/` (5 files)
- EDIT `src/agents/extensions/triage-workflow.ts` — remove `JsonlWriter` import (line 3), replace with `fs.appendFileSync` to `${process.cwd()}/triage/audit.jsonl`

### W1-B: Bridge issue-scoped cwd
- EDIT `src/agents/bridge.mjs` — line 211-212, change `cwd: body.workspace || "/workspace"` to scope by `wakeContext.issueId || runId || "scratch"`, add `fs.mkdirSync(cwd, { recursive: true })`

### W1-C: Docker Aspire → OpenObserve
- EDIT `docker-compose.yml` — replace `dashboard` service (lines 106-117) with `openobserve` service, update all `OTEL_EXPORTER_OTLP_ENDPOINT` refs from `dashboard:18890` to `openobserve:5080/api/default`, add `openobserve-data` volume

### W1-D: Settings.json OTEL configs (all 7 agents)
- EDIT `src/agents/{ceo,researcher,data,writer,qa,coder,publisher}/.pi/agent/settings.json` — change `endpoint` from `dashboard:18889` to `openobserve:5080/api/default`, `protocol` from `grpc` to `http`

### W1-E: Permissions cleanup (all 7 agents)
- EDIT `src/agents/{ceo,researcher,data,writer,qa,coder,publisher}/.pi/agent/pi-permissions.jsonc` — remove `log_event`, `get_log`, `get_trace_id` lines

## Wave 2 — 4 parallel worktree subagents (after wave 1 merge)

### W2-A: Researcher workproduct local-first
- REWRITE `src/agents/researcher/.pi/agent/extensions/workproduct.ts` — drop `artifact-client` import, write to `${process.cwd()}/workproduct/findings/` via `node:fs`, query/get scan local dir

### W2-B: Data workproduct local-first
- REWRITE `src/agents/data/.pi/agent/extensions/workproduct.ts` — same pattern, write to `workproduct/data/`

### W2-C: Writer + QA workproduct local-first
- REWRITE `src/agents/writer/.pi/agent/extensions/workproduct.ts` — write to `workproduct/content/`
- REWRITE `src/agents/qa/.pi/agent/extensions/workproduct.ts` — write to `workproduct/assessments/`

### W2-D: Deep-research + DuckDB local-first
- REWRITE `src/agents/extensions/deep-research/store.ts` — `client.write()` → `fs.writeFileSync()` under `${process.cwd()}/deep-research/{sessionId}/`
- REWRITE `src/agents/extensions/deep-research/query.ts` — `client.list()` → `fs.readdirSync()`, `client.read()` → `fs.readFileSync()`
- REWRITE `src/agents/extensions/duckdb/session.ts` — state file at `${process.cwd()}/duckdb/state.sql`

## Wave 3 — 2 parallel worktree subagents (after wave 2 merge)

### W3-A: Restructure artifacts.ts → artifacts/
- MOVE `artifacts.ts` → `artifacts/index.ts`, update import from `./lib/artifact-client.js` to `./client.js`
- MOVE `lib/artifact-client.ts` → `artifacts/client.ts`
- DELETE `src/agents/extensions/lib/` directory

### W3-B: CLAUDE.md updates
- Remove logging extension from repo layout
- Update Aspire → OpenObserve references
- Update artifact sharing section for local-first pattern
- Update `artifacts.ts` → `artifacts/` reference

## Verification after final merge

- `grep -r "artifact-client" src/agents/extensions/` → only in `artifacts/client.ts` and `artifacts/index.ts`
- `grep -r "logging/" src/agents/ --include="*.ts"` → zero
- `grep -r "log_event" --include="*.jsonc"` → zero
- `grep -r "dashboard" docker-compose.yml` → zero
- `grep -r "protocol.*grpc" --include="*.json"` → zero

## Merge strategy

All worktree branches touch disjoint files. Merge sequentially into feature branch — each merge conflict-free. Each wave's subagents use `isolation: "worktree"`. Orchestrator merges returned branches between waves.

## Subagent count: 11 total (5 + 4 + 2), max 5 concurrent
