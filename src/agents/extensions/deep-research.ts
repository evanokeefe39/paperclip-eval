import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONFIG } from "./deep-research/config.js";
import type { Config } from "./deep-research/config.js";
import type { Finding } from "./deep-research/types.js";
import { deepResearchWithRetry } from "./deep-research/engine.js";
import { queryIndex, getFullFinding } from "./deep-research/query.js";
import { initSession, streamFinding } from "./deep-research/store.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "deep_research",
    label: "Deep Research",
    description:
      "Execute comprehensive multi-iteration research. Searches hundreds of sources per sub-query, extracts findings with full provenance, streams to knowledge store. Auto-resumes interrupted sessions.",
    parameters: Type.Object({
      query: Type.String({ description: "Research query" }),
      max_iterations: Type.Optional(Type.Number({ description: "Max research iterations (default 3)" })),
      max_sub_queries: Type.Optional(Type.Number({ description: "Max sub-queries per plan (default 6)" })),
    }),
    async execute(_id: string, params: Record<string, any>, signal?: AbortSignal) {
      const config: Config = {
        ...DEFAULT_CONFIG,
        ...(params.max_iterations != null ? { max_iterations: params.max_iterations } : {}),
        ...(params.max_sub_queries != null ? { max_sub_queries: params.max_sub_queries } : {}),
      };
      const result = await deepResearchWithRetry(params.query, config, signal);

      if (result.interrupted) {
        return {
          content: [{ type: "text" as const, text: result.summary }],
          details: { interrupted: true, sessionId: result.sessionId },
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: [
            "## Research Complete",
            `Session: ${result.sessionId}`,
            `Findings: ${result.findingCount}`,
            "",
            result.summary,
            "",
            `Full data: /artifacts/research/sessions/${result.sessionId}/`,
          ].join("\n"),
        }],
      };
    },
  });

  pi.registerTool({
    name: "deep_research_resume",
    label: "Resume Research",
    description:
      "Resume an interrupted research session. Skips completed sub-queries, retries failed ones. Use when a previous deep_research was interrupted.",
    parameters: Type.Object({
      session_id: Type.Optional(Type.String({ description: "Session to resume (auto-detects if omitted)" })),
      query: Type.Optional(Type.String({ description: "Original query (for auto-detection)" })),
    }),
    async execute(_id: string, params: Record<string, any>, signal?: AbortSignal) {
      const config = DEFAULT_CONFIG;
      const result = await deepResearchWithRetry(params.query || "", config, signal);
      return {
        content: [{
          type: "text" as const,
          text: result.interrupted
            ? result.summary
            : `Resumed and completed session ${result.sessionId}. ${result.findingCount} findings.`,
        }],
      };
    },
  });

  pi.registerTool({
    name: "research_query",
    label: "Query Research",
    description:
      "Query existing research findings across all sessions. Search by entity, topic, or keyword. Use before starting new research to check what's already known.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      max_results: Type.Optional(Type.Number({ description: "Max findings (default 20)" })),
      session_id: Type.Optional(Type.String({ description: "Limit to session" })),
      include_full: Type.Optional(Type.Boolean({ description: "Include full chunk text (default false)" })),
    }),
    async execute(_id: string, params: Record<string, any>) {
      const entries = await queryIndex(
        params.query,
        params.max_results || 20,
        DEFAULT_CONFIG,
        params.session_id,
      );

      if (entries.length === 0) {
        return { content: [{ type: "text" as const, text: "No existing findings match this query." }] };
      }

      const lines = [
        `## Existing findings for: ${params.query}`,
        `Found ${entries.length} results:`,
        "",
      ];

      for (const [i, entry] of entries.entries()) {
        lines.push(`${i + 1}. [${entry.confidence.toFixed(1)}] ${entry.claim_preview}`);
        lines.push(`   Source: ${entry.source_url}`);
        lines.push(`   Entities: ${entry.entities.map(e => e.name).join(", ")}`);
        lines.push(`   Session: ${entry.session_id} (${entry.timestamp})`);

        if (params.include_full) {
          const full = await getFullFinding(entry.id, entry.session_id, DEFAULT_CONFIG);
          if (full) lines.push(`   Quote: "${full.verbatim_quote}"`);
        }
        lines.push("");
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  });

  pi.registerTool({
    name: "research_enrich",
    label: "Enrich Research",
    description:
      "Add findings from external sources (datasets, analysis, manual research) to the knowledge store. Used by Data agent to enrich existing research.",
    parameters: Type.Object({
      session_id: Type.Optional(Type.String({ description: "Attach to session or create new" })),
      findings: Type.Array(Type.Object({
        claim: Type.String(),
        source_url: Type.String({ description: "Can be 'internal:dataset:name.csv'" }),
        source_title: Type.String(),
        confidence: Type.Number(),
        verbatim_quote: Type.Optional(Type.String()),
        topic_tags: Type.Optional(Type.Array(Type.String())),
        entities: Type.Optional(Type.Array(Type.Object({
          name: Type.String(),
          type: Type.String(),
        }))),
      })),
    }),
    async execute(_id: string, params: Record<string, any>) {
      const sessionId = params.session_id || `enrichment-${randomUUID()}`;
      await initSession(sessionId, "enrichment", DEFAULT_CONFIG);

      for (const raw of params.findings) {
        const finding: Finding = {
          id: randomUUID(),
          session_id: sessionId,
          timestamp: new Date().toISOString(),
          claim: raw.claim,
          claim_preview: raw.claim.length > DEFAULT_CONFIG.claim_preview_length
            ? raw.claim.slice(0, DEFAULT_CONFIG.claim_preview_length - 3) + "..."
            : raw.claim,
          confidence: raw.confidence,
          source_url: raw.source_url,
          source_title: raw.source_title,
          verbatim_quote: raw.verbatim_quote || "",
          full_chunk: "",
          page_snapshot_path: "",
          sub_query: "enrichment",
          sub_query_id: "enrichment",
          topic_tags: raw.topic_tags || [],
          entities: (raw.entities || []).map((e: any) => ({ name: e.name, type: e.type })),
          related_findings: [],
          contradicts: [],
        };
        await streamFinding(finding, sessionId, DEFAULT_CONFIG);
      }

      return {
        content: [{
          type: "text" as const,
          text: `Added ${params.findings.length} findings to session ${sessionId}.`,
        }],
      };
    },
  });
}
