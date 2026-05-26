# Extension: web-search

## Status

Implemented. File at src/agents/extensions/web-search.ts.

## Intent

Exa API integration for web search. Gives agents the ability to search the web and get ranked, highlighted results. Core information gathering capability for Researcher agent.

## Tool Definition

```typescript
web_search({
  query: string  // required — search query
})
```

Returns: markdown-formatted results with title, URL, score, highlights (3 sentences), text (1500 chars max). 5 results per query.

## Behavior

1. POST to `https://api.exa.ai/search` with query
2. Request `highlights` (3 sentences) and `text` (1500 chars) per result
3. Format results as numbered markdown sections
4. Return formatted string to agent

## Dependencies

- Exa API (`EXA_API_KEY` env var)
- No npm dependencies (uses fetch)

## Error Handling

- Missing API key: tool registration should be conditional (not currently implemented)
- API failure: error propagates to agent as tool error
- Empty results: returns empty result set

## Loaded By

- Researcher (primary consumer)
- CEO (could use for quick lookups, but typically delegates)

## Gaps

- No pagination (fixed at 5 results)
- No date filtering
- No domain filtering
- No result caching (same query re-executes every time)
- Tool registers unconditionally — should skip if EXA_API_KEY missing
- No rate limiting
- Hardcoded result count (5) — should be configurable or parameterized
