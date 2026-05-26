# Extension: web-scrape

## Status

Stub. Empty file at src/agents/extensions/web-scrape.ts.
Detailed plans exist at tasks/plans/web-scraping-apify.md, web-scraping-gateway.md, web-scraping-tiers.md.

## Intent

Dual-mode web scraping extension for structured data extraction. Mode 1 (Apify) for known site types with existing actors. Mode 2 (custom/Scrapling) for ad-hoc or unsupported sites. Enables Data Engineer agent to acquire structured data from the web at scale.

## Tool Definitions (from plans)

```typescript
scrape_structured({
  actor_id: string,        // Apify actor ID (e.g., "apify/instagram-scraper")
  input: object,           // Actor-specific input config
  max_results?: number,    // default: 50
  timeout?: number         // default: 45s
})

scrape_custom({
  url: string,             // target URL
  selectors: object,       // CSS/XPath extraction rules
  paginate?: boolean,      // follow pagination
  render_js?: boolean      // use headless browser
})

list_available_scrapers({
  query?: string           // search Apify store
})
```

## Architecture (from plans)

### Tier Model

| Tier | Method | Use case | Cost |
|------|--------|----------|------|
| 1 | Apify (known actors) | Social media, e-commerce, search engines | Pay-per-result, cheapest |
| 2 | Apify (generic actors) | Blogs, news, forums | Pay-per-result, moderate |
| 3 | Custom/Scrapling | Rare sites, custom extraction | Pay-per-GB, highest |

### Tier 1 Known Actors

Instagram, Twitter/X, LinkedIn, TikTok, Amazon, eBay, Glassdoor, Google Search, Google Maps, YouTube

### Gateway Routing (future)

Gateway layer routes requests to appropriate tier based on site + confidence level. Handles result aggregation and deduplication across runs.

## Dependencies

- Apify API (`APIFY_API_TOKEN` env var, $39/month budget)
- Scrapling (Python library — requires Python in container or sidecar)
- No current npm dependencies

## Error Handling

- Actor timeout: configurable per invocation, max 60s
- Rate limiting: per-platform limits enforced
- Budget cap: monthly scraping budget tracked and enforced
- Partial results: returned with completeness indicator
- Actor not found: error with suggestion to search store

## Loaded By

- Data Engineer (primary consumer)
- Researcher (possible, for targeted scraping tasks)

## Gaps / Open Questions

- Scrapling requires Python — how does this fit in Node.js container? (Sidecar? Python subprocess? Pure JS alternative?)
- Budget tracking implementation — per-agent or global cap?
- How does actor discovery work in practice? (Agent searches store, or pre-configured actor list?)
- Result schema normalization across different actors (each returns different structure)
- How does scraping interact with artifacts extension? (Write results to /artifacts automatically?)
- Rate limit handling — per-platform cooldowns tracked where?
- Legal/ethical scraping policy — robots.txt respect, ToS compliance
- Apify free tier vs. paid — what's available without the $39/month?
