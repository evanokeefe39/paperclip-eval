import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Finding, SessionMeta, SubQuery, EngineState } from "./types.js";
import type { Config } from "./config.js";

export async function initSession(sessionId: string, _query: string, _config: Config): Promise<void> {
  const base = path.join(process.cwd(), "deep-research", sessionId);
  fs.mkdirSync(path.join(base, "findings"), { recursive: true });
  fs.mkdirSync(path.join(base, "pages"), { recursive: true });
}

export async function streamFinding(finding: Finding, sessionId: string, _config: Config): Promise<void> {
  const dir = path.join(process.cwd(), "deep-research", sessionId, "findings");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `finding-${finding.id}.json`),
    JSON.stringify(finding, null, 2)
  );
}

export async function storePage(sessionId: string, url: string, content: string, _config: Config): Promise<string> {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const dir = path.join(process.cwd(), "deep-research", sessionId, "pages");
  fs.mkdirSync(dir, { recursive: true });
  const filename = `page-${hash}.md`;
  fs.writeFileSync(
    path.join(dir, filename),
    `<!-- Source: ${url} -->\n<!-- Captured: ${new Date().toISOString()} -->\n\n${content}`
  );
  return filename;
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
  const base = path.join(process.cwd(), "deep-research", sessionId);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "session-meta.json"), JSON.stringify(meta, null, 2));
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
    const base = path.join(process.cwd(), "deep-research", sessionId);
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, "session-summary.md"), summary);
  } catch {
    // Non-critical — summary is returned to agent regardless
  }

  return summary;
}
