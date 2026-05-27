import { createHash } from "node:crypto";
import * as client from "../artifact-client.js";
import type { Finding, SessionMeta, SubQuery, EngineState } from "./types.js";
import type { Config } from "./config.js";

export async function initSession(_sessionId: string, _query: string, _config: Config): Promise<void> {
  // buckets managed by infrastructure — no local dirs to create
}

export async function streamFinding(finding: Finding, sessionId: string, _config: Config): Promise<void> {
  await client.write({
    filename: `finding-${finding.id}.json`,
    content: JSON.stringify(finding),
    type: "research",
    bucket: "artifacts",
    mime: "application/json",
    metadata: {
      session_id: sessionId,
      claim_preview: finding.claim_preview,
      confidence: finding.confidence,
      source_url: finding.source_url,
      topic_tags: finding.topic_tags,
      entities: finding.entities,
    },
  });
}

export async function storePage(sessionId: string, url: string, content: string, _config: Config): Promise<string> {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const result = await client.write({
    filename: `page-${hash}.md`,
    content: `<!-- Source: ${url} -->\n<!-- Captured: ${new Date().toISOString()} -->\n\n${content}`,
    type: "research",
    bucket: "artifacts",
    mime: "text/markdown",
    metadata: { session_id: sessionId, source_url: url },
  });
  return result.ref;
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
  await client.write({
    filename: `session-${sessionId}-meta.json`,
    content: JSON.stringify(meta, null, 2),
    type: "session",
    bucket: "artifacts",
    mime: "application/json",
    metadata: { session_id: sessionId, query },
  });
}

export async function buildSessionSummary(
  query: string,
  state: EngineState,
  sessionId: string,
  _config: Config
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

  try {
    await client.write({
      filename: `session-${sessionId}-summary.md`,
      content: summary,
      type: "research",
      bucket: "artifacts",
      mime: "text/markdown",
      metadata: { session_id: sessionId, query },
    });
  } catch {
    // Non-critical — summary is returned to agent regardless
  }

  return summary;
}
