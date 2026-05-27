import type { ArtifactRecord } from "./types";

/**
 * Build a canonical artifact URI from a record.
 *
 * Format: artifact://{company_id}/{project_id}/{run_id}/{agent_name}/{artifact_type}/{id}_{filename}
 */
export function buildUri(record: ArtifactRecord): string {
  const runSegment = record.run_id ?? "no-run";
  return `artifact://${record.company_id}/${record.project_id}/${runSegment}/${record.agent_name}/${record.artifact_type}/${record.id}_${record.filename}`;
}

/**
 * Parse an artifact URI back into its components.
 *
 * Throws on malformed URIs.
 */
export function parseUri(uri: string): {
  company_id: string;
  project_id: string;
  run_id: string | null;
  agent_name: string;
  artifact_type: string;
  id: string;
  filename: string;
} {
  const PREFIX = "artifact://";
  if (!uri.startsWith(PREFIX)) {
    throw new Error(`Malformed artifact URI: missing "artifact://" prefix — got "${uri}"`);
  }

  const body = uri.slice(PREFIX.length);
  const parts = body.split("/");

  // Expect: company_id / project_id / run_id / agent_name / artifact_type / id_filename
  if (parts.length !== 6) {
    throw new Error(
      `Malformed artifact URI: expected 6 path segments, got ${parts.length} — "${uri}"`,
    );
  }

  const [company_id, project_id, runSegment, agent_name, artifact_type, idFilename] = parts;

  const underscoreIdx = idFilename.indexOf("_");
  if (underscoreIdx === -1) {
    throw new Error(
      `Malformed artifact URI: final segment must be "{id}_{filename}" — got "${idFilename}"`,
    );
  }

  const id = idFilename.slice(0, underscoreIdx);
  const filename = idFilename.slice(underscoreIdx + 1);

  if (!id || !filename) {
    throw new Error(
      `Malformed artifact URI: id and filename must be non-empty — got "${idFilename}"`,
    );
  }

  return {
    company_id,
    project_id,
    run_id: runSegment === "no-run" ? null : runSegment,
    agent_name,
    artifact_type,
    id,
    filename,
  };
}
