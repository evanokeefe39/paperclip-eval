# Extension: web-scrape

## Status

Implemented. 4-tier scraping stack with decoupled fetch/parse architecture.
Implementation: `src/agents/extensions/web-scrape.ts`
Design: `tasks/plans/scrape-stack-redesign.md`

## Intent

Multi-tier web scraping extension for structured data extraction. Self-hosted tiers (T1-T3) for sites our stack can reach. Apify (T4) as commercial fallback for protected sites. Enables Data and Researcher agents to acquire structured data from the web.

## Architecture

### Tier Model (implemented)

| Tier | Fetch | Parse | Container | When to use |
|------|-------|-------|-----------|-------------|
| T1 | Node fetch() | cheerio | data | Static HTML, no bot protection |
| T2 | Scrapling Fetcher (Python) | cheerio | data, researcher | TLS fingerprint detection (Cloudflare basic) |
| T3 | Scrapling DynamicFetcher + Chromium (Python) | cheerio | data | JS-rendered content, wait_for selectors |
| T4 | Apify cloud actors | Apify (structured) | N/A | Protected sites beyond T3 ceiling |

Fetch decoupled from parse. Python scripts return raw HTML. Cheerio handles all extraction for T1/T2/T3 (one parser, zero selector portability bugs). T4 bypasses parse (Apify returns structured data).

Challenge detection between fetch and parse identifies: Cloudflare, DataDome, PerimeterX, AWS WAF.

Diagnostic output on zero items: HTTP status, HTML length, challenge vendor, selector match count, page title.

### Tool Definitions

```typescript
scrape_static({ url, selector, extract_fields?, max_items? })     // T1
scrape_stealth({ url, selector, extract_fields?, max_items? })    // T2
scrape_browser({ url, selector, extract_fields?, wait_for?, max_items? })  // T3
scrape_structured({ actor_id, input, max_results?, timeout? })    // T4
list_available_scrapers({ query? })                                // Apify store search
```

## Campaign Results (2026-05-26)

15 sites, 4 phases, 3 self-hosted tiers tested. APIFY_API_TOKEN not set (T4 skipped).

| Site | T1 | T2 | T3 | Protection | Notes |
|------|----|----|-----|------------|-------|
| Hacker News | PASS | PASS | PASS | None | All tiers work |
| Books to Scrape | PASS | - | - | None | T1 sufficient |
| Wikipedia | PASS | - | - | None | T1 sufficient |
| GitHub Trending | PASS | PASS | - | Light | T2 stealth handles it |
| IMDb Top 250 | EMPTY | EMPTY | PASS | SSR+JS | Needs browser render |
| Amazon | PASS | PASS | PASS | AWS WAF | All tiers work (single page) |
| Indeed | BLOCK | PASS | PASS | Cloudflare | T2 stealth bypasses |
| Reddit (old) | PASS | BLOCK | PASS | Cloudflare | T2 gets 403, T1/T3 fine |
| Zillow | PASS | - | PASS | PerimeterX | Works on single pages |
| Booking.com | EMPTY | - | PASS | PerimeterX | Needs browser render |
| Yelp | BLOCK | BLOCK | BLOCK | Cloudflare+ | All self-hosted tiers fail |
| eBay | BLOCK | BLOCK | EMPTY | Advanced | T3 renders but selector stale |
| Etsy | BLOCK | BLOCK | BLOCK | DataDome | All self-hosted tiers fail |
| Google Maps | - | - | - | SPA+Google | T4 only (Apify actor) |
| Walmart | EMPTY | - | EMPTY | PerimeterX | Advanced PerimeterX |

**Summary: 10/15 passed, 0 failed, 5 skipped (expected blocks).**

### T3 Ceiling: What Blocks Even Our Browser

Sites that block all self-hosted tiers share a pattern: advanced behavioral analysis that detects automated browsers even when they render JavaScript. Three anti-bot systems define the ceiling:

1. **DataDome** (Etsy) — JavaScript challenge + behavioral fingerprinting. Detects automation via mouse movement patterns, scroll behavior, and timing analysis. Our headless Chromium passes the JS challenge but fails behavioral checks.

2. **PerimeterX/HUMAN** (Walmart, partial on Zillow/Booking) — Similar behavioral analysis. Single-page visits sometimes work (Zillow PASS, Booking T3 PASS) but search/listing pages with pagination triggers are blocked.

3. **Aggressive Cloudflare** (Yelp) — Cloudflare's managed challenge mode with Turnstile. Goes beyond standard Cloudflare (which T2 bypasses for Indeed). Requires browser interaction to solve challenges.

The common factor: these systems detect that our browser doesn't exhibit human browsing behavior (mouse movement, scroll patterns, dwell time, viewport interactions). Scrapling's DynamicFetcher does stealth patching (UA, webdriver flags, navigator properties) but doesn't simulate behavioral patterns.

### Skip Handling Strategy

Each skip has a different path forward:

**Path A: T4 Apify fallback (Yelp, Etsy, Google Maps, Walmart)**
These sites have existing Apify actors with commercial-grade anti-detection. When T3 returns BLOCK or EMPTY for a known-protected site, the agent should escalate to T4. Requires APIFY_API_TOKEN.

- Yelp: `apify/yelp-scraper` or generic web scraper actor
- Etsy: `epctex/etsy-scraper`
- Google Maps: `compass/crawler-google-places` (already configured in sites.json)
- Walmart: `epctex/walmart-scraper`

Cost: pay-per-result, typically $0.25-2.00 per 1000 results.

**Path B: Selector refresh (eBay)**
eBay T3 renders the page (HTML returned, no challenge detected) but `.s-item` matches nothing. The selector is stale — eBay likely changed their DOM structure. Fix: inspect current eBay search results page, update selector in sites.json. No code changes needed.

**Path C: Behavioral simulation (future, not eval-stage)**
For sites where we want to avoid Apify costs long-term, the investment is Playwright with stealth plugins (`playwright-extra` + `puppeteer-extra-plugin-stealth`) plus behavioral simulation (random mouse movements, scroll patterns, realistic timing). This is a significant engineering effort and belongs in production planning, not eval.

### Decision: Eval-Stage Skip Policy

For eval, the policy is simple:
1. Self-hosted tiers handle what they can (10/15 sites).
2. Sites beyond T3 ceiling use T4 (Apify) — agent decides when to escalate based on BLOCK/EMPTY diagnostics.
3. No behavioral simulation investment at eval stage.
4. Stale selectors fixed as they're discovered (sites.json is the single source of truth).

## Dependencies

- Apify API (`APIFY_API_TOKEN` env var) — required for T4, optional for T1-T3
- Scrapling (Python, installed in data + researcher containers)
- Chromium + Playwright (installed in data container only, ~1.5GB)
- cheerio (npm, installed globally in containers)

## Loaded By

- Data Engineer (all tiers, primary consumer)
- Researcher (T1 + T2 only, lightweight container without Chromium)

## Resolved Questions

- Scrapling/Python integration: Python subprocess via execFileSync, scripts in container at /app/scripts/
- Parser portability: Solved by decoupling fetch from parse. All tiers use cheerio.
- Result schema: Items array with extract_fields mapping. Consistent across T1-T3.
- Artifact interaction: Agents write scrape results to /artifacts/ volume, pass path in text.
- Challenge detection: Implemented between fetch and parse. Agent gets diagnostic on what blocked it.

## Platform Inventory

What agents can scrape today, grouped by access method.

### Self-hosted (T1/T2/T3) — working, no external deps

| Platform | Best tier | Data type |
|----------|-----------|-----------|
| Hacker News | T1 | Posts, links |
| GitHub Trending | T1/T2 | Repos, descriptions |
| Wikipedia | T1 | Article content |
| Amazon (product pages) | T1 | Product details |
| Indeed | T2/T3 | Job listings |
| Reddit (old) | T1/T3 | Posts, threads |
| IMDb | T3 | Movie rankings |
| Zillow (single listings) | T1/T3 | Property listings |
| Booking.com | T3 | Hotel listings |

### Apify T4 — requires APIFY_API_TOKEN

| Platform | Actor | Data type |
|----------|-------|-----------|
| TikTok | clockworks/free-tiktok-scraper | Profiles, videos, engagement |
| Instagram | apify/instagram-scraper | Posts, profiles, hashtags |
| YouTube | streamers/youtube-scraper | Videos, channels, search results |
| Google Maps | compass/crawler-google-places | Places, reviews, details |
| Yelp | apify/yelp-scraper | Business listings, reviews |
| eBay | dainty_screw/ebay-scraper | Product listings, prices |
| Etsy | epctex/etsy-scraper | Product listings |
| Walmart | epctex/walmart-scraper | Product listings, prices |

### API integration — Airbyte, not scraping or per-provider extensions

Structured data sources with API access go through Airbyte (ELT platform, 600+ connectors), not custom extensions. Data agent triggers syncs via `airbyte.ts` extension. See ROADMAP.md for full Airbyte plan.

| Platform | Airbyte connector | Notes |
|----------|-------------------|-------|
| Crunchbase | None — custom build needed | Low-code Builder against Crunchbase REST API. User has subscription. |
| GitHub | Official | Repos, issues, PRs, stars |
| Notion | Official | Pages, databases |
| Google Sheets | Official | Spreadsheet data |
| HubSpot | Official | CRM data |

### Not yet covered

LinkedIn, Twitter/X, Glassdoor — all require Apify actors or API access. Add as needed.

## Enhancement: Video & Audio Content Extraction (T5)

Status: Designed. Spike validated 2026-05-27. Implementation pending.

### Problem

Apify T4 scrapes video metadata and engagement but misses rich content inside videos:
- On-screen text, graphics, lower-thirds, product placements
- Visual context (who appears, what they demonstrate, scene descriptions)
- Instagram reels have no native subtitle/transcript extraction via Apify

TikTok and YouTube subtitles are available for free (toggle in Apify actor input), but are not currently enabled. Instagram reels require a separate transcript solution.

### Architecture: T5 Content Enrichment

T5 is not a scraping tier — it's a post-scrape enrichment layer that extracts content from videos already scraped by T4.

```
T4 Apify scrape
  ├── metadata + engagement (existing)
  ├── subtitles/transcripts (TikTok + YouTube, enable toggles)
  └── video URL in Apify KVS (publicly accessible)
        │
        ├──► Groq Whisper (Instagram reels only — audio transcription)
        │     Model: whisper-large-v3-turbo
        │     Input: extracted audio from downloaded reel
        │     Output: transcript text
        │     Cost: $0 (free tier, 2,000 req/day)
        │
        └──► NVIDIA NIM (all platforms — visual analysis)
              Model: nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
              Input: video URL (must be publicly accessible)
              Output: structured JSON (on-screen text, speakers, visuals, tone)
              Cost: $0 (free tier, 40 RPM)
```

### Apify Actor Configuration Changes

**TikTok (clockworks/free-tiktok-scraper):**
- Enable `shouldDownloadSubtitles: true`
- Enable `shouldDownloadVideos: true` (for NIM URL access)
- No cost change — flat $0.004/result

**YouTube (streamers/youtube-scraper):**
- Enable `downloadSubtitles: true`
- Set `subtitlesFormat: "plaintext"`
- Set `subtitlesLanguage: "en"` (or `"any"`)
- Set `preferAutoGeneratedSubtitles: true`
- Enable `saveSubsToKVS: true`
- No cost change — flat $0.003/video

**Instagram (apify/instagram-reel-scraper):**
- Do NOT enable transcript add-on ($0.041/min — use Groq instead)
- Video download needed for Groq audio extraction
- Base cost: $0.0023/reel + video download: $0.015/MB

### Provider Limits and Costs

Full reference: `spike/video-analysis/LIMITS.md`

| Provider | Use | Free Tier Limit | Daily Max |
|---|---|---|---|
| NVIDIA NIM | Video analysis | 40 RPM, no daily cap | ~5,760 videos |
| Groq | IG audio transcript | 2,000 req/day, 7,200 audio sec/hr | 2,000 reels |
| Apify | Scrape + download | Budget-gated | ~1,400 on $5 free |

**Cost per 100 videos: $0.31. Cost is ~100% Apify. Analysis is free.**

### NIM Integration Details

Validated in spike (`spike/video-analysis/test-nim.mjs`):
- Video input via URL only (base64 returns 401 on hosted endpoint)
- Apify KVS URLs are publicly accessible and work as input
- Structured JSON output via prompt engineering (avoid reasoning loops)
- ~9,200 input tokens, ~1,800 output tokens per 53s video
- ~20 seconds latency per video
- No rate limit headers — must implement client-side throttling

### Groq Whisper Integration Details

- OpenAI-compatible `/v1/audio/transcriptions` endpoint
- 216x realtime speed (60min audio in 16s)
- 25MB file size limit
- Rate limit headers exposed (x-ratelimit-*)
- Requires audio extraction from video (ffmpeg or similar)

### Bottleneck Phases

| Phase | Scale | Bottleneck | Mitigation |
|---|---|---|---|
| 1 | 1–500 videos | Apify runtime | Parallel actor runs |
| 2 | 500–5,000 videos | NIM 40 RPM | Request 200 RPM upgrade |
| 3 | 2,000+ IG reels/day | Groq 2,000/day | Voxtral fallback ($0.003/min) |

## Remaining Gaps

- T4 Apify testing (requires token — actors configured in sites.json, untested)
- Airbyte deployment and Crunchbase custom connector (see ROADMAP.md)
- Budget tracking for Apify usage (per-agent or global cap)
- Auto-escalation logic: currently agent-driven, could be automated in extension
- Stale selector detection: no automated way to detect when a selector stops working across releases
- robots.txt/ToS compliance policy not formalized
- T5 video/audio enrichment implementation (see `tasks/plans/video-audio-analysis.md`)
- ffmpeg dependency for Instagram audio extraction (not in containers yet)
- NIM client-side rate limiter (no server headers to rely on)
- Apify actor input defaults need updating (subtitle toggles off by default)
