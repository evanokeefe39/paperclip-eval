# Plan: Artifact Store v2 Implementation

**Plan for:** `tasks/specs/artifact-store-v2.md`
**Date:** 2026-05-27
**Status:** draft

## Wave structure

Three waves. Each wave is independently testable and produces a mergeable increment. No wave depends on future waves. Waves are sequential within themselves but presented as parallelizable where possible.

---

## Wave 0: New infrastructure (zero impact on running system)

Build and validate all new containers independently. Nothing touches existing agents or Paperclip. At end of Wave 0, `docker compose up postgres minio artifact-service` brings up a working artifact store — agents just don't use it yet.

### 0.1 — Init script: `scripts/init-artifact-db.sql`

**Creates:** postgres-init script that the Postgres container runs on first start.

- CREATE DATABASE artifact_store
- \connect artifact_store
- CREATE TABLE artifacts (per spec schema — ULID PK, CHECK constraint on artifact_type, indexes on run_id, agent_name, artifact_type, content_hash, company_id+project_id, created_at DESC)
- CREATE USER artifact with password from env
- GRANT all on artifact_store to artifact user

**Verification:** `docker compose up postgres` → container healthy, `docker compose exec postgres psql -U paperclip -d artifact_store -c "\dt"` shows artifacts table with correct columns and indexes.

### 0.2 — Artifact service: `src/artifact-service/`

New Bun service. All files below.

#### 0.2a — `package.json`

Dependencies: `@aws-sdk/client-s3`, `ulid`. No HTTP framework (Bun.serve). No Postgres driver (Bun.sql).

#### 0.2b — `types.ts`

Shared types: ArtifactRecord, WriteRequest, WriteResponse, ListQuery, HealthResponse, ErrorResponse.

#### 0.2c — `uri.ts`

Two pure functions:
- `buildUri(record) → "artifact://..."` string
- `parseUri(uri) → { company_id, project_id, run_id, agent_name, artifact_type, ulid, filename }`

#### 0.2d — `storage.ts`

MinIO client wrapping `@aws-sdk/client-s3`:
- `putBlob(bucket, key, content, mime)` → void
- `getBlob(bucket, key)` → Buffer
- `checkConnection()` → boolean
All use env vars for endpoint and credentials.

#### 0.2e — `metastore.ts`

Postgres queries using `Bun.sql`:
- `insertArtifact(record)` → void
- `getArtifactById(id)` → ArtifactRecord | null
- `listArtifacts(filters)` → ArtifactRecord[]
- `checkConnection()` → boolean

#### 0.2f — `rbac.ts`

Loads `rbac.json` from disk on startup. One function:
- `canRead(agentName, s3Key) → boolean`
- `canWrite(agentName, s3Key) → boolean`
Glob matching per spec.

#### 0.2g — `routes.ts`

Four route handlers, each takes `(req: Request, agentName: string)`:
1. `handleWrite` — validate body, generate ULID, compute SHA-256, putBlob, insertArtifact, return ref
2. `handleRead` — parse ULID from path, getArtifactById, rbac check, getBlob, return content + headers
3. `handleList` — parse query params, listArtifacts, return JSON array
4. `handleHealth` — checkConnection for both Postgres and MinIO, return status

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
- `minio-init` — image: minio/mc, depends_on minio healthy, creates `artifacts` bucket, exits
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
  -d '{"filename":"test.md","content":"aGVsbG8=","type":"research","mime":"text/markdown"}'
# → {"ref":"artifact://...","id":"01...","size":5,"hash":"sha256:..."}
curl http://localhost:8090/artifacts/OLID -H "X-Agent-Name: researcher"
# → hello
docker compose down
```

---

## Wave 1: Wire agents to the artifact service

This is where existing components change. Paperclip moves to external Postgres, agents drop the bind mount and talk to the artifact service over HTTP. The old `./artifacts/` directory stays on disk for reference but nothing writes to it.

### 1.1 — Rewrite artifacts.ts (extension)

Replace `src/agents/extensions/artifacts.ts` (~354 lines → ~100 lines).

**Keeps:** Same 4 tool names, same parameter signatures, same get_template behavior.

**Drops:** All `node:fs` imports, sidecar logic, walkDir, resolvePath, ensureDir, path traversal guards.

**Adds:** HTTP client calling artifact service (same pattern as `skills/client.ts`).

Changes per tool:
- `write_artifact`: serialize params, POST to `{ARTIFACT_SERVICE_URL}/artifacts`, return `{ ref, id, size, hash }` instead of `{ path, metadata_path, size_bytes }`.
- `read_artifact`: send ULID (extracted from URI or raw ID) to GET `{ARTIFACT_SERVICE_URL}/artifacts/:id`, return content + metadata.
- `list_artifacts`: send query params to GET `{ARTIFACT_SERVICE_URL}/artifacts`, return formatted results.
- `get_template`: unchanged — still reads from `/app/templates/`.

**Error handling:** If ARTIFACT_SERVICE_URL is not set, tools return clear error messages rather than failing silently. If service returns non-2xx, surface the status + body.

### 1.2 — Update promptSnippet

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

### 1.3 — docker-compose.yml: wire Paperclip to external Postgres

Add to Paperclip service:
```yaml
environment:
  DATABASE_URL: "postgres://paperclip:${POSTGRES_PASSWORD:-paperclip-eval}@postgres:5432/paperclip"
depends_on:
  postgres:
    condition: service_healthy
```

Remove `paperclip-data` named volume from Paperclip service (embedded Postgres auto-disables when DATABASE_URL is set).

### 1.4 — docker-compose.yml: wire agents to artifact service

For each agent (ceo, researcher, data, writer):
- Add `ARTIFACT_SERVICE_URL=http://artifact-service:8090` to environment
- Remove `- ./artifacts:/artifacts` bind mount
- Add `depends_on: artifact-service: condition: service_healthy`

### 1.5 — Update per-agent `.env` files

Add to each agent's `src/agents/{name}/.env`:
```bash
ARTIFACT_SERVICE_URL=http://artifact-service:8090
```

### 1.6 — Verification

```bash
docker compose down -v   # clean slate
docker compose up -d     # full stack
# All containers healthy

# Paperclip accessible at :3100, working on external Postgres
# Agent artifacts extension registers without errors
# Test artifact write/read/list round-trip via any agent's bridge

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
4. For each agent: ensure `ARTIFACT_SERVICE_URL=http://artifact-service:8090` in agent `.env` file (idempotent — don't duplicate)
5. Existing Paperclip setup unchanged

### 2.2 — Update CLAUDE.md

- Replace `./artifacts:/artifacts` bind mount references with artifact service architecture
- Document new containers: postgres, minio, minio-init, artifact-service
- Update port table (add 5432, 8090, 9000, 9001)
- Add new env vars to documentation
- Update artifact sharing section: agents pass `artifact://` URIs, not filesystem paths
- Note: `docker compose down -v` now destroys Postgres AND MinIO data — mention backup considerations

### 2.3 — Update ROADMAP.md

Mark "MinIO artifact storage (Option B)" as done. Remove the blocked-on lines. Reference this plan.

### 2.4 — Tests

- Unit tests: artifact service routes (mock MinIO and Postgres clients, test each route handler)
- Integration test: `docker compose up` the new containers, exercise write → read → list against artifact service directly
- E2E test: full stack, agent writes artifact, another agent reads it, verify URI-based handoff
- Update existing test files that reference filesystem paths to use artifact URIs

### 2.5 — Cleanup

- Remove `./artifacts` directory from git tracking (add to .gitignore if needed) — old data stays on disk for reference, not version controlled
- Remove `paperclip-data` named volume declaration from docker-compose.yml (no longer needed)

---

## Dependency graph

```
Wave 0 ──────────────────────────────────────────────────────────────
│
├── 0.1 init script ──────┐
│                          ├── 0.4 docker-compose: new containers
├── 0.2 artifact service ─┤       │
├── 0.3 rbac.json ────────┘       │
│                                  │
├── 0.5 .env.example ─────────────┤
│                                  │
└── 0.6 verification ◄────────────┘
         │
         ▼
Wave 1 ──────────────────────────────────────────────────────────────
│
├── 1.1 rewrite artifacts.ts ──┐
├── 1.2 update promptSnippet ──┤
├── 1.3 wire Paperclip DB ─────┤  All parallel within wave
├── 1.4 wire agents ───────────┤  No dependency between tasks
├── 1.5 per-agent .env ────────┘
│
└── 1.6 verification (needs all of above)
         │
         ▼
Wave 2 ──────────────────────────────────────────────────────────────
│
├── 2.1 setup.sh ───────┐
├── 2.2 CLAUDE.md ──────┤
├── 2.3 ROADMAP.md ─────┤  All parallel
├── 2.4 tests ──────────┤
├── 2.5 cleanup ────────┘
│
└── Final: docker compose down -v && docker compose up -d (clean slate verify)
```

## Risk items

1. **Paperclip on external Postgres** — first time running this config. If it fails, revert by removing DATABASE_URL and restoring paperclip-data volume. This is a 2-line revert in docker-compose.yml.

2. **Bun.sql maturity** — built-in since Bun 1.2. Queries are simple INSERT/SELECT/WHERE. Risk is low. If it fails, the metastore.ts interface isolates the change — swap to `postgres` npm package with no other changes.

3. **Extension dep on artifact service** — if service is down, all artifact tools fail. Mitigated by healthcheck + restart policy. Extension must return clear "artifact service unavailable" error.

4. **MinIO data persistence** — minio-data volume is named, survives restarts. But `docker compose down -v` destroys it. Document this. The old `./artifacts/` host directory serves as pre-existing reference data.

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
| `docker-compose.yml` | 0.4, 1.3, 1.4 | Edit |
| `.env.example` | 0.5 | Edit |
| `src/agents/extensions/artifacts.ts` | 1.1, 1.2 | Rewrite |
| `src/agents/ceo/.env` | 1.5 | Edit |
| `src/agents/researcher/.env` | 1.5 | Edit |
| `src/agents/data/.env` | 1.5 | Edit |
| `src/agents/writer/.env` | 1.5 | Edit |
| `src/agents/setup.sh` | 2.1 | Edit |
| `CLAUDE.md` | 2.2 | Edit |
| `ROADMAP.md` | 2.3 | Edit |
| `tests/artifacts/` | 2.4 | Create/update |
| `.gitignore` | 2.5 | Edit (optional) |
