# Extension: web-fetch

## Status

Implemented. File at src/agents/extensions/web-fetch.ts.

## Intent

URL content extraction tool. Fetches a URL and returns clean text content. Dual-mode: direct HTTP fetch with HTML parsing, Jina Reader fallback for JS-rendered pages. Complements web-search by letting agents read full page content after finding URLs.

## Tool Definition

```typescript
web_fetch({
  url: string  // required — URL to fetch
})
```

Returns: title, content (cleaned text), method indicator (direct/jina/direct-partial), character count.

## Behavior

1. Attempt direct HTTP fetch with 30s timeout, 5MB size cap
2. Parse HTML: strip tags, remove nav/footer/header/script/style elements, collapse whitespace
3. If direct fetch fails or returns insufficient content, fallback to Jina Reader (`https://r.jina.ai/{url}`)
4. Return structured result with method indicator

## Dependencies

- Jina Reader API (free, no API key required for basic usage)
- No npm dependencies (uses fetch + regex-based HTML parsing)

## Error Handling

- Timeout: 30s timeout on direct fetch
- Size cap: 5MB response size limit
- Jina fallback: triggers on direct fetch failure
- Both fail: error propagates to agent

## Loaded By

- Researcher (primary consumer — reads pages found via web-search)

## Gaps

- HTML parsing is regex-based — fragile for complex pages
- No JavaScript rendering in direct mode (relies on Jina fallback)
- No content caching (same URL re-fetched every time)
- No robots.txt checking
- No user-agent configuration
- No support for authenticated pages
- Jina Reader has rate limits not currently handled
- No content truncation strategy beyond size cap — very long pages return everything
