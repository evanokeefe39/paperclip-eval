# Extension: deep-research

## Status

Stub. Empty file at src/agents/extensions/deep-research.ts.
Detailed plan exists at tasks/plans/deep-research-engine.md (+ deep-research-store.md, deep-research-graph.md).

## Intent

Self-contained research orchestration engine. Plans sub-queries, executes parallel sweeps, reflects on coverage, iterates. Uses cheap inner LLM calls (DeepSeek) for extraction while keeping outer agent model-agnostic. Replaces single-shot web-search with systematic, multi-wave research.

## Tool Definition

```typescript
deep_research({
  query: string,              // required — research question
  max_iterations?: number,    // default: 3
  focus_areas?: string[]      // optional — hints for sub-query planning
})
```

Returns: structured findings collection with sources, confidence, coverage assessment, and session summary.

## Architecture (from plan)

```
deep_research(query)
    │
    ▼
Plan (1 LLM call, ~2k ctx) → 3-6 sub-queries
    │
    ▼
Promise.all(sweeps)  ← PARALLEL, ISOLATED
    │  Each: search (Exa) → rank (BM25 + score) → select (LLM) → fetch → extract (LLM)
    │  → stream findings to store
    ▼
Reflect (1 LLM call, summaries ~3k ctx) → continue or stop
    │
    ▼
Iterate (max 3) or finalize → return session summary
```

## Dependencies

- Exa API (via existing web-search pattern)
- DeepSeek API (inner LLM calls — plan, select, extract, reflect)
- Web fetch (via existing web-fetch pattern)
- Findings store (deep-research-store.md — SQLite for eval)

## File Structure (from plan)

```
src/agents/extensions/
  deep-research.ts              Main extension — registers tool
  deep-research/
    engine.ts                   Orchestration loop
    sweep.ts                    Single sub-query pipeline
    llm.ts                      Provider API client
    rank.ts                     Heuristic ranking (BM25 + Exa score)
    extract.ts                  LLM-powered extraction + entities
    checkpoint.ts               Durable execution (SQLite)
    prompts.ts                  All inner LLM prompts
    config.ts                   Knobs and defaults
    cache.ts                    In-memory LRU cache
    types.ts                    Interfaces
```

## Config Knobs

| Knob | Default | Description |
|------|---------|-------------|
| max_iterations | 3 | Maximum reflect-iterate cycles |
| max_sub_queries | 6 | Sub-queries per plan |
| snippet_results_per_query | 10 | Exa results per sub-query |
| top_k_urls_after_rank | 5 | URLs to deep-extract per sub-query |
| inner_llm_provider | deepseek | Provider for extraction LLM calls |
| inner_llm_model | deepseek-chat | Model for extraction |
| cache_ttl_days | 7 | Search/page cache TTL |

## Context Budget (per inner LLM call)

| Call | Max tokens | Content |
|------|-----------|---------|
| Plan | ~2k | System prompt + original query |
| Select URLs | ~5k | System prompt + sub-query + 40 snippets |
| Extract (per page) | ~4k | System prompt + sub-query + page chunks |
| Reflect | ~3k | System prompt + original query + 6 summaries |

No call exceeds 5k tokens.

## Loaded By

- Researcher (sole consumer)

## Gaps / Open Questions

- Findings store implementation not started (deep-research-store.md is plan only)
- Checkpoint/resume not yet designed in detail (what happens if agent is paused mid-research?)
- Entity extraction schema not defined
- Cache implementation (in-memory LRU per plan) — survives within a run, lost between runs
- Error handling for partial sweep failures (one sub-query fails, others succeed)
- Cost estimation before execution (how many LLM calls will this produce?)
- How does deep-research interact with escalate? (e.g., research hits paywall, needs human to provide content)
