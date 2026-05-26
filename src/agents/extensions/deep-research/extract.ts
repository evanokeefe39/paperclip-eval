import { randomUUID } from "node:crypto";
import type { Finding, SubQuery, RankedSnippet } from "./types.js";
import type { Config } from "./config.js";
import { structuredCall, buildLLMConfig } from "./llm.js";
import { SELECT_PROMPT, EXTRACT_PROMPT } from "./prompts.js";
import { streamFinding, storePage } from "./store.js";
import { validateSelectResponse, validateExtractResponse } from "./validate.js";

export async function selectUrls(
  subQueryText: string,
  survivors: RankedSnippet[],
  config: Config,
  signal?: AbortSignal,
): Promise<string[]> {
  const llmConfig = buildLLMConfig(config);

  const formatted = survivors
    .slice(0, config.snippet_cap_for_llm)
    .map(
      (s, i) =>
        `${i + 1}. [${s.combined_score.toFixed(2)}] ${s.title}\n   URL: ${s.url}\n   ${(s.text || "").slice(0, config.min_content_length)}`,
    )
    .join("\n\n");

  const userContent = `Sub-query: ${subQueryText}\n\nRanked snippets:\n${formatted}`;

  try {
    const result = await structuredCall<{ selected_urls: string[] }>(
      llmConfig,
      SELECT_PROMPT,
      userContent,
      validateSelectResponse,
      config,
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
  const snapshotPath = await storePage(sessionId, url, fullContent, config);

  for (const chunk of chunks) {
    if (chunk.trim().length < config.min_chunk_length) continue;

    const userContent = [
      `Sub-query: ${subQuery.query}`,
      `Source: ${title} (${url})`,
      "",
      "Content:",
      chunk,
    ].join("\n");

    try {
      const result = await structuredCall(
        llmConfig,
        EXTRACT_PROMPT,
        userContent,
        validateExtractResponse,
        config,
        signal,
      );

      for (const raw of result.findings || []) {
        if (!raw.claim || raw.claim.length < 10) continue;

        const rawAny = raw as Record<string, unknown>;
        const finding: Finding = {
          id: randomUUID(),
          session_id: sessionId,
          timestamp: new Date().toISOString(),
          claim: raw.claim,
          claim_preview:
            raw.claim.length > config.claim_preview_length
              ? raw.claim.slice(0, config.claim_preview_length - 3) + "..."
              : raw.claim,
          confidence: Math.max(0, Math.min(1, raw.confidence || 0.5)),
          source_url: url,
          source_title: title,
          verbatim_quote: (rawAny.verbatim_quote as string) || "",
          full_chunk: chunk,
          page_snapshot_path: snapshotPath,
          sub_query: subQuery.query,
          sub_query_id: subQuery.id,
          topic_tags: raw.topic_tags || [],
          entities: ((rawAny.entities as Array<{ name: string; type: string }>) || []).map((e) => ({
            name: e.name,
            type: e.type,
          })),
          related_findings: [],
          contradicts: [],
        };

        allFindings.push(finding);
        await streamFinding(finding, sessionId, config);
      }
    } catch {
      continue;
    }
  }

  return allFindings;
}
