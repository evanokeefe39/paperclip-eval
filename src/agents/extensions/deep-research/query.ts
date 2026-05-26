import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IndexEntry, Finding } from "./types.js";
import type { Config } from "./config.js";

export async function queryIndex(
  query: string,
  maxResults: number,
  config: Config,
  sessionFilter?: string
): Promise<IndexEntry[]> {
  const indexPath = `${config.artifacts_base}/index.jsonl`;
  if (!existsSync(indexPath)) return [];

  const queryTerms = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (queryTerms.length === 0) return [];

  const results: { entry: IndexEntry; score: number }[] = [];

  const lines = (await readFile(indexPath, "utf-8")).split("\n").filter(Boolean);
  for (const line of lines) {
    const entry: IndexEntry = JSON.parse(line);
    if (sessionFilter && entry.session_id !== sessionFilter) continue;

    const searchText = [
      entry.claim_preview,
      ...entry.topic_tags,
      ...entry.entities.map(e => e.name),
    ].join(" ").toLowerCase();

    const matches = queryTerms.filter(t => searchText.includes(t)).length;
    if (matches === 0) continue;

    // Weight term coverage by confidence so high-confidence findings rank higher
    const score = (matches / queryTerms.length) * entry.confidence;
    results.push({ entry, score });
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(r => r.entry);
}

export async function getFullFinding(findingId: string, sessionId: string, config: Config): Promise<Finding | null> {
  const path = `${config.artifacts_base}/sessions/${sessionId}/findings.jsonl`;
  if (!existsSync(path)) return null;

  const lines = (await readFile(path, "utf-8")).split("\n").filter(Boolean);
  for (const line of lines) {
    const f: Finding = JSON.parse(line);
    if (f.id === findingId) return f;
  }
  return null;
}
