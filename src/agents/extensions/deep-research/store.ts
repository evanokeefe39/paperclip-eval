import { existsSync } from "node:fs";
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Finding, IndexEntry, SessionMeta, SubQuery, EngineState } from "./types.js";
import type { Config } from "./config.js";

export async function initSession(sessionId: string, query: string, config: Config): Promise<void> {
  const base = `${config.artifacts_base}/sessions/${sessionId}`;
  await mkdir(`${base}/pages`, { recursive: true });
}

export async function streamFinding(finding: Finding, sessionId: string, config: Config): Promise<void> {
  const base = `${config.artifacts_base}/sessions/${sessionId}`;

  await appendFile(
    `${base}/findings.jsonl`,
    JSON.stringify(finding) + "\n"
  );

  const indexEntry: IndexEntry = {
    id: finding.id,
    claim_preview: finding.claim_preview,
    confidence: finding.confidence,
    source_url: finding.source_url,
    session_id: sessionId,
    timestamp: finding.timestamp,
    topic_tags: finding.topic_tags,
    entities: finding.entities,
  };
  await appendFile(
    `${config.artifacts_base}/index.jsonl`,
    JSON.stringify(indexEntry) + "\n"
  );
}

export async function storePage(sessionId: string, url: string, content: string, config: Config): Promise<string> {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const path = `${config.artifacts_base}/sessions/${sessionId}/pages/${hash}.md`;
  if (!existsSync(path)) {
    await writeFile(path, `<!-- Source: ${url} -->\n<!-- Captured: ${new Date().toISOString()} -->\n\n${content}`);
  }
  return path;
}

export async function writeSessionMeta(
  sessionId: string,
  query: string,
  subQueries: SubQuery[],
  config: Config,
  state: EngineState
): Promise<void> {
  const meta: SessionMeta = {
    session_id: sessionId,
    query,
    sub_queries: subQueries,
    started_at: state.startedAt,
    completed_at: new Date().toISOString(),
    total_findings: state.allFindings.length,
    total_sources: new Set(state.allFindings.map(f => f.source_url)).size,
    iterations: state.iteration,
    config: { max_iterations: config.max_iterations, max_sub_queries: config.max_sub_queries },
  };
  await writeFile(
    `${config.artifacts_base}/sessions/${sessionId}/meta.json`,
    JSON.stringify(meta, null, 2)
  );
}

export async function buildSessionSummary(
  query: string,
  state: EngineState,
  sessionId: string,
  config: Config
): Promise<string> {
  const findings = state.allFindings
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 15);

  const lines: string[] = [
    `## Research Summary: ${query}`,
    "",
    `**Session:** ${sessionId}`,
    `**Iterations:** ${state.iteration + 1}`,
    `**Total findings:** ${state.allFindings.length}`,
    `**Unique sources:** ${new Set(state.allFindings.map(f => f.source_url)).size}`,
    "",
    "### Key Findings",
    "",
  ];

  for (const [i, f] of findings.entries()) {
    lines.push(`${i + 1}. [${f.confidence.toFixed(1)}] ${f.claim_preview}`);
    lines.push(`   Source: ${f.source_url}`);
    if (f.entities.length > 0) {
      lines.push(`   Entities: ${f.entities.map(e => e.name).join(", ")}`);
    }
    lines.push("");
  }

  const sweepSummaries = [...state.sweepResults.values()];
  if (sweepSummaries.length > 0) {
    lines.push("### Coverage");
    lines.push("");
    for (const s of sweepSummaries) {
      lines.push(`- **${s.summary.query}**: ${s.summary.coverage}`);
    }
  }

  const summary = lines.join("\n");

  const base = `${config.artifacts_base}/sessions/${sessionId}`;
  try {
    await writeFile(`${base}/summary.md`, summary);
  } catch {
    // Non-critical -- summary is returned to agent regardless
  }

  return summary;
}
