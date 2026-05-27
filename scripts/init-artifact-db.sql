-- =============================================================================
-- Postgres 17 init script
-- Runs once via docker-entrypoint-initdb.d on first container start
-- Creates: artifact_store (artifact service) + paperclip (Paperclip app)
-- =============================================================================

-- Paperclip database
SELECT 'CREATE DATABASE paperclip'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'paperclip')\gexec

-- Artifact store database
SELECT 'CREATE DATABASE artifact_store'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'artifact_store')\gexec

\connect artifact_store

-- Artifacts table
CREATE TABLE IF NOT EXISTS artifacts (
    id              TEXT        PRIMARY KEY,
    filename        TEXT        NOT NULL,
    artifact_type   TEXT        NOT NULL
        CHECK (artifact_type IN (
            'research', 'finding', 'log', 'dataset',
            'code', 'brief', 'state', 'session'
        )),
    mime_type       TEXT        NOT NULL,
    agent_name      TEXT        NOT NULL,
    run_id          TEXT,
    company_id      TEXT        DEFAULT 'default',
    project_id      TEXT        DEFAULT 'default',
    bucket          TEXT        NOT NULL DEFAULT 'artifacts'
        CHECK (bucket IN ('artifacts', 'logs', 'state')),
    s3_key          TEXT        NOT NULL,
    content_hash    TEXT        NOT NULL,
    size_bytes      INTEGER     NOT NULL,
    metadata        JSONB       DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_artifacts_run_id
    ON artifacts (run_id);

CREATE INDEX IF NOT EXISTS idx_artifacts_agent_name
    ON artifacts (agent_name);

CREATE INDEX IF NOT EXISTS idx_artifacts_artifact_type
    ON artifacts (artifact_type);

CREATE INDEX IF NOT EXISTS idx_artifacts_content_hash
    ON artifacts (content_hash);

CREATE INDEX IF NOT EXISTS idx_artifacts_company_project
    ON artifacts (company_id, project_id);

CREATE INDEX IF NOT EXISTS idx_artifacts_created_at
    ON artifacts (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_artifacts_metadata
    ON artifacts USING gin (metadata);

-- Application user
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'artifact') THEN
        CREATE ROLE artifact WITH LOGIN PASSWORD 'artifact-eval';
    END IF;
END
$$;

GRANT ALL PRIVILEGES ON DATABASE artifact_store TO artifact;
GRANT ALL PRIVILEGES ON TABLE artifacts TO artifact;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO artifact;
