# Systemic: Fetch and parse are coupled in the tier architecture

**Type:** Design flaw
**Severity:** High — root cause of issues t2-selector-compat, yelp-selectors-stale, walmart-etsy-antibot-ceiling (detection gap)
**Component:** src/agents/extensions/web-scrape.ts, src/agents/{data,researcher}/scripts/scrape_*.py

## Description

Each scraping tier is a monolith that owns both how to fetch HTML (anti-bot evasion) and how to parse it (CSS selector extraction). This couples two orthogonal concerns:

| Tier | Fetch engine | Parse engine |
|------|-------------|-------------|
| T1 | Node fetch() | cheerio (htmlparser2) |
| T2 | Scrapling Fetcher (Python, curl_cffi) | Scrapling (lxml) |
| T3 | Scrapling DynamicFetcher (Python, Playwright) | Scrapling (lxml) |
| T4 | Apify cloud | Apify actor-specific |

Three different parsers for the same CSS selectors. Selectors that work in cheerio may fail in lxml and vice versa. The agent cannot mix fetch and parse strategies (e.g. "stealth fetch with cheerio parse").

## Consequences

1. **Selector portability broken** — same selector, different results across tiers
2. **Opaque failures** — EMPTY could mean: blocked, stale selector, parser difference, or JS-only content. No way to distinguish
3. **Duplicated extraction logic** — scrape_stealth.py, scrape_browser.py, and web-scrape.ts T1 all implement the same iterate-elements-extract-fields-handle-pagination pattern in two languages
4. **No diagnostic path** — when extraction fails, the agent can't inspect what the page contained because raw HTML is never surfaced
5. **No challenge page detection** — can't examine fetched HTML for anti-bot signatures before attempting extraction

## Design fix

Separate fetch layer from parse layer:
- Fetch tiers return raw HTML (or indicate failure/block)
- One parser (cheerio) handles all CSS selector extraction
- Python scripts become thin fetch wrappers that dump HTML to stdout
- Challenge page detection sits between fetch and parse

See implementation plan: tasks/plans/scrape-stack-redesign.md
