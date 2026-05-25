# Deep Research Extension

## Intent

Self-contained research engine as a Pi extension. Executes multi-iteration deep research internally using cheap LLM calls, returns structured findings with full provenance. Streams findings to persistent store (JSONL + optional knowledge graph) as they're produced. Designed for downstream enrichment by Data agent and consumption by Writer agent.

## Architecture: Self-Contained Research Engine (Option B)

The deep_research tool orchestrates everything internally via code. The Researcher agent (any model, can be cheap) just invokes it and presents results. All research logic — planning, scanning, ranking, extraction, reflection — runs inside the tool with targeted cheap LLM calls and parallel execution.

```
Researcher Agent (cheap model — DeepSeek/Groq)
    │ calls deep_research(query)
    ▼
┌──────────────────────────────────────────────────────────────┐
│ deep_research tool (code-level orchestration)                │
│                                                              │
│   Plan (1 cheap LLM call, ~2k ctx)                          │
│       ↓                                                      │
│   Sub-query 1 ──┐                                           │
│   Sub-query 2 ──┼── Promise.all (PARALLEL)                  │
│   Sub-query 3 ──┘                                           │
│       ↓                                                      │
│   Each sweep (ISOLATED context per LLM call, max ~5k):      │
│     search (Exa) → heuristic rank → select (LLM, ~5k ctx)  │
│     → fetch pages → chunk → extract (LLM, ~4k ctx each)    │
│     → STREAM findings to JSONL + graph                      │
│       ↓                                                      │
│   Reflect (1 cheap LLM call, summaries only ~3k ctx)        │
│       ↓                                                      │
│   Iterate or finalize                                        │
└──────────────────────────────────────────────────────────────┘
    │ returns concise summary (~2k tokens) to agent
    ▼
Outer agent context stays clean
```

### Key properties

| Property | How achieved |
|----------|-------------|
| **Parallelism** | Promise.all across sub-queries. Promise.all for page fetches and extraction within each sweep. |
| **Context isolation** | Each inner LLM call is an independent HTTP request (~4-5k tokens). No accumulation. |
| **No context bloat** | Page content lives in JS heap (code memory). Only small chunks passed per extraction call. Outer agent sees 2k summary. |
| **Streaming output** | Findings written to JSONL + graph as produced, not batched at end. |
| **Cost control** | Heuristic pre-filter (free) → cheap model for ranking/extraction (DeepSeek $0.14/M). ~$0.04/session. |

### Model selection for inner calls

| Task | Model | Context used | Why |
|------|-------|-------------|-----|
| Plan sub-queries | DeepSeek Chat | ~2k | Good instruction following |
| Select URLs from snippets | DeepSeek Chat | ~5k | Reliable structured output |
| Extract findings + entities | DeepSeek Chat | ~4k per page | Best quality/price for structured extraction |
| Reflect on coverage | DeepSeek Chat | ~3k (summaries only) | Adequate for gap detection |
| Ranking | Heuristic (BM25) | 0 (code) | Free, instant, Exa pre-ranks |

### Cost estimate at scale

```
6 sub-queries × 200 snippets = 1,200 snippets
Heuristic kills 80% → 240 survive
LLM selects top 5-8 per sub-query → ~40 pages deep-extracted
40 pages × 8 chunks = ~40 extraction calls (1 per page, batched chunks)

Per session:
  Plan: 1 call                    $0.0003
  Select (6 sub-queries): 6 calls $0.004
  Extract (40 pages): 40 calls    $0.028
  Reflect: 1-2 calls              $0.001
  Total: ~$0.035/session

At 10 sessions/day: $10.50/month
```

## Finding Output Model

Every finding carries full provenance — original chunks, page snapshots, entities. Designed for downstream enrichment and knowledge graph ingestion.

### Finding structure

```typescript
interface Finding {
  // Identity
  id: string;                    // uuid
  session_id: string;
  timestamp: string;             // ISO 8601
  
  // Content
  claim: string;                 // full extracted claim
  claim_preview: string;         // ≤120 chars
  confidence: number;            // 0-1
  
  // Provenance (full, not just reference)
  source_url: string;
  source_title: string;
  verbatim_quote: string;        // exact text from source
  full_chunk: string;            // the chunk it was extracted from
  page_snapshot_path: string;    // path to full page artifact
  
  // Context
  sub_query: string;             // what research question produced this
  sub_query_id: string;
  topic_tags: string[];
  
  // Entities (extracted in same LLM call, zero additional cost)
  entities: Entity[];
  
  // Relationships (populated by graph or cross-reference)
  related_findings: string[];    // IDs
  contradicts: string[];         // IDs of conflicting findings
}

interface Entity {
  name: string;                  // "Tesla", "$1.3T", "Q1 2025"
  type: string;                  // company, metric, period, person, technology, location
  normalized?: string;           // canonical form (e.g., "Tesla, Inc.")
}

interface SessionMeta {
  session_id: string;
  query: string;
  sub_queries: SubQuery[];
  config: Partial<Config>;
  started_at: string;
  completed_at: string;
  total_findings: number;
  total_sources: number;
  iterations: number;
}
```

### Artifact storage layout

```
/artifacts/research/
  sessions/
    {session-id}/
      meta.json                  # SessionMeta — query, sub-queries, config, timestamps
      findings.jsonl             # one Finding per line, append-only during session
      pages/
        {url-hash}.md            # full page snapshot at time of research
      summary.md                 # final assembled summary (for human readability)
  
  index.jsonl                    # cross-session finding index (append-only, all sessions)
```

### Streaming writes during sweep

```typescript
// Inside executeSweep, after each extraction call:
function streamFinding(finding: Finding, sessionId: string): void {
  // 1. Append to session findings (immediate, durable)
  appendFileSync(
    `/artifacts/research/sessions/${sessionId}/findings.jsonl`,
    JSON.stringify(finding) + "\n"
  );
  
  // 2. Append to cross-session index (lightweight entry)
  appendFileSync(
    `/artifacts/research/index.jsonl`,
    JSON.stringify({
      id: finding.id,
      claim_preview: finding.claim_preview,
      entities: finding.entities,
      source_url: finding.source_url,
      session_id: sessionId,
      timestamp: finding.timestamp,
      confidence: finding.confidence,
      topic_tags: finding.topic_tags,
    }) + "\n"
  );
  
  // 3. Store page snapshot (once per URL, deduplicated)
  const pageHash = hashUrl(finding.source_url);
  const pagePath = `/artifacts/research/sessions/${sessionId}/pages/${pageHash}.md`;
  if (!existsSync(pagePath)) {
    writeFileSync(pagePath, pageContent);
  }
  finding.page_snapshot_path = pagePath;
  
  // 4. POST to knowledge graph (non-blocking, graph is optional)
  graphIngest(finding).catch(() => {});
}
```

### Entity extraction (piggybacked on existing LLM call)

No additional cost — expand the extraction prompt to include entities:

```typescript
const EXTRACT_PROMPT = `Extract findings from content chunks.

Return JSON: {"findings": [{
  "claim": "specific verifiable assertion",
  "verbatim_quote": "exact text from source (≥20 chars)",
  "confidence": 0.0-1.0,
  "topic_tags": ["market-size", "growth"],
  "entities": [
    {"name": "Tesla", "type": "company"},
    {"name": "$1.3T", "type": "metric"},
    {"name": "2030", "type": "period"}
  ]
}]}

Rules:
1. Each claim must be specific and verifiable.
2. verbatim_quote must appear exactly in the provided text.
3. entities: named things mentioned (companies, people, metrics, dates, technologies, locations).
4. A chunk may yield 0-3 findings. Do not force findings from low-value text.
5. confidence: 0.9 = explicit with data, 0.6 = stated no source, 0.3 = implied.`;
```

## Implementation Plan

### Phase 1: Core infrastructure

#### 1.1 — File structure

```
src/agents/extensions/
  deep-research.ts              Main extension — registers tools
  deep-research/
    types.ts                    Finding, Entity, SessionMeta, Config interfaces
    engine.ts                   Main orchestration loop (plan → sweep → reflect)
    sweep.ts                    Single sub-query sweep pipeline
    llm.ts                      Provider API client (structured output calls)
    rank.ts                     Heuristic ranking (BM25 + Exa score)
    extract.ts                  LLM-powered extraction with entity extraction
    store.ts                    JSONL writer, page snapshot, index management
    graph.ts                    Knowledge graph client (optional, fire-and-forget)
    cache.ts                    In-memory LRU cache
    prompts.ts                  All inner LLM prompts
    config.ts                   Knobs and defaults
```

#### 1.2 — LLM client (llm.ts)

Thin wrapper for structured output calls. Zero deps — raw fetch.

```typescript
interface LLMConfig {
  provider: "deepseek" | "groq" | "cerebras";
  model: string;
  apiKey: string;
  baseUrl: string;
  maxRetries: number;
  timeoutMs: number;
}

const PROVIDERS: Record<string, { baseUrl: string; envKey: string }> = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", envKey: "DEEPSEEK_API_KEY" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", envKey: "GROQ_API_KEY" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", envKey: "CEREBRAS_API_KEY" },
};

async function structuredCall<T>(
  config: LLMConfig,
  systemPrompt: string,
  userContent: string,
  signal?: AbortSignal
): Promise<T> {
  for (let attempt = 0; attempt < config.maxRetries; attempt++) {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
      signal: AbortSignal.any([
        AbortSignal.timeout(config.timeoutMs),
        ...(signal ? [signal] : []),
      ]),
    });

    if (res.ok) {
      const data = await res.json();
      return JSON.parse(data.choices[0].message.content) as T;
    }

    if (res.status === 429) {
      await sleep(1000 * Math.pow(2, attempt) * (0.5 + Math.random()));
      continue;
    }
    
    throw new Error(`LLM API ${res.status}: ${await res.text()}`);
  }
  throw new Error(`LLM call failed after ${config.maxRetries} attempts`);
}
```

#### 1.3 — Config (config.ts)

```typescript
const DEFAULT_CONFIG = {
  // Inner LLM
  llm_provider: process.env.RESEARCH_LLM_PROVIDER || "deepseek",
  llm_model: process.env.RESEARCH_LLM_MODEL || "deepseek-chat",
  max_retries: 5,
  llm_timeout_ms: 30_000,

  // Research budget
  max_iterations: 3,
  max_sub_queries: 6,
  snippet_results_per_query: 200,
  heuristic_keep_ratio: 0.2,          // keep top 20% from heuristic
  top_k_for_extraction: 8,            // URLs selected for deep extraction per sub-query

  // Chunking
  chunk_size: 1500,
  chunk_overlap: 200,
  max_chunks_per_page: 10,

  // Output caps
  max_findings_per_sweep: 30,
  max_findings_in_summary: 15,

  // Storage
  artifacts_base: "/artifacts/research",
  graph_url: process.env.GRAPHITI_URL || "",  // empty = graph disabled
};
```

### Phase 2: Heuristic ranking (rank.ts)

At 200 snippets per sub-query, heuristic is the filter. Exa already returns relevance-scored results.

```typescript
interface RankedSnippet {
  url: string;
  title: string;
  text: string;
  highlights: string[];
  exa_score: number;
  heuristic_score: number;
  combined_score: number;
}

function heuristicRank(snippets: ExaResult[], query: string): RankedSnippet[] {
  const queryTerms = extractKeywords(query);
  
  return snippets.map(s => {
    const textLower = (s.text || "").toLowerCase();
    const titleLower = (s.title || "").toLowerCase();
    
    // BM25-style keyword scoring
    const termMatches = queryTerms.filter(t => textLower.includes(t)).length;
    const termScore = termMatches / queryTerms.length;
    
    // Title relevance bonus
    const titleMatches = queryTerms.filter(t => titleLower.includes(t)).length;
    const titleBonus = titleMatches > 0 ? 0.2 : 0;
    
    // Highlight density (Exa highlights are relevance signals)
    const highlightBonus = s.highlights?.length ? Math.min(s.highlights.length * 0.1, 0.3) : 0;
    
    // Content length (very short = probably low value)
    const lengthPenalty = (s.text?.length || 0) < 200 ? -0.2 : 0;
    
    // Exact phrase match bonus
    const phraseBonus = textLower.includes(query.toLowerCase()) ? 0.3 : 0;
    
    const heuristic_score = Math.min(1, Math.max(0,
      termScore + titleBonus + highlightBonus + lengthPenalty + phraseBonus
    ));
    
    // Combined: Exa's ML ranking + our heuristic
    const combined_score = (s.score * 0.6) + (heuristic_score * 0.4);
    
    return { ...s, exa_score: s.score, heuristic_score, combined_score };
  })
  .sort((a, b) => b.combined_score - a.combined_score);
}
```

### Phase 3: LLM-powered extraction (extract.ts)

#### 3.1 — URL selection (LLM picks which pages to deep-extract)

After heuristic ranking returns top 40 snippets, one LLM call selects which to fetch fully:

```typescript
const SELECT_PROMPT = `You are a research relevance filter. Given a sub-query and ranked snippets, select the URLs most likely to contain substantive, verifiable information.

Return JSON: {"selected_urls": ["url1", "url2", ...], "reason": "one sentence"}

Rules:
1. Select 5-8 URLs maximum.
2. Prefer: primary sources, data-rich pages, expert analysis.
3. Avoid: listicles, aggregator pages, thin content, paywalled sites.
4. Diversity: don't select 3 pages from the same domain.`;

async function selectUrls(
  subQuery: string,
  rankedSnippets: RankedSnippet[],
  config: Config,
  signal?: AbortSignal
): Promise<string[]> {
  const top = rankedSnippets.slice(0, 40);
  const formatted = top.map((s, i) =>
    `[${i + 1}] Score: ${s.combined_score.toFixed(2)} | ${s.title}\n    URL: ${s.url}\n    ${s.text?.slice(0, 200)}`
  ).join("\n\n");

  const result = await structuredCall<{ selected_urls: string[] }>(
    getLLMConfig(config),
    SELECT_PROMPT,
    `Sub-query: ${subQuery}\n\nSnippets (ranked):\n${formatted}`,
    signal
  );

  return result.selected_urls.slice(0, config.top_k_for_extraction);
}
```

#### 3.2 — Finding extraction with entities

```typescript
async function extractFromPage(
  url: string,
  title: string,
  chunks: string[],
  subQuery: string,
  config: Config,
  signal?: AbortSignal
): Promise<Finding[]> {
  const formatted = chunks.map((c, i) => `[Chunk ${i + 1}]:\n${c}`).join("\n\n---\n\n");

  const result = await structuredCall<{ findings: RawFinding[] }>(
    getLLMConfig(config),
    EXTRACT_PROMPT,
    `Sub-query: ${subQuery}\nSource: ${title} (${url})\n\nContent:\n${formatted}`,
    signal
  );

  return result.findings.map(f => ({
    id: crypto.randomUUID(),
    session_id: "",  // filled by caller
    timestamp: new Date().toISOString(),
    claim: f.claim,
    claim_preview: f.claim.slice(0, 120),
    confidence: f.confidence,
    source_url: url,
    source_title: title,
    verbatim_quote: f.verbatim_quote,
    full_chunk: chunks.find(c => c.includes(f.verbatim_quote)) || chunks[0],
    page_snapshot_path: "",  // filled by store
    sub_query: subQuery,
    sub_query_id: "",  // filled by caller
    topic_tags: f.topic_tags || [],
    entities: f.entities || [],
    related_findings: [],
    contradicts: [],
  }));
}
```

### Phase 4: Sweep pipeline (sweep.ts)

```typescript
async function executeSweep(
  subQuery: SubQuery,
  originalQuery: string,
  sessionId: string,
  config: Config,
  state: SessionState,
  signal?: AbortSignal
): Promise<SweepResult> {
  // 1. Search (Exa API, 200 results)
  const snippets = await searchExa(subQuery.query, config.snippet_results_per_query, state.searchCache, signal);

  // 2. Heuristic rank (free, instant)
  const ranked = heuristicRank(snippets, subQuery.query);
  const survivors = ranked.slice(0, Math.ceil(ranked.length * config.heuristic_keep_ratio));

  // 3. LLM URL selection (one call, ~5k context)
  const selectedUrls = await selectUrls(subQuery.query, survivors, config, signal);

  // 4. Fetch full pages (parallel HTTP, stored in code memory + artifacts)
  const pages = await Promise.all(
    selectedUrls.map(async url => {
      const cached = state.fetchCache.get(url);
      if (cached) return { url, title: cached.title, content: cached.content };
      
      const page = await fetchPage(url, signal);
      state.fetchCache.set(url, page);
      
      // Store page snapshot
      storePage(sessionId, url, page.content);
      
      return page;
    })
  );

  // 5. Chunk pages
  const pageChunks = pages.map(p => ({
    url: p.url,
    title: p.title,
    chunks: chunkText(p.content, config.chunk_size, config.chunk_overlap)
      .slice(0, config.max_chunks_per_page),
  }));

  // 6. Extract findings (parallel LLM calls, isolated context per page)
  const allFindings: Finding[] = [];
  await Promise.all(
    pageChunks.map(async ({ url, title, chunks }) => {
      const findings = await extractFromPage(url, title, chunks, subQuery.query, config, signal);
      
      for (const finding of findings) {
        finding.session_id = sessionId;
        finding.sub_query_id = subQuery.id;
        
        // STREAM: write finding immediately as produced
        streamFinding(finding, sessionId, config);
        allFindings.push(finding);
      }
    })
  );

  // 7. Deduplicate within sweep
  const deduplicated = deduplicateFindings(allFindings);
  const capped = deduplicated
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, config.max_findings_per_sweep);

  // 8. Build summary
  const summary: SubQuerySummary = {
    sub_query_id: subQuery.id,
    query: subQuery.query,
    key_claims: capped.slice(0, 7).map(f => f.claim_preview),
    coverage: `${capped.length} findings from ${selectedUrls.length} sources (${snippets.length} snippets scanned).`,
    gaps: [],
    finding_count: capped.length,
    source_count: selectedUrls.length,
  };

  return { sub_query: subQuery, findings: capped, summary, sources_used: pages.map(p => ({ url: p.url, title: p.title })) };
}
```

### Phase 5: Main orchestration engine (engine.ts)

```typescript
async function deepResearch(
  query: string,
  config: Config,
  signal?: AbortSignal
): Promise<{ sessionId: string; summary: string; findingCount: number }> {
  const sessionId = crypto.randomUUID();
  const state: SessionState = {
    sweepResults: new Map(),
    allFindings: [],
    searchCache: new Map(),
    fetchCache: new Map(),
  };

  // Initialize session directory
  initSession(sessionId, query, config);

  // 1. PLAN — one cheap LLM call
  const subQueries = await planSubQueries(query, config, signal);

  // 2. EXECUTE — parallel sub-queries
  let iteration = 0;
  let pendingSubQueries = [...subQueries];

  while (iteration < config.max_iterations && pendingSubQueries.length > 0) {
    const results = await Promise.all(
      pendingSubQueries.map(sq => executeSweep(sq, query, sessionId, config, state, signal))
    );

    for (const result of results) {
      state.sweepResults.set(result.sub_query.id, result);
      state.allFindings.push(...result.findings);
    }

    // 3. REFLECT — one cheap LLM call (summaries only, ~3k context)
    const summaries = [...state.sweepResults.values()].map(r => r.summary);
    const decision = await reflect(query, summaries, iteration, config, signal);

    if (!decision.continue || decision.new_sub_queries.length === 0) break;

    pendingSubQueries = decision.new_sub_queries;
    iteration++;
  }

  // 4. FINALIZE — write session summary
  const finalSummary = buildSessionSummary(query, state, sessionId);
  writeSessionMeta(sessionId, query, subQueries, config, state);

  return {
    sessionId,
    summary: finalSummary,
    findingCount: state.allFindings.length,
  };
}
```

### Phase 6: Tool registration (deep-research.ts)

```typescript
export default function (pi: ExtensionAPI) {

  // Tool 1: deep_research (main engine)
  pi.registerTool({
    name: "deep_research",
    label: "Deep Research",
    description: "Execute comprehensive multi-iteration research on a topic. Searches hundreds of sources, extracts findings with full provenance, streams results to knowledge store. Returns session summary.",
    parameters: Type.Object({
      query: Type.String({ description: "Research query or question" }),
      max_iterations: Type.Optional(Type.Number({ description: "Max research iterations (default 3)" })),
      max_sub_queries: Type.Optional(Type.Number({ description: "Max sub-queries per iteration (default 6)" })),
    }),
    async execute(_id, params, signal) {
      const config = { ...DEFAULT_CONFIG, ...params };
      const result = await deepResearch(params.query, config, signal);

      return {
        content: [{ type: "text" as const, text: [
          `## Research Complete`,
          `Session: ${result.sessionId}`,
          `Findings: ${result.findingCount}`,
          ``,
          result.summary,
          ``,
          `Full findings: /artifacts/research/sessions/${result.sessionId}/findings.jsonl`,
        ].join("\n") }],
      };
    },
  });

  // Tool 2: research_query (query existing findings)
  pi.registerTool({
    name: "research_query",
    label: "Query Research",
    description: "Query existing research findings across all sessions. Search by entity, topic, or keyword. Use before starting new research to check what's already known.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query (matches claims, entities, topics)" }),
      max_results: Type.Optional(Type.Number({ description: "Max findings to return (default 20)" })),
      session_id: Type.Optional(Type.String({ description: "Limit to specific session" })),
    }),
    async execute(_id, params) {
      const findings = queryIndex(params.query, params.max_results || 20, params.session_id);

      if (findings.length === 0) {
        return { content: [{ type: "text" as const, text: "No existing findings match this query." }] };
      }

      const lines = [
        `## Existing findings for: ${params.query}`,
        `Found ${findings.length} relevant findings:`,
        "",
        ...findings.map((f, i) =>
          `${i + 1}. [${f.confidence.toFixed(1)}] ${f.claim_preview}\n   Source: ${f.source_url}\n   Session: ${f.session_id} (${f.timestamp})`
        ),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  });

  // Tool 3: research_enrich (Data agent writes findings from other sources)
  pi.registerTool({
    name: "research_enrich",
    label: "Enrich Research",
    description: "Add findings from external sources (datasets, analysis, manual research) to the research store. Used by Data agent to enrich existing research with additional data.",
    parameters: Type.Object({
      session_id: Type.Optional(Type.String({ description: "Attach to existing session, or creates new enrichment session" })),
      findings: Type.Array(Type.Object({
        claim: Type.String(),
        source_url: Type.String({ description: "Source (can be internal: 'dataset:name.csv')" }),
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
}
```

### Phase 7: Knowledge graph integration (graph.ts)

Optional sidecar. System works without it (JSONL is the primary store). Graph adds relationship queries and semantic search.

```typescript
const GRAPH_URL = process.env.GRAPHITI_URL || "";

async function graphIngest(finding: Finding): Promise<void> {
  if (!GRAPH_URL) return;  // graph disabled, no-op
  
  try {
    await fetch(`${GRAPH_URL}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        episode: {
          content: finding.claim,
          source: finding.source_url,
          timestamp: finding.timestamp,
          metadata: {
            session_id: finding.session_id,
            confidence: finding.confidence,
            finding_id: finding.id,
          },
        },
        entities: finding.entities.map(e => ({
          name: e.name,
          type: e.type,
        })),
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Graph ingest is fire-and-forget. Failures don't block research.
  }
}

async function graphQuery(query: string, limit: number): Promise<any[]> {
  if (!GRAPH_URL) return [];
  
  try {
    const res = await fetch(`${GRAPH_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    return (await res.json()).results || [];
  } catch {
    return [];
  }
}
```

#### Graph infrastructure (docker-compose addition when ready)

```yaml
services:
  graphiti:
    build: ./src/agents/graphiti
    environment:
      - NEO4J_URI=bolt://neo4j:7687
      - LLM_PROVIDER=deepseek
      - LLM_API_KEY=${DEEPSEEK_API_KEY}
    depends_on:
      - neo4j
    networks:
      - internal

  neo4j:
    image: neo4j:5-community
    environment:
      - NEO4J_AUTH=neo4j/${NEO4J_PASSWORD}
    volumes:
      - neo4j-data:/data
    networks:
      - internal
```

Note: Graphiti normally uses OpenAI for entity extraction. Configure to use DeepSeek instead (or skip graph-level extraction since we already extract entities in our tool).

### Phase 8: Index query (store.ts)

Simple JSONL grep for the research_query tool. No database needed for eval.

```typescript
function queryIndex(query: string, maxResults: number, sessionFilter?: string): IndexEntry[] {
  const indexPath = `/artifacts/research/index.jsonl`;
  if (!existsSync(indexPath)) return [];

  const queryTerms = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const results: { entry: IndexEntry; score: number }[] = [];

  const lines = readFileSync(indexPath, "utf-8").split("\n").filter(Boolean);
  for (const line of lines) {
    const entry: IndexEntry = JSON.parse(line);
    if (sessionFilter && entry.session_id !== sessionFilter) continue;

    // Score against query
    const text = `${entry.claim_preview} ${entry.topic_tags.join(" ")} ${entry.entities.map(e => e.name).join(" ")}`.toLowerCase();
    const matches = queryTerms.filter(t => text.includes(t)).length;
    if (matches === 0) continue;

    const score = (matches / queryTerms.length) * entry.confidence;
    results.push({ entry, score });
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map(r => r.entry);
}
```

### Phase 9: Helpers

#### Chunking

```typescript
function chunkText(text: string, size: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start += size - overlap;
  }
  return chunks;
}
```

#### Deduplication

```typescript
function deduplicateFindings(findings: Finding[], threshold = 0.7): Finding[] {
  const result: Finding[] = [];
  for (const f of findings) {
    const fWords = new Set(f.claim.toLowerCase().split(/\s+/));
    const isDupe = result.some(existing => {
      const eWords = new Set(existing.claim.toLowerCase().split(/\s+/));
      const intersection = [...fWords].filter(w => eWords.has(w)).length;
      const union = new Set([...fWords, ...eWords]).size;
      return intersection / union > threshold;
    });
    if (!isDupe) result.push(f);
  }
  return result;
}
```

#### Page fetching (reuses web-fetch pattern)

```typescript
async function fetchPage(url: string, signal?: AbortSignal): Promise<{ url: string; title: string; content: string }> {
  // Direct fetch first
  const direct = await fetchDirect(url, signal);
  if (!direct.error && direct.content.length >= 200) {
    return { url, title: direct.title, content: direct.content };
  }
  // Jina fallback
  const jina = await fetchWithJina(url, signal);
  if (jina) return { url, title: jina.title, content: jina.content };
  // Return whatever we got
  return { url, title: direct.title || "", content: direct.content || "" };
}
```

### Phase 10: Testing

- Unit: heuristic ranking (keyword scoring, combined score calculation)
- Unit: LLM client retry/backoff (mock HTTP 429, 500)
- Unit: extraction response parsing (valid JSON, malformed, partial)
- Unit: entity extraction (verify entities field populated)
- Unit: deduplication (known dupes removed, near-misses kept)
- Unit: chunking (overlap correctness, boundary handling)
- Unit: index query (keyword matching, scoring, session filter)
- Integration: full sweep with mocked Exa + mocked DeepSeek
- Integration: real sweep (live Exa + live DeepSeek) on known query
- Integration: research_query after research_enrich (round-trip)
- Integration: streaming writes (verify JSONL append during sweep)
- End-to-end: deep_research on real query, verify artifacts created

## Downstream agent workflows

### Data agent enrichment

```
1. CEO assigns: "Enrich EV research with market data"
2. Data agent calls: research_query("electric vehicle market")
3. Gets existing findings: entities ["Tesla", "BYD", "market size"]
4. Data agent scrapes: financial APIs, market datasets
5. Data agent calls: research_enrich(findings=[...])
6. Index grows. Graph builds cross-references automatically.
```

### Writer consumption

```
1. CEO assigns: "Write LinkedIn post about EV trends"
2. Writer calls: research_query("EV market trends")
3. Gets 30 findings from research + enrichment sessions
4. Each finding has: claim, source, quote, confidence, entities
5. Writer synthesizes narrative with proper attribution
```

### Analyst (human) exploration

```
1. Browse /artifacts/research/sessions/ — see all research sessions
2. Read findings.jsonl — every finding with full provenance
3. Read pages/{hash}.md — original source pages at time of research
4. Query graph (Graphiti UI or API) — entity relationships, temporal facts
5. Add more research via Data agent or direct enrichment
```

## Open Questions

1. **Graphiti provider swap:** Graphiti uses OpenAI by default for entity extraction. Since we extract entities ourselves, can we disable Graphiti's extraction and just ingest pre-extracted entities? Or configure it to use DeepSeek?

2. **Index scaling:** JSONL grep works for hundreds of findings. At thousands+, need proper search (SQLite FTS, or vector search). When to upgrade?

3. **Cross-session deduplication:** Same fact found in multiple sessions. Currently stored separately. Should index-level dedup merge them? Or keep separate (temporal — "we learned this again" is signal)?

4. **Finding expiry:** Research ages. A finding from 6 months ago may be stale. Timestamp enables this but who enforces freshness? QA agent during review?

5. **Page snapshot storage:** 200 pages × 6 sub-queries × ~50KB = ~60MB per session. At 10 sessions/day = 600MB/day. Need TTL/cleanup policy. Keep findings forever, expire page snapshots after 30 days?

## Definition of Done

- [ ] Engine: plan → parallel sweeps → reflect → iterate loop working
- [ ] Heuristic ranking: BM25 + Exa score combined filter
- [ ] LLM URL selection: one call per sub-query, picks top pages
- [ ] LLM extraction: findings + entities from page chunks
- [ ] Streaming: findings written to JSONL as produced (not batched)
- [ ] Page snapshots: full pages stored as artifacts
- [ ] Cross-session index: queryable JSONL with keyword search
- [ ] deep_research tool: full pipeline, returns session summary
- [ ] research_query tool: searches existing findings
- [ ] research_enrich tool: Data agent can add findings from other sources
- [ ] Graph integration: fire-and-forget POST to Graphiti (if configured)
- [ ] Parallel execution: sub-queries run concurrently
- [ ] Context isolation: no inner LLM call exceeds ~5k tokens
- [ ] Cost: <$0.04 per research session at 200 sources × 6 sub-queries
- [ ] Integration tests with mocked APIs
- [ ] End-to-end test with real query
- [ ] Zero npm dependencies (raw fetch throughout)
- [ ] Provider keys documented in .env.example

## Risks

- **Inner LLM latency:** 6 parallel sub-queries × ~5 LLM calls each = 30 concurrent API calls to DeepSeek. Rate limits may throttle. Mitigation: semaphore (max 10 concurrent), retry with backoff.
- **Exa cost at 200 results:** Exa charges per search. 200 results per query × 6 queries × 3 iterations = 18 Exa calls. At ~$0.003/search = $0.054. Combined with LLM: ~$0.09/session total.
- **Page fetch failures:** Some URLs will 403/timeout. Mitigation: skip failed fetches, don't retry (time is cost). Note failure in sweep summary.
- **JSONL index scaling:** Linear scan of index.jsonl is O(n). At 10k+ findings, search slows. Mitigation: acceptable for eval; upgrade to SQLite FTS when needed.
- **Storage growth:** 60MB/day for page snapshots. Mitigation: TTL-based cleanup (keep findings, expire snapshots after configurable period).
