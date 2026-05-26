import { randomUUID } from "node:crypto";
import type { Finding, SubQuery, RankedSnippet, LLMConfig } from "./types.js";
import type { Config } from "./config.js";
import { structuredCall, buildLLMConfig } from "./llm.js";
import { SELECT_PROMPT, EXTRACT_PROMPT } from "./prompts.js";
import { streamFinding, storePage } from "./store.js";

interface SelectResponse {
  selected_urls: string[];
  reason: string;
}

interface ExtractedFinding {
  claim: string;
  verbatim_quote: string;
  confidence: number;
  topic_tags: string[];
  entities: { name: string; type: string }[];
}

interface ExtractResponse {
  findings: ExtractedFinding[];
}

export async function selectUrls(
  subQueryText: string,
  survivors: RankedSnippet[],
  config: Config,
  signal?: AbortSignal,
): Promise<string[]> {
  const llmConfig = buildLLMConfig(config);

  const formatted = survivors
    .slice(0, 40)
    .map(
      (s, i) =>
        `${i + 1}. [${s.combined_score.toFixed(2)}] ${s.title}\n   URL: ${s.url}\n   ${(s.text || "").slice(0, 200)}`,
    )
    .join("\n\n");

  const userContent = `Sub-query: ${subQueryText}\n\nRanked snippets:\n${formatted}`;

  try {
    const result = await structuredCall<SelectResponse>(
      llmConfig,
      SELECT_PROMPT,
      userContent,
      signal,
    );
    return result.selected_urls || [];
  } catch {
    // LLM failure fallback: take top K URLs by combined score
    return survivors.slice(0, config.top_k_for_extraction).map((s) => s.url);
  }
}

export async function extractFromPage(
  url: string,
  title: string,
  chunks: string[],
  subQuery: SubQuery,
  sessionId: string,
  config: Config,
  signal?: AbortSignal,
): Promise<Finding[]> {
  const llmConfig = buildLLMConfig(config);
  const allFindings: Finding[] = [];

  const fullContent = chunks.join("\n\n---\n\n");
  const snapshotPath = storePage(sessionId, url, fullContent, config);

  for (const chunk of chunks) {
    if (chunk.trim().length < 100) continue;

    const userContent = [
      `Sub-query: ${subQuery.query}`,
      `Source: ${title} (${url})`,
      "",
      "Content:",
      chunk,
    ].join("\n");

    try {
      const result = await structuredCall<ExtractResponse>(
        llmConfig,
        EXTRACT_PROMPT,
        userContent,
        signal,
      );

      for (const raw of result.findings || []) {
        if (!raw.claim || raw.claim.length < 10) continue;

        const finding: Finding = {
          id: randomUUID(),
          session_id: sessionId,
          timestamp: new Date().toISOString(),
          claim: raw.claim,
          claim_preview:
            raw.claim.length > 120
              ? raw.claim.slice(0, 117) + "..."
              : raw.claim,
          confidence: Math.max(0, Math.min(1, raw.confidence || 0.5)),
          source_url: url,
          source_title: title,
          verbatim_quote: raw.verbatim_quote || "",
          full_chunk: chunk,
          page_snapshot_path: snapshotPath,
          sub_query: subQuery.query,
          sub_query_id: subQuery.id,
          topic_tags: raw.topic_tags || [],
          entities: (raw.entities || []).map((e) => ({
            name: e.name,
            type: e.type,
          })),
          related_findings: [],
          contradicts: [],
        };

        allFindings.push(finding);
        streamFinding(finding, sessionId, config);
      }
    } catch {
      continue;
    }
  }

  return allFindings;
}
