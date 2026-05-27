# Plan: Artifact Store v2 Implementation

**Plan for:** `tasks/specs/artifact-store-v2.md`
**Date:** 2026-05-27
**Status:** draft
**Revision:** 2 — unified client architecture, metastore replaces JSONL

## Design principles

1. **Artifact writing is infrastructure, not just a tool.** Tools, extensions, and internal modules all use the same write path to the artifact store. Different buckets/paths, same client.
2. **Each layer imports one level down.** Triage imports logging. Logging imports artifact client. Findings tools call artifact client. Nothing skips layers.
3. **The metastore is the query engine.** All JSONL walk/scan/filter logic replaced by Postgres queries via the artifact service API. No local state files.
4. **JSONB metadata column** in the artifacts table holds type-specific fields (ADMIRALTY grades, log levels, session metadata, DuckDB state). Base schema stays uniform.

## Dependency graph (modules)

```
triage-workflow.ts  ──imports──▶  logging client (logging/jsonl.ts)
                                       │
                                       ▼
findings.ts (tools) ──imports──▶  artifact-client.ts  ──HTTP──▶  artifact-service
artifacts.ts (tools) ──imports──▶  artifact-client.ts
deep-research/store.ts ──imports──▶  artifact-client.ts
duckdb/session.ts ──imports──▶  artifact-client.ts
```

## Wave structure

Three waves. Each wave is independently testable and produces a mergeable increment.

---

## Wave 0: New infrastructure (zero impact on running system)

Build and validate all new containers independently. Nothing touches existing agents or Paperclip. At end of Wave 0, `docker compose up postgres minio artifact-service` brings up a working artifact store — agents don't use it yet.

### 0.1 — Init script: `scripts/init-artifact-db.sql`

**Creates:** postgres-init script that the Postgres container runs on first start.

- CREATE DATABASE artifact_store
- \connect artifact_store
- CREATE TABLE artifacts:
  ```sql
  id          TEXT PRIMARY KEY,          -- ULID
  filename    TEXT NOT NULL,
  artifact_type TEXT NOT NULL,           -- research, finding, log, dataset, code, brief, state, session
  mime_type   TEXT NOT NULL,
  agent_name  TEXT NOT NULL,
  run_id      TEXT,
  company_id  TEXT DEFAULT 'default',
  project_id  TEXT DEFAULT 'default',
  bucket      TEXT NOT NULL DEFAULT 'artifacts',  -- artifacts, logs, state
  s3_key      TEXT NOT NULL,
  content_hash TEXT NOT NULL,            -- sha256
  size_bytes  INTEGER NOT NULL,
  metadata    JSONB DEFAULT '{}',        -- type-specific: ADMIRALTY grades, log levels, session info, etc.
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  ```
- CHECK constraint on artifact_type
- Indexes: run_id, agent_name, artifact_type, content_hash, company_id+project_id, created_at DESC
- GIN index on metadata (for JSONB queries)
- CREATE USER artifact with password from env
- GRANT all on artifact_store to artifact user

**Verification:** `docker compose up postgres` → container healthy, table shows correct columns, indexes, and GIN index on metadata.

### 0.2 — Artifact service: `src/artifact-service/`

New Bun service. All files below.

#### 0.2a — `package.json`

Dependencies: `@aws-sdk/client-s3`, `ulid`. No HTTP framework (Bun.serve). No Postgres driver (Bun.sql).

#### 0.2b — `types.ts`

Shared types: ArtifactRecord (includes metadata: Record<string, unknown>), WriteRequest, WriteResponse, ListQuery, HealthResponse, ErrorResponse.

#### 0.2c — `uri.ts`

Two pure functions:
- `buildUri(record) → "artifact://..."` string
- `parseUri(uri) → { company_id, project_id, run_id, agent_name, artifact_type, ulid, filename }`

#### 0.2d — `storage.ts`

MinIO client wrapping `@aws-sdk/client-s3`:
- `putBlob(bucket, key, content, mime)` → void
- `getBlob(bucket, key)` → Buffer
- `checkConnection()` → boolean

All use env vars for endpoint and credentials. Supports multiple buckets (artifacts, logs, state).

#### 0.2e — `metastore.ts`

Postgres queries using `Bun.sql`:
- `insertArtifact(record)` → void
- `getArtifactById(id)` → ArtifactRecord | null
- `listArtifacts(filters)` → ArtifactRecord[]
- `updateMetadata(id, metadata)` → void (JSONB merge for add_source, state updates)
- `checkConnection()` → boolean

`listArtifacts` supports filtering on: agent_name, artifact_type, run_id, bucket, created_at range, and JSONB metadata fields (e.g. `metadata->>'style' = 'intelligence'`, `metadata->>'source_reliability' <= 'B'`).

#### 0.2f — `rbac.ts`

Loads `rbac.json` from disk on startup. One function:
- `canRead(agentName, s3Key) → boolean`
- `canWrite(agentName, s3Key) → boolean`
Glob matching per spec.

#### 0.2g — `routes.ts`

Five route handlers, each takes `(req: Request, agentName: string)`:
1. `handleWrite` — validate body (including optional metadata JSONB), generate ULID, compute SHA-256, putBlob to specified bucket, insertArtifact, return ref
2. `handleRead` — parse ULID from path, getArtifactById, rbac check, getBlob, return content + headers
3. `handleList` — parse query params (including metadata filters), listArtifacts, return JSON array
4. `handleUpdate` — PATCH metadata on existing artifact (JSONB merge), return updated record
5. `handleHealth` — checkConnection for both Postgres and MinIO, return status

All routes require `X-Agent-Name` header. Return structured errors with status codes on failure.

#### 0.2h — `server.ts`

`Bun.serve()` entry point:
- Parse PORT from env (default 8090)
- Route dispatch: method + path → routes handler
- Extract X-Agent-Name header, pass to routes
- 404 for unknown paths
- Global error handler returns 500 + error message

#### 0.2i — `Dockerfile`

```dockerfile
FROM oven/bun:alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
EXPOSE 8090
CMD ["bun", "run", "server.ts"]
```

### 0.3 — `src/agents/rbac.json`

Per-spec RBAC rules. Agents: ceo, researcher, data, writer, qa, coder. CEO and QA get `*` read. All agents get write to own namespace only. Read patterns enumerate upstream types each role needs.

### 0.4 — docker-compose.yml: new containers

Add four new services (no changes to existing):
- `postgres` — image: postgres:17-alpine, two DBs via init script, 256MB limit, healthcheck
- `minio` — image: minio/minio, two ports (9000 API, 9001 console), healthcheck
- `minio-init` — image: minio/mc, depends_on minio healthy, creates buckets (artifacts, logs, state), exits
- `artifact-service` — build from `src/artifact-service/`, depends_on postgres + minio healthy, healthcheck on :8090, 128MB limit

### 0.5 — `.env.example`: add new env vars

```bash
# Postgres (shared instance for Paperclip + artifact store)
POSTGRES_PASSWORD=paperclip-eval
ARTIFACT_DB_PASSWORD=artifact-eval

# MinIO (S3-compatible object store)
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin
```

### 0.6 — Verification

```bash
docker compose up -d postgres minio artifact-service
# All three healthy
curl http://localhost:8090/health
# → {"status":"ok","postgres":true,"minio":true}
curl -X POST http://localhost:8090/artifacts \
  -H "X-Agent-Name: researcher" \
  -H "Content-Type: application/json" \
  -d '{"filename":"test.md","content":"aGVsbG8=","type":"research","bucket":"artifacts","mime":"text/markdown","metadata":{"style":"general"}}'
# → {"ref":"artifact://...","id":"01...","size":5,"hash":"sha256:..."}
curl http://localhost:8090/artifacts/ULID -H "X-Agent-Name: researcher"
# → hello
docker compose down
```

---

## Wave 1: Wire agents to the artifact service

This is where existing components change. The shared artifact client becomes the single write path for all extensions. The old `./artifacts/` directory stays on disk for reference but nothing writes to it.

### 1.1 — Artifact client: `src/agents/extensions/artifact-client.ts`

**New shared module.** HTTP client for the artifact service. Imported by tools and internal modules alike.

```typescript
// Core API
write(params: { filename, content, type, bucket?, mime?, metadata? }) → { ref, id, size, hash }
read(id: string) → { content: Buffer, metadata: ArtifactRecord }
list(filters: { agent?, type?, bucket?, run_id?, since?, metadata? }) → ArtifactRecord[]
updateMetadata(id: string, metadata: Record<string, unknown>) → ArtifactRecord

// Convenience for JSONL-append patterns (logging, streaming findings)
append(params: { filename, line: string, type, bucket?, metadata? }) → { ref, id }

// Internal
agentName: string       // from AGENT_NAME env
serviceUrl: string      // from ARTIFACT_SERVICE_URL env
```

If `ARTIFACT_SERVICE_URL` is not set, all methods return clear error messages. No silent failures, no fallback to filesystem.

### 1.2 — Rewrite artifacts.ts (tools)

Replace `src/agents/extensions/artifacts.ts` (~354 lines → ~80 lines).

**Keeps:** Same 4 tool names, same parameter signatures, same get_template behavior.

**Drops:** All `node:fs` imports, sidecar logic, walkDir, resolvePath, ensureDir, path traversal guards.

**Adds:** Imports artifact-client.ts. Each tool is a thin wrapper.

Changes per tool:
- `write_artifact`: call `client.write({ bucket: "artifacts", ... })`, return `{ ref, id, size, hash }`.
- `read_artifact`: accept ULID or URI, call `client.read(id)`, return content + metadata.
- `list_artifacts`: call `client.list(filters)`, return formatted results.
- `get_template`: unchanged — still reads from `/app/templates/`.

### 1.3 — Rewrite logging/jsonl.ts

Replace `JsonlWriter` class (~36 lines → ~20 lines).

**Drops:** All `node:fs` imports, mkdirSync, appendFileSync.

**Adds:** Imports artifact-client.ts. Writes to `logs` bucket.

```typescript
class JsonlWriter {
  append(entry: LogEntry): void {
    // calls client.append({ bucket: "logs", filename: "run.log.jsonl", type: "log", line: JSON.stringify(entry) })
  }
}
```

Triage-workflow.ts unchanged — still calls `appendFileSync` via... no. Triage imports logging. Let me be precise:

### 1.4 — Update triage-workflow.ts logging

**Drops:** Direct `appendFileSync` / `mkdirSync` imports, hardcoded LOG_PATH.

**Adds:** Imports `JsonlWriter` from `logging/jsonl.ts`. Calls `writer.append(entry)` instead of raw filesystem writes.

The `logEvent()` helper becomes:
```typescript
const writer = new JsonlWriter(AGENT_NAME, true);
function logEvent(event: string, data: Record<string, unknown>) {
  writer.append({ ts: new Date().toISOString(), agent: AGENT_NAME, phase, event, ...data });
}
```

Triage never knows about artifacts or HTTP. It logs. Logging decides where that goes.

### 1.5 — Rewrite findings.ts

**Keeps:** Same 4 tool names (`record_finding`, `add_source`, `query_findings`, `get_finding`), same parameter schemas, same ADMIRALTY grading, same validation logic.

**Drops:** All imports from `workproduct/storage.ts` (`appendRecord`, `readRecords`, `findRecordById`, `updateRecord`, `scanAllAgents`).

**Adds:** Imports artifact-client.ts directly.

Changes per tool:
- `record_finding`: calls `client.write({ type: "finding", bucket: "artifacts", metadata: { style, admiralty_grade, corroboration, sources, entities, topic_tags, ... } })`. Finding data goes in metadata JSONB. Content is the claim text.
- `add_source`: calls `client.updateMetadata(id, { sources: [...existing, newSource] })`. Uses PATCH route.
- `query_findings`: calls `client.list({ type: "finding", agent, metadata filters })`. Metastore handles all filtering — no local JSONL scan.
- `get_finding`: calls `client.read(id)`. Returns full record including metadata.

### 1.6 — Rewrite deep-research/store.ts

**Drops:** All `node:fs` imports, direct mkdir/writeFile/appendFile calls.

**Adds:** Imports artifact-client.ts.

Changes:
- `initSession`: no-op (no directories to create, bucket already exists)
- `streamFinding`: calls `client.append({ bucket: "artifacts", type: "research-finding", ... })`. Index maintained by metastore, not local JSONL.
- `storePage`: calls `client.write({ bucket: "artifacts", type: "research-page", ... })`
- `writeSessionMeta`: calls `client.write({ bucket: "artifacts", type: "session-meta", metadata: { session_id, query, sub_queries, ... } })`
- `buildSessionSummary`: calls `client.write({ bucket: "artifacts", type: "research-summary", ... })`

### 1.7 — Rewrite duckdb/session.ts

**Drops:** All `node:fs` imports, direct readFileSync/writeFileSync.

**Adds:** Imports artifact-client.ts. State stored in `state` bucket.

Changes:
- `restoreState`: calls `client.list({ type: "duckdb-state", agent, bucket: "state" })` then `client.read(id)` to get SQL statements.
- `appendState`: calls `client.write({ bucket: "state", type: "duckdb-state", ... })` or `client.append(...)`.
- State file becomes an artifact like anything else.

### 1.8 — Update promptSnippet

In `artifacts.ts`, update promptSnippet to reference URIs instead of filesystem paths:

```
When sharing work with other agents or referencing artifacts:
- Write output using write_artifact. It returns an artifact reference (URI).
- Pass that URI in Paperclip issue comments or handoff messages. Never paste artifact content inline.
- To read another agent's work, call read_artifact with the URI you received.
- To discover available artifacts, call list_artifacts with filters.
- URIs look like: artifact://default/default/run123/researcher/research/01JHX_findings.md
- The downstream agent resolves the URI when it needs the content.
```

### 1.9 — docker-compose.yml: wire Paperclip to external Postgres

Add to Paperclip service:
```yaml
environment:
  DATABASE_URL: "postgres://paperclip:${POSTGRES_PASSWORD:-paperclip-eval}@postgres:5432/paperclip"
depends_on:
  postgres:
    condition: service_healthy
```

Remove `paperclip-data` named volume from Paperclip service.

### 1.10 — docker-compose.yml: wire agents to artifact service

For each agent (ceo, researcher, data, writer):
- Add `ARTIFACT_SERVICE_URL=http://artifact-service:8090` to environment
- Remove `- ./artifacts:/artifacts` bind mount
- Add `depends_on: artifact-service: condition: service_healthy`

### 1.11 — Update per-agent `.env` files

Add to each agent's `src/agents/{name}/.env`:
```bash
ARTIFACT_SERVICE_URL=http://artifact-service:8090
```

### 1.12 — Verification

```bash
docker compose down -v   # clean slate
docker compose up -d     # full stack
# All containers healthy

# Paperclip accessible at :3100, working on external Postgres
# Agent artifacts extension registers without errors
# Test artifact write/read/list round-trip via any agent's bridge
# Test finding record/query round-trip
# Test logging appears in logs bucket
# Test deep-research session writes to artifacts bucket

docker compose down
docker compose up -d     # second start — persistence works
```

---

## Wave 2: Documentation, tests, cleanup

Production-readiness pass. All docs updated, tests passing, setup.sh handles new env vars.

### 2.1 — Update setup.sh

Add to setup script:
1. Wait for Postgres healthcheck
2. Wait for MinIO healthcheck
3. Wait for artifact service healthcheck
4. For each agent: ensure `ARTIFACT_SERVICE_URL=http://artifact-service:8090` in agent `.env` file
5. Existing Paperclip setup unchanged

### 2.2 — Update CLAUDE.md

- Replace `./artifacts:/artifacts` bind mount references with artifact service architecture
- Document artifact-client.ts as shared infrastructure layer
- Document new containers: postgres, minio, minio-init, artifact-service
- Update port table (add 5432, 8090, 9000, 9001)
- Add new env vars to documentation
- Update artifact sharing section: agents pass `artifact://` URIs, not filesystem paths
- Document bucket layout: artifacts (work products), logs (structured logs), state (DuckDB, etc.)
- Note: `docker compose down -v` now destroys Postgres AND MinIO data — mention backup considerations

### 2.3 — Update ROADMAP.md

Mark "MinIO artifact storage (Option B)" as done. Remove the blocked-on lines. Reference this plan.

### 2.4 — Tests

- Unit tests: artifact-client.ts (mock HTTP, verify requests for write/read/list/append/updateMetadata)
- Unit tests: artifact service routes (mock MinIO and Postgres clients, test each route handler including PATCH)
- Integration test: `docker compose up` the new containers, exercise write → read → list → update-metadata against artifact service directly
- Integration test: findings round-trip (record_finding → query_findings → get_finding → add_source)
- Integration test: logging round-trip (log event → verify in logs bucket)
- E2E test: full stack, agent writes artifact, another agent reads it, verify URI-based handoff
- Update existing test files that reference filesystem paths to use artifact URIs

### 2.5 — Cleanup

- Delete `src/agents/extensions/workproduct/storage.ts` (replaced by artifact-client + metastore)
- Keep `workproduct/ulid.ts` (still used for client-side ID generation)
- Keep `workproduct/validate.ts` (validation logic is domain, not storage)
- Remove `./artifacts` directory from git tracking (add to .gitignore if needed)
- Remove `paperclip-data` named volume declaration from docker-compose.yml
- Delete role-guard.ts LOG_PATH filesystem code (role-guard is being deprecated, but if retained, it imports logging)

---

## Dependency graph (waves)

```
Wave 0 ──────────────────────────────────────────────────────────────
│
├── 0.1 init script (with JSONB + GIN) ┐
│                                       ├── 0.4 docker-compose: new containers
├── 0.2 artifact service ──────────────┤       │
├── 0.3 rbac.json ─────────────────────┘       │
│                                               │
├── 0.5 .env.example ──────────────────────────┤
│                                               │
└── 0.6 verification ◄─────────────────────────┘
         │
         ▼
Wave 1 ──────────────────────────────────────────────────────────────
│
├── 1.1 artifact-client.ts (shared module) ◄── everything depends on this
│       │
│       ├── 1.2 rewrite artifacts.ts (tools)
│       ├── 1.3 rewrite logging/jsonl.ts
│       │       └── 1.4 update triage-workflow.ts (imports logging)
│       ├── 1.5 rewrite findings.ts (imports client directly)
│       ├── 1.6 rewrite deep-research/store.ts
│       └── 1.7 rewrite duckdb/session.ts
│
├── 1.8 update promptSnippet
├── 1.9 wire Paperclip DB
├── 1.10 wire agents to artifact service
├── 1.11 per-agent .env
│
└── 1.12 verification (needs all of above)
         │
         ▼
Wave 2 ──────────────────────────────────────────────────────────────
│
├── 2.1 setup.sh
├── 2.2 CLAUDE.md
├── 2.3 ROADMAP.md
├── 2.4 tests
├── 2.5 cleanup (delete workproduct/storage.ts, etc.)
│
└── Final: docker compose down -v && docker compose up -d
```

## What gets deleted

| File | Why |
|------|-----|
| `workproduct/storage.ts` | Replaced by artifact-client.ts + metastore queries |
| All `node:fs` write code in logging/jsonl.ts | Replaced by artifact-client.ts |
| All `node:fs` write code in deep-research/store.ts | Replaced by artifact-client.ts |
| All `node:fs` write code in duckdb/session.ts | Replaced by artifact-client.ts |
| Direct `appendFileSync` in triage-workflow.ts | Replaced by logging client import |
| Sidecar `.meta.json` logic in artifacts.ts | Replaced by metastore JSONB |
| `walkDir`, `scanAllAgents` patterns | Replaced by metastore list queries |

## What survives

| File | Why |
|------|-----|
| `workproduct/ulid.ts` | Client-side ULID generation, no storage dependency |
| `workproduct/validate.ts` | Domain validation logic, no storage dependency |
| `get_template` tool | Reads from `/app/templates/`, not artifacts — stays filesystem |
| `duckdb/safety.ts` | Path allowlist for DuckDB queries — needs update to reference artifact URIs |

## Risk items

1. **Paperclip on external Postgres** — first time running this config. Revert: remove DATABASE_URL and restore paperclip-data volume (2-line change in docker-compose.yml).

2. **Bun.sql maturity** — built-in since Bun 1.2. Queries are simple. If it fails, swap metastore.ts internals to `postgres` npm package with no other changes.

3. **Extension dep on artifact service** — if service is down, all artifact tools AND internal logging/findings fail. Mitigated by healthcheck + restart policy. artifact-client.ts must return clear "artifact service unavailable" errors.

4. **MinIO data persistence** — minio-data volume is named, survives restarts. `docker compose down -v` destroys it. Document this.

5. **JSONB query performance** — GIN index on metadata covers most queries. If ADMIRALTY filtering is slow, add targeted expression indexes later. Not a risk at eval scale.

6. **MinIO open-source archived (April 2026)** — still functional, S3 API is stable. If long-term maintenance needed, swap to SeaweedFS, Garage, or RustFS. The S3 API abstraction in storage.ts isolates this — swap is contained to one file.

## Files changed (summary)

| File | Wave | Action |
|------|------|--------|
| `scripts/init-artifact-db.sql` | 0.1 | Create |
| `src/artifact-service/package.json` | 0.2a | Create |
| `src/artifact-service/types.ts` | 0.2b | Create |
| `src/artifact-service/uri.ts` | 0.2c | Create |
| `src/artifact-service/storage.ts` | 0.2d | Create |
| `src/artifact-service/metastore.ts` | 0.2e | Create |
| `src/artifact-service/rbac.ts` | 0.2f | Create |
| `src/artifact-service/routes.ts` | 0.2g | Create |
| `src/artifact-service/server.ts` | 0.2h | Create |
| `src/artifact-service/Dockerfile` | 0.2i | Create |
| `src/artifact-service/bun.lock` | 0.2a | Create (generated) |
| `src/agents/rbac.json` | 0.3 | Create |
| `docker-compose.yml` | 0.4, 1.9, 1.10 | Edit |
| `.env.example` | 0.5 | Edit |
| `src/agents/extensions/artifact-client.ts` | 1.1 | Create |
| `src/agents/extensions/artifacts.ts` | 1.2, 1.8 | Rewrite |
| `src/agents/extensions/logging/jsonl.ts` | 1.3 | Rewrite |
| `src/agents/extensions/triage-workflow.ts` | 1.4 | Edit |
| `src/agents/extensions/findings.ts` | 1.5 | Rewrite |
| `src/agents/extensions/deep-research/store.ts` | 1.6 | Rewrite |
| `src/agents/extensions/duckdb/session.ts` | 1.7 | Rewrite |
| `src/agents/ceo/.env` | 1.11 | Edit |
| `src/agents/researcher/.env` | 1.11 | Edit |
| `src/agents/data/.env` | 1.11 | Edit |
| `src/agents/writer/.env` | 1.11 | Edit |
| `src/agents/setup.sh` | 2.1 | Edit |
| `CLAUDE.md` | 2.2 | Edit |
| `ROADMAP.md` | 2.3 | Edit |
| `tests/artifacts/` | 2.4 | Create/update |
| `src/agents/extensions/workproduct/storage.ts` | 2.5 | Delete |
| `.gitignore` | 2.5 | Edit (optional) |
