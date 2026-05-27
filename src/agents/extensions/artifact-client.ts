const AGENT_NAME = process.env.AGENT_NAME || "unknown";
const SERVICE_URL = process.env.ARTIFACT_SERVICE_URL || "";

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
  created_at: string;
}

interface WriteParams {
  filename: string;
  content: string;
  type: string;
  bucket?: string;
  mime?: string;
  metadata?: Record<string, unknown>;
  run_id?: string;
  company_id?: string;
  project_id?: string;
}

interface WriteResult {
  ref: string;
  id: string;
  size: number;
  hash: string;
}

interface ReadResult {
  content: Buffer;
  metadata: ArtifactRecord;
}

interface ListFilters {
  agent?: string;
  type?: string;
  bucket?: string;
  run_id?: string;
  since?: string;
  metadata?: Record<string, unknown>;
}

function requireService(): string {
  if (!SERVICE_URL) {
    throw new Error("ARTIFACT_SERVICE_URL not set — artifact service unavailable");
  }
  return SERVICE_URL;
}

function headers(): Record<string, string> {
  return {
    "x-agent-name": AGENT_NAME,
    "content-type": "application/json",
  };
}

export async function write(params: WriteParams): Promise<WriteResult> {
  const base = requireService();
  const body = {
    filename: params.filename,
    content: Buffer.from(params.content, "utf8").toString("base64"),
    type: params.type,
    bucket: params.bucket,
    mime: params.mime,
    metadata: params.metadata,
    run_id: params.run_id,
    company_id: params.company_id,
    project_id: params.project_id,
  };

  const resp = await fetch(`${base}/artifacts`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(`artifact write failed (${resp.status}): ${(err as any).error}`);
  }

  return resp.json() as Promise<WriteResult>;
}

export async function writeRaw(params: WriteParams & { contentBase64: string }): Promise<WriteResult> {
  const base = requireService();
  const body = {
    filename: params.filename,
    content: params.contentBase64,
    type: params.type,
    bucket: params.bucket,
    mime: params.mime,
    metadata: params.metadata,
    run_id: params.run_id,
    company_id: params.company_id,
    project_id: params.project_id,
  };

  const resp = await fetch(`${base}/artifacts`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(`artifact write failed (${resp.status}): ${(err as any).error}`);
  }

  return resp.json() as Promise<WriteResult>;
}

export async function read(id: string): Promise<ReadResult> {
  const base = requireService();

  const resp = await fetch(`${base}/artifacts/${id}`, {
    headers: { "x-agent-name": AGENT_NAME },
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(`artifact read failed (${resp.status}): ${(err as any).error}`);
  }

  const content = Buffer.from(await resp.arrayBuffer());
  const metaHeader = resp.headers.get("x-artifact-metadata");
  if (!metaHeader) {
    throw new Error(`artifact metadata header missing for id: ${id}`);
  }
  const metadata = JSON.parse(metaHeader) as ArtifactRecord;

  return { content, metadata };
}

export async function list(filters: ListFilters): Promise<ArtifactRecord[]> {
  const base = requireService();
  const params = new URLSearchParams();

  if (filters.agent) params.set("agent_name", filters.agent);
  if (filters.type) params.set("artifact_type", filters.type);
  if (filters.bucket) params.set("bucket", filters.bucket);
  if (filters.run_id) params.set("run_id", filters.run_id);
  if (filters.since) params.set("since", filters.since);
  if (filters.metadata) params.set("metadata", JSON.stringify(filters.metadata));

  const qs = params.toString();
  const url = qs ? `${base}/artifacts?${qs}` : `${base}/artifacts`;

  const resp = await fetch(url, {
    headers: { "x-agent-name": AGENT_NAME },
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(`artifact list failed (${resp.status}): ${(err as any).error}`);
  }

  return resp.json() as Promise<ArtifactRecord[]>;
}

export async function updateMetadata(
  id: string,
  metadata: Record<string, unknown>,
): Promise<ArtifactRecord> {
  const base = requireService();

  const resp = await fetch(`${base}/artifacts/${id}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ metadata }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(`metadata update failed (${resp.status}): ${(err as any).error}`);
  }

  return resp.json() as Promise<ArtifactRecord>;
}

export async function append(params: {
  filename: string;
  line: string;
  type: string;
  bucket?: string;
  metadata?: Record<string, unknown>;
  run_id?: string;
}): Promise<WriteResult> {
  return write({
    filename: params.filename,
    content: params.line + "\n",
    type: params.type,
    bucket: params.bucket,
    metadata: params.metadata,
    run_id: params.run_id,
  });
}

export function getAgentName(): string {
  return AGENT_NAME;
}

export function getServiceUrl(): string {
  return SERVICE_URL;
}
