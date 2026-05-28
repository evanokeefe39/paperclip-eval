import * as fs from "node:fs";
import * as path from "node:path";
import type { IndexEntry, Finding } from "./types.js";
import type { Config } from "./config.js";

export async function queryIndex(
  query: string,
  maxResults: number,
  _config: Config,
  sessionFilter?: string
): Promise<IndexEntry[]> {
  const baseDir = path.join(process.cwd(), "deep-research");
  if (!fs.existsSync(baseDir)) return [];

  // Collect findings from all sessions (or filtered session)
  const sessions = sessionFilter
    ? [sessionFilter]
    : fs.readdirSync(baseDir).filter(d => fs.statSync(path.join(baseDir, d)).isDirectory());

  const queryTerms = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (queryTerms.length === 0) return [];

  const results: { entry: IndexEntry; score: number }[] = [];

  for (const session of sessions) {
    const findingsDir = path.join(baseDir, session, "findings");
    if (!fs.existsSync(findingsDir)) continue;

    for (const file of fs.readdirSync(findingsDir).filter(f => f.endsWith(".json"))) {
      try {
        const finding = JSON.parse(fs.readFileSync(path.join(findingsDir, file), "utf8"));

        const entry: IndexEntry = {
          id: finding.id,
          claim_preview: finding.claim_preview || "",
          confidence: finding.confidence || 0,
          source_url: finding.source_url || "",
          session_id: session,
          timestamp: finding.timestamp || "",
          topic_tags: finding.topic_tags || [],
          entities: finding.entities || [],
        };

        const searchText = [
          entry.claim_preview,
          ...entry.topic_tags,
          ...entry.entities.map((e: any) => typeof e === "string" ? e : e.name),
        ].join(" ").toLowerCase();

        const matches = queryTerms.filter(t => searchText.includes(t)).length;
        if (matches === 0) continue;

        const score = (matches / queryTerms.length) * entry.confidence;
        results.push({ entry, score });
      } catch { /* skip corrupt files */ }
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(r => r.entry);
}

export async function getFullFinding(findingId: string, sessionId: string, _config: Config): Promise<Finding | null> {
  const findingsDir = path.join(process.cwd(), "deep-research", sessionId, "findings");
  const filePath = path.join(findingsDir, `finding-${findingId}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Finding;
  } catch {
    return null;
  }
}
