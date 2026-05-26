# Artifact Store v2: Bun Service + Postgres + MinIO

## Status

Spec. Supersedes ext-artifacts.md (v1) for storage backend. Tool interface preserved.

## Intent

Replace the bind-mounted `./artifacts` directory and `.meta.json` sidecar files with a proper artifact store: a Bun-based artifact service exposing REST routes, MinIO for blob storage, Postgres for metadata. Agents interact with the service over HTTP — no direct database or S3 connections from extensions.

This is "Option B" from ROADMAP.md, adapted to eval-stage constraints.

## Context Package

### Relevant existing code

- `src/agents/extensions/artifacts.ts` — v1 extension, 354 lines. Registers 4 tools: `write_artifact`, `read_artifact`, `list_artifacts`, `get_template`. Uses `node:fs` to read/write files on a shared Docker volume. Metadata stored as `.meta.json` sidecar files alongside artifacts. Path traversal guards, agent namespace isolation on writes, open reads.
- `docker-compose.yml` — current stack: Paperclip (embedded Postgres), Aspire dashboard, 4 agent containers (ceo, researcher, data, writer). Artifacts shared via `./artifacts:/artifacts` bind mount.
- `.env.example` — shared provider API keys, bridge defaults, Discord config. No database or object store config yet.
- `tasks/specs/ext-artifacts.md` — v1 spec. Documents tool interface, sidecar schema, path conventions, security model. Tool signatures are the stable API.
- `src/agents/skills/client.ts` — Paperclip API client pattern (session-cookie auth with caching). Reference for how extensions talk to services over HTTP.

### Architectural constraints

- Agents run Pi extensions in Node containers. Extensions cannot install arbitrary deps into the Pi runtime. HTTP client calls are the clean boundary.
- Bridge is zero-dep Node.js. Extension layer stays thin.
- Paperclip supports `DATABASE_URL` env var for external Postgres. Setting it disables the embedded instance.
- Eval stage — optimize for debuggability and simplicity. Named volumes over managed services. Single-node everything.

### Prior decisions

- Pass-by-reference: agents exchange artifact URIs, never inline content.
- Agent namespace isolation: agents write only to their own namespace. Reads are configurable via RBAC.
- Workspace vs artifacts separation: `/workspace` is ephemeral per-agent scratch. Artifact store is durable shared storage. These remain distinct.

### Anti-patterns to avoid

- No ORM. Raw SQL with parameterized queries via `Bun.sql`.
- No centralized artifact service that tries to do everything. Keep routes thin — validate, store, respond.
- No migration framework. Schema applied via init script. `CREATE TABLE IF NOT EXISTS` for eval.
- No speculative features. Tables, routes, and code exist only when something reads/writes them.

## Architecture

### Container topology

```
┌────────────────────────────────────────────────────────────┐
│  docker-compose                                             │
│                                                             │
│  ┌──────────┐   DATABASE_URL    ┌──────────┐               │
│  │ Paperclip│──────────────────▶│ Postgres │               │
│  └──────────┘                   │ (2 DBs)  │               │
│                                 │paperclip │               │
│  ┌──────────┐                   │art_store │               │
│  │ Aspire   │                   └──────────┘               │
│  │Dashboard │                        ▲                     │
│  └──────────┘                        │ Bun.sql             │
│                                 ┌──────────┐               │
│  ┌──────────┐    HTTP :8090     │ Artifact │  S3 API       │
│  │   CEO    │──── ext ────────▶│ Service  │─────────┐     │
│  ├──────────┤                   │ (Bun)    │         │     │
│  │Researcher│──── ext ────────▶│          │    ┌────▼───┐ │
│  ├──────────┤                   └──────────┘    │ MinIO  │ │
│  │  Data    │──── ext ─────────────────────────▶│:9000 API│ │
│  ├──────────┤                                   │:9001 UI│ │
│  │ Writer   │──── ext ─────────────────────────▶└────────┘ │
│  └──────────┘                                              │
│                                                             │
│  Each agent has:                                            │
│    ARTIFACT_SERVICE_URL=http://artifact-service:8090        │
│    AGENT_NAME (unchanged)                                   │
│    /workspace (ephemeral, named volume, unchanged)          │
│                                                             │
└────────────────────────────────────────────────────────────┘
```

Key change from v1 spec: agents no longer connect to Postgres or MinIO directly. The artifact service owns all storage interactions. Extensions are thin HTTP clients.

### New containers

#### postgres

```yaml
postgres:
  image: postgres:17-alpine
  restart: unless-stopped
  ports:
    - "5432:5432"
  environment:
    POSTGRES_USER: paperclip
    POSTGRES_PASSWORD: "${POSTGRES_PASSWORD:-paperclip-eval}"
    POSTGRES_DB: paperclip
  volumes:
    - postgres-data:/var/lib/postgresql/data
    - ./scripts/init-artifact-db.sql:/docker-entrypoint-initdb.d/01-artifact-db.sql
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U paperclip"]
    interval: 5s
    timeout: 3s
    start_period: 10s
    retries: 5
  deploy:
    resources:
      limits:
        memory: 256M
```

Two databases in one instance:
- `paperclip` — Paperclip's own schema, managed by Paperclip migrations
- `artifact_store` — our schema, created by init script

#### minio

```yaml
minio:
  image: minio/minio
  restart: unless-stopped
  command: server /data --console-address ":9001"
  ports:
    - "9000:9000"
    - "9001:9001"
  environment:
    MINIO_ROOT_USER: "${MINIO_ROOT_USER:-minioadmin}"
    MINIO_ROOT_PASSWORD: "${MINIO_ROOT_PASSWORD:-minioadmin}"
  volumes:
    - minio-data:/data
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
    interval: 5s
    timeout: 3s
    start_period: 10s
    retries: 5
  deploy:
    resources:
      limits:
        memory: 256M
```

Browse artifacts via MinIO Console at :9001. No separate file browser needed.

#### minio-init

```yaml
minio-init:
  image: minio/mc
  depends_on:
    minio:
      condition: service_healthy
  entrypoint: >
    /bin/sh -c "
    mc alias set store http://minio:9000 $${MINIO_ROOT_USER} $${MINIO_ROOT_PASSWORD};
    mc mb --ignore-existing store/artifacts;
    mc anonymous set none store/artifacts;
    "
  environment:
    MINIO_ROOT_USER: "${MINIO_ROOT_USER:-minioadmin}"
    MINIO_ROOT_PASSWORD: "${MINIO_ROOT_PASSWORD:-minioadmin}"
```

Creates `artifacts` bucket. Exits after. No restart policy.

#### artifact-service

```yaml
artifact-service:
  build:
    context: ./src/artifact-service
    dockerfile: Dockerfile
  restart: unless-stopped
  ports:
    - "8090:8090"
  environment:
    PORT: 8090
    DATABASE_URL: "postgres://artifact:${ARTIFACT_DB_PASSWORD:-artifact-eval}@postgres:5432/artifact_store"
    MINIO_ENDPOINT: "http://minio:9000"
    MINIO_ACCESS_KEY: "${MINIO_ROOT_USER:-minioadmin}"
    MINIO_SECRET_KEY: "${MINIO_ROOT_PASSWORD:-minioadmin}"
    MINIO_BUCKET: "artifacts"
  depends_on:
    postgres:
      condition: service_healthy
    minio:
      condition: service_healthy
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:8090/health"]
    interval: 5s
    timeout: 3s
    start_period: 5s
    retries: 3
  deploy:
    resources:
      limits:
        memory: 128M
```

Dockerfile:

```dockerfile
FROM oven/bun:alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
CMD ["bun", "run", "server.ts"]
```

Image size: ~60MB total. `oven/bun:alpine` base (~55MB) + `@aws-sdk/client-s3` + `ulid`.

### Changed containers

#### paperclip

```yaml
paperclip:
  # ... existing config ...
  environment:
    DATABASE_URL: "postgres://paperclip:${POSTGRES_PASSWORD:-paperclip-eval}@postgres:5432/paperclip"
  depends_on:
    postgres:
      condition: service_healthy
```

Remove `paperclip-data` volume. Embedded Postgres auto-disables when DATABASE_URL is set.

#### all agents

```yaml
# remove from each agent:
#   - ./artifacts:/artifacts

# add to each agent's environment:
#   ARTIFACT_SERVICE_URL=http://artifact-service:8090

# add dependency:
#   depends_on:
#     artifact-service:
#       condition: service_healthy
```

Agents no longer need `ARTIFACT_DB_URL`, `MINIO_ENDPOINT`, or MinIO credentials. Single env var points to the service.

### Removed

- `./artifacts:/artifacts` bind mount from all agents
- `./artifacts` host directory (no longer source of truth)
- `.meta.json` sidecar files (metadata moves to Postgres)
- `paperclip-data` named volume (Paperclip now uses shared Postgres)
- Direct Postgres/MinIO connections from agent containers
- Filestash container (MinIO Console at :9001 covers browsing)

### Kept unchanged

- Per-agent workspace named volumes (`ceo-workspace:/workspace`, etc.)
- Aspire dashboard container
- Template files at `/app/templates/` (COPYed into image)
- `get_template` tool (reads from local filesystem)

## Identifiers

### ULID only

All artifact IDs are ULIDs — 26-character Crockford Base32, millisecond-precision, time-sortable, case-insensitive.

```
01JHX3YMKD7Q2R1BFPWG5E9T4N
```

Used as:
- Primary key in Postgres (`TEXT NOT NULL PRIMARY KEY`)
- S3 key prefix within the type directory
- External reference in `artifact://` URIs

Library: `ulid` npm package (single dep, 0 transitive deps, 1KB).

No UUIDv7. One ID scheme for everything. Postgres handles TEXT PKs fine. The marginal B-tree benefit of native UUID is irrelevant at eval scale.

## S3 Key Structure

```
{company_id}/{project_id}/{run_id}/{agent_name}/{artifact_type}/{ulid}_{filename}
```

Examples:
```
default/default/01JHX3YMKD.../researcher/dataset/01JHX3YMPP_competitors.csv
default/default/01JHX3YMKD.../writer/content/01JHX3YNRR_market-analysis.md
```

`company_id` and `project_id` default to "default" for eval. Hierarchy ready for multi-tenant without imposing overhead now.

## Artifact URI Scheme

```
artifact://{company}/{project}/{run}/{agent}/{type}/{ulid}_{filename}
```

Reference object returned by `write_artifact`:

```json
{
  "ref": "artifact://default/default/01JHX3YMKD.../researcher/dataset/01JHX3YMPP_competitors.csv",
  "id": "01JHX3YMPP",
  "type": "dataset",
  "mime": "text/csv",
  "size": 24576,
  "hash": "sha256:a1b2c3...",
  "producer": "researcher",
  "summary": "47 competitors — market share, pricing, features"
}
```

Resolution flow:
1. Extension sends URI to artifact service
2. Service parses URI, checks RBAC, fetches blob from MinIO
3. Returns content + metadata

The `artifact://` scheme abstracts storage backend. If MinIO moves to S3 or elsewhere, agent prompts don't change.

## Artifact Service

### Stack

- **Runtime**: Bun (oven/bun:alpine)
- **HTTP**: `Bun.serve()` — native, no framework
- **Postgres**: `Bun.sql` — built-in driver, speaks wire protocol, zero deps
- **S3**: `@aws-sdk/client-s3` — PutObject, GetObject, ListObjectsV2
- **IDs**: `ulid` npm package

### Directory structure

```
src/artifact-service/
  server.ts          Bun.serve() entry point, route dispatch
  routes.ts          Route handlers (write, read, list, health)
  storage.ts         MinIO client (S3 put/get/list)
  metastore.ts       Postgres queries (insert/select/filter)
  rbac.ts            RBAC check against rbac.json rules
  uri.ts             artifact:// URI parse/format
  types.ts           Shared TypeScript types
  Dockerfile
  package.json
```

### Routes

```
POST   /artifacts          Write artifact (body: multipart or JSON with content)
GET    /artifacts/:id      Read artifact by ULID
GET    /artifacts          List/filter artifacts (query params: agent, type, run_id)
GET    /health             Healthcheck (Postgres + MinIO connectivity)
```

All routes require `X-Agent-Name` header. Service uses this for RBAC checks against `rbac.json`.

#### POST /artifacts

Request:
```json
{
  "filename": "competitors.csv",
  "content": "base64-encoded-content",
  "type": "dataset",
  "mime": "text/csv",
  "summary": "47 competitors",
  "run_id": "01JHX3YMKD...",
  "paperclip": { "issue_id": "..." }
}
```

Response:
```json
{
  "ref": "artifact://default/default/01JHX.../researcher/dataset/01JHX..._competitors.csv",
  "id": "01JHX3YMPP",
  "size": 24576,
  "hash": "sha256:a1b2c3..."
}
```

Flow:
1. Validate params, check RBAC (agent can write to own namespace)
2. Generate ULID
3. Compute SHA-256 of content
4. Build S3 key, upload blob to MinIO
5. INSERT metadata into Postgres
6. Return artifact reference

#### GET /artifacts/:id

Request: ULID in path, `X-Agent-Name` header.

Response: artifact content + metadata headers (`X-Artifact-Type`, `X-Artifact-Mime`, `X-Artifact-Hash`, `X-Artifact-Ref`).

Flow:
1. Lookup metadata in Postgres by ULID
2. Check RBAC (requesting agent vs artifact path)
3. Fetch blob from MinIO
4. Stream content in response body

#### GET /artifacts

Request: query params for filtering.

```
?agent=researcher&type=dataset&run_id=01JHX...&limit=50
```

Response: JSON array of artifact metadata (no content bodies).

#### GET /health

Response: `{ "status": "ok", "postgres": true, "minio": true }`

### Connection management

`Bun.sql` manages its own connection pool. Set `max: 5` — single service, single consumer, 256MB Postgres. S3 client reuses HTTP connections by default.

## Metastore Schema

File: `scripts/init-artifact-db.sql`

```sql
CREATE DATABASE artifact_store;
\connect artifact_store;

CREATE TABLE artifacts (
    id              TEXT PRIMARY KEY,          -- ULID
    company_id      TEXT NOT NULL DEFAULT 'default',
    project_id      TEXT NOT NULL DEFAULT 'default',
    run_id          TEXT,
    agent_name      TEXT NOT NULL,
    artifact_type   TEXT NOT NULL CHECK (artifact_type IN (
                        'research', 'analysis', 'content', 'dataset',
                        'code', 'verdict', 'receipt', 'brief'
                    )),
    filename        TEXT NOT NULL,
    s3_bucket       TEXT NOT NULL DEFAULT 'artifacts',
    s3_key          TEXT NOT NULL UNIQUE,
    content_hash    TEXT,
    size_bytes      BIGINT,
    mime_type       TEXT,
    summary         TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}',
    paperclip       JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ
);

CREATE INDEX idx_artifacts_run ON artifacts(run_id);
CREATE INDEX idx_artifacts_agent ON artifacts(agent_name);
CREATE INDEX idx_artifacts_type ON artifacts(artifact_type);
CREATE INDEX idx_artifacts_hash ON artifacts(content_hash);
CREATE INDEX idx_artifacts_company_project ON artifacts(company_id, project_id);
CREATE INDEX idx_artifacts_created ON artifacts(created_at DESC);
```

Changes from v1 spec:
- ULID as TEXT primary key (no UUIDv7, no dual ID)
- CHECK constraint replaces `artifact_types` lookup table
- `summary` promoted to column (was buried in metadata JSONB)
- No `version`, `parent_id` columns (no versioning in eval)
- No `artifact_lineage`, `executions`, `execution_artifacts` tables (no consumer yet)
- Fewer indexes (dropped redundant ULID index — it's the PK)

### paperclip JSONB column

Stores Paperclip-specific context without polluting core schema:

```json
{
  "issue_id": "uuid-or-null",
  "run_id": "uuid-or-null",
  "project_id": "uuid-or-null",
  "goal_id": "uuid-or-null"
}
```

Queryable via Postgres JSONB operators.

## RBAC Model

Single layer. Application-level only. No MinIO IAM policies for eval.

All agents use the same MinIO credentials (root). The artifact service enforces access control before touching MinIO. Defense-in-depth via MinIO IAM is a production concern.

Config file: `src/agents/rbac.json`

```json
{
  "ceo": {
    "read": ["*"],
    "write": ["ceo/**"]
  },
  "researcher": {
    "read": ["researcher/**", "ceo/**/brief/**"],
    "write": ["researcher/**"]
  },
  "data": {
    "read": ["data/**", "researcher/**/dataset/**"],
    "write": ["data/**"]
  },
  "writer": {
    "read": ["writer/**", "researcher/**/research/**", "data/**/dataset/**"],
    "write": ["writer/**"]
  },
  "qa": {
    "read": ["*"],
    "write": ["qa/**"]
  },
  "coder": {
    "read": ["coder/**", "ceo/**/brief/**"],
    "write": ["coder/**"]
  }
}
```

Rules:
- Agents always write to their own namespace
- Read patterns are explicit — enumerate upstream types the role needs
- CEO and QA get `*` read (oversight roles)
- No delete (append-only in eval)
- Glob matching against the S3 key path (after company/project/run prefix)
- Agent identity from `X-Agent-Name` header (trusted — Docker network only)

## Extension Changes

### artifacts.ts becomes thin HTTP client

v2 `artifacts.ts` drops all filesystem logic, Postgres logic, and S3 logic. It becomes an HTTP client calling the artifact service. Same pattern as `skills/client.ts` calling Paperclip's REST API.

```
src/agents/extensions/artifacts.ts    (~100 lines, down from 354)
```

Responsibilities:
- Register 4 tools with Pi (unchanged tool names and parameter signatures)
- `write_artifact`: serialize params, POST to artifact service, return ref
- `read_artifact`: send URI to artifact service GET, return content + metadata
- `list_artifacts`: send filters to artifact service GET, format results
- `get_template`: read from local `/app/templates/` (unchanged)

No direct imports of `pg`, `@aws-sdk/client-s3`, or `ulid` in extension code. Single dependency: `ARTIFACT_SERVICE_URL` env var.

### Return value change (breaking, acknowledged)

`write_artifact` return changes from `{ path, metadata_path, size_bytes }` to `{ ref, id, size, hash }`. This is a breaking change. Agent prompts reference `ref` instead of `path` going forward. The promptSnippet update handles this — agents learn to pass URIs.

No legacy `/artifacts/...` path support. Clean break. No backward compat shim for an eval system.

## promptSnippet Update

```
When sharing work with other agents or referencing artifacts:
- Write output using write_artifact. It returns an artifact reference (URI).
- Pass that URI in Paperclip issue comments or handoff messages. Never paste artifact content inline.
- To read another agent's work, call read_artifact with the URI you received.
- To discover available artifacts, call list_artifacts with filters.
- URIs look like: artifact://default/default/run123/researcher/research/01JHX_findings.md
- The downstream agent resolves the URI when it needs the content.
```

## Workspace vs Artifact Store

| | Workspace | Artifact Store |
|---|---|---|
| Mount | `/workspace` (named Docker volume) | MinIO bucket (network) |
| Scope | Per-agent, private | Shared, RBAC-controlled |
| Lifecycle | Ephemeral — survives restart, wipeable | Durable — survives stack teardown |
| Contents | Drafts, temp files, tool outputs | Final deliverables, published data |
| Access | Only the owning agent | Cross-agent via artifact tools |
| Browsable | Inside container only | MinIO Console at :9001 |

## Dependencies

### Artifact service (`src/artifact-service/package.json`)

```
@aws-sdk/client-s3    — S3 API client (PutObject, GetObject, ListObjectsV2)
ulid                  — ULID generation
```

`Bun.sql` is built-in — no Postgres driver dep. `Bun.serve()` is built-in — no HTTP framework dep.

### Agent extension

No new deps. Uses `fetch()` (available in Node and Pi runtime) to call artifact service.

## Environment Variables

Added to `.env.example`:

```bash
# Postgres (shared instance for Paperclip + artifact store)
POSTGRES_PASSWORD=paperclip-eval
ARTIFACT_DB_PASSWORD=artifact-eval

# MinIO (S3-compatible object store)
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin
```

Per-agent `.env` (written by setup.sh):

```bash
# Artifact service (same for all agents)
ARTIFACT_SERVICE_URL=http://artifact-service:8090
```

Agents no longer need individual MinIO credentials or database URLs.

## setup.sh Changes

Simpler than v1 spec. No MinIO service accounts to create.

1. Wait for Postgres healthcheck
2. Wait for MinIO healthcheck
3. Wait for artifact service healthcheck
4. For each agent: write `ARTIFACT_SERVICE_URL` to agent's `.env` file
5. Existing Paperclip setup (company, agents, API keys) unchanged

## Migration Path

1. Add new containers to docker-compose (postgres, minio, minio-init, artifact-service)
2. Point Paperclip at external Postgres via DATABASE_URL
3. Deploy updated artifacts.ts extension (HTTP client version)
4. Remove `./artifacts:/artifacts` bind mount from agents
5. `docker compose up -d` — clean start

No data migration for eval. Existing `./artifacts/` directory stays on disk for reference. New artifacts go through artifact service to MinIO. Clean break.

## Port Allocation Summary

| Service | Port | Purpose |
|---------|------|---------|
| Paperclip | 3100 | Paperclip UI + API |
| Postgres | 5432 | Database (Paperclip + artifact metadata) |
| MinIO API | 9000 | S3 API (artifact service access) |
| MinIO Console | 9001 | MinIO management UI + artifact browser |
| Artifact Service | 8090 | Artifact REST API |
| Aspire Dashboard | 18888 | OTel traces + logs |
| CEO bridge | 8081 | Agent HTTP adapter |
| Researcher bridge | 8082 | Agent HTTP adapter |
| Data bridge | 8083 | Agent HTTP adapter |
| Writer bridge | 8084 | Agent HTTP adapter |

## Definition of Done

- [ ] `scripts/init-artifact-db.sql` creates artifact_store database and schema (single table + indexes)
- [ ] `src/artifact-service/` implements Bun service with 4 routes (write, read, list, health)
- [ ] `src/artifact-service/Dockerfile` builds on `oven/bun:alpine`
- [ ] docker-compose.yml has postgres, minio, minio-init, artifact-service containers
- [ ] Paperclip container uses DATABASE_URL pointing to shared Postgres
- [ ] Paperclip starts and runs correctly on external Postgres
- [ ] `./artifacts:/artifacts` bind mount removed from all agents
- [ ] `.env.example` has all new env vars documented
- [ ] `src/agents/rbac.json` defines per-agent read/write rules
- [ ] `artifacts.ts` rewritten as thin HTTP client calling artifact service
- [ ] `write_artifact` returns `artifact://` URI references
- [ ] `read_artifact` resolves `artifact://` URIs via artifact service
- [ ] `list_artifacts` queries artifact service instead of walking filesystem
- [ ] `get_template` unchanged (still reads local filesystem)
- [ ] promptSnippet updated to reference URIs instead of filesystem paths
- [ ] `docker compose up -d` brings up full stack from clean state
- [ ] Existing tests updated or replaced for v2 behavior
- [ ] CLAUDE.md and ROADMAP.md updated to reflect new architecture

## Negative Space

What must not change:
- Tool names and parameter signatures (write_artifact, read_artifact, list_artifacts, get_template)
- Per-agent workspace volumes (`/workspace`)
- Bridge.mjs — extension loading unchanged (`-e /app/extensions/artifacts.ts`)
- Template system — reads from `/app/templates/` in container image

What is explicitly out of scope:
- Lineage/provenance tracking (add tables when something consumes them)
- Execution tracking tables
- Artifact versioning
- MinIO IAM policies / per-agent service accounts (production concern)
- Content-addressable dedup (add when duplicate storage costs matter)
- Legacy `/artifacts/...` path backward compatibility
- Artifact deletion tools (append-only in eval)
- Presigned URL generation
- Filestash or separate file browser (MinIO Console is sufficient)

What decisions are reserved for human review:
- Whether to expose Postgres port 5432 to host (currently yes for debugging)
- RBAC rule changes (additions to rbac.json)
- Adding new artifact types to CHECK constraint

## Open Questions

None.

## Risks

1. **Paperclip on external Postgres** — first time running this config. Fallback: revert to embedded Postgres (remove DATABASE_URL, restore paperclip-data volume).

2. **Bun.sql maturity** — built-in since Bun 1.2, well-tested for basic CRUD. Our queries are simple (INSERT, SELECT with WHERE, no CTEs or window functions). Low risk. Fallback: swap to `postgres` (porsager) npm package with no other changes.

3. **Extension dep on artifact service availability** — if service is down, all artifact tools fail. Healthcheck + restart policy mitigates. Extension should return clear error ("artifact service unavailable") not cryptic fetch failures.
