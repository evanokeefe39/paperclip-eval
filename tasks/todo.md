# Artifact Store v2: Postgres + MinIO + Filestash

Spec: `tasks/specs/artifact-store-v2.md`

## Infrastructure

- [ ] Write `scripts/init-artifact-db.sql` (CREATE DATABASE + schema)
- [ ] Add postgres container to docker-compose.yml (postgres:17-alpine, healthcheck, init script mount)
- [ ] Add minio container to docker-compose.yml (minio/minio, healthcheck, named volume)
- [ ] Add minio-init container (one-shot mc bucket creation)
- [ ] Add filestash container to docker-compose.yml (machines/filestash, port 8334)
- [ ] Migrate Paperclip to external Postgres (DATABASE_URL env var, remove paperclip-data volume)
- [ ] Remove `./artifacts:/artifacts` bind mount from all agents
- [ ] Add new volumes: postgres-data, minio-data
- [ ] Update `.env.example` with Postgres, MinIO, artifact store vars
- [ ] Verify `docker compose up -d` brings up full stack clean

## setup.sh

- [ ] Add Postgres health wait
- [ ] Add MinIO health wait
- [ ] Create MinIO service accounts per agent with IAM policies
- [ ] Write MINIO_ACCESS_KEY, MINIO_SECRET_KEY, ARTIFACT_DB_URL to agent .env files
- [ ] Test idempotent re-run

## Extension Rewrite

- [ ] Add npm deps to Dockerfile: @aws-sdk/client-s3, pg, ulid
- [ ] Write `src/agents/rbac.json` (per-agent read/write/delete rules)
- [ ] Rewrite artifacts.ts: MinIO backend for blobs
- [ ] Rewrite artifacts.ts: Postgres backend for metadata
- [ ] ULID generation for artifact IDs
- [ ] SHA-256 content hashing + dedup check
- [ ] `artifact://` URI scheme in write_artifact return
- [ ] `read_artifact` resolves URIs + checks RBAC
- [ ] `read_artifact` legacy path support with deprecation warning
- [ ] `list_artifacts` queries Postgres instead of filesystem walk
- [ ] `get_template` unchanged
- [ ] Updated promptSnippet (URIs instead of paths)
- [ ] RBAC enforcement on read_artifact and list_artifacts

## Validation

- [ ] Paperclip starts correctly on external Postgres
- [ ] Agent can write_artifact and get back artifact:// URI
- [ ] Agent can read_artifact by URI
- [ ] Agent can read_artifact by legacy path (with deprecation warning)
- [ ] list_artifacts returns URI-based results from Postgres
- [ ] RBAC blocks unauthorized reads
- [ ] Content dedup works (same content returns existing ref)
- [ ] Filestash browses MinIO bucket, renders markdown/JSON/CSV
- [ ] MinIO console accessible at :9001
- [ ] Update existing tests for v2 behavior

## Docs

- [ ] Update CLAUDE.md repo layout and key context
- [ ] Update ROADMAP.md (MinIO no longer "planned", mark as done)
- [ ] Update ext-artifacts.md spec status or mark superseded

---

# Prior: E2E / Integration Test Suite

(Moved to bottom — prior work, mostly complete)

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
