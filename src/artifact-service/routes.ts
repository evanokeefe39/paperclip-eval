import { ulid } from "ulid";
import type { ArtifactRecord, WriteRequest, ListQuery } from "./types";
import { buildUri } from "./uri";
import { putBlob, getBlob, checkConnection as storageHealth } from "./storage";
import {
  insertArtifact,
  getArtifactById,
  listArtifacts,
  updateMetadata,
  checkConnection as metastoreHealth,
} from "./metastore";
import { canRead, canWrite } from "./rbac";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_BUCKET = "artifacts";
const DEFAULT_MIME = "application/octet-stream";
const DEFAULT_COMPANY = "default";
const DEFAULT_PROJECT = "default";

// ---------------------------------------------------------------------------
// POST /artifacts
// ---------------------------------------------------------------------------

export async function handleWrite(
  req: Request,
  agentName: string,
): Promise<Response> {
  let body: WriteRequest;
  try {
    body = (await req.json()) as WriteRequest;
  } catch {
    return errorResponse("invalid JSON body", 400);
  }

  if (!body.filename || !body.content || !body.type) {
    return errorResponse(
      "missing required fields: filename, content, type",
      400,
    );
  }

  const id = ulid();
  const bucket = body.bucket || DEFAULT_BUCKET;
  const companyId = body.company_id || DEFAULT_COMPANY;
  const projectId = body.project_id || DEFAULT_PROJECT;
  const runId = body.run_id ?? null;
  const mime = body.mime || DEFAULT_MIME;
  const runSegment = runId ?? "no-run";
  const s3Key = `${companyId}/${projectId}/${runSegment}/${agentName}/${body.type}/${id}_${body.filename}`;

  if (!canWrite(agentName, s3Key)) {
    return errorResponse("write denied by RBAC policy", 403);
  }

  const content = Buffer.from(body.content, "base64");

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  const hash = hasher.digest("hex") as string;

  const record: ArtifactRecord = {
    id,
    filename: body.filename,
    artifact_type: body.type,
    mime_type: mime,
    agent_name: agentName,
    run_id: runId,
    company_id: companyId,
    project_id: projectId,
    bucket,
    s3_key: s3Key,
    content_hash: hash,
    size_bytes: content.length,
    metadata: body.metadata ?? {},
    created_at: new Date(),
  };

  try {
    await putBlob(bucket, s3Key, content, mime);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "storage write failed";
    return errorResponse(`MinIO error: ${msg}`, 500);
  }

  try {
    await insertArtifact(record);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "metadata insert failed";
    return errorResponse(`Postgres error: ${msg}`, 500);
  }

  return Response.json(
    {
      ref: buildUri(record),
      id: record.id,
      size: record.size_bytes,
      hash: record.content_hash,
    },
    { status: 201 },
  );
}

// ---------------------------------------------------------------------------
// GET /artifacts/:id
// ---------------------------------------------------------------------------

export async function handleRead(
  req: Request,
  agentName: string,
): Promise<Response> {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const id = segments[segments.length - 1];

  if (!id) {
    return errorResponse("missing artifact id", 400);
  }

  let record: ArtifactRecord | null;
  try {
    record = await getArtifactById(id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "metadata read failed";
    return errorResponse(`Postgres error: ${msg}`, 500);
  }

  if (!record) {
    return errorResponse("artifact not found", 404);
  }

  if (!canRead(agentName, record.s3_key)) {
    return errorResponse("read denied by RBAC policy", 403);
  }

  let blob: Buffer;
  try {
    blob = await getBlob(record.bucket, record.s3_key);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "storage read failed";
    return errorResponse(`MinIO error: ${msg}`, 500);
  }

  return new Response(blob, {
    status: 200,
    headers: {
      "Content-Type": record.mime_type,
      "X-Artifact-Metadata": JSON.stringify(record),
    },
  });
}

// ---------------------------------------------------------------------------
// GET /artifacts
// ---------------------------------------------------------------------------

export async function handleList(
  req: Request,
  _agentName: string,
): Promise<Response> {
  const url = new URL(req.url);
  const params = url.searchParams;

  const filters: ListQuery = {};
  if (params.has("agent_name")) filters.agent_name = params.get("agent_name")!;
  if (params.has("artifact_type"))
    filters.artifact_type = params.get("artifact_type")!;
  if (params.has("run_id")) filters.run_id = params.get("run_id")!;
  if (params.has("bucket")) filters.bucket = params.get("bucket")!;
  if (params.has("since")) filters.since = params.get("since")!;
  if (params.has("metadata")) {
    try {
      filters.metadata = JSON.parse(params.get("metadata")!);
    } catch {
      return errorResponse("metadata param must be valid JSON", 400);
    }
  }

  try {
    const records = await listArtifacts(filters);
    return Response.json(records, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "list query failed";
    return errorResponse(`Postgres error: ${msg}`, 500);
  }
}

// ---------------------------------------------------------------------------
// PATCH /artifacts/:id
// ---------------------------------------------------------------------------

export async function handleUpdate(
  req: Request,
  agentName: string,
): Promise<Response> {
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const id = segments[segments.length - 1];

  if (!id) {
    return errorResponse("missing artifact id", 400);
  }

  let body: { metadata?: Record<string, unknown> };
  try {
    body = (await req.json()) as { metadata?: Record<string, unknown> };
  } catch {
    return errorResponse("invalid JSON body", 400);
  }

  if (!body.metadata || typeof body.metadata !== "object") {
    return errorResponse("body must contain a metadata object", 400);
  }

  let existing: ArtifactRecord | null;
  try {
    existing = await getArtifactById(id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "metadata read failed";
    return errorResponse(`Postgres error: ${msg}`, 500);
  }

  if (!existing) {
    return errorResponse("artifact not found", 404);
  }

  if (!canWrite(agentName, existing.s3_key)) {
    return errorResponse("write denied by RBAC policy", 403);
  }

  try {
    const updated = await updateMetadata(id, body.metadata);
    return Response.json(updated, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "metadata update failed";
    return errorResponse(`Postgres error: ${msg}`, 500);
  }
}

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------

export async function handleHealth(
  _req: Request,
  _agentName: string,
): Promise<Response> {
  const [pg, s3] = await Promise.all([metastoreHealth(), storageHealth()]);
  const status = pg && s3 ? "ok" : "degraded";
  return Response.json({ status, postgres: pg, minio: s3 }, { status: 200 });
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function errorResponse(error: string, status: number): Response {
  return Response.json({ error, status }, { status });
}
