import * as client from "../artifact-client.js";
import type { IndexEntry, Finding } from "./types.js";
import type { Config } from "./config.js";

export async function queryIndex(
  query: string,
  maxResults: number,
  _config: Config,
  sessionFilter?: string
): Promise<IndexEntry[]> {
  const filters: Record<string, unknown> = { type: "research" };
  if (sessionFilter) {
    filters.metadata = { session_id: sessionFilter };
  }

  let records;
  try {
    records = await client.list(filters as any);
  } catch {
    return [];
  }

  const queryTerms = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (queryTerms.length === 0) return [];

  const results: { entry: IndexEntry; score: number }[] = [];

  for (const record of records) {
    const meta = record.metadata as Record<string, any>;
    if (sessionFilter && meta.session_id !== sessionFilter) continue;

    const entry: IndexEntry = {
      id: record.id,
      claim_preview: meta.claim_preview || "",
      confidence: meta.confidence || 0,
      source_url: meta.source_url || "",
      session_id: meta.session_id || "",
      timestamp: record.created_at,
      topic_tags: meta.topic_tags || [],
      entities: meta.entities || [],
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
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(r => r.entry);
}

export async function getFullFinding(findingId: string, _sessionId: string, _config: Config): Promise<Finding | null> {
  try {
    const result = await client.read(findingId);
    return JSON.parse(result.content.toString("utf8")) as Finding;
  } catch {
    return null;
  }
}
