import { Type } from "typebox";

// ADMIRALTY grading (source reliability + information credibility)
export const SourceReliability = Type.Union([
  Type.Literal("A"), Type.Literal("B"), Type.Literal("C"),
  Type.Literal("D"), Type.Literal("E"), Type.Literal("F"),
], { description: "NATO ADMIRALTY source reliability: A=completely reliable, B=usually reliable, C=fairly reliable, D=not usually reliable, E=unreliable, F=cannot be judged" });

export const InformationCredibility = Type.Union([
  Type.Literal(1), Type.Literal(2), Type.Literal(3),
  Type.Literal(4), Type.Literal(5), Type.Literal(6),
], { description: "NATO ADMIRALTY information credibility: 1=confirmed, 2=probably true, 3=possibly true, 4=doubtful, 5=improbable, 6=cannot be judged" });

export const SourceType = Type.Union([
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

export const CollectionMethod = Type.Union([
  Type.Literal("web_search"),
  Type.Literal("api_query"),
  Type.Literal("web_scrape"),
  Type.Literal("deep_research"),
  Type.Literal("direct_reference"),
  Type.Literal("human_provided"),
  Type.Literal("database_query"),
], { description: "How this source was obtained" });

export const Corroboration = Type.Union([
  Type.Literal("confirmed"),
  Type.Literal("probable"),
  Type.Literal("uncorroborated"),
  Type.Literal("conflicting"),
], { description: "Corroboration status across sources. Auto-inferred from source count if omitted." });

export const SourceSchema = Type.Object({
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

// Shared reusable types for cross-agent workproducts
export const ArtifactRef = Type.String({
  description: "ULID of an artifact stored via the artifact service",
});

export const ISODate = Type.String({
  description: "ISO 8601 timestamp or date string",
});
