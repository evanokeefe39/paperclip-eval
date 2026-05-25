# Deep Research Extension

## Intent

Port the wave-based iterative research pattern from agent-researcher (LangGraph/Python) to a Pi extension (TypeScript). Gives Researcher agent ability to conduct multi-iteration deep research: plan sub-queries, execute search sweeps, rank and extract findings, reflect on coverage, iterate until satisfied or budget exhausted.

## Architecture Decision: LLM-as-Orchestrator

Pi's model IS the orchestrator. No need for a code-level state machine. Register high-level compound tools that encapsulate mechanical work. The LLM calls them in sequence, making strategic decisions (what to research, when to stop) while code handles mechanics (batching, caching, parallelism, chunking).

**Tool decomposition:**

| Tool | LLM decides | Code handles |
|------|-------------|--------------|
| `research_plan` | Sub-query angles, rationales | Parse structured output, validate count bounds |
| `research_sweep` | Nothing — just invokes | Full pipeline: search → rank → fetch → chunk → extract |
| `research_reflect` | Continue/stop, new sub-queries | Enforce iteration cap, format inputs |
| `research_finalize` | Nothing — just invokes | Assemble findings, dedupe, format output |

The LLM's natural loop: plan → sweep(each) → reflect → (sweep new | finalize).

## Design Constraints

- Zero npm deps beyond what's already in the container (node:22-slim)
- Extension must work with DeepSeek as provider (reliable tool calling per CLAUDE.md)
- Context window pressure: findings accumulate in LLM context. Tool responses must be concise (refs/summaries, not raw content)
- Exa API for search (already integrated via web-search.ts — reuse pattern)
- Cache must survive within a single invocation but not across (no persistent SQLite in ephemeral workspace)

## Implementation Plan

### Phase 1: Core tools (research_plan, research_sweep)

#### 1.1 — File structure

```
src/agents/extensions/
  deep-research.ts          Main extension file — registers all tools
  deep-research/
    types.ts                State interfaces, finding schemas
    sweep.ts                Wide sweep pipeline (search → rank → extract)
    cache.ts                In-memory LRU cache for search/fetch results
    prompts.ts              System prompts for internal LLM calls
    config.ts               Knobs and defaults
```

#### 1.2 — State types

```typescript
interface SubQuery {
  id: string;          // snake_case slug
  query: string;       // search query text
  rationale: string;   // why this angle matters
}

interface FindingRef {
  id: string;
  url: string;
  claim: string;       // ≤150 chars
  confidence: number;  // 0-1
  sub_query_id: string;
}

interface SubQuerySummary {
  sub_query_id: string;
  key_claims: string[];     // 3-7 bullets
  coverage: string;         // 1-2 sentences
  gaps: string[];
  finding_count: number;
  source_count: number;
}

interface SweepResult {
  sub_query: SubQuery;
  findings: FindingRef[];
  summary: SubQuerySummary;
}
```

#### 1.3 — research_plan tool

**Input:** `{ query: string, max_sub_queries?: number }`
**Output:** Structured list of SubQuery objects (3-6)

Implementation:
1. Call LLM (via Exa? No — need internal LLM call)

**Problem:** Pi extensions can't make LLM calls directly. They execute tools and return results. The LLM calling the tool IS the model.

**Revised architecture:** The research_plan tool doesn't call an LLM — it formats a structured prompt that the Pi agent LLM responds to directly. The tool itself just validates and stores the plan.

Wait — no. Pi tools execute and return results. The LLM sees the result and decides next action. We need a different pattern:

**Correct pattern for Pi:**
- `research_plan` doesn't generate sub-queries (that's the LLM's job) — it STORES them
- The LLM generates sub-queries naturally, then calls `research_sweep` for each
- `research_sweep` does the mechanical work (search, rank, extract) and returns findings
- `research_reflect` returns a summary of all findings so far for the LLM to evaluate
- The LLM decides whether to continue or finalize

**Revised tool set:**

| Tool | Input | Output | Internal work |
|------|-------|--------|---------------|
| `research_sweep` | `{ query, sub_query, context? }` | `SweepResult` (findings + summary) | search → rank → fetch → chunk → extract |
| `research_progress` | `{}` | All summaries + iteration count | Read from accumulated state |
| `research_finalize` | `{ format? }` | Assembled findings collection | Dedupe, sort by confidence, format |

The LLM itself handles: planning, reflection, iteration decisions. No need for plan/reflect tools because the LLM IS the planner and reflector.

**This is simpler.** Three tools instead of four. The LLM's system prompt instructs it on the wave pattern.

#### 1.4 — research_sweep implementation (the big one)

Pipeline inside a single tool execution:

```
1. Search (Exa API)
   - query: sub_query text
   - numResults: 10 (configurable)
   - Get snippets with highlights

2. Rank (internal heuristic — no LLM call available)
   - Score snippets by: title relevance, highlight density, content length
   - TF-IDF or keyword overlap scoring against sub_query
   - Keep top-K (5) URLs

3. Fetch full pages (top-K URLs)
   - Reuse web-fetch.ts pattern (direct + Jina fallback)
   - Concurrent fetches with timeout
   - Cache results (in-memory, keyed by URL)

4. Chunk
   - Split full-page text: 1500 chars, 200 overlap
   - Keep top 8 chunks per URL (by keyword density vs sub_query)

5. Extract findings (heuristic — no internal LLM)
   - Pull sentences containing sub_query keywords
   - Extract claims: sentences with factual assertions (numbers, dates, names)
   - Score by keyword density and position (earlier = higher confidence)
   - Cap at 20 findings per sweep

6. Summarize
   - Return: key findings (top 10 by confidence), sources used, coverage estimate
```

**Key constraint:** No internal LLM calls from within a tool. All extraction must be heuristic/mechanical. The LLM's intelligence is applied AFTER it reads the sweep results.

**Alternative:** If Pi supports nested tool calls or has an LLM invocation API available to extensions, we could do LLM-powered extraction. Check Pi extension API.

#### 1.5 — Ranking without LLM

Since we can't call an LLM inside the tool, ranking uses:
- BM25-style keyword scoring (query terms vs snippet text)
- Bonus for exact phrase matches
- Bonus for title containing query terms
- Penalty for very short snippets (<100 chars)
- Returns sorted by score, top-K

This is less accurate than LLM ranking but zero-cost and fast. The LLM compensates by evaluating the returned findings itself.

#### 1.6 — Extraction without LLM

Heuristic extraction from chunks:
- Sentence segmentation (split on `.!?` followed by space/newline)
- Filter: keep sentences with ≥2 query keywords OR containing numbers/statistics
- Filter: remove navigation/boilerplate (sentences <20 chars, or matching common patterns)
- Score: keyword density × position weight × length bonus
- Format as findings with URL, sentence text, confidence score
- Deduplicate by similarity (Jaccard on word sets, threshold 0.7)

The LLM reads these findings and applies its own judgment about relevance and quality.

### Phase 2: State management and caching

#### 2.1 — In-memory state

Extension maintains state across tool calls within a single Pi session:

```typescript
// Module-level state (persists across tool calls in one session)
const sessionState = {
  sweepResults: Map<string, SweepResult>(),  // sub_query_id → result
  allFindings: FindingRef[],
  searchCache: Map<string, ExaResult[]>(),   // query → results
  fetchCache: Map<string, string>(),          // url → content
  iterationCount: 0,
};
```

#### 2.2 — Cache strategy

- Search results: keyed by query string (exact match)
- Fetched pages: keyed by URL
- Both in-memory only (session-scoped, no persistence needed)
- LRU eviction at 100 entries to bound memory

### Phase 3: research_progress and research_finalize

#### 3.1 — research_progress

Returns current state for LLM to evaluate:
- Total findings count
- Per-sub-query: summary, finding count, coverage assessment
- Iteration count
- Suggested action (continue if <3 iterations and gaps detected — heuristic)

#### 3.2 — research_finalize

Assembles all findings into a structured output:
- Deduplicate across sub-queries (Jaccard similarity)
- Sort by confidence descending
- Group by source URL
- Format as markdown with citations
- Clear session state

### Phase 4: System prompt integration

The Researcher agent's system prompt must instruct the wave pattern:

```
## Deep Research Protocol

When given a complex research query, follow this iterative process:

1. PLAN: Decompose the query into 3-6 non-overlapping sub-queries, each independently searchable
2. SWEEP: Call research_sweep for each sub-query. Read the findings carefully.
3. EVALUATE: After all sweeps complete, call research_progress to review coverage.
4. DECIDE: If significant gaps remain and iteration < 3, identify 1-3 new sub-queries and sweep again.
5. FINALIZE: When coverage is sufficient (or max iterations reached), call research_finalize.

Be conservative — research has a cost. Most queries need 1-2 iterations. Only continue if gaps would materially change the findings.
```

### Phase 5: Testing

- Unit tests for ranking heuristic (keyword scoring)
- Unit tests for extraction heuristic (sentence filtering)
- Unit tests for deduplication (Jaccard similarity)
- Integration test: mock Exa API, run full sweep, verify finding structure
- End-to-end: run Researcher agent with deep-research extension against real query

## Open Questions (must resolve before implementation)

1. **Can Pi extensions make LLM calls?** If yes, we can do LLM-powered ranking and extraction (much higher quality). If no, heuristic approach is the fallback. Check Pi extension API docs.

2. **Session state persistence:** Does Pi maintain extension module state across tool calls in one conversation? If not, need a different state pattern (write to /artifacts and read back).

3. **Concurrency in extensions:** Can we use `Promise.all` for parallel fetches inside a tool execution? Or does Pi's runtime constrain this?

4. **Token budget:** How much text can a tool return before it overwhelms the agent's context? Need to cap sweep result size (finding count, summary length).

5. **Extension loading:** Can one extension register multiple tools? (Existing extensions register one each, but the API may support multiple.)

## Definition of Done

- [ ] research_sweep tool: search → rank → fetch → chunk → extract pipeline working
- [ ] research_progress tool: returns accumulated state summary
- [ ] research_finalize tool: assembles and formats findings collection
- [ ] In-memory caching for search results and fetched pages
- [ ] Deduplication across sub-queries
- [ ] Researcher agent system prompt updated with deep research protocol
- [ ] Integration test with mocked Exa API
- [ ] End-to-end test with real query (manual, documented in test results)
- [ ] No new npm dependencies
- [ ] Extension loads cleanly alongside existing web_search and web_fetch

## Risks

- **Heuristic extraction quality:** Without LLM-powered extraction, findings will be noisier. Mitigation: the agent LLM filters noise when it reads results. Acceptable for eval stage.
- **Context overflow:** Too many findings could overwhelm agent context. Mitigation: cap findings per sweep (20), summaries are concise (bullets only).
- **Exa rate limits:** Multiple sweeps hit Exa API heavily. Mitigation: caching prevents redundant searches; configurable numResults.
