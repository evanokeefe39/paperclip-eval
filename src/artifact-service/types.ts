/** Database row for an artifact. */
export interface ArtifactRecord {
  id: string;
  filename: string;
  artifact_type: string;
  mime_type: string;
  agent_name: string;
  run_id: string | null;
  company_id: string;
  project_id: string;
  bucket: string;
  s3_key: string;
  content_hash: string;
  size_bytes: number;
  metadata: Record<string, unknown>;
  created_at: Date;
}

/** Body for POST /artifacts. */
export interface WriteRequest {
  filename: string;
  /** Base-64 encoded file content. */
  content: string;
  /** Artifact type label (e.g. "report", "dataset", "finding"). */
  type: string;
  bucket?: string;
  mime?: string;
  metadata?: Record<string, unknown>;
  run_id?: string;
  company_id?: string;
  project_id?: string;
}

/** Response from POST /artifacts. */
export interface WriteResponse {
  ref: string;
  id: string;
  size: number;
  hash: string;
}

/** Query filters for GET /artifacts. */
export interface ListQuery {
  agent_name?: string;
  artifact_type?: string;
  run_id?: string;
  bucket?: string;
  /** ISO-8601 date string — return artifacts created at or after this time. */
  since?: string;
  /** JSONB containment filter. */
  metadata?: Record<string, unknown>;
}

/** Response from GET /health. */
export interface HealthResponse {
  status: string;
  postgres: boolean;
  minio: boolean;
}

/** Generic error envelope. */
export interface ErrorResponse {
  error: string;
  status: number;
}
