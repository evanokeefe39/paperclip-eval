# Deep Research Engine (Core)

## Intent

Self-contained research orchestration engine as a Pi extension tool. Code-level state machine that plans sub-queries, executes parallel sweeps, reflects on coverage, and iterates. Uses cheap inner LLM calls (DeepSeek) for extraction quality while keeping outer agent model-agnostic. All parallelism and context isolation handled internally.

## Dependencies

- Exa API (search, already integrated)
- DeepSeek API (inner LLM calls for selection + extraction)
- Web fetch pattern (from existing web-fetch.ts)
- Findings store (see deep-research-store.md)

## File structure

```
src/agents/extensions/
  deep-research.ts              Main extension — registers tools
  deep-research/
    engine.ts                   Main orchestration loop
    sweep.ts                    Single sub-query sweep pipeline
    llm.ts                      Provider API client
    rank.ts                     Heuristic ranking (BM25 + Exa score)
    extract.ts                  LLM-powered extraction + entities
    checkpoint.ts               Durable execution — SQLite checkpoint/resume
    prompts.ts                  All inner LLM prompts
    config.ts                   Knobs and defaults
    cache.ts                    In-memory LRU cache
    types.ts                    Interfaces (SubQuery, SweepResult, Config)
```

## Architecture

```
deep_research(query) called by Researcher agent
    │
    ▼
Plan (1 LLM call, ~2k ctx)
    → 3-6 sub-queries
    │
    ▼
Promise.all([sweep(sq1), sweep(sq2), sweep(sq3), ...])  ← PARALLEL
    │
    │  Each sweep (ISOLATED, no shared context):
    │    search (Exa, 200 results) → heuristic rank → LLM select (~5k ctx)
    │    → fetch pages → chunk → LLM extract (~4k ctx per page)
    │    → stream findings to store
    │
    ▼
Reflect (1 LLM call, summaries only ~3k ctx)
    → continue + new sub-queries, or stop
    │
    ▼
Iterate (max 3) or finalize
    → return session summary to agent
```

### Context budget per inner LLM call

| Call | Max context | Content |
|------|------------|---------|
| Plan | ~2k tokens | System prompt + original query |
| Select URLs | ~5k tokens | System prompt + sub-query + 40 formatted snippets |
| Extract (per page) | ~4k tokens | System prompt + sub-query + page chunks |
| Reflect | ~3k tokens | System prompt + original query + 6 summaries |

No call exceeds 5k tokens. Page content lives in code memory only.

## LLM Client (llm.ts)

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

## Heuristic Ranking (rank.ts)

At 200 snippets per sub-query, heuristic is the primary filter. Exa returns relevance-scored results; we combine with keyword analysis.

```typescript
function heuristicRank(snippets: ExaResult[], query: string): RankedSnippet[] {
  const queryTerms = extractKeywords(query);

  return snippets.map(s => {
    const textLower = (s.text || "").toLowerCase();
    const titleLower = (s.title || "").toLowerCase();

    const termMatches = queryTerms.filter(t => textLower.includes(t)).length;
    const termScore = termMatches / queryTerms.length;
    const titleBonus = queryTerms.some(t => titleLower.includes(t)) ? 0.2 : 0;
    const highlightBonus = s.highlights?.length ? Math.min(s.highlights.length * 0.1, 0.3) : 0;
    const lengthPenalty = (s.text?.length || 0) < 200 ? -0.2 : 0;
    const phraseBonus = textLower.includes(query.toLowerCase()) ? 0.3 : 0;

    const heuristic_score = Math.min(1, Math.max(0,
      termScore + titleBonus + highlightBonus + lengthPenalty + phraseBonus
    ));

    const combined_score = (s.score * 0.6) + (heuristic_score * 0.4);

    return { ...s, exa_score: s.score, heuristic_score, combined_score };
  })
  .sort((a, b) => b.combined_score - a.combined_score);
}
```

## LLM URL Selection (extract.ts)

One call per sub-query. Picks which pages deserve full extraction.

```typescript
const SELECT_PROMPT = `You are a research relevance filter. Given a sub-query and ranked snippets, select the URLs most likely to contain substantive, verifiable information.

Return JSON: {"selected_urls": ["url1", "url2", ...], "reason": "one sentence"}

Rules:
1. Select 5-8 URLs maximum.
2. Prefer: primary sources, data-rich pages, expert analysis.
3. Avoid: listicles, aggregator pages, thin content, paywalled sites.
4. Diversity: don't select 3 pages from the same domain.`;
```

## LLM Extraction with Entities (extract.ts)

Extraction and entity extraction in one call — zero additional cost for entities.

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

## Orchestration Loop (engine.ts)

```typescript
async function deepResearch(
  query: string,
  config: Config,
  signal?: AbortSignal
): Promise<{ sessionId: string; summary: string; findingCount: number }> {
  const sessionId = crypto.randomUUID();
  const state: EngineState = {
    sweepResults: new Map(),
    allFindings: [],
    searchCache: new Map(),
    fetchCache: new Map(),
  };

  initSession(sessionId, query, config);

  // 1. PLAN
  const subQueries = await planSubQueries(query, config, signal);

  // 2. EXECUTE + REFLECT loop
  let iteration = 0;
  let pending = [...subQueries];

  while (iteration < config.max_iterations && pending.length > 0) {
    // Parallel sweep execution
    const results = await Promise.all(
      pending.map(sq => executeSweep(sq, query, sessionId, config, state, signal))
    );

    for (const r of results) {
      state.sweepResults.set(r.sub_query.id, r);
      state.allFindings.push(...r.findings);
    }

    // Reflect (summaries only — tiny context)
    const summaries = [...state.sweepResults.values()].map(r => r.summary);
    const decision = await reflect(query, summaries, iteration, config, signal);

    if (!decision.continue || decision.new_sub_queries.length === 0) break;
    pending = decision.new_sub_queries;
    iteration++;
  }

  // 3. FINALIZE
  const summary = buildSessionSummary(query, state, sessionId);
  writeSessionMeta(sessionId, query, subQueries, config, state);

  return { sessionId, summary, findingCount: state.allFindings.length };
}
```

## Sweep Pipeline (sweep.ts)

```typescript
async function executeSweep(
  subQuery: SubQuery,
  originalQuery: string,
  sessionId: string,
  config: Config,
  state: EngineState,
  signal?: AbortSignal
): Promise<SweepResult> {
  // 1. Search (Exa, 200 results)
  const snippets = await searchExa(subQuery.query, config.snippet_results_per_query, state.searchCache, signal);

  // 2. Heuristic rank (free, instant)
  const ranked = heuristicRank(snippets, subQuery.query);
  const survivors = ranked.slice(0, Math.ceil(ranked.length * config.heuristic_keep_ratio));

  // 3. LLM select (one call, ~5k context)
  const selectedUrls = await selectUrls(subQuery.query, survivors, config, signal);

  // 4. Fetch pages (parallel HTTP, stored in code memory)
  const pages = await fetchPages(selectedUrls, state.fetchCache, signal);

  // 5. Chunk
  const pageChunks = pages.map(p => ({
    url: p.url,
    title: p.title,
    chunks: chunkText(p.content, config.chunk_size, config.chunk_overlap)
      .slice(0, config.max_chunks_per_page),
  }));

  // 6. Extract (parallel LLM calls, isolated context per page)
  const allFindings: Finding[] = [];
  await Promise.all(
    pageChunks.map(async ({ url, title, chunks }) => {
      const findings = await extractFromPage(url, title, chunks, subQuery, sessionId, config, signal);
      for (const f of findings) {
        streamFinding(f, sessionId, config);  // writes to store immediately
        allFindings.push(f);
      }
    })
  );

  // 7. Deduplicate + cap
  const deduplicated = deduplicateFindings(allFindings);
  const capped = deduplicated.sort((a, b) => b.confidence - a.confidence).slice(0, config.max_findings_per_sweep);

  // 8. Summary
  const summary: SubQuerySummary = {
    sub_query_id: subQuery.id,
    query: subQuery.query,
    key_claims: capped.slice(0, 7).map(f => f.claim_preview),
    coverage: `${capped.length} findings from ${selectedUrls.length} sources (${snippets.length} scanned).`,
    gaps: [],
    finding_count: capped.length,
    source_count: selectedUrls.length,
  };

  return { sub_query: subQuery, findings: capped, summary, sources_used: pages.map(p => ({ url: p.url, title: p.title })) };
}
```

## Config (config.ts)

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
  heuristic_keep_ratio: 0.2,
  top_k_for_extraction: 8,

  // Chunking
  chunk_size: 1500,
  chunk_overlap: 200,
  max_chunks_per_page: 10,

  // Output
  max_findings_per_sweep: 30,
  max_findings_in_summary: 15,

  // Storage
  artifacts_base: "/artifacts/research",
  graph_url: process.env.GRAPHITI_URL || "",
};
```

## Cost estimate

```
Per session (6 sub-queries × 200 snippets × 3 iterations max):
  Plan: 1 call                    $0.0003
  Select (6-18 calls): 6×3       $0.012
  Extract (40-120 pages): ~60     $0.042
  Reflect: 1-3 calls              $0.002
  Exa search: 6-18 calls          $0.054
  Total: ~$0.06-0.11/session

At 10 sessions/day: $18-33/month
```

## Resilience Strategy

Paperclip does NOT retry failed agent tasks automatically. Two layers of resilience compensate.

### Layer 1: Within a single invocation

| Mechanism | Handles | Implementation |
|-----------|---------|---------------|
| Retry with backoff on API calls | Transient Exa/DeepSeek errors | In llm.ts and searchExa (existing retry loop) |
| `Promise.allSettled` for sweeps | One sub-query failure doesn't kill session | In engine.ts orchestration loop |
| Checkpoint per completed sweep | Progress survives crash | In checkpoint.ts (see below) |
| Top-level self-retry | Whole-engine transient failures | In tool execute wrapper |

### Layer 2: Across invocations (resume)

| Mechanism | Handles | Implementation |
|-----------|---------|---------------|
| Checkpoint file persists in workspace | Container restart, process crash | JSON file at /workspace/.research-checkpoint.json |
| Auto-resume on re-invocation | Manual or CEO-triggered retry | Engine checks for checkpoint on startup |
| `deep_research_resume` tool | Explicit resume by agent | Separate tool registration |
| CEO-level awareness | Systemic failures, stuck tasks | Researcher reports partial results; CEO can re-assign |

### Top-level self-retry wrapper

```typescript
function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("econnrefused") ||
    msg.includes("fetch failed") ||
    msg.includes("socket hang up") ||
    msg.includes("503") ||
    msg.includes("429") ||
    msg.includes("network")
  );
}

async function deepResearchWithRetry(
  query: string,
  config: Config,
  signal?: AbortSignal
): Promise<ResearchResult> {
  const MAX_TOP_RETRIES = 2;

  for (let attempt = 0; attempt <= MAX_TOP_RETRIES; attempt++) {
    try {
      return await deepResearch(query, config, signal);
    } catch (err) {
      const transient = isTransient(err);
      const retriable = attempt < MAX_TOP_RETRIES && transient;

      if (retriable) {
        const delay = 5000 * (attempt + 1);
        await sleep(delay);
        // Checkpoint ensures no duplicate work on retry
        continue;
      }

      // Non-retriable or exhausted retries: return partial results
      const checkpoint = new Checkpoint();
      const session = checkpoint.findResumable(query);
      const completedCount = session
        ? session.subQueries.filter(sq => sq.status === "complete").length
        : 0;

      return {
        sessionId: session?.session_id || "unknown",
        summary: [
          `## Research Interrupted`,
          `Error: ${err instanceof Error ? err.message : String(err)}`,
          `Completed sweeps: ${completedCount}`,
          `Partial findings saved to checkpoint.`,
          transient
            ? `Transient error — resume with deep_research_resume or re-submit same query.`
            : `Non-transient error — investigate before retrying.`,
        ].join("\n"),
        findingCount: 0,
        interrupted: true,
      };
    }
  }
  throw new Error("unreachable");
}
```

### CEO-level awareness

When research fails or returns partial results, the Researcher agent's response to Paperclip includes enough info for the CEO agent to decide what to do.

**Researcher system prompt addition:**

```
## Failure Reporting

If deep_research returns an interrupted result:
1. Report the partial findings (what WAS completed)
2. Report the error and whether it's transient
3. Recommend: "resume" (transient) or "investigate" (non-transient)
4. Do NOT silently retry indefinitely — report status to CEO after max retries exhausted

The CEO will decide whether to:
- Re-assign the same research task (triggers auto-resume via checkpoint)
- Modify the research scope and re-assign
- Escalate to human
```

**CEO system prompt addition:**

```
## Handling Agent Failures

If an agent reports an interrupted or failed task:
1. Check if the error is transient (network, timeout) or systemic (bad query, API key, quota)
2. For transient: re-assign the same task. The agent's checkpoint system will resume from where it left off.
3. For systemic: escalate to human with the error details.
4. Do NOT re-assign more than twice for the same task. After 2 failures, escalate.

Track retry count in the issue thread. Pattern:
  "Attempt 1: interrupted (ECONNRESET). Re-assigning."
  "Attempt 2: interrupted (ETIMEDOUT). Re-assigning."
  "Attempt 3: still failing. Escalating to human."
```

### Failure → resume flow

```
Invocation 1:
  deep_research("EV market trends")
    sweep(sq1) ✓ → checkpoint
    sweep(sq2) ✓ → checkpoint
    sweep(sq3) ← ECONNRESET
    self-retry (attempt 2):
      sweep(sq3) ← ETIMEDOUT (still broken)
    returns: interrupted, 2/6 sweeps complete

Researcher agent → Paperclip:
  "Research interrupted after 2/6 sub-queries. Transient network error. Recommend resume."

CEO reads response, re-assigns task to Researcher.

Invocation 2:
  deep_research("EV market trends")
    finds checkpoint → sq1 done, sq2 done, sq3-6 pending
    sweep(sq3) ✓ → checkpoint (network recovered)
    sweep(sq4) ✓ → checkpoint
    sweep(sq5) ✓ → checkpoint
    sweep(sq6) ✓ → checkpoint
    reflect → finalize
    returns: complete, all findings
```

Total cost of resume: only the remaining sweeps execute. Completed work never repeated.

## Tool registration (deep-research.ts)

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "deep_research",
    label: "Deep Research",
    description: "Execute comprehensive multi-iteration research. Searches hundreds of sources per sub-query, extracts findings with full provenance, streams to knowledge store. Auto-resumes interrupted sessions.",
    parameters: Type.Object({
      query: Type.String({ description: "Research query" }),
      max_iterations: Type.Optional(Type.Number()),
      max_sub_queries: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, signal) {
      const config = { ...DEFAULT_CONFIG, ...params };
      const result = await deepResearchWithRetry(params.query, config, signal);

      if (result.interrupted) {
        return {
          content: [{ type: "text" as const, text: result.summary }],
          details: { interrupted: true, sessionId: result.sessionId },
        };
      }

      return {
        content: [{ type: "text" as const, text: [
          `## Research Complete`,
          `Session: ${result.sessionId}`,
          `Findings: ${result.findingCount}`,
          ``,
          result.summary,
          ``,
          `Full data: /artifacts/research/sessions/${result.sessionId}/`,
        ].join("\n") }],
      };
    },
  });

  pi.registerTool({
    name: "deep_research_resume",
    label: "Resume Research",
    description: "Resume an interrupted research session. Skips completed sub-queries, retries failed ones. Use when a previous deep_research was interrupted.",
    parameters: Type.Object({
      session_id: Type.Optional(Type.String({ description: "Session to resume (auto-detects if omitted)" })),
      query: Type.Optional(Type.String({ description: "Original query (for auto-detection)" })),
    }),
    async execute(_id, params, signal) {
      const config = DEFAULT_CONFIG;
      const result = await deepResearchWithRetry(params.query || "", config, signal);
      return {
        content: [{ type: "text" as const, text: result.interrupted
          ? result.summary
          : `Resumed and completed session ${result.sessionId}. ${result.findingCount} findings.`
        }],
      };
    },
  });

  // research_query and research_enrich registered here too
  // (implementation in deep-research-store.md)
}
```

## Durable Execution (checkpoint.ts)

Research sessions run 5-10+ minutes. Transient failures (network blips, API timeouts, container restarts) shouldn't lose all progress. Checkpoint after each atomic unit of work (completed sweep). Resume skips completed work.

### Design principles

- **Checkpoint granularity: per sweep.** A sweep is the atomic unit — either fully complete or retried from scratch. No mid-sweep checkpointing (too complex for marginal gain).
- **Storage: SQLite in workspace.** Single file, WAL mode, survives process restart. No external service dependency.
- **Resume: automatic.** Engine checks for existing checkpoint on startup. If found for same query, resumes. If not, starts fresh.
- **Not Temporal.** No workflow orchestrator, no event sourcing. Just a state snapshot after each step.

### Checkpoint schema

```sql
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  config TEXT NOT NULL,           -- JSON
  status TEXT NOT NULL,           -- 'running' | 'reflecting' | 'complete' | 'failed'
  iteration INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sub_queries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  query TEXT NOT NULL,
  rationale TEXT,
  iteration INTEGER NOT NULL,     -- which iteration spawned this
  status TEXT NOT NULL,           -- 'pending' | 'running' | 'complete' | 'failed'
  summary TEXT,                   -- JSON SubQuerySummary (null until complete)
  error TEXT,                     -- error message if failed
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE TABLE IF NOT EXISTS reflections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  iteration INTEGER NOT NULL,
  decision TEXT NOT NULL,         -- JSON { continue, reason, new_sub_queries }
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
```

### Checkpoint operations

```typescript
import Database from "better-sqlite3";  // or: raw sqlite3 via child_process

const DB_PATH = "/workspace/.research-checkpoint.db";

class Checkpoint {
  private db: Database.Database;

  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA_SQL);
  }

  // Check if resumable session exists for this query
  findResumable(query: string): SessionCheckpoint | null {
    const row = this.db.prepare(
      "SELECT * FROM sessions WHERE query = ? AND status IN ('running', 'reflecting') ORDER BY updated_at DESC LIMIT 1"
    ).get(query);
    if (!row) return null;
    return {
      ...row,
      subQueries: this.db.prepare("SELECT * FROM sub_queries WHERE session_id = ?").all(row.session_id),
      reflections: this.db.prepare("SELECT * FROM reflections WHERE session_id = ? ORDER BY iteration").all(row.session_id),
    };
  }

  // Create new session
  createSession(sessionId: string, query: string, config: Config): void {
    this.db.prepare(
      "INSERT INTO sessions (session_id, query, config, status, iteration, created_at, updated_at) VALUES (?, ?, ?, 'running', 0, ?, ?)"
    ).run(sessionId, query, JSON.stringify(config), now(), now());
  }

  // Record planned sub-queries
  addSubQueries(sessionId: string, subQueries: SubQuery[], iteration: number): void {
    const stmt = this.db.prepare(
      "INSERT OR IGNORE INTO sub_queries (id, session_id, query, rationale, iteration, status) VALUES (?, ?, ?, ?, ?, 'pending')"
    );
    for (const sq of subQueries) {
      stmt.run(sq.id, sessionId, sq.query, sq.rationale, iteration);
    }
  }

  // Mark sweep started
  markSweepStarted(subQueryId: string): void {
    this.db.prepare(
      "UPDATE sub_queries SET status = 'running', started_at = ? WHERE id = ?"
    ).run(now(), subQueryId);
  }

  // Mark sweep complete (with summary)
  markSweepComplete(subQueryId: string, summary: SubQuerySummary): void {
    this.db.prepare(
      "UPDATE sub_queries SET status = 'complete', summary = ?, completed_at = ? WHERE id = ?"
    ).run(JSON.stringify(summary), now(), subQueryId);
  }

  // Mark sweep failed
  markSweepFailed(subQueryId: string, error: string): void {
    this.db.prepare(
      "UPDATE sub_queries SET status = 'failed', error = ?, completed_at = ? WHERE id = ?"
    ).run(error, now(), subQueryId);
  }

  // Record reflection decision
  addReflection(sessionId: string, iteration: number, decision: ReflectDecision): void {
    this.db.prepare(
      "INSERT INTO reflections (session_id, iteration, decision, created_at) VALUES (?, ?, ?, ?)"
    ).run(sessionId, iteration, JSON.stringify(decision), now());
    this.db.prepare(
      "UPDATE sessions SET iteration = ?, status = 'reflecting', updated_at = ? WHERE session_id = ?"
    ).run(iteration, now(), sessionId);
  }

  // Mark session complete
  markComplete(sessionId: string): void {
    this.db.prepare(
      "UPDATE sessions SET status = 'complete', updated_at = ? WHERE session_id = ?"
    ).run(now(), sessionId);
  }

  // Cleanup old sessions (keep last 20)
  cleanup(): void {
    this.db.prepare(
      "DELETE FROM sessions WHERE session_id NOT IN (SELECT session_id FROM sessions ORDER BY updated_at DESC LIMIT 20)"
    ).run();
  }
}
```

### Engine integration

```typescript
async function deepResearch(query: string, config: Config, signal?: AbortSignal) {
  const checkpoint = new Checkpoint();
  
  // Check for resumable session
  const existing = checkpoint.findResumable(query);
  
  let sessionId: string;
  let subQueries: SubQuery[];
  let iteration: number;
  let completedSweeps: Map<string, SubQuerySummary>;

  if (existing) {
    // RESUME from checkpoint
    sessionId = existing.session_id;
    iteration = existing.iteration;
    subQueries = existing.subQueries.map(sq => ({ id: sq.id, query: sq.query, rationale: sq.rationale }));
    completedSweeps = new Map(
      existing.subQueries
        .filter(sq => sq.status === "complete")
        .map(sq => [sq.id, JSON.parse(sq.summary)])
    );
    // Pending = not yet complete (including previously failed — retry)
    const pendingIds = new Set(
      existing.subQueries.filter(sq => sq.status !== "complete").map(sq => sq.id)
    );
    // ... continue from pending
  } else {
    // FRESH session
    sessionId = crypto.randomUUID();
    checkpoint.createSession(sessionId, query, config);
    
    subQueries = await planSubQueries(query, config, signal);
    checkpoint.addSubQueries(sessionId, subQueries, 0);
    
    iteration = 0;
    completedSweeps = new Map();
  }

  // Execute loop (same as before, but with checkpoint writes)
  let pending = subQueries.filter(sq => !completedSweeps.has(sq.id));

  while (iteration < config.max_iterations && pending.length > 0) {
    const results = await Promise.allSettled(
      pending.map(async sq => {
        checkpoint.markSweepStarted(sq.id);
        try {
          const result = await executeSweep(sq, query, sessionId, config, state, signal);
          checkpoint.markSweepComplete(sq.id, result.summary);
          return result;
        } catch (err) {
          checkpoint.markSweepFailed(sq.id, err.message);
          throw err;
        }
      })
    );

    // Process results (fulfilled sweeps contribute findings)
    for (const r of results) {
      if (r.status === "fulfilled") {
        state.sweepResults.set(r.value.sub_query.id, r.value);
        state.allFindings.push(...r.value.findings);
      }
      // Failed sweeps: logged in checkpoint, skipped for now
    }

    // Reflect
    const summaries = [...state.sweepResults.values()].map(r => r.summary);
    const decision = await reflect(query, summaries, iteration, config, signal);
    checkpoint.addReflection(sessionId, iteration, decision);

    if (!decision.continue || decision.new_sub_queries.length === 0) break;
    
    // New sub-queries for next iteration
    checkpoint.addSubQueries(sessionId, decision.new_sub_queries, iteration + 1);
    pending = decision.new_sub_queries;
    iteration++;
  }

  checkpoint.markComplete(sessionId);
  checkpoint.cleanup();

  return { sessionId, summary: buildSessionSummary(query, state, sessionId), findingCount: state.allFindings.length };
}
```

### Resume behavior

| Scenario | Behavior |
|----------|----------|
| Process restart mid-sweep | Checkpoint shows sweep as 'running'. On resume: reset to 'pending', retry from scratch. |
| Network error in one sweep (parallel) | `Promise.allSettled` catches it. Other sweeps continue. Failed sweep marked in checkpoint. |
| All sweeps complete, crash before reflect | Checkpoint shows all sweeps 'complete'. Resume: skip sweeps, go directly to reflect. |
| Reflect complete, crash before next iteration | Reflection stored. Resume: read new sub-queries from reflection, continue. |
| Agent manually re-invokes same query | Finds existing session, resumes. Different query = new session. |

### SQLite in the extension

**Problem:** `better-sqlite3` is a native module (npm dependency). Conflicts with zero-dep goal.

**Options:**
1. Use Node's built-in `node:sqlite` (available in Node 22.5+ via `--experimental-sqlite`) — zero deps
2. Shell out to `sqlite3` CLI (installed in container): `execSync('sqlite3 /workspace/.checkpoint.db "SELECT..."')`
3. Use a JSON file as checkpoint (simpler, less robust)

**Recommendation:** Option 1 if Node 22.5+ (likely in node:22-slim). Fallback to Option 3 (JSON checkpoint file) if not available.

```typescript
// JSON checkpoint fallback (no SQLite needed)
const CHECKPOINT_PATH = "/workspace/.research-checkpoint.json";

interface CheckpointFile {
  sessions: Record<string, {
    query: string;
    status: string;
    iteration: number;
    subQueries: Record<string, { status: string; summary?: SubQuerySummary }>;
    reflections: ReflectDecision[];
  }>;
}

// Read/write atomically (write to .tmp, rename)
function writeCheckpoint(data: CheckpointFile): void {
  writeFileSync(CHECKPOINT_PATH + ".tmp", JSON.stringify(data));
  renameSync(CHECKPOINT_PATH + ".tmp", CHECKPOINT_PATH);
}
```

JSON file is sufficient for eval. Atomic write (tmp + rename) prevents corruption on crash. Upgrade to SQLite if concurrency or query complexity demands it.

### Tool addition: deep_research_resume

```typescript
pi.registerTool({
  name: "deep_research_resume",
  label: "Resume Research",
  description: "Resume an interrupted research session. Skips completed sub-queries, retries failed ones, continues from last checkpoint.",
  parameters: Type.Object({
    session_id: Type.Optional(Type.String({ description: "Session to resume (auto-detects if omitted)" })),
    query: Type.Optional(Type.String({ description: "Original query (for auto-detection)" })),
  }),
  async execute(_id, params, signal) {
    // Engine's resume logic triggered by finding existing checkpoint
    // This tool is explicit resume; deep_research auto-resumes implicitly
    const config = DEFAULT_CONFIG;
    const result = await deepResearch(params.query || "", config, signal);
    return { content: [{ type: "text" as const, text: `Resumed session ${result.sessionId}. ${result.findingCount} findings.` }] };
  },
});
```

## Helpers

### Chunking
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

### Deduplication (Jaccard)
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

### In-memory cache
```typescript
class LRUCache {
  private map = new Map<string, { value: any; expiry: number }>();
  private maxSize = 200;

  get(key: string): any | null {
    const entry = this.map.get(key);
    if (!entry || entry.expiry < Date.now()) return null;
    return entry.value;
  }

  set(key: string, value: any, ttlMs = 600_000): void {
    if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expiry: Date.now() + ttlMs });
  }
}
```

## Definition of Done

- [ ] LLM client: structured calls with retry/backoff to DeepSeek
- [ ] Heuristic ranking: BM25 + Exa combined scoring
- [ ] LLM URL selection: one call per sub-query
- [ ] LLM extraction + entities: findings from page chunks
- [ ] Sweep pipeline: search → rank → select → fetch → chunk → extract
- [ ] Orchestration: plan → parallel sweeps → reflect → iterate
- [ ] Parallel execution via Promise.all (sub-queries + page extraction)
- [ ] Context isolation: no inner call exceeds ~5k tokens
- [ ] Durable execution: checkpoint after each completed sweep
- [ ] Resume: auto-detects existing session, skips completed work
- [ ] Failed sweeps: logged and retryable on resume
- [ ] Atomic checkpoint writes (no corruption on crash)
- [ ] deep_research_resume tool registered
- [ ] Cost <$0.11 per session at 200 sources × 6 sub-queries
- [ ] Integration tests with mocked Exa + DeepSeek
- [ ] End-to-end test with real APIs
- [ ] Zero npm dependencies (JSON checkpoint, or node:sqlite if available)
- [ ] Config via env vars documented in .env.example

## Risks

- **DeepSeek rate limits:** 30 concurrent extraction calls may throttle. Mitigation: semaphore (max 10 concurrent), exponential backoff.
- **Exa cost at 200 results:** ~$0.003/search × 18 searches = $0.054. Acceptable but monitor.
- **Page fetch failures:** Some URLs 403/timeout. Skip and note in summary. Don't retry (time > value).
- **Heuristic quality:** BM25 may miss semantically relevant but lexically different results. Acceptable — LLM selection step catches important misses from top 40.
