# Deep Research Store (Findings Model + Persistence)

## Intent

Structured findings store with full provenance. Findings stream to persistent JSONL as produced during research. Cross-session index enables downstream agents (Data, Writer) to query existing knowledge. Enrichment API allows Data agent to add findings from external sources (datasets, analysis).

## Dependencies

- Deep research engine (deep-research-engine.md) — produces findings
- File system at /artifacts/research/ (shared Docker volume)

## File structure

```
src/agents/extensions/
  deep-research/
    types.ts                    Finding, Entity, SessionMeta interfaces
    store.ts                    JSONL writer, page snapshots, session management
    query.ts                    Index search (keyword matching across findings)
```

## Finding Data Model

```typescript
interface Finding {
  // Identity
  id: string;                    // crypto.randomUUID()
  session_id: string;
  timestamp: string;             // ISO 8601

  // Content
  claim: string;                 // full extracted claim
  claim_preview: string;         // ≤120 chars
  confidence: number;            // 0-1

  // Provenance (full — not just reference)
  source_url: string;
  source_title: string;
  verbatim_quote: string;        // exact text from source
  full_chunk: string;            // chunk it was extracted from
  page_snapshot_path: string;    // path to full page artifact

  // Research context
  sub_query: string;
  sub_query_id: string;

  // Semantic
  topic_tags: string[];
  entities: Entity[];

  // Relationships (populated by graph or manual linking)
  related_findings: string[];
  contradicts: string[];
}

interface Entity {
  name: string;                  // "Tesla", "$1.3T", "Q1 2025"
  type: string;                  // company, metric, period, person, technology, location
  normalized?: string;           // canonical form
}

interface IndexEntry {
  id: string;
  claim_preview: string;
  confidence: number;
  source_url: string;
  session_id: string;
  timestamp: string;
  topic_tags: string[];
  entities: Entity[];
}

interface SessionMeta {
  session_id: string;
  query: string;
  sub_queries: SubQuery[];
  started_at: string;
  completed_at: string;
  total_findings: number;
  total_sources: number;
  iterations: number;
  config: Partial<Config>;
}
```

## Storage Layout

```
/artifacts/research/
  sessions/
    {session-id}/
      meta.json                  # SessionMeta
      findings.jsonl             # one Finding per line, append-only
      pages/
        {url-hash}.md            # full page at time of research
      summary.md                 # human-readable session summary

  index.jsonl                    # cross-session index (lightweight entries)
```

### Design decisions

- **Findings are append-only.** Never mutated. Contradictions tracked via `contradicts` field pointing to newer findings.
- **Full chunks stored.** Analyst can read raw source without re-fetching dead URLs.
- **Page snapshots stored.** URLs die; snapshots are permanent evidence.
- **Index is lightweight.** Only claim_preview + metadata. Full finding in session JSONL.
- **One JSONL per session + one global index.** Session files are self-contained; index enables cross-session queries.

## Streaming Writer (store.ts)

```typescript
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";

function initSession(sessionId: string, query: string, config: Config): void {
  const base = `${config.artifacts_base}/sessions/${sessionId}`;
  mkdirSync(`${base}/pages`, { recursive: true });
}

function streamFinding(finding: Finding, sessionId: string, config: Config): void {
  const base = `${config.artifacts_base}/sessions/${sessionId}`;

  // 1. Append to session findings
  appendFileSync(
    `${base}/findings.jsonl`,
    JSON.stringify(finding) + "\n"
  );

  // 2. Append to cross-session index (lightweight)
  const indexEntry: IndexEntry = {
    id: finding.id,
    claim_preview: finding.claim_preview,
    confidence: finding.confidence,
    source_url: finding.source_url,
    session_id: sessionId,
    timestamp: finding.timestamp,
    topic_tags: finding.topic_tags,
    entities: finding.entities,
  };
  appendFileSync(
    `${config.artifacts_base}/index.jsonl`,
    JSON.stringify(indexEntry) + "\n"
  );
}

function storePage(sessionId: string, url: string, content: string, config: Config): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const path = `${config.artifacts_base}/sessions/${sessionId}/pages/${hash}.md`;
  if (!existsSync(path)) {
    writeFileSync(path, `<!-- Source: ${url} -->\n<!-- Captured: ${new Date().toISOString()} -->\n\n${content}`);
  }
  return path;
}

function writeSessionMeta(
  sessionId: string,
  query: string,
  subQueries: SubQuery[],
  config: Config,
  state: EngineState
): void {
  const meta: SessionMeta = {
    session_id: sessionId,
    query,
    sub_queries: subQueries,
    started_at: state.startedAt,
    completed_at: new Date().toISOString(),
    total_findings: state.allFindings.length,
    total_sources: new Set(state.allFindings.map(f => f.source_url)).size,
    iterations: state.iteration,
    config: { max_iterations: config.max_iterations, max_sub_queries: config.max_sub_queries },
  };
  writeFileSync(
    `${config.artifacts_base}/sessions/${sessionId}/meta.json`,
    JSON.stringify(meta, null, 2)
  );
}
```

## Index Query (query.ts)

Simple keyword search over JSONL index. No database for eval stage.

```typescript
import { existsSync, readFileSync } from "fs";

function queryIndex(
  query: string,
  maxResults: number,
  config: Config,
  sessionFilter?: string
): IndexEntry[] {
  const indexPath = `${config.artifacts_base}/index.jsonl`;
  if (!existsSync(indexPath)) return [];

  const queryTerms = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const results: { entry: IndexEntry; score: number }[] = [];

  const lines = readFileSync(indexPath, "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    const entry: IndexEntry = JSON.parse(line);
    if (sessionFilter && entry.session_id !== sessionFilter) continue;

    // Match against claim, topics, entities
    const searchText = [
      entry.claim_preview,
      ...entry.topic_tags,
      ...entry.entities.map(e => e.name),
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

function getFullFinding(findingId: string, sessionId: string, config: Config): Finding | null {
  const path = `${config.artifacts_base}/sessions/${sessionId}/findings.jsonl`;
  if (!existsSync(path)) return null;

  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    const f: Finding = JSON.parse(line);
    if (f.id === findingId) return f;
  }
  return null;
}
```

## Tool Registration

### research_query

```typescript
pi.registerTool({
  name: "research_query",
  label: "Query Research",
  description: "Query existing research findings across all sessions. Search by entity, topic, or keyword. Use before starting new research to check what's already known.",
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
    max_results: Type.Optional(Type.Number({ description: "Max findings (default 20)" })),
    session_id: Type.Optional(Type.String({ description: "Limit to session" })),
    include_full: Type.Optional(Type.Boolean({ description: "Include full chunk text (default false)" })),
  }),
  async execute(_id, params) {
    const entries = queryIndex(params.query, params.max_results || 20, DEFAULT_CONFIG, params.session_id);

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
        const full = getFullFinding(entry.id, entry.session_id, DEFAULT_CONFIG);
        if (full) lines.push(`   Quote: "${full.verbatim_quote}"`);
      }
      lines.push("");
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
});
```

### research_enrich

```typescript
pi.registerTool({
  name: "research_enrich",
  label: "Enrich Research",
  description: "Add findings from external sources (datasets, analysis, manual research) to the knowledge store. Used by Data agent to enrich existing research.",
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
  async execute(_id, params) {
    const sessionId = params.session_id || `enrichment-${crypto.randomUUID()}`;
    initSession(sessionId, "enrichment", DEFAULT_CONFIG);

    for (const raw of params.findings) {
      const finding: Finding = {
        id: crypto.randomUUID(),
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        claim: raw.claim,
        claim_preview: raw.claim.slice(0, 120),
        confidence: raw.confidence,
        source_url: raw.source_url,
        source_title: raw.source_title,
        verbatim_quote: raw.verbatim_quote || "",
        full_chunk: "",
        page_snapshot_path: "",
        sub_query: "enrichment",
        sub_query_id: "enrichment",
        topic_tags: raw.topic_tags || [],
        entities: raw.entities || [],
        related_findings: [],
        contradicts: [],
      };
      streamFinding(finding, sessionId, DEFAULT_CONFIG);
    }

    return { content: [{ type: "text" as const, text: `Added ${params.findings.length} findings to session ${sessionId}.` }] };
  },
});
```

## Downstream Agent Workflows

### Data agent enrichment
```
1. CEO assigns: "Enrich EV research with market data"
2. Data agent calls: research_query("electric vehicle market")
3. Sees entities: ["Tesla", "BYD", "market size $1.3T"]
4. Scrapes financial data, market reports
5. Calls: research_enrich(findings=[...])
6. Index grows. Knowledge accumulates.
```

### Writer consumption
```
1. Writer calls: research_query("EV market trends", include_full=true)
2. Gets findings + verbatim quotes + sources
3. Synthesizes narrative with attribution
```

### Human analyst
```
1. Browse /artifacts/research/sessions/
2. Read findings.jsonl — every finding with provenance
3. Read pages/{hash}.md — original sources
4. Cross-reference via index queries
```

## Storage growth estimates

```
Per session:
  findings.jsonl: ~50KB (30 findings × ~1.5KB each)
  pages/: ~400KB (8 pages × ~50KB each)
  meta.json: ~2KB
  Total: ~450KB/session

Per day (10 sessions): ~4.5MB
Per month: ~135MB

Index growth: ~15KB/day (lightweight entries only)
```

Page snapshots are the growth driver. TTL policy (30-day expiry on pages, keep findings forever) bounds this.

## Scaling path

| Scale | Solution |
|-------|----------|
| <1000 findings | JSONL grep (current, sufficient) |
| 1000-10000 | SQLite FTS5 (drop-in, same query interface) |
| 10000+ | Vector search (embeddings) + graph (Graphiti) |

Transition is mechanical: same data model, different query backend. Index format doesn't change.

## Definition of Done

- [ ] Finding data model with full provenance
- [ ] streamFinding: append to session JSONL + cross-session index
- [ ] storePage: page snapshots with URL + timestamp header
- [ ] initSession / writeSessionMeta: session lifecycle
- [ ] queryIndex: keyword search across findings
- [ ] getFullFinding: retrieve full finding by ID
- [ ] research_query tool: search existing knowledge
- [ ] research_enrich tool: Data agent adds findings
- [ ] Storage layout created during initSession
- [ ] Integration test: write findings → query back
- [ ] Integration test: enrich → query enriched findings
