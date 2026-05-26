# Real-World Scraping Test Campaign

Status: Active
Created: 2026-05-26

## Purpose

Validate the 4-tier scraping extension against 15 real websites spanning 4 difficulty
levels. Determine where each tier succeeds, fails, and where Apify is necessary vs.
overkill vs. insufficient. Identify gaps in our scraping stack and sites where we
provide unique value beyond what Apify offers.

## Our Scraping Stack

| Tier | Tool | Engine | Anti-Bot | Speed |
|------|------|--------|----------|-------|
| 1 | scrape_static | cheerio (Node) | None — raw HTTP fetch with Chrome UA | Fast |
| 2 | scrape_stealth | Scrapling Fetcher (Python) | TLS fingerprinting, header rotation | Fast |
| 3 | scrape_browser | Scrapling DynamicFetcher (Python/Playwright) | Headless Chromium, anti-detection | Slow |
| 4 | scrape_apify | Apify Cloud API | Residential proxies, per-site actors | Variable |

## Anti-Bot Landscape (reference)

| Vendor | Difficulty | Notable Sites |
|--------|-----------|---------------|
| None / basic rate limit | Easy | Wikipedia, Hacker News, government portals |
| Cloudflare (basic) | Moderate | Indeed, Reddit |
| AWS WAF Bot Control | Moderate-Hard | Amazon |
| PerimeterX / HUMAN | Hard | Zillow, Booking.com, Walmart, StockX |
| DataDome | Very Hard | Etsy, TripAdvisor, Foot Locker |
| Akamai Bot Manager | Very Hard | Nike SNKRS |
| Kasada | Very Hard | Realtor.com |
| Arkose Labs | Very Hard | LinkedIn |
| Custom | Varies | Twitter/X, Instagram, TikTok |

---

## The 15 Test Sites

### Level 1: Static / No Protection (expect T1 success)

These validate basic functionality against real HTML. If T1 fails here, something
is fundamentally broken.

#### 1. Hacker News — news.ycombinator.com

- What: Tech news aggregator, server-rendered HTML, no anti-bot
- Why test: Simplest real-world target. Validates CSS selector extraction on clean HTML
- Selector: `.titleline > a`
- Extract: `{title: ".titleline > a", link: ".titleline > a[href]", score: ".score"}`
- Pagination: `.morelink` (next page)
- Expected: T1 pass, T2 pass, T3 pass
- Apify: Actors exist but pointless — this is trivial to self-scrape
- Value: Low (API exists), but good baseline test

#### 2. Books to Scrape — books.toscrape.com

- What: Purpose-built scraping sandbox, 1000 books across 50 pages
- Why test: Known-good baseline with pagination stress test
- Selector: `article.product_pod`
- Extract: `{title: "h3 a[title]", price: ".price_color", rating: ".star-rating"}`
- Pagination: `.next a` (50 pages)
- Expected: T1 pass (all 50 pages), T2 pass, T3 pass
- Apify: Not needed
- Value: Zero (test sandbox), but validates pagination at scale

#### 3. Wikipedia — en.wikipedia.org/wiki/Web_scraping

- What: Largest encyclopedia, server-rendered, scraping-friendly
- Why test: Complex nested HTML structure (tables, infoboxes, references)
- Selector: `#mw-content-text p` (paragraphs), `.wikitable tr` (tables)
- Extract: `{text: "p"}` or `{col1: "td:nth-child(1)", col2: "td:nth-child(2)"}`
- Expected: T1 pass, T2 pass, T3 pass
- Apify: Not needed
- Value: Low (dumps available), but tests complex DOM parsing

#### 4. GitHub Trending — github.com/trending

- What: Trending repos page, server-rendered HTML
- Why test: Moderate HTML complexity, rate-limited but not bot-blocked
- Selector: `article.Box-row`
- Extract: `{repo: "h2 a", description: "p.col-9", stars: ".f6 .octicon-star + span"}`
- Expected: T1 pass (single page), may 429 on burst
- Apify: Actors exist but overpriced for public data
- Value: Medium — useful for monitoring trending projects

### Level 2: JS-Rendered / Light Protection (expect T1 fail, T2/T3 success)

These require either stealth headers or browser rendering. Tests tier escalation.

#### 5. IMDb Top 250 — imdb.com/chart/top

- What: Movie database, server-rendered core but JS-enhanced
- Why test: Mix of SSR and client-side rendering. Rate limits at volume
- Selector: `.ipc-metadata-list-summary-item`
- Extract: `{title: ".ipc-title__text", rating: ".ipc-rating-star--rating"}`
- Expected: T1 may partial-pass (some SSR), T2 pass, T3 pass
- Apify: `epctex/imdb-scraper` (popular, well-maintained)
- Value: Medium — useful for entertainment data

#### 6. Yelp Business Listings — yelp.com/search?find_desc=restaurants&find_loc=NYC

- What: Local business reviews, progressive JS rendering
- Why test: Rate limiting, some JS rendering needed for full content
- Selector: `[data-testid="serp-ia-card"]` or `.css-1m051bw`
- Extract: `{name: "a.css-19v1rkv", rating: "[aria-label*=star]", reviews: ".css-chan6m"}`
- Expected: T1 partial (limited data), T2 better, T3 full extraction
- Apify: `yin/yelp-scraper` (decent)
- Value: High — Yelp API is expensive ($500+/mo for volume)

#### 7. Reddit (Old) — old.reddit.com/r/programming

- What: Reddit's old interface, mostly server-rendered but with Cloudflare
- Why test: Cloudflare basic challenge. Tests T2's TLS fingerprinting
- Selector: `.thing .title a`
- Extract: `{title: ".title a.title", score: ".score.unvoted", comments: ".comments"}`
- Pagination: `.next-button a`
- Expected: T1 likely blocked (Cloudflare), T2 should pass, T3 pass
- Apify: `trudax/reddit-scraper` ($45/mo base, 3.2 stars — mediocre)
- Value: HIGH — Reddit API is heavily restricted post-2023, expensive third-party

#### 8. eBay Listings — ebay.com/sch/i.html?_nkw=vintage+watches

- What: E-commerce marketplace, server-rendered with JS enhancements
- Why test: Light bot detection, important commercial target
- Selector: `.s-item`
- Extract: `{title: ".s-item__title", price: ".s-item__price", link: ".s-item__link[href]"}`
- Pagination: `.pagination__next`
- Expected: T1 may pass (eBay is surprisingly scraper-tolerant), T2 pass, T3 pass
- Apify: Actors exist but rated below 3.1 stars — unreliable
- Value: HIGH — eBay actors on Apify are poor quality. Self-scraping beats Apify here

### Level 3: Moderate Anti-Bot (expect T1/T2 fail, T3 might work)

These have real anti-bot systems. Tests the limits of our local browser scraping.

#### 9. Amazon Product Page — amazon.com/dp/B0D1XD1ZV3

- What: E-commerce giant, AWS WAF Bot Control
- Why test: Datacenter IPs blacklisted. Tests whether scrapling browser evades
- Selector: `#productTitle`, `#priceblock_ourprice`, `.a-price .a-offscreen`
- Extract: `{title: "#productTitle", price: ".a-price .a-offscreen"}`
- Expected: T1 fail (captcha/block), T2 fail, T3 maybe (depends on IP), T4 needed
- Apify: Multiple actors, well-supported but compute-heavy
- Value: HIGH — Amazon data is commercially very valuable
- Risk: IP block. Run max 1 request. Do not burst.

#### 10. Indeed Job Listings — indeed.com/jobs?q=software+engineer&l=remote

- What: Job board, Cloudflare protection
- Why test: Cloudflare challenge page. Can scrapling's StealthyFetcher solve it?
- Selector: `.job_seen_beacon`
- Extract: `{title: ".jobTitle a", company: ".companyName", location: ".companyLocation"}`
- Expected: T1 fail, T2 might pass (scrapling vs basic Cloudflare), T3 likely pass
- Apify: `misceres/indeed-scraper` (decent)
- Value: HIGH — Indeed API is restricted/expensive

#### 11. Zillow Listings — zillow.com/homes/San-Francisco,-CA_rb/

- What: Real estate, PerimeterX protection
- Why test: PerimeterX is harder than Cloudflare. Tests T3 browser limits
- Selector: `article[data-test="property-card"]`
- Extract: `{address: "[data-test=property-card-addr]", price: "[data-test=property-card-price]"}`
- Expected: T1 fail, T2 fail, T3 likely fail (PerimeterX), T4 needed
- Apify: `petr_cermak/zillow-api-scraper` (popular)
- Value: HIGH — real estate data extremely valuable, Zillow API limited
- Risk: 403 likely. Single request only.

#### 12. Booking.com — booking.com/searchresults.html?ss=London

- What: Travel booking, PerimeterX protection
- Why test: Another PerimeterX site. Cross-validates T3 against different PerimeterX config
- Selector: `[data-testid="property-card"]`
- Extract: `{name: "[data-testid=title]", price: "[data-testid=price-and-discounted-price]"}`
- Expected: T1 fail, T2 fail, T3 uncertain, T4 likely needed
- Apify: `voyager/booking-scraper` (good)
- Value: HIGH — travel price comparison data

### Level 4: Extreme / Gap Analysis (stress tests, Apify-poor sites)

These test the absolute limits. Some have no good Apify solution at all.

#### 13. Etsy — etsy.com/search?q=handmade+jewelry

- What: E-commerce marketplace, DataDome protection
- Why test: DataDome is intent-based (analyzes WHAT you're doing, not just WHO you are)
- Selector: `.v2-listing-card`
- Extract: `{title: ".v2-listing-card__info h3", price: ".currency-value"}`
- Expected: T1-T3 fail (DataDome), T4 uncertain — no great Apify actor
- Apify: Limited actors, DataDome blocks most automated access
- Value: HIGH — handmade marketplace data, no good API
- Key question: Can our T3 browser fool DataDome intent analysis?

#### 14. Google Maps Places — google.com/maps/search/restaurants+near+me

- What: Local business data, Google's custom protection
- Why test: Extremely valuable data, complex JS SPA, Google actively fights scrapers
- Selector: `div[role="feed"] > div`
- Extract: `{name: ".fontHeadlineSmall", rating: ".fontBodyMedium span[role=img]"}`
- Expected: T1-T3 fail (full SPA + protection), T4 with `compass/crawler-google-places`
- Apify: `compass/crawler-google-places` (413K users, 4.8 stars) — BEST SUPPORTED on Apify
- Value: EXTREME — Google Maps data is one of the most valuable scraping targets
- Note: Compare Apify results vs. self-scrape attempt to quantify the gap

#### 15. Walmart — walmart.com/search?q=laptop

- What: E-commerce, PerimeterX + dynamic protection levels
- Why test: PerimeterX with variable aggressiveness (changes by time of day)
- Selector: `[data-testid="list-view"]`
- Extract: `{title: "[data-automation-id=product-title]", price: "[data-automation-id=product-price]"}`
- Expected: T1-T3 fail, T4 needed
- Apify: Actors exist but PerimeterX makes them flaky
- Value: HIGH — price comparison data
- Risk: Heavy PerimeterX. Single request. Expect block.

---

## Test Execution Strategy

### Phase 1: Baseline (Sites 1-4)

Run all 4 sites through T1. Expect 100% pass. If anything fails, fix before proceeding.
Single request per site. No burst. Validates basic extraction pipeline.

### Phase 2: Tier Escalation (Sites 5-8)

Run each site through T1, then T2, then T3 in sequence. Record which tier first succeeds.
Tests the tier escalation model the agent should use. Max 3 requests per site.

### Phase 3: Anti-Bot Probing (Sites 9-12)

Run T1 through T3 on each site. Expect failures. Record exact error (403, captcha, empty,
timeout). Then run T4 on sites where actors exist. Max 1 request per tier per site.

IMPORTANT: Use delays between requests to avoid IP reputation damage.

### Phase 4: Stress / Gap Analysis (Sites 13-15)

Full tier sweep. Document exactly where our stack ceiling is. Identify sites where
neither our local stack nor Apify provides good coverage.

Note: Social media sites (LinkedIn, Instagram, TikTok, Twitter, YouTube) excluded —
Apify actors already validated for those via manual testing.

---

## Success Metrics Per Site

Each site test produces a row in the results matrix:

| Site | T1 | T2 | T3 | T4 | Items | Errors | Duration | Cost | Notes |
|------|----|----|----|----|-------|--------|----------|------|-------|

Status values: PASS (data extracted), PARTIAL (some data), BLOCK (403/captcha),
EMPTY (page loaded but selector found nothing), TIMEOUT, SKIP (not attempted), N/A.

## Key Questions This Campaign Answers

1. Where does Scrapling Fetcher's TLS fingerprinting beat naive HTTP? (T1 vs T2 gap)
2. Where does browser rendering beat stealth HTTP? (T2 vs T3 gap)
3. Where do all local tiers fail and Apify is mandatory? (T3 vs T4 gap)
4. Which sites have poor Apify coverage? (our opportunity for self-scrape value)
5. What is our IP reputation risk from running these tests? (error rate patterns)
6. Which sites return partial data at a lower tier? (cost/quality tradeoff)

## Sites Where Self-Scrape Beats Apify (hypothesis)

Based on research, these sites have poor Apify actor quality:
- eBay (actors rated < 3.1 stars)
- Reddit (expensive, low quality)
- Yelp (API expensive, actors mediocre)
- Etsy (DataDome blocks most actors too)

If our T2/T3 can handle these, that is significant value.

## Rate Limiting / Safety Rules

- Never burst more than 3 requests to the same domain within 60 seconds
- Always use 5-second minimum delay between requests to the same domain
- Sites marked "Risk: IP block" — single request only, 30-second cooldown after
- Social media (13-17) — Apify only, no direct requests from our IP
- If any site returns a captcha or block page, do NOT retry. Log and move on
- Run tests from a single IP. Do not parallelize across sites in the same tier
- All test traffic uses standard User-Agent strings (no spoofing beyond what scrapling provides)
- Campaign is for evaluation purposes only — no storage of PII, no commercial use of scraped data

## Implementation Notes

- Test runner: `tests/scraping/real-world-tests.sh`
- Results: `tests/results/real-world-YYYYMMDD-HHMMSS.md`
- Requires running data agent container (T1-T3) and Apify token (T4)
- Python scripts called directly for T2/T3 (bypass bridge for deterministic testing)
- Each site test is a standalone function, can run individually
- Campaign takes ~20-40 minutes end to end (dominated by cooldown delays between risky sites)
