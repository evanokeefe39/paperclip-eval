# Findings Schema and record_finding Tool

## Intent

Define a universal structured data model for agent findings that supports multiple domain citation/grading standards via a `style` parameter. Enforce the schema deterministically through tool-call validation (TypeBox), not prompt engineering. Store as JSONL for machine consumption; markdown rendering is a downstream concern.

## Design

### Style routing

The `style` argument selects a validation profile. All styles share the same underlying JSONL schema — style determines which fields are required, which are optional, and what guidance the agent sees in the tool description.

Storage is always the same. A finding recorded as `intelligence` and one recorded as `academic` live in the same JSONL file with the same field names. The `style` field is persisted so downstream consumers know which standard was applied.

### Styles

#### `intelligence` — NATO ADMIRALTY / ICD 206

For competitive intelligence, market research, OSINT, threat analysis.

**Required fields:**
- claim, sources (at least one)
- Per source: source_name, source_url, source_type, source_reliability (A-F), information_credibility (1-6), date_accessed, collection_method

**Encouraged (warn if absent):**
- corroboration (finding-level — auto-inferred from source count if omitted)
- verbatim_quote (per source, for factual claims)
- date_information (finding-level, when the intel is FROM, not when accessed)

**ADMIRALTY guidance surfaced to agent:**
```
Source Reliability:
  A — Completely reliable: no doubt of authenticity, trustworthiness, competency
  B — Usually reliable: minor doubts, strong track record
  C — Fairly reliable: genuine doubt about source
  D — Not usually reliable: significant doubt
  E — Unreliable: no confidence in source
  F — Cannot be judged: new source, no track record

Information Credibility:
  1 — Confirmed: confirmed by independent sources
  2 — Probably true: not confirmed, but consistent with known information
  3 — Possibly true: not confirmed, reasonably consistent
  4 — Doubtful: not confirmed, inconsistent with known information
  5 — Improbable: contradicted by known information
  6 — Cannot be judged: no basis to evaluate
```

#### `academic` — CSL-JSON / Dublin Core aligned

For research papers, literature reviews, technical reports, systematic analysis.

**Required fields:**
- claim, sources (at least one)
- Per source: source_name, source_url, source_type, authors (at least one), date_published, date_accessed

**Encouraged:**
- Per source: publisher, doi, verbatim_quote
- source_reliability, information_credibility (still available, not required)

**Not required:**
- collection_method (assumed web_search or database_query in academic context)
- corroboration (academic peer review is implicit)

#### `journalism` — ClaimReview / editorial standard

For news monitoring, media analysis, PR tracking, fact-checking.

**Required fields:**
- claim, sources (at least one)
- Per source: source_name, source_url, source_type, authors (byline), date_published, date_accessed

**Encouraged:**
- Per source: publisher, verbatim_quote (critical for attribution), source_reliability, information_credibility

**Additional field behavior:**
- claim should be a specific, attributable statement (not a summary)
- verbatim_quote strongly encouraged — journalism lives on exact wording

#### `data` — structured data / API results

For datasets, API responses, database query results, scraped structured data.

**Required fields:**
- claim, sources (at least one)
- Per source: source_name, source_url, source_type, date_accessed, collection_method, source_reliability, information_credibility

**Encouraged:**
- date_information (finding-level, when the data is from — crucial for time-series, financial data)
- corroboration (finding-level)

**Not required:**
- authors (APIs don't have bylines)
- publisher (often same as source_name)
- verbatim_quote (structured data, not prose)

#### `general` — minimum viable finding

Fallback when no specific domain applies. Maximum flexibility.

**Required fields:**
- claim, sources (at least one)
- Per source: source_name, source_url, source_type, date_accessed

**Everything else optional.** Use when recording quick observations, leads, or preliminary findings that will be upgraded later.

### Validation behavior

The tool does NOT reject findings missing encouraged fields. It:
1. Validates required fields — rejects if missing
2. Warns on missing encouraged fields — returns the finding ID + a note like "Warning: intelligence style recommends corroboration field"
3. Accepts everything else as optional

This avoids railroading agents into fabricating metadata they don't have. A finding with honest gaps is better than one with hallucinated authors.

## Schema

### TypeBox definition

```typescript
import { Type, type Static } from "typebox";

const SourceReliability = Type.Union([
  Type.Literal("A"), Type.Literal("B"), Type.Literal("C"),
  Type.Literal("D"), Type.Literal("E"), Type.Literal("F"),
]);

const InformationCredibility = Type.Union([
  Type.Literal(1), Type.Literal(2), Type.Literal(3),
  Type.Literal(4), Type.Literal(5), Type.Literal(6),
]);

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
]);

const CollectionMethod = Type.Union([
  Type.Literal("web_search"),
  Type.Literal("api_query"),
  Type.Literal("web_scrape"),
  Type.Literal("deep_research"),
  Type.Literal("direct_reference"),
  Type.Literal("human_provided"),
  Type.Literal("database_query"),
]);

const Corroboration = Type.Union([
  Type.Literal("confirmed"),
  Type.Literal("probable"),
  Type.Literal("uncorroborated"),
  Type.Literal("conflicting"),
]);

const FindingStyle = Type.Union([
  Type.Literal("intelligence"),
  Type.Literal("academic"),
  Type.Literal("journalism"),
  Type.Literal("data"),
  Type.Literal("general"),
]);

// -- Source object (one finding can have multiple) --
const SourceSchema = Type.Object({
  source_name: Type.String({ description: "Human name: 'Crunchbase', 'TechCrunch', 'SEC EDGAR'" }),
  source_url: Type.String({ description: "URL of specific page or document" }),
  source_type: SourceType,
  source_reliability: Type.Optional(SourceReliability),
  information_credibility: Type.Optional(InformationCredibility),
  authors: Type.Optional(Type.Array(Type.String(), { description: "Named authors if known" })),
  publisher: Type.Optional(Type.String({ description: "Publishing organization" })),
  date_published: Type.Optional(Type.String({ description: "When source material was published (ISO 8601)" })),
  date_accessed: Type.Optional(Type.String({ description: "When retrieved — auto-set if omitted" })),
  collection_method: Type.Optional(CollectionMethod),
  doi: Type.Optional(Type.String({ description: "Digital Object Identifier if available" })),
  verbatim_quote: Type.Optional(Type.String({ description: "Exact quote from this specific source" })),
});

type Source = Static<typeof SourceSchema>;

const FindingSchema = Type.Object({
  // -- Style --
  style: FindingStyle,

  // -- Core (required all styles) --
  claim: Type.String({ description: "The specific factual assertion" }),

  // -- Sources (one or many) --
  sources: Type.Array(SourceSchema, {
    minItems: 1,
    description: "One or more sources supporting this finding. First source is primary unless primary_source_index is set.",
  }),
  primary_source_index: Type.Optional(Type.Integer({
    minimum: 0,
    description: "Index into sources[] indicating the strongest/primary source. Defaults to 0.",
  })),

  // -- Finding-level assessment (aggregated across sources) --
  corroboration: Type.Optional(Corroboration),
  date_information: Type.Optional(Type.String({
    description: "When the information is FROM, if different from source publish/access dates (e.g. 'Q3 2025' for earnings data)",
  })),

  // -- Content --
  topic_tags: Type.Optional(Type.Array(Type.String())),
  entities: Type.Optional(Type.Array(Type.String(), { description: "Named entities: companies, people, products" })),
  related_findings: Type.Optional(Type.Array(Type.String(), { description: "IDs of related findings" })),
  contradicts: Type.Optional(Type.Array(Type.String(), { description: "IDs of contradicted findings" })),
});

type Finding = Static<typeof FindingSchema>;
```

### Per-style required field map

Fields are split between finding-level and source-level. Source-level requirements apply to each source in the `sources` array.

```typescript
const STYLE_SOURCE_REQUIRED: Record<string, string[]> = {
  intelligence: [
    "source_reliability", "information_credibility",
    "date_accessed", "collection_method",
  ],
  academic: [
    "authors", "date_published", "date_accessed",
  ],
  journalism: [
    "authors", "date_published", "date_accessed",
  ],
  data: [
    "date_accessed", "collection_method",
    "source_reliability", "information_credibility",
  ],
  general: [
    "date_accessed",
  ],
};

const STYLE_SOURCE_ENCOURAGED: Record<string, string[]> = {
  intelligence: [
    "verbatim_quote",
  ],
  academic: [
    "publisher", "doi", "verbatim_quote",
  ],
  journalism: [
    "publisher", "verbatim_quote",
    "source_reliability", "information_credibility",
  ],
  data: [],
  general: [],
};

const STYLE_FINDING_ENCOURAGED: Record<string, string[]> = {
  intelligence: [
    "corroboration", "date_information",
  ],
  academic: [],
  journalism: [],
  data: [
    "date_information", "corroboration",
  ],
  general: [],
};
```

### Corroboration auto-inference

When a finding has multiple sources, the tool can infer `corroboration` if not explicitly set:
- 3+ sources with independent `source_name` values → `confirmed`
- 2 sources with independent `source_name` values → `probable`
- 1 source → `uncorroborated`
- Agent can override by setting `corroboration` explicitly (e.g. two sources that cite each other = still `uncorroborated`)


### JSONL storage format

One finding per line. Auto-generated fields prepended at write time:

```jsonl
{"id":"01JHX3YMPP","session_id":"01JHX3YMKD","agent":"researcher","timestamp":"2026-05-27T14:30:00Z","claim_preview":"LangChain raised $25M Series A led by Sequoia","style":"intelligence","claim":"LangChain raised $25M Series A led by Sequoia in January 2024","sources":[{"source_name":"Crunchbase","source_url":"https://crunchbase.com/org/langchain","source_type":"structured_aggregator","source_reliability":"B","information_credibility":2,"date_accessed":"2026-05-27T14:30:00Z","collection_method":"web_scrape"},{"source_name":"TechCrunch","source_url":"https://techcrunch.com/2024/01/langchain-series-a","source_type":"news_editorial","source_reliability":"B","information_credibility":2,"authors":["Connie Loizos"],"publisher":"TechCrunch","date_published":"2024-01-15","date_accessed":"2026-05-27T14:32:00Z","collection_method":"web_search","verbatim_quote":"LangChain has raised $25 million in a Series A round led by Sequoia Capital"},{"source_name":"LangChain Blog","source_url":"https://blog.langchain.dev/announcing-series-a","source_type":"press_release","source_reliability":"A","information_credibility":1,"date_published":"2024-01-15","date_accessed":"2026-05-27T14:35:00Z","collection_method":"web_search"}],"primary_source_index":2,"corroboration":"confirmed","date_information":"2024-01","topic_tags":["funding","ai-agents"],"entities":["LangChain","Sequoia Capital","Connie Loizos"]}
```

Note: the primary source is index 2 (LangChain's own announcement = A1 primary_official) even though Crunchbase was found first. Corroboration is `confirmed` — three independent sources agree.

Auto-set fields (agent does not provide):
- `id` — ULID, generated by tool
- `session_id` — from Paperclip run context or env var
- `agent` — from AGENT_NAME env var
- `timestamp` — ISO 8601, time of recording
- `date_accessed` — defaults to timestamp if agent omits it
- `claim_preview` — first 120 chars of claim, generated by tool

### Storage location

Current stack (v1 artifacts, bind mount):
```
/artifacts/{agent}/findings/{session_id}.jsonl
```

Future stack (v2 artifact service):
```
artifact://default/default/{run_id}/{agent}/dataset/{ulid}_findings.jsonl
```

The tool appends to the session file. One file per research session. Index file at `/artifacts/{agent}/findings/index.json` tracks sessions.

### Tool interface

```
record_finding(
  style: "intelligence" | "academic" | "journalism" | "data" | "general",
  claim: string,
  sources: [
    {
      source_name: string,
      source_url: string,
      source_type: <enum>,
      source_reliability?: "A"-"F",
      information_credibility?: 1-6,
      authors?: string[],
      publisher?: string,
      date_published?: string,
      date_accessed?: string,
      collection_method?: <enum>,
      doi?: string,
      verbatim_quote?: string,
    },
    ...additional sources
  ],
  primary_source_index?: number,
  corroboration?: <enum>,
  date_information?: string,
  topic_tags?: string[],
  entities?: string[],
  related_findings?: string[],
  contradicts?: string[],
)
→ { id, admiralty_grade?, corroboration, source_count, warnings[] }
```

Return value:
- `id` — the ULID for cross-referencing
- `admiralty_grade` — combined "B2" string from the primary source's ADMIRALTY fields, null if absent
- `corroboration` — explicit or auto-inferred from source count
- `source_count` — number of sources recorded
- `warnings` — list of missing encouraged fields for the chosen style

### Adding sources to an existing finding

```
add_source(
  finding_id: string,
  source: { ...same source fields... }
)
→ { finding_id, source_count, corroboration }
```

Appends a source to an existing finding's `sources` array. Recalculates `corroboration` if it was auto-inferred. Lets agents build up multi-source findings incrementally — record the first source when found, add corroborating sources as they surface later.

### promptSnippet (per-style)

The tool's promptSnippet changes based on which style the agent's AGENTS.md designates as default. Researcher default: `intelligence`. Data default: `data`. Writer reads findings but doesn't record them.

Intelligence snippet includes the full ADMIRALTY scale descriptions. Academic snippet includes CSL-style field guidance. This way agents see domain-appropriate guidance without reading the full schema.

## Companion tools

### query_findings

```
query_findings(
  agent?: string,        # filter by producing agent
  session_id?: string,   # filter by session
  topic_tag?: string,    # filter by tag
  entity?: string,       # filter by named entity
  min_reliability?: "A"|"B"|"C"|"D"|"E"|"F",
  min_credibility?: 1|2|3|4|5|6,
  since?: string,        # ISO 8601
  limit?: number         # default 50
)
→ Finding[]
```

Reads JSONL, filters in-memory. Fine for eval scale. Moves to Postgres query when v2 artifact store lands.

### get_finding

```
get_finding(id: string) → Finding
```

Lookup by ULID across all session files.

## Relationship to existing code

### deep-research Finding type

`src/agents/extensions/deep-research/types.ts` has its own `Finding` interface with `confidence: number` (0-1). This becomes a migration:

- `confidence` maps to `information_credibility` (0.9+ → 1, 0.7-0.9 → 2, 0.5-0.7 → 3, 0.3-0.5 → 4, <0.3 → 5)
- deep-research engine calls `record_finding` with style `intelligence` instead of writing its own JSONL
- Existing fields map: `source_url` → `source_url`, `source_title` → `source_name`, `verbatim_quote` → `verbatim_quote`, `topic_tags` → `topic_tags`, `entities` → `entities` (flatten from objects to strings)
- `full_chunk` and `page_snapshot_path` don't map — these are deep-research internal state, not finding metadata. Keep in deep-research's own storage, reference by finding ID.

### research-output.md template

Current template has freeform `**Confidence:** high | medium | low` per finding. Replace with ADMIRALTY grade reference. Template becomes a view over JSONL findings, not the source of truth.

### Writer AGENTS.md

Already references ADMIRALTY grades for hedging decisions (B3+ = no caveat, C3/D2 = hedge, worse = exclude). No change needed — Writer queries findings, reads `source_reliability` and `information_credibility`, applies same rules.

## Dependencies

- TypeBox (already in project)
- ULID generation (one-liner, no dep needed: `Date.now().toString(36) + Math.random().toString(36).slice(2)` for eval, or import from deep-research if it uses one)
- node:fs for JSONL append (current stack)

No new npm packages.

## Definition of Done

- [ ] TypeBox schema defined in shared types file
- [ ] `record_finding` tool registered in new extension `findings.ts`
- [ ] Style-based validation (required/encouraged) implemented
- [ ] JSONL append storage with session-scoped files
- [ ] `query_findings` tool with in-memory filtering
- [ ] `get_finding` lookup by ID
- [ ] promptSnippet with ADMIRALTY descriptions for intelligence style
- [ ] Researcher AGENTS.md updated to reference `record_finding` with default style `intelligence`
- [ ] Data AGENTS.md updated to reference `record_finding` with default style `data`
- [ ] T1-T4 tier system in AGENTS.md replaced with ADMIRALTY + source_type
- [ ] deep-research engine migrated to call `record_finding`
- [ ] research-output.md template updated to reference ADMIRALTY grades
- [ ] Existing deep-research tests still pass after migration

## Negative space

Out of scope:
- Rendering findings as markdown (downstream — Writer or a dedicated tool)
- Full CSL-JSON export (future, if academic publishing matters)
- ClaimReview schema.org markup generation
- Postgres storage (v2 artifact store concern)
- Finding versioning or amendment (append a new finding, reference old one in `related_findings`)

Not changing:
- Writer's ADMIRALTY consumption rules
- deep-research's internal chunk/snapshot storage
- Artifact extension tool signatures
- Bridge.mjs

## Open Questions

None.
