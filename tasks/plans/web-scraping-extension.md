# Web Scraping Extension

## Intent

Dual-mode web scraping extension for Data/Analyst agent. Mode 1: Apify actor-based scraping for structured sites (social media, e-commerce, search engines). Mode 2: Custom scraping for sites without Apify actors or needing bespoke extraction. Gives Data agent the ability to gather structured data at scale from any web source.

## Architecture

Two scraping backends, unified tool interface:

```
┌─────────────────────────────────────────────┐
│  Data Agent (Pi + bridge.mjs)               │
│                                             │
│  Tools:                                     │
│    scrape_structured  → Apify REST API      │
│    scrape_custom      → Crawlee (local)     │
│    list_scrapers      → Apify Store search  │
│    scrape_status      → Poll running jobs   │
└─────────────────────────────────────────────┘
```

### Scrapling → Crawlee substitution

Scrapling is Python-only. Our extensions are TypeScript running in a Node container. Options considered:

| Option | Pros | Cons |
|--------|------|------|
| Scrapling via Python subprocess | Exact match to user spec | Extra runtime (Python) in container, IPC complexity, error handling across process boundary |
| Crawlee (TypeScript) | Native TS, zero IPC, same ecosystem as Apify, anti-detection built-in | Different library name than requested |
| Playwright raw | Already available via MCP | No anti-detection, no session management, no proxy rotation |

**Recommendation: Crawlee.** It's Apify's open-source scraping framework in TypeScript/Node. Has anti-detection (browser fingerprinting, session rotation, proxy management), handles pagination, works headless in Docker. Architecturally consistent with Mode 1 (same company, same patterns). If Scrapling is a hard requirement, we add Python to the container image and shell out — but that's significant complexity for eval stage.

**Decision needed:** Crawlee (recommended) or Scrapling via subprocess?

## Implementation Plan

### Phase 1: Apify integration (scrape_structured, list_scrapers)

#### 1.1 — File structure

```
src/agents/extensions/
  web-scraping.ts           Main extension file — registers all scraping tools
  web-scraping/
    apify.ts                Apify REST API client (zero deps, raw fetch)
    crawlee.ts              Local Crawlee scraping engine
    types.ts                Shared interfaces
    config.ts               API keys, timeouts, defaults
```

#### 1.2 — Apify REST API client

No SDK — raw `fetch` calls to Apify API v2. Endpoints needed:

```typescript
// Actor discovery
GET /v2/store?search={query}&limit=10
// → Returns actor list with name, description, stats (runs, rating)

// Actor detail + input schema
GET /v2/acts/{actorId}
// → Returns README, input schema (JSON Schema), pricing

// Run actor
POST /v2/acts/{actorId}/runs?waitForFinish={seconds}
// Body: actor input (per input schema)
// → Returns run object with id, status, datasetId

// Get run status
GET /v2/actor-runs/{runId}
// → Returns status, datasetId, usage

// Get dataset items
GET /v2/datasets/{datasetId}/items?limit={n}&offset={o}&format=json
// → Returns scraped data array
```

**Auth:** `APIFY_API_TOKEN` env var. Bearer token in Authorization header.

#### 1.3 — list_scrapers tool

**Input:** `{ query: string, category?: string }`
**Output:** Top 5 matching actors with: name, description, monthly runs, input schema summary

Implementation:
1. Search Apify Store via API
2. Sort by monthly runs (popularity proxy)
3. Return concise list for LLM to select from

#### 1.4 — scrape_structured tool

**Input:**
```typescript
{
  actor_id: string;        // e.g. "apify/web-scraper" or actor ID from list_scrapers
  input: object;           // Actor-specific input (per input schema)
  wait_seconds?: number;   // Max wait for results (default 45, cap at 60)
  max_results?: number;    // Cap dataset items returned (default 50)
}
```

**Output:** Scraped data array (JSON) + metadata (run ID, items count, cost estimate)

Implementation:
1. Validate actor_id exists (HEAD check or cached from list_scrapers)
2. POST run with input + waitForFinish
3. If run completes within wait: fetch dataset items (paginated if needed)
4. If run still running: return run ID for polling via scrape_status
5. Cap results at max_results to prevent context overflow

#### 1.5 — scrape_status tool

**Input:** `{ run_id: string }`
**Output:** Run status + results if complete

For long-running scrapes. LLM calls this to poll.

### Phase 2: Custom scraping (scrape_custom)

#### 2.1 — Crawlee integration

Crawlee runs inside the container. Requires adding it as a dependency (first npm dep in the project — flag in assumption log).

**Container changes:**
- Add `crawlee` and `playwright` to package.json
- Install Chromium in Dockerfile (playwright install chromium)
- This adds ~400MB to image size (Chromium binary)

**Alternative (lighter):** Use `cheerio-crawler` from Crawlee (no browser, HTML parsing only). Add `playwright-crawler` only if JS-rendered pages needed. Start with Cheerio, escalate to Playwright per-request.

#### 2.2 — scrape_custom tool

**Input:**
```typescript
{
  url: string;                    // Target URL or start URL
  selector: string;              // CSS selector for target data
  pagination?: {
    next_selector?: string;      // CSS selector for "next" button/link
    max_pages?: number;          // Page limit (default 5)
  };
  extract_fields?: {             // Named fields to extract per item
    [field_name: string]: string; // field_name → CSS selector
  };
  wait_for?: string;             // CSS selector to wait for before extraction (JS-rendered)
  use_browser?: boolean;         // Force Playwright (default: try Cheerio first)
  max_items?: number;            // Cap results (default 100)
}
```

**Output:** Extracted items array + metadata (pages crawled, items found, errors)

Implementation:
1. If `use_browser` or `wait_for` specified: use PlaywrightCrawler
2. Otherwise: try CheerioCrawler first (fast, light)
3. Navigate to URL, apply selector
4. If `extract_fields`: for each matched element, extract sub-selectors
5. If `pagination`: follow next_selector up to max_pages
6. Deduplicate results
7. Return structured JSON array

#### 2.3 — Anti-detection

Crawlee provides:
- Session rotation (cookie persistence per session)
- User-Agent rotation
- Request fingerprinting mitigation
- Automatic retry with backoff on blocks (HTTP 403/429)
- Proxy support (configure via `PROXY_URLS` env var, optional)

Configure in crawlee.ts:
```typescript
const crawler = new PlaywrightCrawler({
  sessionPoolOptions: { maxPoolSize: 10 },
  maxRequestRetries: 3,
  requestHandlerTimeoutSecs: 30,
  headless: true,
  launchContext: {
    launchOptions: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
  }
});
```

### Phase 3: Security and resource limits

#### 3.1 — Execution limits

- **Timeout:** 60s per scrape_custom call (hard kill)
- **Page count:** Max 10 pages per pagination crawl
- **Result size:** Max 200 items returned (truncate with warning)
- **Concurrent requests:** Max 5 in-flight per crawl
- **Response size:** Skip pages >10MB
- **Domain allowlist/blocklist:** Configurable. Default: no restrictions in eval. Production: block internal network ranges (10.x, 172.16.x, 192.168.x, localhost)

#### 3.2 — Container security for scraping

- Chromium runs with `--no-sandbox` (already in container, acceptable since container IS the sandbox)
- No access to host network (Docker network isolation)
- Memory limit on container (4GB) prevents runaway browser instances
- Scraping runs in same container as Data agent — no escape to other agents' filesystems

#### 3.3 — Rate limiting

- Per-domain rate limit: max 2 requests/second (configurable)
- Global rate limit: max 10 requests/second across all domains
- Respect robots.txt by default (configurable override for specific actors)
- Back off on 429 responses (exponential, max 30s)

### Phase 4: Output formatting

#### 4.1 — Result structure

All tools return consistent format:

```typescript
interface ScrapeResult {
  items: object[];           // Extracted data
  metadata: {
    source: "apify" | "crawlee";
    url: string;
    pages_crawled: number;
    items_found: number;
    items_returned: number;  // May be less than found (cap)
    duration_ms: number;
    errors: string[];        // Non-fatal errors encountered
  };
}
```

#### 4.2 — Artifact output

For large results (>50 items), write to /artifacts/data/{timestamp}-{domain}.json and return path reference instead of inline data. Keeps LLM context clean.

```typescript
if (result.items.length > 50) {
  const path = `/artifacts/data/${Date.now()}-${domain}.json`;
  writeFileSync(path, JSON.stringify(result, null, 2));
  return {
    content: [{ type: "text", text: `Scraped ${result.items.length} items. Full data: ${path}\nPreview (first 10):\n${preview}` }],
  };
}
```

### Phase 5: Testing

- Unit tests for Apify client (mock HTTP responses)
- Unit tests for CSS selector extraction (static HTML fixtures)
- Integration test: list_scrapers with real Apify API
- Integration test: scrape_structured with a known actor (e.g., web-scraper on a test page)
- Integration test: scrape_custom on a static test page (local HTTP server in test)
- Rate limit test: verify backoff behavior
- Timeout test: verify hard kill on long-running crawl

## Dependencies

| Dependency | Purpose | Size impact |
|------------|---------|-------------|
| crawlee | Scraping framework (Cheerio + Playwright crawlers) | ~15MB |
| playwright | Browser automation (Chromium) | ~2MB (lib) + ~400MB (browser binary) |

**Note:** These are the first npm dependencies in the project. The bridge itself remains zero-dep. Only the Data agent container gets these deps (separate Dockerfile layer or separate image).

**Mitigation for image size:** Multi-stage Docker build. Chromium installed only in Data agent image. Other agents keep the slim image.

## Dockerfile changes

```dockerfile
# data-agent.Dockerfile (extends shared base)
FROM paperclip-agent-base AS data-agent

# Install Chromium for Playwright
RUN npx playwright install chromium --with-deps

# Install scraping deps
COPY extensions/web-scraping/package.json /app/extensions/web-scraping/
RUN cd /app/extensions/web-scraping && npm ci --production
```

## Open Questions

1. **Crawlee vs Scrapling:** User specified Scrapling. Crawlee is architecturally better fit (TypeScript, same ecosystem as Apify). Need explicit confirmation.

2. **Image size:** Chromium adds ~400MB. Acceptable for eval? If not, start with CheerioCrawler only (no browser, ~15MB total). Add Playwright later when JS-rendered pages are needed.

3. **Apify token:** Free tier sufficient for eval? Free tier: 5 USD/month compute. May hit limits with heavy scraping.

4. **Proxy support:** Need proxy rotation for production scraping? For eval, direct requests are fine. Add proxy config knob but don't require it.

5. **Per-agent images:** Currently all agents share one Dockerfile. Adding Chromium bloats all images. Move to per-agent Dockerfiles? Or conditional install based on build arg?

## Definition of Done

- [ ] list_scrapers tool: searches Apify Store, returns top matches with schemas
- [ ] scrape_structured tool: runs Apify actor, returns results (sync for short, poll for long)
- [ ] scrape_status tool: polls running Apify jobs
- [ ] scrape_custom tool: CSS selector extraction with pagination
- [ ] Cheerio path working (static HTML)
- [ ] Playwright path working (JS-rendered pages)
- [ ] Rate limiting per-domain
- [ ] Timeout enforcement (60s hard kill)
- [ ] Large results written to /artifacts with path reference
- [ ] Container security: no host network, memory-bounded
- [ ] Integration tests with mocked Apify API
- [ ] Integration test with local HTTP fixture server
- [ ] Dockerfile for Data agent with Chromium
- [ ] APIFY_API_TOKEN documented in .env.example

## Risks

- **Image size bloat:** 400MB for Chromium. Mitigation: per-agent Dockerfiles, start Cheerio-only.
- **Anti-detection arms race:** Sites may block Crawlee. Mitigation: Apify actors are maintained by community, handle this upstream.
- **Cost creep on Apify:** Heavy actor usage burns through free tier. Mitigation: prefer scrape_custom for simple sites, reserve Apify for complex targets with existing actors.
- **Chromium stability in container:** Headless Chrome can crash/leak. Mitigation: per-request browser context, hard timeout, container memory limit.
