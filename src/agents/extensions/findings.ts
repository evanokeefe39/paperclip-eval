import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";

import * as client from "./artifact-client.js";
import { validateByStyle, type StyleProfiles } from "./workproduct/validate.js";

// ---------------------------------------------------------------------------
// TypeBox schemas (source of truth — matches findings-schema.md spec)
// ---------------------------------------------------------------------------

const SourceReliability = Type.Union([
  Type.Literal("A"), Type.Literal("B"), Type.Literal("C"),
  Type.Literal("D"), Type.Literal("E"), Type.Literal("F"),
], { description: "NATO ADMIRALTY source reliability: A=completely reliable, B=usually reliable, C=fairly reliable, D=not usually reliable, E=unreliable, F=cannot be judged" });

const InformationCredibility = Type.Union([
  Type.Literal(1), Type.Literal(2), Type.Literal(3),
  Type.Literal(4), Type.Literal(5), Type.Literal(6),
], { description: "NATO ADMIRALTY information credibility: 1=confirmed, 2=probably true, 3=possibly true, 4=doubtful, 5=improbable, 6=cannot be judged" });

const SourceType = Type.Union([
  Type.Literal("primary_official"),
  Type.Literal("structured_aggregator"),
  Type.Literal("news_editorial"),
  Type.Literal("press_release"),
  Type.Literal("academic_paper"),
  Type.Literal("industry_report"),
  Type.Literal("social_media"),
  Type.Literal("community_forum"),
  Type.Literal("blog_personal"),
  Type.Literal("api_data"),
  Type.Literal("dataset"),
  Type.Literal("other"),
], { description: "Structural classification of the source" });

const CollectionMethod = Type.Union([
  Type.Literal("web_search"),
  Type.Literal("api_query"),
  Type.Literal("web_scrape"),
  Type.Literal("deep_research"),
  Type.Literal("direct_reference"),
  Type.Literal("human_provided"),
  Type.Literal("database_query"),
], { description: "How this source was obtained" });

const Corroboration = Type.Union([
  Type.Literal("confirmed"),
  Type.Literal("probable"),
  Type.Literal("uncorroborated"),
  Type.Literal("conflicting"),
], { description: "Corroboration status across sources. Auto-inferred from source count if omitted." });

const FindingStyle = Type.Union([
  Type.Literal("intelligence"),
  Type.Literal("academic"),
  Type.Literal("journalism"),
  Type.Literal("data"),
  Type.Literal("general"),
], { description: "Citation/grading standard to apply. Determines which fields are required." });

const SourceSchema = Type.Object({
  source_name: Type.String({ description: "Human name: 'Crunchbase', 'TechCrunch', 'SEC EDGAR'" }),
  source_url: Type.String({ description: "URL of specific page or document" }),
  source_type: SourceType,
  source_reliability: Type.Optional(SourceReliability),
  information_credibility: Type.Optional(InformationCredibility),
  authors: Type.Optional(Type.Array(Type.String(), { description: "Named authors if known" })),
  publisher: Type.Optional(Type.String({ description: "Publishing organization" })),
  date_published: Type.Optional(Type.String({ description: "When source material was published (ISO 8601)" })),
  date_accessed: Type.Optional(Type.String({ description: "When retrieved — auto-set to now if omitted" })),
  collection_method: Type.Optional(CollectionMethod),
  doi: Type.Optional(Type.String({ description: "Digital Object Identifier if available" })),
  verbatim_quote: Type.Optional(Type.String({ description: "Exact quote from this specific source" })),
});

type SourceInput = Static<typeof SourceSchema>;

// ---------------------------------------------------------------------------
// Style validation profiles
// ---------------------------------------------------------------------------

const FINDING_PROFILES: StyleProfiles = {
  sourceRequired: {
    intelligence: ["source_reliability", "information_credibility", "date_accessed", "collection_method"],
    academic: ["authors", "date_published", "date_accessed"],
    journalism: ["authors", "date_published", "date_accessed"],
    data: ["date_accessed", "collection_method", "source_reliability", "information_credibility"],
    general: ["date_accessed"],
  },
  sourceEncouraged: {
    intelligence: ["verbatim_quote"],
    academic: ["publisher", "doi", "verbatim_quote"],
    journalism: ["publisher", "verbatim_quote", "source_reliability", "information_credibility"],
    data: [],
    general: [],
  },
  recordEncouraged: {
    intelligence: ["corroboration", "date_information"],
    academic: [],
    journalism: [],
    data: ["date_information", "corroboration"],
    general: [],
  },
};

// ---------------------------------------------------------------------------
// Domain logic
// ---------------------------------------------------------------------------

function inferCorroboration(sources: SourceInput[], explicit?: string): string {
  if (explicit) return explicit;
  const uniqueNames = new Set(sources.map(s => s.source_name.toLowerCase()));
  if (uniqueNames.size >= 3) return "confirmed";
  if (uniqueNames.size === 2) return "probable";
  return "uncorroborated";
}

function admiraltyGrade(sources: SourceInput[], primaryIndex: number): string | null {
  const primary = sources[primaryIndex];
  if (!primary) return null;
  if (primary.source_reliability && primary.information_credibility) {
    return `${primary.source_reliability}${primary.information_credibility}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// StoredFinding type (used as metadata shape)
// ---------------------------------------------------------------------------

interface StoredFinding {
  id: string;
  session_id: string;
  agent: string;
  timestamp: string;
  claim_preview: string;
  style: string;
  claim: string;
  sources: SourceInput[];
  primary_source_index: number;
  corroboration: string;
  date_information?: string;
  topic_tags: string[];
  entities: string[];
  related_findings: string[];
  contradicts: string[];
}

// ---------------------------------------------------------------------------
// Prompt snippets per style
// ---------------------------------------------------------------------------

const INTELLIGENCE_SNIPPET = `Record every discrete factual claim using record_finding with style "intelligence".

ADMIRALTY grading (required for each source):
  Source Reliability: A=completely reliable, B=usually reliable, C=fairly reliable, D=not usually reliable, E=unreliable, F=cannot be judged
  Information Credibility: 1=confirmed, 2=probably true, 3=possibly true, 4=doubtful, 5=improbable, 6=cannot be judged

Multiple sources on one finding strengthen corroboration. Use add_source to append corroborating sources to existing findings.
Use query_findings to search recorded findings. Use get_finding to retrieve a specific finding by ID.`;

const DATA_SNIPPET = `Record every discrete data point using record_finding with style "data".

ADMIRALTY grading (required for each source):
  Source Reliability: A=completely reliable (official API), B=usually reliable (established aggregator), C=fairly reliable, D-F=increasing doubt
  Information Credibility: 1=confirmed by multiple sources, 2=probably true, 3=possibly true, 4=doubtful, 5=improbable, 6=cannot judge

Use add_source to attach corroborating sources to existing findings.
Use query_findings to search recorded findings. Use get_finding to retrieve by ID.`;

const GENERAL_SNIPPET = `Record findings using record_finding. Choose a style: intelligence (ADMIRALTY grading), academic (author/publisher focus), journalism (byline/quote focus), data (API/dataset focus), or general (minimal requirements).
Use add_source to attach additional sources to existing findings.
Use query_findings to search. Use get_finding to retrieve by ID.`;

function getPromptSnippet(): string {
  const defaultStyle = process.env.FINDING_STYLE || "";
  if (defaultStyle === "intelligence") return INTELLIGENCE_SNIPPET;
  if (defaultStyle === "data") return DATA_SNIPPET;
  return GENERAL_SNIPPET;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSessionId(): string {
  return process.env.PAPERCLIP_RUN_ID || process.env.SESSION_ID || "default";
}

/** Reconstruct a StoredFinding from an ArtifactRecord + its content. */
function recordToFinding(rec: client.ArtifactRecord, content: string): StoredFinding {
  const m = rec.metadata as Record<string, any>;
  return {
    id: rec.id,
    session_id: m.session_id || "",
    agent: rec.agent_name,
    timestamp: rec.created_at,
    claim_preview: m.claim_preview || "",
    style: m.style || "general",
    claim: content,
    sources: m.sources || [],
    primary_source_index: m.primary_source_index ?? 0,
    corroboration: m.corroboration || "uncorroborated",
    date_information: m.date_information,
    topic_tags: m.topic_tags || [],
    entities: m.entities || [],
    related_findings: m.related_findings || [],
    contradicts: m.contradicts || [],
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  if (!client.getAgentName()) return;

  const snippet = getPromptSnippet();
  const agentName = client.getAgentName();

  // ---- record_finding ----
  pi.registerTool({
    name: "record_finding",
    label: "Record Finding",
    description:
      "Record a structured finding with one or more sources, ADMIRALTY grading, and provenance metadata. " +
      "Style determines which fields are required: intelligence (ADMIRALTY + collection_method), academic (authors + dates), " +
      "journalism (byline + quotes), data (ADMIRALTY + collection_method), general (minimal).",
    promptSnippet: snippet,
    parameters: Type.Object({
      style: FindingStyle,
      claim: Type.String({ description: "The specific factual assertion" }),
      sources: Type.Array(SourceSchema, {
        minItems: 1,
        description: "One or more sources supporting this finding",
      }),
      primary_source_index: Type.Optional(Type.Integer({
        minimum: 0,
        description: "Index into sources[] for the strongest source. Defaults to 0.",
      })),
      corroboration: Type.Optional(Corroboration),
      date_information: Type.Optional(Type.String({
        description: "When the information is FROM if different from access/publish dates",
      })),
      topic_tags: Type.Optional(Type.Array(Type.String())),
      entities: Type.Optional(Type.Array(Type.String(), {
        description: "Named entities: companies, people, products",
      })),
      related_findings: Type.Optional(Type.Array(Type.String())),
      contradicts: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId: string, params: Record<string, any>, _signal?: AbortSignal) {
      try {
        const style = params.style as string;
        const sources: SourceInput[] = params.sources;
        const now = new Date().toISOString();

        for (const src of sources) {
          if (!src.date_accessed) src.date_accessed = now;
        }

        const { errors, warnings } = validateByStyle(
          FINDING_PROFILES, style, sources as Record<string, unknown>[], params,
        );
        if (errors.length > 0) {
          return {
            content: [{ type: "text" as const, text: `Validation failed:\n${errors.join("\n")}` }],
          };
        }

        const primaryIdx = params.primary_source_index ?? 0;
        if (primaryIdx >= sources.length) {
          return {
            content: [{ type: "text" as const, text: `Error: primary_source_index ${primaryIdx} exceeds sources length ${sources.length}` }],
          };
        }

        const corroboration = inferCorroboration(sources, params.corroboration);
        const grade = admiraltyGrade(sources, primaryIdx);
        const sessionId = getSessionId();

        const result = await client.write({
          type: "finding",
          bucket: "artifacts",
          filename: "finding.json",
          mime: "application/json",
          content: JSON.stringify(params.claim),
          metadata: {
            style,
            sources,
            primary_source_index: primaryIdx,
            corroboration,
            admiralty_grade: grade,
            date_information: params.date_information || undefined,
            topic_tags: params.topic_tags || [],
            entities: params.entities || [],
            related_findings: params.related_findings || [],
            contradicts: params.contradicts || [],
            claim_preview: params.claim.slice(0, 120),
            session_id: sessionId,
          },
          run_id: sessionId,
        });

        const parts = [`Finding recorded: ${result.id}`];
        if (grade) parts.push(`ADMIRALTY grade: ${grade}`);
        parts.push(`Corroboration: ${corroboration}`);
        parts.push(`Sources: ${sources.length}`);
        if (warnings.length > 0) {
          parts.push(`\nWarnings:\n${warnings.join("\n")}`);
        }

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: { id: result.id, admiralty_grade: grade, corroboration, source_count: sources.length, warnings },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });

  // ---- add_source ----
  pi.registerTool({
    name: "add_source",
    label: "Add Source to Finding",
    description:
      "Append an additional source to an existing finding. Recalculates corroboration if it was auto-inferred. " +
      "Use this when you discover a corroborating source for an already-recorded finding.",
    parameters: Type.Object({
      finding_id: Type.String({ description: "ULID of the existing finding" }),
      source: SourceSchema,
    }),
    async execute(_toolCallId: string, params: Record<string, any>, _signal?: AbortSignal) {
      try {
        const { content: rawContent, metadata: rec } = await client.read(params.finding_id);
        if (rec.artifact_type !== "finding") {
          return { content: [{ type: "text" as const, text: `Error: artifact ${params.finding_id} is not a finding` }] };
        }

        const m = rec.metadata as Record<string, any>;
        const existingSources: SourceInput[] = m.sources || [];
        const style: string = m.style || "general";

        const src: SourceInput = params.source;
        if (!src.date_accessed) src.date_accessed = new Date().toISOString();

        const { errors, warnings } = validateByStyle(
          FINDING_PROFILES, style, [src] as Record<string, unknown>[], {},
        );
        if (errors.length > 0) {
          return {
            content: [{ type: "text" as const, text: `Validation failed for new source:\n${errors.join("\n")}` }],
          };
        }

        const updatedSources = [...existingSources, src];
        const corroboration = inferCorroboration(updatedSources);
        const primaryIdx: number = m.primary_source_index ?? 0;

        await client.updateMetadata(params.finding_id, {
          ...m,
          sources: updatedSources,
          corroboration,
        });

        const grade = admiraltyGrade(updatedSources, primaryIdx);
        const parts = [
          `Source added to finding ${params.finding_id}`,
          `Sources: ${updatedSources.length}`,
          `Corroboration: ${corroboration}`,
        ];
        if (grade) parts.push(`Primary ADMIRALTY grade: ${grade}`);
        if (warnings.length > 0) parts.push(`\nWarnings:\n${warnings.join("\n")}`);

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: { finding_id: params.finding_id, source_count: updatedSources.length, corroboration },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });

  // ---- query_findings ----
  pi.registerTool({
    name: "query_findings",
    label: "Query Findings",
    description:
      "Search recorded findings with optional filters. Returns matching findings sorted by timestamp descending.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Filter by producing agent" })),
      session_id: Type.Optional(Type.String({ description: "Filter by research session" })),
      topic_tag: Type.Optional(Type.String({ description: "Filter by topic tag (substring match)" })),
      entity: Type.Optional(Type.String({ description: "Filter by named entity (substring match)" })),
      min_reliability: Type.Optional(SourceReliability),
      max_credibility: Type.Optional(InformationCredibility),
      since: Type.Optional(Type.String({ description: "ISO 8601 — only findings after this timestamp" })),
      style: Type.Optional(FindingStyle),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Max results, default 50" })),
    }),
    async execute(_toolCallId: string, params: Record<string, any>, _signal?: AbortSignal) {
      try {
        const targetAgent = params.agent || agentName;

        // Build metadata filter for server-side JSONB containment
        const metadataFilter: Record<string, unknown> = {};
        if (params.style) metadataFilter.style = params.style;
        if (params.session_id) metadataFilter.session_id = params.session_id;

        const records = await client.list({
          type: "finding",
          agent: targetAgent,
          since: params.since,
          metadata: Object.keys(metadataFilter).length > 0 ? metadataFilter : undefined,
        });

        // Post-filter for criteria the metastore cannot handle (substring, numeric comparison)
        const reliabilityOrder = "ABCDEF";
        let findings: Array<{ rec: client.ArtifactRecord; m: Record<string, any> }> = records.map(rec => ({
          rec,
          m: rec.metadata as Record<string, any>,
        }));

        if (params.topic_tag) {
          const tag = params.topic_tag.toLowerCase();
          findings = findings.filter(({ m }) => {
            const tags: string[] = m.topic_tags || [];
            return tags.some((t: string) => t.toLowerCase().includes(tag));
          });
        }
        if (params.entity) {
          const ent = params.entity.toLowerCase();
          findings = findings.filter(({ m }) => {
            const entities: string[] = m.entities || [];
            return entities.some((e: string) => e.toLowerCase().includes(ent));
          });
        }
        if (params.min_reliability) {
          const minIdx = reliabilityOrder.indexOf(params.min_reliability);
          findings = findings.filter(({ m }) => {
            const sources: SourceInput[] = m.sources || [];
            const primary = sources[m.primary_source_index ?? 0];
            if (!primary?.source_reliability) return false;
            return reliabilityOrder.indexOf(primary.source_reliability) <= minIdx;
          });
        }
        if (params.max_credibility) {
          findings = findings.filter(({ m }) => {
            const sources: SourceInput[] = m.sources || [];
            const primary = sources[m.primary_source_index ?? 0];
            if (!primary?.information_credibility) return false;
            return primary.information_credibility <= params.max_credibility;
          });
        }

        // Sort by created_at DESC (service may already do this, but ensure it)
        findings.sort((a, b) => b.rec.created_at.localeCompare(a.rec.created_at));

        const limit = params.limit || 50;
        findings = findings.slice(0, limit);

        if (findings.length === 0) {
          return { content: [{ type: "text" as const, text: "No findings match the filters." }], details: { count: 0 } };
        }

        const lines: string[] = [`Found ${findings.length} finding(s):\n`];
        for (const { rec, m } of findings) {
          const sources: SourceInput[] = m.sources || [];
          const primary = sources[m.primary_source_index ?? 0];
          const grade = primary?.source_reliability && primary?.information_credibility
            ? `${primary.source_reliability}${primary.information_credibility}`
            : "—";
          lines.push(`- [${rec.id}] ${grade} | ${m.corroboration || "uncorroborated"} | ${sources.length} src | ${m.claim_preview || ""}`);
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { count: findings.length },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });

  // ---- get_finding ----
  pi.registerTool({
    name: "get_finding",
    label: "Get Finding",
    description: "Retrieve a specific finding by its ULID. Returns full finding with all sources and metadata.",
    parameters: Type.Object({
      id: Type.String({ description: "ULID of the finding" }),
    }),
    async execute(_toolCallId: string, params: Record<string, any>, _signal?: AbortSignal) {
      try {
        const { content: rawContent, metadata: rec } = await client.read(params.id);

        const claim = rawContent.toString("utf8");
        const finding = recordToFinding(rec, JSON.parse(claim));
        const grade = admiraltyGrade(finding.sources, finding.primary_source_index);

        const text = JSON.stringify(finding, null, 2);
        return {
          content: [{ type: "text" as const, text }],
          details: { id: finding.id, admiralty_grade: grade },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });
}
