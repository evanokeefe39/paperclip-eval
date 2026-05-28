import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import * as fs from "node:fs";
import * as path from "node:path";
import { ulid } from "./workproduct-lib/ulid.js";
import { validateByStyle, type StyleProfiles } from "./workproduct-lib/validate.js";

// ---------------------------------------------------------------------------
// Writer content kinds
// ---------------------------------------------------------------------------

const ContentKind = Type.Union([
  Type.Literal("report"),
  Type.Literal("guide"),
  Type.Literal("article"),
  Type.Literal("marketing_copy"),
  Type.Literal("newsletter"),
], { description: "Type of written content." });

// ---------------------------------------------------------------------------
// Style validation profiles (per content kind)
// ---------------------------------------------------------------------------

const KIND_PROFILES: StyleProfiles = {
  sourceRequired: {
    report: [],
    guide: [],
    article: [],
    marketing_copy: [],
    newsletter: [],
  },
  sourceEncouraged: {
    report: [],
    guide: [],
    article: [],
    marketing_copy: [],
    newsletter: [],
  },
  recordEncouraged: {
    report: ["recommendations", "confidence", "topic_tags"],
    guide: ["prerequisites", "difficulty", "topic_tags"],
    article: ["tone", "seo_keywords", "topic_tags"],
    marketing_copy: ["format_constraints", "variants", "topic_tags"],
    newsletter: ["issue_number", "topic_tags"],
  },
};

const WRITER_KINDS = ["report", "guide", "article", "marketing_copy", "newsletter"] as const;

// ---------------------------------------------------------------------------
// Local filesystem storage helpers
// ---------------------------------------------------------------------------

const AGENT_NAME = process.env.AGENT_NAME || "unknown";

interface LocalRecord {
  id: string;
  agent: string;
  type: string;
  filename: string;
  timestamp: string;
  content: string;
  metadata: Record<string, unknown>;
}

function writeLocal(subdir: string, type: string, filename: string, content: string, metadata: Record<string, unknown>): { id: string } {
  const dir = path.join(process.cwd(), "workproduct", subdir);
  fs.mkdirSync(dir, { recursive: true });
  const id = ulid();
  const record: LocalRecord = {
    id,
    agent: AGENT_NAME,
    type,
    filename,
    timestamp: new Date().toISOString(),
    content,
    metadata,
  };
  fs.writeFileSync(path.join(dir, `${id}-${type}.json`), JSON.stringify(record, null, 2));
  return { id };
}

function readLocal(subdir: string, id: string): LocalRecord | null {
  const dir = path.join(process.cwd(), "workproduct", subdir);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  const match = files.find(f => f.startsWith(id));
  if (!match) return null;
  return JSON.parse(fs.readFileSync(path.join(dir, match), "utf8"));
}

function listLocal(subdir: string, filters?: { type?: string; session_id?: string; since?: string }): LocalRecord[] {
  const dir = path.join(process.cwd(), "workproduct", subdir);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  const records: LocalRecord[] = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as LocalRecord;
      if (filters?.type && rec.type !== filters.type) continue;
      if (filters?.session_id && rec.metadata.session_id !== filters.session_id) continue;
      if (filters?.since && rec.timestamp < filters.since) continue;
      records.push(rec);
    } catch { /* skip corrupt files */ }
  }
  return records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSessionId(): string {
  return process.env.PAPERCLIP_RUN_ID || process.env.SESSION_ID || "default";
}

function countWords(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function previewTitle(title: string): string {
  return title.length > 120 ? title.slice(0, 120) : title;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  if (AGENT_NAME !== "writer") {
    if (AGENT_NAME) {
      console.warn(
        `[workproduct] writer extension loaded in wrong agent: ${AGENT_NAME}`,
      );
    }
    return;
  }

  // ---- record_report ----
  pi.registerTool({
    name: "record_report",
    label: "Record Report",
    description:
      "Record a long-form report with executive summary, sections, and optional recommendations. " +
      "Stores content as a markdown artifact with structured metadata for discovery.",
    parameters: Type.Object({
      title: Type.String({ description: "Report title" }),
      audience: Type.String({ description: "Intended audience (e.g. 'CEO', 'engineering leads', 'public')" }),
      source_refs: Type.Array(Type.String(), {
        minItems: 1,
        description: "Artifact IDs of source findings, datasets, or briefs",
      }),
      content: Type.String({ description: "Full report body in markdown" }),
      sections: Type.Array(Type.String(), { description: "Ordered list of section headings" }),
      executive_summary: Type.String({ description: "1-3 paragraph summary at the top of the report" }),
      recommendations: Type.Optional(Type.Array(Type.String(), {
        description: "Actionable recommendations the report concludes with",
      })),
      confidence: Type.Optional(Type.Union([
        Type.Literal("high"),
        Type.Literal("medium"),
        Type.Literal("low"),
      ], { description: "Confidence in the report's conclusions" })),
      format_version: Type.Optional(Type.String()),
      topic_tags: Type.Optional(Type.Array(Type.String())),
      prior_content_refs: Type.Optional(Type.Array(Type.String(), {
        description: "Artifact IDs of related earlier content this report builds on",
      })),
    }),
    async execute(_toolCallId: string, params: Record<string, any>, _signal?: AbortSignal) {
      try {
        const wordCount = countWords(params.content);
        const sessionId = getSessionId();

        const { warnings } = validateByStyle(
          KIND_PROFILES, "report", [], params,
        );

        const metadata: Record<string, unknown> = {
          title: params.title,
          title_preview: previewTitle(params.title),
          audience: params.audience,
          source_refs: params.source_refs,
          sections: params.sections,
          executive_summary: params.executive_summary,
          recommendations: params.recommendations || [],
          confidence: params.confidence,
          format_version: params.format_version,
          topic_tags: params.topic_tags || [],
          prior_content_refs: params.prior_content_refs || [],
          word_count: wordCount,
          session_id: sessionId,
        };

        const result = writeLocal("content", "report", "report.md", params.content, metadata);

        const parts = [
          `Report recorded: ${result.id}`,
          `Title: ${params.title}`,
          `Words: ${wordCount}`,
          `Audience: ${params.audience}`,
        ];
        if (warnings.length > 0) parts.push(`\nWarnings:\n${warnings.join("\n")}`);

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: { id: result.id, word_count: wordCount, warnings },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });

  // ---- record_guide ----
  pi.registerTool({
    name: "record_guide",
    label: "Record Guide",
    description:
      "Record a how-to guide or tutorial with steps, prerequisites, and outcome. " +
      "Stores content as a markdown artifact with structured metadata.",
    parameters: Type.Object({
      title: Type.String({ description: "Guide title" }),
      audience: Type.String({ description: "Intended audience and skill level" }),
      source_refs: Type.Array(Type.String(), {
        minItems: 1,
        description: "Artifact IDs of source material",
      }),
      content: Type.String({ description: "Full guide body in markdown" }),
      prerequisites: Type.Optional(Type.Array(Type.String(), {
        description: "What the reader needs before starting",
      })),
      steps_count: Type.Integer({ minimum: 1, description: "Number of discrete steps in the guide" }),
      outcome: Type.String({ description: "What the reader will be able to do after completing the guide" }),
      difficulty: Type.Optional(Type.Union([
        Type.Literal("beginner"),
        Type.Literal("intermediate"),
        Type.Literal("advanced"),
      ])),
      format_version: Type.Optional(Type.String()),
      topic_tags: Type.Optional(Type.Array(Type.String())),
      prior_content_refs: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId: string, params: Record<string, any>, _signal?: AbortSignal) {
      try {
        const wordCount = countWords(params.content);
        const sessionId = getSessionId();

        const { warnings } = validateByStyle(
          KIND_PROFILES, "guide", [], params,
        );

        const metadata: Record<string, unknown> = {
          title: params.title,
          title_preview: previewTitle(params.title),
          audience: params.audience,
          source_refs: params.source_refs,
          prerequisites: params.prerequisites || [],
          steps_count: params.steps_count,
          outcome: params.outcome,
          difficulty: params.difficulty,
          format_version: params.format_version,
          topic_tags: params.topic_tags || [],
          prior_content_refs: params.prior_content_refs || [],
          word_count: wordCount,
          session_id: sessionId,
        };

        const result = writeLocal("content", "guide", "guide.md", params.content, metadata);

        const parts = [
          `Guide recorded: ${result.id}`,
          `Title: ${params.title}`,
          `Steps: ${params.steps_count}`,
          `Words: ${wordCount}`,
        ];
        if (warnings.length > 0) parts.push(`\nWarnings:\n${warnings.join("\n")}`);

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: { id: result.id, word_count: wordCount, warnings },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });

  // ---- record_article ----
  pi.registerTool({
    name: "record_article",
    label: "Record Article",
    description:
      "Record an editorial article with angle, target platform, and optional SEO metadata.",
    parameters: Type.Object({
      title: Type.String({ description: "Article title or headline" }),
      audience: Type.String({ description: "Intended readership" }),
      source_refs: Type.Array(Type.String(), {
        minItems: 1,
        description: "Artifact IDs of source findings, interviews, or research",
      }),
      content: Type.String({ description: "Full article body in markdown" }),
      angle: Type.String({ description: "Editorial angle or thesis the article advances" }),
      platform: Type.String({ description: "Publishing platform (e.g. 'company blog', 'Substack', 'Medium')" }),
      tone: Type.Optional(Type.String({ description: "Voice/tone descriptor (e.g. 'analytical', 'conversational')" })),
      seo_keywords: Type.Optional(Type.Array(Type.String(), {
        description: "Target SEO keywords",
      })),
      format_version: Type.Optional(Type.String()),
      topic_tags: Type.Optional(Type.Array(Type.String())),
      prior_content_refs: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId: string, params: Record<string, any>, _signal?: AbortSignal) {
      try {
        const wordCount = countWords(params.content);
        const sessionId = getSessionId();

        const { warnings } = validateByStyle(
          KIND_PROFILES, "article", [], params,
        );

        const metadata: Record<string, unknown> = {
          title: params.title,
          title_preview: previewTitle(params.title),
          audience: params.audience,
          source_refs: params.source_refs,
          angle: params.angle,
          platform: params.platform,
          tone: params.tone,
          seo_keywords: params.seo_keywords || [],
          format_version: params.format_version,
          topic_tags: params.topic_tags || [],
          prior_content_refs: params.prior_content_refs || [],
          word_count: wordCount,
          session_id: sessionId,
        };

        const result = writeLocal("content", "article", "article.md", params.content, metadata);

        const parts = [
          `Article recorded: ${result.id}`,
          `Title: ${params.title}`,
          `Platform: ${params.platform}`,
          `Words: ${wordCount}`,
        ];
        if (warnings.length > 0) parts.push(`\nWarnings:\n${warnings.join("\n")}`);

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: { id: result.id, word_count: wordCount, warnings },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });

  // ---- record_marketing_copy ----
  pi.registerTool({
    name: "record_marketing_copy",
    label: "Record Marketing Copy",
    description:
      "Record marketing/promotional copy for a specific platform with a call-to-action and optional variants. " +
      "Source refs are optional for marketing copy.",
    parameters: Type.Object({
      title: Type.String({ description: "Internal name for this copy (e.g. 'Q3 launch tweet thread')" }),
      audience: Type.String({ description: "Target audience segment" }),
      source_refs: Type.Optional(Type.Array(Type.String(), {
        description: "Optional artifact IDs of brand/product material",
      })),
      content: Type.String({ description: "The marketing copy itself" }),
      platform: Type.String({ description: "Distribution channel (e.g. 'Twitter', 'LinkedIn ad', 'landing page hero')" }),
      call_to_action: Type.String({ description: "Primary CTA the copy drives toward" }),
      format_constraints: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
        description: "Platform constraints (max chars, image requirements, etc.)",
      })),
      variants: Type.Optional(Type.Array(Type.String(), {
        description: "Alternate phrasings or A/B test variants",
      })),
      format_version: Type.Optional(Type.String()),
      topic_tags: Type.Optional(Type.Array(Type.String())),
      prior_content_refs: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId: string, params: Record<string, any>, _signal?: AbortSignal) {
      try {
        const wordCount = countWords(params.content);
        const sessionId = getSessionId();

        const { warnings } = validateByStyle(
          KIND_PROFILES, "marketing_copy", [], params,
        );

        const metadata: Record<string, unknown> = {
          title: params.title,
          title_preview: previewTitle(params.title),
          audience: params.audience,
          source_refs: params.source_refs || [],
          platform: params.platform,
          call_to_action: params.call_to_action,
          format_constraints: params.format_constraints,
          variants: params.variants || [],
          format_version: params.format_version,
          topic_tags: params.topic_tags || [],
          prior_content_refs: params.prior_content_refs || [],
          word_count: wordCount,
          session_id: sessionId,
        };

        const result = writeLocal("content", "marketing_copy", "marketing_copy.md", params.content, metadata);

        const parts = [
          `Marketing copy recorded: ${result.id}`,
          `Platform: ${params.platform}`,
          `CTA: ${params.call_to_action}`,
          `Words: ${wordCount}`,
        ];
        if (warnings.length > 0) parts.push(`\nWarnings:\n${warnings.join("\n")}`);

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: { id: result.id, word_count: wordCount, warnings },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });

  // ---- record_newsletter ----
  pi.registerTool({
    name: "record_newsletter",
    label: "Record Newsletter",
    description:
      "Record a newsletter issue with cadence, sections, and featured content references.",
    parameters: Type.Object({
      title: Type.String({ description: "Newsletter issue title" }),
      audience: Type.String({ description: "Subscriber audience" }),
      source_refs: Type.Array(Type.String(), {
        minItems: 1,
        description: "Artifact IDs of source content",
      }),
      content: Type.String({ description: "Full newsletter body in markdown" }),
      issue_number: Type.Optional(Type.Integer({ minimum: 1, description: "Sequential issue number" })),
      cadence: Type.Union([
        Type.Literal("daily"),
        Type.Literal("weekly"),
        Type.Literal("biweekly"),
        Type.Literal("monthly"),
        Type.Literal("ad_hoc"),
      ], { description: "Publishing cadence" }),
      sections: Type.Array(Type.String(), { description: "Ordered list of section headings" }),
      featured_items: Type.Array(Type.String(), {
        description: "Artifact IDs of featured content items in this issue",
      }),
      format_version: Type.Optional(Type.String()),
      topic_tags: Type.Optional(Type.Array(Type.String())),
      prior_content_refs: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId: string, params: Record<string, any>, _signal?: AbortSignal) {
      try {
        const wordCount = countWords(params.content);
        const sessionId = getSessionId();

        const { warnings } = validateByStyle(
          KIND_PROFILES, "newsletter", [], params,
        );

        const metadata: Record<string, unknown> = {
          title: params.title,
          title_preview: previewTitle(params.title),
          audience: params.audience,
          source_refs: params.source_refs,
          issue_number: params.issue_number,
          cadence: params.cadence,
          sections: params.sections,
          featured_items: params.featured_items,
          format_version: params.format_version,
          topic_tags: params.topic_tags || [],
          prior_content_refs: params.prior_content_refs || [],
          word_count: wordCount,
          session_id: sessionId,
        };

        const result = writeLocal("content", "newsletter", "newsletter.md", params.content, metadata);

        const parts = [
          `Newsletter recorded: ${result.id}`,
          `Title: ${params.title}`,
          `Cadence: ${params.cadence}`,
          `Featured items: ${params.featured_items.length}`,
          `Words: ${wordCount}`,
        ];
        if (warnings.length > 0) parts.push(`\nWarnings:\n${warnings.join("\n")}`);

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: { id: result.id, word_count: wordCount, warnings },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });

  // ---- query_content ----
  pi.registerTool({
    name: "query_content",
    label: "Query Content",
    description:
      "Search recorded writer content (reports, guides, articles, marketing copy, newsletters) with optional filters. " +
      "Returns matching items sorted by created_at descending.",
    parameters: Type.Object({
      kind: Type.Optional(ContentKind),
      agent: Type.Optional(Type.String({ description: "Filter by producing agent (defaults to own)" })),
      session_id: Type.Optional(Type.String({ description: "Filter by session" })),
      topic_tag: Type.Optional(Type.String({ description: "Filter by topic tag (substring match)" })),
      audience: Type.Optional(Type.String({ description: "Filter by audience (substring match)" })),
      since: Type.Optional(Type.String({ description: "ISO 8601 — only items after this timestamp" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Max results, default 50" })),
    }),
    async execute(_toolCallId: string, params: Record<string, any>, _signal?: AbortSignal) {
      try {
        let allRecords: LocalRecord[];
        if (params.kind) {
          allRecords = listLocal("content", {
            type: params.kind,
            session_id: params.session_id,
            since: params.since,
          });
        } else {
          allRecords = listLocal("content", {
            session_id: params.session_id,
            since: params.since,
          });
        }

        let items = allRecords.map(rec => ({ rec, m: rec.metadata as Record<string, any> }));

        if (params.topic_tag) {
          const tag = params.topic_tag.toLowerCase();
          items = items.filter(({ m }) => {
            const tags: string[] = m.topic_tags || [];
            return tags.some((t: string) => t.toLowerCase().includes(tag));
          });
        }
        if (params.audience) {
          const aud = params.audience.toLowerCase();
          items = items.filter(({ m }) => {
            const a: string = m.audience || "";
            return a.toLowerCase().includes(aud);
          });
        }

        items.sort((a, b) => b.rec.timestamp.localeCompare(a.rec.timestamp));

        const limit = params.limit || 50;
        items = items.slice(0, limit);

        if (items.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No content matches the filters." }],
            details: { count: 0 },
          };
        }

        const lines: string[] = [`Found ${items.length} item(s):\n`];
        for (const { rec, m } of items) {
          const title = m.title_preview || m.title || "(untitled)";
          const audience = m.audience || "—";
          const words = m.word_count ?? 0;
          lines.push(`[${rec.id}] ${rec.type} | ${title} | ${audience} | words=${words}`);
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { count: items.length },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });

  // ---- get_content ----
  pi.registerTool({
    name: "get_content",
    label: "Get Content",
    description: "Retrieve a specific piece of writer content by ULID. Returns metadata and full content.",
    parameters: Type.Object({
      id: Type.String({ description: "ULID of the content artifact" }),
    }),
    async execute(_toolCallId: string, params: Record<string, any>, _signal?: AbortSignal) {
      try {
        const rec = readLocal("content", params.id);
        if (!rec) {
          return {
            content: [{ type: "text" as const, text: `Error: artifact ${params.id} not found` }],
          };
        }
        if (!(WRITER_KINDS as readonly string[]).includes(rec.type)) {
          return {
            content: [{
              type: "text" as const,
              text: `Error: artifact ${params.id} is not writer content (type=${rec.type})`,
            }],
          };
        }

        const payload = {
          id: rec.id,
          kind: rec.type,
          agent: rec.agent,
          created_at: rec.timestamp,
          metadata: rec.metadata,
          content: rec.content,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: { id: rec.id, kind: rec.type },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });
}
