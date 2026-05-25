# Web Scraping Tiers (Entrypoint Scripts)

## Intent

Entrypoint scripts for each scraping tier. Run inside ephemeral containers spawned by the scrape gateway. Each script: receive JSON params → scrape → output JSON to stdout. One file per tier.

## Dependencies

- Scrape gateway (web-scraping-gateway.md) — spawns these containers
- Official Docker images (pre-pulled):
  - `apify/actor-node-cheerio:22`
  - `pyd4vinci/scrapling:latest`
  - `apify/actor-node-playwright-chrome:22`

## File structure

```
src/agents/scrape-gateway/
  entrypoints/
    cheerio.mjs           Node script for Cheerio container
    scrapling.py          Python script for Scrapling container
    playwright.mjs        Node script for Playwright container
```

## Shared Input/Output Contract

All entrypoints receive params as first CLI argument (JSON string) and write results to stdout as JSON.

### Input (from gateway)

```typescript
interface ScrapeParams {
  url: string;
  selector?: string;               // CSS selector for target elements
  extract_fields?: Record<string, string>;  // field_name → CSS selector
  pagination?: {
    next_selector: string;         // CSS selector for next page link
    max_pages: number;             // page limit
  };
  wait_for?: string;               // CSS selector to wait for (Playwright only)
  max_items?: number;              // cap results
}
```

### Output (to stdout)

```json
{
  "items": [...],
  "pages_crawled": 3,
  "duration_ms": 4500,
  "errors": ["page 4: timeout"]
}
```

## Tier 1: Cheerio (cheerio.mjs)

Fast HTML parsing, no browser. For static sites without anti-bot.

```javascript
#!/usr/bin/env node
import * as cheerio from "cheerio";

const params = JSON.parse(process.argv[2] || "{}");
const startTime = Date.now();
const items = [];
const errors = [];
let pagesCrawled = 0;

async function scrapePage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept": "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  const $ = cheerio.load(html);
  pagesCrawled++;

  // Extract items
  const selector = params.selector || "body";
  $(selector).each((i, el) => {
    if (params.max_items && items.length >= params.max_items) return false;

    if (params.extract_fields) {
      const item = {};
      for (const [field, sel] of Object.entries(params.extract_fields)) {
        item[field] = $(el).find(sel).text().trim() || $(el).find(sel).attr("href") || "";
      }
      items.push(item);
    } else {
      items.push({
        text: $(el).text().trim(),
        html: $(el).html()?.slice(0, 500),
      });
    }
  });

  // Pagination
  if (params.pagination && pagesCrawled < params.pagination.max_pages) {
    const nextEl = $(params.pagination.next_selector);
    const nextHref = nextEl.attr("href");
    if (nextHref) {
      const nextUrl = new URL(nextHref, url).href;
      await scrapePage(nextUrl);
    }
  }
}

try {
  await scrapePage(params.url);
} catch (err) {
  errors.push(err.message);
}

console.log(JSON.stringify({
  items,
  pages_crawled: pagesCrawled,
  duration_ms: Date.now() - startTime,
  errors,
}));
```

### Notes

- Uses native `fetch` (Node 22 built-in) — no external HTTP library needed
- `cheerio` is available in the `apify/actor-node-cheerio:22` image
- Pagination is recursive with page count guard
- 15s timeout per page fetch

## Tier 2: Scrapling (scrapling.py)

Anti-detection scraping without browser. TLS fingerprinting, header rotation.

```python
#!/usr/bin/env python3
import sys
import json
import time

start_time = time.time()
params = json.loads(sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read())
items = []
errors = []
pages_crawled = 0

try:
    from scrapling import StealthFetcher

    fetcher = StealthFetcher()
    max_items = params.get("max_items", 100)

    def scrape_page(url):
        global pages_crawled
        page = fetcher.get(url)
        pages_crawled += 1

        selector = params.get("selector", "body")
        elements = page.css(selector)

        for el in elements:
            if len(items) >= max_items:
                break

            if params.get("extract_fields"):
                item = {}
                for field, sel in params["extract_fields"].items():
                    found = el.css(sel)
                    if found:
                        item[field] = found[0].text.strip()
                        # Try href if text is empty
                        if not item[field]:
                            item[field] = found[0].attrib.get("href", "")
                    else:
                        item[field] = ""
                items.append(item)
            else:
                items.append({
                    "text": el.text.strip() if hasattr(el, 'text') else str(el),
                })

        # Pagination
        pagination = params.get("pagination")
        if pagination and pages_crawled < pagination.get("max_pages", 5):
            next_els = page.css(pagination["next_selector"])
            if next_els:
                next_href = next_els[0].attrib.get("href")
                if next_href:
                    # Resolve relative URL
                    from urllib.parse import urljoin
                    next_url = urljoin(url, next_href)
                    scrape_page(next_url)

    scrape_page(params["url"])

except Exception as e:
    errors.append(str(e))

duration_ms = int((time.time() - start_time) * 1000)
print(json.dumps({
    "items": items,
    "pages_crawled": pages_crawled,
    "duration_ms": duration_ms,
    "errors": errors,
}))
```

### Notes

- Uses `StealthFetcher` (anti-detection mode: smart TLS, header rotation)
- `scrapling` is pre-installed in `pyd4vinci/scrapling:latest`
- No browser used — httpx under the hood with stealth modifications
- Falls back gracefully on import/runtime errors

## Tier 3: Playwright (playwright.mjs)

Full browser rendering. For SPAs, dynamic content, JS-required pages.

```javascript
#!/usr/bin/env node
import { chromium } from "playwright";

const params = JSON.parse(process.argv[2] || "{}");
const startTime = Date.now();
const items = [];
const errors = [];
let pagesCrawled = 0;

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

const context = await browser.newContext({
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});

async function scrapePage(url) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });

    // Wait for dynamic content if specified
    if (params.wait_for) {
      await page.waitForSelector(params.wait_for, { timeout: 15000 });
    } else {
      // Default: wait for network idle (brief)
      await page.waitForLoadState("networkidle").catch(() => {});
    }

    pagesCrawled++;
    const selector = params.selector || "body";
    const maxItems = params.max_items || 100;

    // Extract items
    const extracted = await page.$$eval(selector, (els, fields, max) => {
      return els.slice(0, max).map(el => {
        if (fields) {
          const item = {};
          for (const [field, sel] of Object.entries(fields)) {
            const found = el.querySelector(sel);
            item[field] = found?.textContent?.trim() || found?.getAttribute("href") || "";
          }
          return item;
        }
        return { text: el.textContent?.trim(), html: el.innerHTML?.slice(0, 500) };
      });
    }, params.extract_fields || null, maxItems - items.length);

    items.push(...extracted);

    // Pagination
    if (params.pagination && pagesCrawled < params.pagination.max_pages && items.length < maxItems) {
      const nextEl = await page.$(params.pagination.next_selector);
      if (nextEl) {
        const href = await nextEl.getAttribute("href");
        if (href) {
          const nextUrl = new URL(href, url).href;
          await page.close();
          await scrapePage(nextUrl);
          return;
        }
      }
    }
  } catch (err) {
    errors.push(`${url}: ${err.message}`);
  } finally {
    await page.close().catch(() => {});
  }
}

try {
  await scrapePage(params.url);
} catch (err) {
  errors.push(err.message);
}

await browser.close();

console.log(JSON.stringify({
  items,
  pages_crawled: pagesCrawled,
  duration_ms: Date.now() - startTime,
  errors,
}));
```

### Notes

- `playwright` and Chromium pre-installed in `apify/actor-node-playwright-chrome:22`
- `--no-sandbox` safe because container IS the sandbox
- New page per URL (clean state, no cookie leakage between pages)
- `networkidle` wait catches most dynamic content without explicit `wait_for`
- 20s page load timeout, 15s selector wait timeout

## Delivery to Containers

Gateway bind-mounts entrypoints directory read-only:

```bash
# Cheerio
docker run --rm -v ./entrypoints/cheerio.mjs:/app/entrypoint.mjs:ro \
  apify/actor-node-cheerio:22 node /app/entrypoint.mjs '{"url":"...", "selector":"..."}'

# Scrapling
docker run --rm -v ./entrypoints/scrapling.py:/app/entrypoint.py:ro \
  pyd4vinci/scrapling:latest python /app/entrypoint.py '{"url":"...", "selector":"..."}'

# Playwright
docker run --rm -v ./entrypoints/playwright.mjs:/app/entrypoint.mjs:ro \
  apify/actor-node-playwright-chrome:22 node /app/entrypoint.mjs '{"url":"...", "selector":"..."}'
```

## Testing

Each entrypoint testable independently:

```bash
# Local test (Cheerio)
docker run --rm -v $(pwd)/entrypoints/cheerio.mjs:/app/e.mjs:ro \
  apify/actor-node-cheerio:22 node /app/e.mjs \
  '{"url":"https://example.com","selector":"h1"}'

# Expected: {"items":[{"text":"Example Domain","html":"Example Domain"}],"pages_crawled":1,...}
```

### Test fixtures

Create a simple static HTTP server for integration tests:

```javascript
// test/fixtures/scrape-target/server.mjs
import { createServer } from "http";
const html = `<html><body>
  <div class="item"><h2 class="title">Item 1</h2><p class="price">$10</p></div>
  <div class="item"><h2 class="title">Item 2</h2><p class="price">$20</p></div>
  <a class="next" href="/page2">Next</a>
</body></html>`;
createServer((req, res) => { res.end(html); }).listen(9999);
```

Test params:
```json
{
  "url": "http://host.docker.internal:9999",
  "selector": ".item",
  "extract_fields": { "title": ".title", "price": ".price" },
  "pagination": { "next_selector": ".next", "max_pages": 2 }
}
```

## Definition of Done

- [ ] cheerio.mjs: extracts items via CSS selector
- [ ] cheerio.mjs: pagination working (follows next link)
- [ ] cheerio.mjs: extract_fields mapping working
- [ ] scrapling.py: anti-detection fetch working
- [ ] scrapling.py: CSS selector extraction
- [ ] scrapling.py: pagination working
- [ ] playwright.mjs: JS-rendered page extraction
- [ ] playwright.mjs: wait_for selector support
- [ ] playwright.mjs: pagination working
- [ ] All entrypoints: respect max_items cap
- [ ] All entrypoints: output valid JSON to stdout
- [ ] All entrypoints: report errors without crashing
- [ ] Integration test per tier against fixture server
- [ ] Timeout behavior: scripts exit cleanly when killed

## Risks

- **Scrapling image entrypoint conflict:** `pyd4vinci/scrapling:latest` may have its own ENTRYPOINT. Need to verify we can override with our script via bind-mount + explicit command.
- **Cheerio import path:** `apify/actor-node-cheerio:22` may have cheerio at a non-standard import path. Test import resolution inside container.
- **Playwright version mismatch:** Our script uses playwright API that may differ from version in `apify/actor-node-playwright-chrome:22`. Pin to image's installed version.
