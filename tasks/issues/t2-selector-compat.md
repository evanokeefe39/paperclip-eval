# T2 (Scrapling Fetcher) selector compatibility bug

**Severity:** High
**Component:** src/agents/data/scripts/scrape_stealth.py, src/agents/researcher/scripts/scrape_stealth.py
**Found:** 2026-05-26 real-world scraping campaign
**Systemic root:** Fetch-parse coupling (see tasks/issues/systemic-fetch-parse-coupling.md)

## Problem

T2 (Scrapling Fetcher) returns EMPTY on sites where T1 (cheerio) PASS. The HTTP request succeeds — no block, no error — but CSS selectors that match in cheerio find nothing in Scrapling's DOM tree.

## Affected sites

| Site | Selector | T1 | T2 |
|------|----------|----|----|
| Reddit (old) | `.thing .title` → `a.title` | PASS (10 items) | EMPTY |
| Amazon | `#productTitle` | PASS (1 item) | PASS (but others EMPTY) |
| IMDb | `.ipc-metadata-list-summary-item` | EMPTY | EMPTY |
| Yelp | `[data-testid='serp-ia-card']` | BLOCK | EMPTY |
| eBay | `.s-item` → `.s-item__title` | BLOCK | EMPTY |

## Five Whys

```
Problem: T2 returns EMPTY where T1 returns PASS with identical selectors
Why 1: CSS selectors match in cheerio but miss in Scrapling's response object
Why 2: Cheerio uses htmlparser2; Scrapling uses lxml. Different parsers normalize
       DOM differently — whitespace, attribute order, self-closing tags, nesting
Why 3: Each tier owns both fetching AND parsing. T1 = fetch+cheerio.
       T2 = scrapling fetch+scrapling lxml parse. No shared parser
Why 4: The tier system was designed around "escalating stealth level" as a single
       axis. Parsing was treated as an implementation detail, not a separate concern
Why 5: The architecture conflates two orthogonal problems — how to GET the HTML
       (fetch strategy) and how to EXTRACT data from it (parse strategy). These
       were never separated because tiers were built bottom-up from available
       libraries, not top-down from problem decomposition
```

**Root cause:** Fetch and parse are coupled. This is not a bug in Scrapling or cheerio — it is a design flaw in the tier architecture. Fixing selectors per-site is whack-a-mole. The fix is to decouple fetch from parse so all tiers use one parser.

## Impact

Breaks the tier escalation model. When T1 returns EMPTY (JS-rendered page), the agent should try T2 next, but T2 has the same selector issue plus its own DOM differences. Current workaround: skip T2 for EMPTY cases, go straight to T3 (browser).

## References

- Campaign results: tests/results/real-world-campaign-20260526.md
- scrape_stealth.py: src/agents/data/scripts/scrape_stealth.py
- Systemic issue: tasks/issues/systemic-fetch-parse-coupling.md
