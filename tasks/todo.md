# Artifact Store v2: Bun Service + Postgres + MinIO

Spec: `tasks/specs/artifact-store-v2.md`

## Phase 1: Schema + Artifact Service (no integration yet)

Build the service standalone. Testable in isolation before touching compose or agents.

- [ ] 1.1 Write `scripts/init-artifact-db.sql` — CREATE DATABASE artifact_store, single artifacts table, CHECK constraint for types, indexes
- [ ] 1.2 Scaffold `src/artifact-service/` directory: package.json, tsconfig, Dockerfile
- [ ] 1.3 `src/artifact-service/types.ts` — shared types (ArtifactRecord, ArtifactRef, WriteRequest, RBAC rules)
- [ ] 1.4 `src/artifact-service/uri.ts` — artifact:// URI parse and format
- [ ] 1.5 `src/artifact-service/metastore.ts` — Postgres queries via Bun.sql (insert, getById, list with filters)
- [ ] 1.6 `src/artifact-service/storage.ts` — MinIO S3 client (putObject, getObject)
- [ ] 1.7 `src/artifact-service/rbac.ts` — glob matcher against rbac.json rules, takes agent name + s3 key path
- [ ] 1.8 `src/artifact-service/routes.ts` — route handlers: POST /artifacts, GET /artifacts/:id, GET /artifacts, GET /health
- [ ] 1.9 `src/artifact-service/server.ts` — Bun.serve() entry, route dispatch, X-Agent-Name header extraction
- [ ] 1.10 `src/agents/rbac.json` — per-agent read/write rules (no delete)
- [ ] 1.11 Verify service starts and /health returns ok against local Postgres + MinIO

## Phase 2: Docker Compose Integration

Wire service into the stack. Paperclip on external Postgres. Agents point at service.

- [ ] 2.1 Add postgres container (postgres:17-alpine, healthcheck, init script mount, named volume)
- [ ] 2.2 Add minio container (minio/minio, curl healthcheck, named volume)
- [ ] 2.3 Add minio-init container (one-shot mc bucket creation, no restart)
- [ ] 2.4 Add artifact-service container (build from src/artifact-service/, healthcheck on /health)
- [ ] 2.5 Migrate Paperclip to external Postgres (DATABASE_URL env var, remove paperclip-data volume)
- [ ] 2.6 Remove `./artifacts:/artifacts` bind mount from all agents
- [ ] 2.7 Add ARTIFACT_SERVICE_URL to each agent's environment
- [ ] 2.8 Add depends_on artifact-service (service_healthy) to each agent
- [ ] 2.9 Add new named volumes: postgres-data, minio-data
- [ ] 2.10 Update `.env.example` with POSTGRES_PASSWORD, ARTIFACT_DB_PASSWORD, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD
- [ ] 2.11 Verify `docker compose up -d` from clean state — all containers healthy

## Phase 3: Extension Rewrite

artifacts.ts becomes thin HTTP client. No new deps in agent containers.

- [ ] 3.1 Rewrite `src/agents/extensions/artifacts.ts` as HTTP client calling ARTIFACT_SERVICE_URL
- [ ] 3.2 write_artifact: serialize params, POST to service, return { ref, id, size, hash }
- [ ] 3.3 read_artifact: send URI to GET /artifacts/:id, return content + metadata
- [ ] 3.4 list_artifacts: send filters to GET /artifacts, format results with URIs
- [ ] 3.5 get_template: no change (local filesystem read)
- [ ] 3.6 Clear error message when artifact service unreachable
- [ ] 3.7 Update promptSnippet in all AGENTS.md files (URIs instead of paths)

## Phase 4: setup.sh

- [ ] 4.1 Add Postgres health wait (same pattern as Paperclip wait)
- [ ] 4.2 Add MinIO health wait
- [ ] 4.3 Add artifact service health wait
- [ ] 4.4 Write ARTIFACT_SERVICE_URL to each agent's .env file
- [ ] 4.5 Remove old MinIO credential logic (no per-agent service accounts)
- [ ] 4.6 Test idempotent re-run

## Phase 5: Validation

- [ ] 5.1 Paperclip starts correctly on external Postgres (UI loads, agents listed)
- [ ] 5.2 Agent calls write_artifact, gets artifact:// URI back
- [ ] 5.3 Agent calls read_artifact with URI, gets content
- [ ] 5.4 list_artifacts returns URI-based results
- [ ] 5.5 RBAC blocks unauthorized reads (researcher can't read writer namespace)
- [ ] 5.6 MinIO Console at :9001 shows uploaded artifacts in bucket
- [ ] 5.7 Cross-agent flow: researcher writes artifact, writer reads via URI from issue comment
- [ ] 5.8 Stack survives `docker compose down && docker compose up -d` (data persists in volumes)

## Phase 6: Tests + Docs

- [ ] 6.1 Unit tests for artifact service (routes, metastore, rbac, uri parsing)
- [ ] 6.2 Integration test: service against real Postgres + MinIO (docker compose subset)
- [ ] 6.3 Update existing artifact extension tests for v2 HTTP client behavior
- [ ] 6.4 Update CLAUDE.md repo layout and key context
- [ ] 6.5 Update ROADMAP.md — mark MinIO as implemented
- [ ] 6.6 Mark ext-artifacts.md as superseded by artifact-store-v2.md

---

## Implementation Notes

**Build order matters.** Phase 1 is fully isolated — service can be developed and tested without touching any existing containers or code. Phase 2 is the risky step (Paperclip on external Postgres, compose restructure). Phase 3 is safe — extension rewrite only affects agent tool behavior. Phase 4 is mechanical. Phase 5 is validation. Phase 6 is cleanup.

**Rollback plan.** If Phase 2 fails (Paperclip rejects external Postgres), revert compose changes and restore paperclip-data volume. Service and extension work are independent — nothing wasted.

**Risk concentration.** Phase 2.5 (Paperclip on external Postgres) is the highest-risk item. Test this early. If it doesn't work, the rest of the plan still holds — just keep Paperclip on embedded Postgres and add a second Postgres instance for artifact_store only.

---

# Prior: E2E / Integration Test Suite

(Prior work, mostly complete)

## Status
- [x] Plan written
- [x] helpers.sh
- [x] e2e-1-registration.sh
- [x] e2e-2-invocation.sh
- [x] e2e-3-cross-agent.sh
- [x] e2e-4-charlimit.sh
- [x] run-e2e.sh
- [ ] Playwright MCP configured
- [ ] Run tests against live stack
- [ ] Add Playwright browser-level tests
