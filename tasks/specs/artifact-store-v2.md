# Artifact Store v2: Postgres + MinIO + Filestash

## Status

Spec. Supersedes ext-artifacts.md (v1) for storage backend. Tool interface preserved.

## Intent

Replace the bind-mounted `./artifacts` directory and `.meta.json` sidecar files with a proper artifact store: MinIO for blob storage, Postgres for metadata, Filestash for browsing. Establish the foundation for RBAC, lineage tracking, content-addressable dedup, and the `artifact://` URI scheme. Externalize Paperclip's embedded Postgres into the same shared instance.

This is the "Option B" from ROADMAP.md, adapted to eval-stage constraints.

## Context Package

### Relevant existing code

- `src/agents/extensions/artifacts.ts` — v1 extension, 354 lines. Registers 4 tools: `write_artifact`, `read_artifact`, `list_artifacts`, `get_template`. Uses `node:fs` to read/write files on a shared Docker volume. Metadata stored as `.meta.json` sidecar files alongside artifacts. Path traversal guards, agent namespace isolation on writes, open reads.
- `docker-compose.yml` — current stack: Paperclip (embedded Postgres), Aspire dashboard, 4 agent containers (ceo, researcher, data, writer). Artifacts shared via `./artifacts:/artifacts` bind mount. Per-agent workspace as named Docker volumes.
- `.env.example` — shared provider API keys, bridge defaults, Discord config. No database or object store config yet.
- `tasks/specs/ext-artifacts.md` — v1 spec. Documents tool interface, sidecar schema, path conventions, security model. Tool signatures are the stable API — internal implementation changes.
- `ROADMAP.md` — documents MinIO as planned, blocked on eval validation of the shared volume pattern.
- `src/agents/skills/client.ts` — Paperclip API client pattern (session-cookie auth with caching). Reference for how extensions authenticate with services.

### Architectural constraints

- Agents run as Pi extensions inside Docker containers. No npm deps beyond what Pi provides (typebox available). MinIO client must be added as a dependency or use raw HTTP (S3 API is just HTTP with signing).
- Bridge is zero-dep Node.js. New deps in the extension layer are acceptable if kept minimal.
- Paperclip supports `DATABASE_URL` env var for external Postgres. Setting it disables the embedded instance.
- Eval stage — optimize for debuggability and simplicity over production hardening. Named volumes over managed services. Single-node everything.

### Prior decisions

- Pass-by-reference: agents exchange artifact paths/URIs, never inline content. Established in v1, strengthened here with `artifact://` URIs.
- Agent namespace isolation: agents write only to their own namespace. Reads are broader (configurable in v2 via RBAC).
- Workspace vs artifacts separation: `/workspace` is ephemeral per-agent scratch space (named Docker volumes). Artifact store is durable shared storage. These remain distinct.
- Sidecar metadata: v1 used `.meta.json` files. v2 moves metadata to Postgres. Sidecars eliminated.

### Anti-patterns to avoid

- No ORM. Raw SQL with parameterized queries. The schema is small and stable.
- No S3 SDK. Use `@aws-sdk/client-s3` only — it's the standard, well-maintained, and handles SigV4 signing. Do not use minio-js (less maintained, non-standard extensions).
- No centralized artifact service container. Extension connects directly to Postgres + MinIO. Centralized service is a future option, not eval-stage scope.
- No migration framework. Schema is applied via init script mounted into Postgres container. For eval, `CREATE TABLE IF NOT EXISTS` is sufficient.

## Architecture

### Container topology

```
┌─────────────────────────────────────────────────────────────────┐
│  docker-compose                                                  │
│                                                                  │
│  ┌──────────┐   DATABASE_URL    ┌──────────┐                    │
│  │ Paperclip│──────────────────▶│ Postgres │◀── ARTIFACT_DB_URL │
│  └──────────┘                   │ (2 DBs)  │          │         │
│                                 │paperclip │          │         │
│  ┌──────────┐                   │art_store │          │         │
│  │ Aspire   │                   └──────────┘          │         │
│  │Dashboard │                                         │         │
│  └──────────┘                   ┌──────────┐          │         │
│                          ┌─────▶│  MinIO   │◀─────────┤         │
│  ┌──────────┐            │      │ :9000 API│          │         │
│  │   CEO    │─── ext ────┤      │ :9001 UI │          │         │
│  ├──────────┤            │      └──────────┘          │         │
│  │Researcher│─── ext ────┤                            │         │
│  ├──────────┤            │      ┌──────────┐          │         │
│  │  Data    │─── ext ────┤      │Filestash │          │         │
│  ├──────────┤            │      │  :8334   │──── S3──▶│         │
│  │ Writer   │─── ext ────┘      └──────────┘          │         │
│  └──────────┘                                         │         │
│       │                                               │         │
│       └── each agent container has:                   │         │
│           ARTIFACT_DB_URL  ───────────────────────────┘         │
│           MINIO_ENDPOINT / ACCESS_KEY / SECRET_KEY              │
│           AGENT_NAME (unchanged)                                │
│           /workspace (ephemeral, named volume, unchanged)       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

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
- `paperclip` — Paperclip's own schema, managed by Paperclip migrations on startup
- `artifact_store` — our schema, created by init script

Postgres init scripts in `/docker-entrypoint-initdb.d/` run once on first volume creation. The init script creates the `artifact_store` database and applies the schema.

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
    test: ["CMD", "mc", "ready", "local"]
    interval: 5s
    timeout: 3s
    start_period: 10s
    retries: 5
  deploy:
    resources:
      limits:
        memory: 256M
```

Bucket creation handled by a one-shot init container (see minio-init below).

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

Creates the `artifacts` bucket on first run. Exits after. No restart policy.

Per-agent MinIO service accounts for RBAC layer 2 are created by setup.sh (see RBAC section).

#### filestash

```yaml
filestash:
  image: machines/filestash
  restart: unless-stopped
  ports:
    - "8334:8334"
  depends_on:
    minio:
      condition: service_healthy
  deploy:
    resources:
      limits:
        memory: 256M
```

First-launch config: admin panel at `localhost:8334/admin`, add S3 backend pointing at `http://minio:9000` with root creds. Renders markdown, JSON, CSV, code with syntax highlighting inline. This is the artifact browser.

### Changed containers

#### paperclip

```yaml
paperclip:
  # ... existing config ...
  environment:
    # ... existing vars ...
    DATABASE_URL: "postgres://paperclip:${POSTGRES_PASSWORD:-paperclip-eval}@postgres:5432/paperclip"
  depends_on:
    postgres:
      condition: service_healthy
```

Remove `paperclip-data` volume (no longer needed — data lives in shared Postgres). The embedded Postgres auto-disables when DATABASE_URL is set.

#### all agents

```yaml
# remove from each agent:
#   - ./artifacts:/artifacts          <-- replaced by MinIO

# add to each agent's env_file or environment:
#   ARTIFACT_DB_URL=postgres://artifact:${ARTIFACT_DB_PASSWORD:-artifact-eval}@postgres:5432/artifact_store
#   MINIO_ENDPOINT=http://minio:9000
#   MINIO_ACCESS_KEY=<per-agent, created by setup.sh>
#   MINIO_SECRET_KEY=<per-agent, created by setup.sh>

# add dependency:
#   depends_on:
#     postgres:
#       condition: service_healthy
#     minio:
#       condition: service_healthy
```

### Removed

- `./artifacts:/artifacts` bind mount from all agents
- `./artifacts` host directory (no longer the source of truth)
- `.meta.json` sidecar files (metadata moves to Postgres)
- `paperclip-data` named volume (Paperclip now uses shared Postgres)

### Kept unchanged

- Per-agent workspace named volumes (`ceo-workspace:/workspace`, etc.) — ephemeral scratch, not part of artifact store
- Aspire dashboard container
- Template files at `/app/templates/` (COPYed into image, not stored in MinIO)
- `get_template` tool (reads from local filesystem, no change)

## Identifiers

### ULID for artifact IDs and S3 keys

All artifact IDs are ULIDs — 26-character Crockford Base32, millisecond-precision, time-sortable, case-insensitive.

```
01JHX3YMKD7Q2R1BFPWG5E9T4N
```

Used as:
- Primary identifier in artifact references
- S3 key prefix within the type directory (ensures time-ordering in prefix scans)
- Postgres column (`ulid TEXT NOT NULL UNIQUE`)

Library: `ulid` npm package (single dep, 0 transitive deps, 1KB).

### UUIDv7 for Postgres primary keys

Postgres PKs use UUIDv7 — native `uuid` column type, RFC 9562, sequential insert performance.

Library: `uuidv7` npm package or generate manually (timestamp + random bits in UUID format).

### Why both

ULID is shorter (26 vs 36 chars) and better for S3 keys where length matters. UUIDv7 fits Postgres's native `uuid` type without custom domains. The artifact record has both: `id` (UUIDv7, PK) and `ulid` (ULID, unique, used in S3 keys and external references).

## S3 Key Structure

```
{company_id}/{project_id}/{run_id}/{agent_name}/{artifact_type}/{ulid}_{filename}
```

Examples:
```
default/default/01JHX3YMKD.../researcher/dataset/01JHX3YMPP_competitors.csv
default/default/01JHX3YMKD.../writer/report/01JHX3YNRR_market-analysis.md
default/default/01JHX3YMKD.../qa/verdict/01JHX3YQTT_qa-pass.json
```

For eval, `company_id` and `project_id` default to "default" since we typically run one company/project. The hierarchy is ready for multi-tenant but doesn't impose overhead now.

When Paperclip context is provided (issue_id, project_id, etc.), the extension resolves company and project from those. When not provided, defaults apply.

## Artifact URI Scheme

```
artifact://{company}/{project}/{run}/{agent}/{type}/{ulid}_{filename}
```

Full reference object returned by `write_artifact` and passed between agents:

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

Agents include the `ref` string in Paperclip issue comments. Consuming agent passes the `ref` to `read_artifact` to resolve it.

Resolution flow:
1. Parse URI → extract S3 key components
2. Check RBAC (does requesting agent have read access to this path?)
3. Fetch blob from MinIO
4. Return content + metadata from Postgres

The `artifact://` scheme abstracts the storage backend. If MinIO moves to AWS S3, Neon, or anywhere else, agent prompts don't change.

## Metastore Schema

File: `scripts/init-artifact-db.sql`

```sql
-- Run by Postgres entrypoint on first init
CREATE DATABASE artifact_store;
\connect artifact_store;

CREATE TABLE artifact_types (
    id              TEXT PRIMARY KEY,
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO artifact_types (id, description) VALUES
    ('research',  'Research findings, source analysis'),
    ('analysis',  'Data analysis, trend reports'),
    ('content',   'Written content, articles, posts'),
    ('dataset',   'Structured data, CSV, JSON collections'),
    ('code',      'Code artifacts, scripts, configs'),
    ('verdict',   'QA pass/fail verdicts'),
    ('receipt',   'Publish receipts, confirmation records'),
    ('brief',     'Task briefs, directives, specs')
ON CONFLICT DO NOTHING;

CREATE TABLE artifacts (
    id              UUID PRIMARY KEY,
    ulid            TEXT NOT NULL UNIQUE,
    company_id      TEXT NOT NULL DEFAULT 'default',
    project_id      TEXT NOT NULL DEFAULT 'default',
    run_id          TEXT,
    agent_name      TEXT NOT NULL,
    artifact_type   TEXT NOT NULL REFERENCES artifact_types(id),
    filename        TEXT NOT NULL,
    s3_bucket       TEXT NOT NULL DEFAULT 'artifacts',
    s3_key          TEXT NOT NULL UNIQUE,
    content_hash    TEXT,
    size_bytes      BIGINT,
    mime_type       TEXT,
    version         INTEGER NOT NULL DEFAULT 1,
    parent_id       UUID REFERENCES artifacts(id),
    metadata        JSONB NOT NULL DEFAULT '{}',
    paperclip       JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ
);

CREATE TABLE artifact_lineage (
    id              UUID PRIMARY KEY,
    source_id       UUID NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    target_id       UUID NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    relationship    TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(source_id, target_id, relationship)
);

CREATE TABLE executions (
    id              UUID PRIMARY KEY,
    run_id          TEXT,
    agent_name      TEXT NOT NULL,
    tool_name       TEXT,
    trace_id        TEXT,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'running',
    metadata        JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE execution_artifacts (
    execution_id    UUID NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    artifact_id     UUID NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    PRIMARY KEY (execution_id, artifact_id, role)
);

-- Indexes
CREATE INDEX idx_artifacts_ulid ON artifacts(ulid);
CREATE INDEX idx_artifacts_run ON artifacts(run_id);
CREATE INDEX idx_artifacts_agent ON artifacts(agent_name);
CREATE INDEX idx_artifacts_type ON artifacts(artifact_type);
CREATE INDEX idx_artifacts_hash ON artifacts(content_hash);
CREATE INDEX idx_artifacts_company_project ON artifacts(company_id, project_id);
CREATE INDEX idx_artifacts_created ON artifacts(created_at DESC);
CREATE INDEX idx_lineage_source ON artifact_lineage(source_id);
CREATE INDEX idx_lineage_target ON artifact_lineage(target_id);
CREATE INDEX idx_executions_run ON executions(run_id);
CREATE INDEX idx_executions_agent ON executions(agent_name);
```

### paperclip JSONB column

Stores Paperclip-specific context without polluting the core schema:

```json
{
  "issue_id": "uuid-or-null",
  "run_id": "uuid-or-null",
  "project_id": "uuid-or-null",
  "goal_id": "uuid-or-null"
}
```

Same fields as the v1 sidecar's `paperclip` object. Queryable via Postgres JSONB operators.

### Content-addressable hashing

SHA-256 of artifact content, stored in `content_hash`. Enables:
- Dedup: skip upload if hash matches existing artifact (return existing reference)
- Integrity: verify after download
- Change detection: "did this artifact change?" without downloading

## RBAC Model

### Layer 1: Application-layer (in extension)

RBAC config per agent, loaded from environment or a shared config file.

```json
{
  "ceo": {
    "read": ["*"],
    "write": ["ceo/**"],
    "delete": []
  },
  "researcher": {
    "read": ["researcher/**", "ceo/**/brief/**"],
    "write": ["researcher/**"],
    "delete": []
  },
  "data": {
    "read": ["data/**", "researcher/**/dataset/**"],
    "write": ["data/**"],
    "delete": []
  },
  "writer": {
    "read": ["writer/**", "researcher/**/research/**", "data/**/dataset/**"],
    "write": ["writer/**"],
    "delete": []
  },
  "qa": {
    "read": ["*"],
    "write": ["qa/**"],
    "delete": []
  },
  "coder": {
    "read": ["coder/**", "ceo/**/brief/**"],
    "write": ["coder/**"],
    "delete": []
  },
  "publisher": {
    "read": ["publisher/**", "qa/**/verdict/**", "writer/**/content/**"],
    "write": ["publisher/**"],
    "delete": []
  }
}
```

Rules:
- Agents always write to their own namespace
- Read patterns are explicit — enumerate upstream agent types the role needs
- CEO and QA get `*` read (oversight roles)
- No agent gets delete (eval stage — artifacts are append-only)
- Glob matching against the S3 key path (after company/project/run prefix)

Config file: `src/agents/rbac.json`. Loaded by artifacts extension on init. Override per-agent via `ARTIFACT_RBAC_ROLE` env var (defaults to AGENT_NAME).

### Layer 2: MinIO IAM policies (defense-in-depth)

Per-agent MinIO service accounts created by setup.sh. Each account gets an IAM policy that mirrors layer 1 at the S3 prefix level.

Example for researcher:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::artifacts/*/researcher/*",
        "arn:aws:s3:::artifacts/*/ceo/*/brief/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::artifacts/*/researcher/*"
    }
  ]
}
```

Service account credentials go into per-agent `.env` files (MINIO_ACCESS_KEY, MINIO_SECRET_KEY). Created by setup.sh alongside Paperclip API keys.

Even if the application-layer RBAC has a bug, MinIO rejects unauthorized access at the storage level.

## Tool Interface Changes

### write_artifact

Parameters: unchanged. Same signature as v1.

Return value changes:

```
v1: { path: "/artifacts/researcher/output/findings.md", metadata_path: "...meta.json", size_bytes: N }
v2: { ref: "artifact://default/default/01JHX.../researcher/research/01JHX..._findings.md",
      id: "01JHX3YMPP", size_bytes: N, hash: "sha256:..." }
```

The `ref` is the artifact URI. Agents pass this in messages. The `path` field is gone — there is no filesystem path. The `metadata_path` is gone — metadata lives in Postgres.

Internal flow:
1. Validate params (name, content, type — same as v1)
2. Generate ULID
3. Compute SHA-256 of content
4. Check dedup: query Postgres for matching hash + agent + type. If found, return existing ref.
5. Build S3 key from context (company/project/run/agent/type/ulid_filename)
6. Upload blob to MinIO
7. INSERT metadata into Postgres artifacts table
8. Return artifact reference

### read_artifact

Parameters: accepts both old-style paths and `artifact://` URIs.

```typescript
read_artifact({
  path: string  // "artifact://..." URI or legacy "/artifacts/..." path
})
```

Legacy path support: if input starts with `/artifacts/`, map it to an S3 key lookup. This provides backward compatibility during migration but logs a deprecation warning.

Internal flow:
1. Parse input — URI or legacy path
2. Resolve to S3 key
3. Check RBAC (requesting agent vs S3 key path)
4. Fetch blob from MinIO
5. Fetch metadata from Postgres
6. Return content + metadata

### list_artifacts

Parameters: unchanged. Same filters.

Return value: includes `ref` URIs instead of filesystem paths.

```
v1: "- /artifacts/researcher/output/findings.md"
v2: "- artifact://default/.../researcher/research/01JHX..._findings.md"
```

Internal: queries Postgres instead of walking directories. Faster, filterable, sorted by index.

### get_template

No change. Templates are static files in the container image, not stored in the artifact store. Reads from `/app/templates/` as before.

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

These are distinct systems with distinct lifecycles:

| | Workspace | Artifact Store |
|---|---|---|
| Mount | `/workspace` (named Docker volume) | MinIO bucket (network) |
| Scope | Per-agent, private | Shared, RBAC-controlled |
| Lifecycle | Ephemeral — survives container restart, wipeable | Durable — survives stack teardown |
| Contents | Tool outputs, drafts, temp files, git worktrees | Final deliverables, published data |
| Access | Only the owning agent | Cross-agent via artifact tools |
| Browsable | Not externally (inside container only) | Filestash at :8334, MinIO console at :9001 |

The transition: agent works in `/workspace`, calls `write_artifact` when output is final. The extension uploads to MinIO and registers in Postgres. The workspace is never shared; the artifact store is always shared.

## Dependencies Added to Extension

```
@aws-sdk/client-s3    — S3 API client (PutObject, GetObject, ListObjectsV2)
pg                    — Postgres client (no ORM, parameterized queries)
ulid                  — ULID generation
```

These install in the agent Docker image. Added to Dockerfile's npm install step or bundled with the extension. Total added: ~5MB compressed.

## Environment Variables (new)

Added to `.env.example`:

```bash
# Postgres (shared instance for Paperclip + artifact store)
POSTGRES_PASSWORD=paperclip-eval

# MinIO (S3-compatible object store)
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin

# Artifact store (per-agent — written by setup.sh into agent .env files)
# ARTIFACT_DB_URL=postgres://artifact:artifact-eval@postgres:5432/artifact_store
# MINIO_ENDPOINT=http://minio:9000
# MINIO_ACCESS_KEY=<per-agent service account>
# MINIO_SECRET_KEY=<per-agent service account>
```

## setup.sh Changes

Setup.sh gains new responsibilities:

1. Wait for Postgres healthcheck (already waits for Paperclip, same pattern)
2. Wait for MinIO healthcheck
3. Create MinIO `artifacts` bucket if not exists (backup to minio-init container)
4. For each agent:
   a. Create MinIO service account with IAM policy matching rbac.json
   b. Write MINIO_ACCESS_KEY and MINIO_SECRET_KEY to agent's `.env` file
   c. Write ARTIFACT_DB_URL to agent's `.env` file
5. Existing Paperclip setup (company, agents, API keys) unchanged

## Migration Path

### From v1 (bind mount + sidecars) to v2 (MinIO + Postgres)

1. Add new containers to docker-compose (postgres, minio, minio-init, filestash)
2. Point Paperclip at external Postgres via DATABASE_URL
3. Deploy updated artifacts.ts extension
4. Remove `./artifacts:/artifacts` bind mount from agents
5. Optional: migrate existing artifacts from `./artifacts/` directory into MinIO via `mc cp --recursive ./artifacts/ store/artifacts/default/default/migrated/`

No data migration required for eval. Existing artifacts in `./artifacts/` can be browsed on disk. New artifacts go to MinIO. Clean break.

## Port Allocation Summary

| Service | Port | Purpose |
|---------|------|---------|
| Paperclip | 3100 | Paperclip UI + API |
| Postgres | 5432 | Database (Paperclip + artifact metadata) |
| MinIO API | 9000 | S3 API (agent access) |
| MinIO Console | 9001 | MinIO management UI |
| Filestash | 8334 | Artifact file browser (markdown/JSON/CSV rendering) |
| Aspire Dashboard | 18888 | OTel traces + logs |
| CEO bridge | 8081 | Agent HTTP adapter |
| Researcher bridge | 8082 | Agent HTTP adapter |
| Data bridge | 8083 | Agent HTTP adapter |
| Writer bridge | 8084 | Agent HTTP adapter |

## Definition of Done

- [ ] `scripts/init-artifact-db.sql` creates artifact_store database and schema
- [ ] docker-compose.yml has postgres, minio, minio-init, filestash containers
- [ ] Paperclip container uses DATABASE_URL pointing to shared Postgres
- [ ] Paperclip starts and runs correctly on external Postgres
- [ ] `./artifacts:/artifacts` bind mount removed from all agents
- [ ] `.env.example` has all new env vars documented
- [ ] `src/agents/rbac.json` defines per-agent read/write/delete rules
- [ ] `artifacts.ts` rewritten: MinIO for blobs, Postgres for metadata, ULID IDs, SHA-256 hashing
- [ ] `write_artifact` returns `artifact://` URI references
- [ ] `read_artifact` resolves `artifact://` URIs and checks RBAC
- [ ] `list_artifacts` queries Postgres instead of walking filesystem
- [ ] `get_template` unchanged (still reads local filesystem)
- [ ] Legacy `/artifacts/...` path input in read_artifact maps to S3 key with deprecation warning
- [ ] promptSnippet updated to reference URIs instead of filesystem paths
- [ ] setup.sh creates MinIO service accounts with per-agent IAM policies
- [ ] setup.sh writes MINIO_ACCESS_KEY, MINIO_SECRET_KEY, ARTIFACT_DB_URL to agent .env files
- [ ] Filestash accessible at :8334, configured to browse MinIO artifacts bucket
- [ ] `docker compose up -d` brings up full stack from clean state
- [ ] Existing tests updated or replaced for v2 behavior
- [ ] CLAUDE.md and ROADMAP.md updated to reflect new architecture

## Negative Space

What must not change:
- Tool names and parameter signatures (write_artifact, read_artifact, list_artifacts, get_template)
- Per-agent workspace volumes (`/workspace`) — these are not part of the artifact store
- Bridge.mjs — no changes needed, extension loading is the same (`-e /app/extensions/artifacts.ts`)
- Agent prompts in AGENTS.md — promptSnippet handles the behavioral change automatically
- Template system — continues to read from `/app/templates/` in the container image

What is explicitly out of scope:
- Centralized artifact service container (future — when RBAC needs to be enforced at network level)
- Artifact versioning UI (MinIO Console shows object versions if versioning is enabled, but not in v2 scope)
- Lineage tracking in the extension (tables exist in schema, populated manually or by future tooling)
- Artifact deletion tools (append-only in eval)
- Presigned URL generation for external access (eval is all internal Docker network)
- Git sync of artifacts (deferred per ROADMAP.md)

What decisions are reserved for human review:
- Whether to enable MinIO bucket versioning (storage cost tradeoff)
- Filestash admin credentials and access policy
- Whether to expose Postgres port 5432 to host (currently yes for debugging, may want to restrict)
- RBAC rule changes (additions to rbac.json require human review)

## Open Questions

None. Spec is complete for implementation.

## Risks

1. **Paperclip on external Postgres** — first time running this config. If Paperclip migrations fail or behave differently, fallback is reverting to embedded Postgres (remove DATABASE_URL, restore paperclip-data volume).

2. **Extension dependency size** — `@aws-sdk/client-s3` is ~5MB. Adds to image size. Acceptable for eval, monitor if it pulls unexpected transitive deps.

3. **Filestash first-run config** — requires manual S3 backend setup in admin panel. Not automatable without API. Document the 3-click setup in README or setup.sh output.
