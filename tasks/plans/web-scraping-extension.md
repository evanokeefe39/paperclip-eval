# Web Scraping Extension

## Intent

Multi-tier web scraping extension for Data/Analyst agent. All scraping backends available simultaneously — agent picks based on target characteristics or auto-escalates on failure. Gives Data agent the ability to gather structured data at scale from any web source, with residential proxy escalation path via Apify Cloud ($39/mo budget).

## Architecture

Four scraping tiers via ephemeral Docker containers + Apify Cloud API, orchestrated by a scraping gateway:

```
Data Agent (Pi + bridge.mjs)
    │ HTTP
    ▼
Scrape Gateway (docker.sock access, always-on sidecar in compose)
    │
    ├── docker run --rm  apify/actor-node-cheerio:22              [Tier 1: fast HTML]
    ├── docker run --rm  pyd4vinci/scrapling:latest               [Tier 2: anti-detection]
    ├── docker run --rm  apify/actor-node-playwright-chrome:22    [Tier 3: JS/SPA]
    └── Apify Cloud REST API                                      [Tier 4: residential proxies]
         $39/mo budget
```

### Tier selection

| Tier | Image / Service | Strength | Use when |
|------|----------------|----------|----------|
| 1 — Cheerio | `apify/actor-node-cheerio:22` | Fast, lightweight, bulk | Static HTML, no anti-bot |
| 2 — Scrapling | `pyd4vinci/scrapling:latest` | TLS fingerprinting, header rotation, anti-detection without browser | 403s from Tier 1, basic bot detection |
| 3 — Playwright | `apify/actor-node-playwright-chrome:22` | Full browser, JS execution | SPAs, dynamic content, JS-required |
| 4 — Apify Cloud | REST API (remote) | Residential proxies, maintained actors, heavy anti-bot | Cloudflare Enterprise, IP blocks, platforms with existing actors (LinkedIn, Amazon, Google Maps) |

### Cost model

- Tiers 1-3: free (local compute, ephemeral containers, ~seconds per run)
- Tier 4: $39/month Apify credit. Residential proxies, managed infrastructure. Reserve for when local methods fail.
- Agent should prefer lowest sufficient tier. Auto-escalation on failure optional.

### Ephemeral container pattern

No scraping images run persistently. Gateway spins them up per-request:

1. Data agent calls gateway: `POST /scrape { tier, params }`
2. Gateway does: `docker run --rm --network=none --memory=2g --stop-timeout=60 {image} {entrypoint} '{params_json}'`
3. Container scrapes, writes results to stdout (JSON)
4. Gateway collects stdout, returns to data agent
5. Container auto-removed

Benefits: no idle resource usage, clean state per scrape, no cross-contamination between targets.

### Pre-pull strategy

Images pulled during `setup.sh` so first scrape doesn't block:

```bash
docker pull apify/actor-node-cheerio:22
docker pull pyd4vinci/scrapling:latest
docker pull apify/actor-node-playwright-chrome:22
```

## Implementation Plan

### Phase 1: Scrape Gateway service

#### 1.1 — File structure

```
src/agents/scrape-gateway/
  server.mjs              HTTP server (Node, zero deps like bridge.mjs)
  entrypoints/
    cheerio.mjs           Entrypoint script for Cheerio container
    scrapling.py          Entrypoint script for Scrapling container
    playwright.mjs        Entrypoint script for Playwright container
  Dockerfile              Gateway image (node:22-slim + docker CLI)
```

#### 1.2 — Gateway server

Thin HTTP server. Responsibilities:
- Accept scrape requests from data agent
- Validate params (allowlisted images only — no arbitrary docker run)
- Spawn ephemeral container with appropriate image
- Collect results (stdout JSON or artifact file)
- Enforce timeout (kill container if exceeded)
- Return results to caller

```typescript
// POST /scrape
interface ScrapeRequest {
  tier: "cheerio" | "scrapling" | "playwright" | "apify";
  params: {
    url: string;
    selector?: string;
    extract_fields?: Record<string, string>;
    pagination?: { next_selector: string; max_pages: number };
    wait_for?: string;       // Tier 3 only
    actor_id?: string;       // Tier 4 only
    actor_input?: object;    // Tier 4 only
  };
  timeout?: number;          // seconds, default 60, max 120
  max_results?: number;      // cap items returned, default 100
}

// POST /scrape/status
interface StatusRequest {
  job_id: string;  // For Tier 4 async runs
}

// POST /list-actors
interface ListActorsRequest {
  query: string;
  category?: string;
}
```

#### 1.3 — Security constraints on gateway

- **Image allowlist:** Only the three pre-approved images + Apify API. No arbitrary image execution.
- **Network isolation:** Ephemeral containers run with `--network=none` (no internet from inside container — gateway fetches URL first and passes content? No, containers need network for scraping). Correction: containers get outbound internet but no access to Docker internal network (custom network with no inter-container routing).
- **Resource limits:** `--memory=2g --cpus=2 --stop-timeout={timeout}`
- **No volume mounts to host:** Results via stdout only. No docker.sock passthrough to scraping containers.
- **Rate limiting:** Gateway enforces max 5 concurrent containers, queue excess.

#### 1.4 — docker-compose integration

```yaml
services:
  scrape-gateway:
    build: ./src/agents/scrape-gateway
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - shared-artifacts:/artifacts
    networks:
      - internal
    environment:
      - APIFY_API_TOKEN=${APIFY_API_TOKEN}
    deploy:
      resources:
        limits:
          memory: 512M
```

### Phase 2: Tier 1 — Cheerio (fast HTML)

#### 2.1 — Entrypoint script (cheerio.mjs)

Runs inside `apify/actor-node-cheerio:22`. Receives params as CLI arg (JSON string).

```javascript
// cheerio.mjs — stdin JSON → scrape → stdout JSON
import { CheerioCrawler } from 'crawlee';

const params = JSON.parse(process.argv[2] || await readStdin());

const results = [];
const crawler = new CheerioCrawler({
  maxRequestsPerCrawl: params.pagination?.max_pages || 1,
  requestHandler: async ({ $, request }) => {
    // Extract items via selector
    $(params.selector).each((i, el) => {
      if (params.extract_fields) {
        const item = {};
        for (const [field, sel] of Object.entries(params.extract_fields)) {
          item[field] = $(el).find(sel).text().trim();
        }
        results.push(item);
      } else {
        results.push({ text: $(el).text().trim(), html: $(el).html() });
      }
    });
    // Pagination
    if (params.pagination?.next_selector) {
      const next = $(params.pagination.next_selector).attr('href');
      if (next) await crawler.addRequests([{ url: new URL(next, request.url).href }]);
    }
  },
});

await crawler.run([params.url]);
console.log(JSON.stringify({ items: results, pages_crawled: crawler.stats.requestsFinished }));
```

#### 2.2 — Gateway spawns it

```bash
docker run --rm --memory=2g --cpus=2 --network=scrape-net \
  apify/actor-node-cheerio:22 \
  node /app/cheerio.mjs '{"url":"...","selector":"..."}'
```

Entrypoint script bind-mounted or built into a thin wrapper image extending the base.

### Phase 3: Tier 2 — Scrapling (anti-detection)

#### 3.1 — Entrypoint script (scrapling.py)

Runs inside `pyd4vinci/scrapling:latest`. Python entrypoint.

```python
# scrapling.py — stdin JSON → scrape → stdout JSON
import sys, json
from scrapling import Fetcher, StealthFetcher

params = json.loads(sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read())

# Use StealthFetcher for anti-detection (smart TLS, header rotation)
fetcher = StealthFetcher()
page = fetcher.get(params["url"])

results = []
elements = page.css(params.get("selector", "body"))
for el in elements:
    if params.get("extract_fields"):
        item = {}
        for field, sel in params["extract_fields"].items():
            found = el.css(sel)
            item[field] = found[0].text if found else ""
        results.append(item)
    else:
        results.append({"text": el.text, "html": str(el)})

# Pagination
pages_crawled = 1
if params.get("pagination"):
    max_pages = params["pagination"].get("max_pages", 5)
    for _ in range(max_pages - 1):
        next_el = page.css(params["pagination"]["next_selector"])
        if not next_el:
            break
        next_url = next_el[0].attrib.get("href")
        if not next_url:
            break
        page = fetcher.get(next_url)
        for el in page.css(params.get("selector", "body")):
            if params.get("extract_fields"):
                item = {}
                for field, sel in params["extract_fields"].items():
                    found = el.css(sel)
                    item[field] = found[0].text if found else ""
                results.append(item)
            else:
                results.append({"text": el.text})
        pages_crawled += 1

print(json.dumps({"items": results, "pages_crawled": pages_crawled}))
```

#### 3.2 — Gateway spawns it

```bash
docker run --rm --memory=2g --cpus=2 --network=scrape-net \
  pyd4vinci/scrapling:latest \
  python /app/scrapling.py '{"url":"...","selector":"..."}'
```

Entrypoint mounted via `-v ./entrypoints/scrapling.py:/app/scrapling.py:ro`

### Phase 4: Tier 3 — Playwright (full browser)

#### 4.1 — Entrypoint script (playwright.mjs)

Runs inside `apify/actor-node-playwright-chrome:22`.

```javascript
// playwright.mjs
import { PlaywrightCrawler } from 'crawlee';

const params = JSON.parse(process.argv[2] || await readStdin());
const results = [];

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: params.pagination?.max_pages || 1,
  headless: true,
  requestHandler: async ({ page, request }) => {
    if (params.wait_for) {
      await page.waitForSelector(params.wait_for, { timeout: 15000 });
    }
    const items = await page.$$eval(params.selector, (els, fields) => {
      return els.map(el => {
        if (fields) {
          const item = {};
          for (const [field, sel] of Object.entries(fields)) {
            const found = el.querySelector(sel);
            item[field] = found?.textContent?.trim() || "";
          }
          return item;
        }
        return { text: el.textContent?.trim(), html: el.innerHTML };
      });
    }, params.extract_fields || null);
    results.push(...items);

    if (params.pagination?.next_selector) {
      const next = await page.$(params.pagination.next_selector);
      if (next) {
        const href = await next.getAttribute('href');
        if (href) await crawler.addRequests([{ url: new URL(href, request.url).href }]);
      }
    }
  },
});

await crawler.run([params.url]);
console.log(JSON.stringify({ items: results, pages_crawled: crawler.stats.requestsFinished }));
```

### Phase 5: Tier 4 — Apify Cloud (residential proxies)

#### 5.1 — Direct REST API from gateway (no container)

Gateway calls Apify API directly. No ephemeral container needed — Apify runs on their infra.

```typescript
// Inside gateway server
async function apifyRun(params: ScrapeRequest): Promise<ScrapeResult> {
  // 1. Run actor
  const runRes = await fetch(
    `https://api.apify.com/v2/acts/${params.params.actor_id}/runs?waitForFinish=45`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${APIFY_API_TOKEN}` },
      body: JSON.stringify(params.params.actor_input),
    }
  );
  const run = await runRes.json();

  // 2. Fetch results
  if (run.data.status === "SUCCEEDED") {
    const dataRes = await fetch(
      `https://api.apify.com/v2/datasets/${run.data.defaultDatasetId}/items?limit=${params.max_results || 50}`
    );
    const items = await dataRes.json();
    return { items, metadata: { source: "apify", cost: run.data.usage } };
  }

  // 3. Still running — return job_id for polling
  return { items: [], metadata: { source: "apify", job_id: run.data.id, status: run.data.status } };
}
```

#### 5.2 — list_actors endpoint

```typescript
// GET /list-actors?query=...
async function listActors(query: string) {
  const res = await fetch(
    `https://api.apify.com/v2/store?search=${encodeURIComponent(query)}&limit=5`,
    { headers: { Authorization: `Bearer ${APIFY_API_TOKEN}` } }
  );
  const data = await res.json();
  return data.data.items.map(a => ({
    id: a.id,
    name: a.name,
    title: a.title,
    description: a.description?.slice(0, 200),
    monthly_runs: a.stats?.totalRuns,
    pricing: a.pricing,
  }));
}
```

### Phase 6: Data Agent extension (scraping tools)

#### 6.1 — Extension file (web-scraping.ts)

Registers tools that call the gateway:

```typescript
// Tools registered:
// - scrape          (main tool — agent picks tier or auto-escalates)
// - list_actors     (discover Apify actors)
// - scrape_status   (poll async Apify jobs)

pi.registerTool({
  name: "scrape",
  parameters: Type.Object({
    url: Type.String(),
    tier: Type.Optional(Type.Union([
      Type.Literal("cheerio"),
      Type.Literal("scrapling"),
      Type.Literal("playwright"),
      Type.Literal("apify"),
    ])),
    selector: Type.Optional(Type.String()),
    extract_fields: Type.Optional(Type.Record(Type.String(), Type.String())),
    pagination: Type.Optional(Type.Object({
      next_selector: Type.String(),
      max_pages: Type.Optional(Type.Number()),
    })),
    wait_for: Type.Optional(Type.String()),
    // Apify-specific
    actor_id: Type.Optional(Type.String()),
    actor_input: Type.Optional(Type.Any()),
    // Control
    auto_escalate: Type.Optional(Type.Boolean()),  // try tiers until success
    max_results: Type.Optional(Type.Number()),
  }),
  async execute(_id, params, signal) {
    const res = await fetch(`http://scrape-gateway:8090/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal,
    });
    return { content: [{ type: "text", text: await res.text() }] };
  },
});
```

#### 6.2 — Auto-escalation logic (in gateway)

If `auto_escalate: true`:
1. Try Cheerio → if 403 or empty results
2. Try Scrapling → if still blocked
3. Try Playwright → if still fails
4. Try Apify Cloud (if actor_id provided)
5. Return best result or failure with tier attempted

### Phase 7: Security and resource limits

- **Image allowlist:** Gateway hardcodes exactly 3 image names. Rejects all others.
- **Container limits:** `--memory=2g --cpus=2` per container. Max 5 concurrent.
- **Timeout:** Hard kill at configured timeout (default 60s). Gateway sends SIGTERM then SIGKILL after 10s.
- **Network:** Scraping containers get outbound internet (necessary for scraping) but no access to internal Docker services (separate network without routes to agent containers).
- **No volume mounts:** Results via stdout only. No filesystem access beyond container's own.
- **Rate limiting:** Gateway tracks requests-per-domain. Max 2/s per domain, 10/s global. Queue excess with backpressure to data agent.
- **Result size cap:** Max 200 items inline. Larger results written to /artifacts, path returned.

### Phase 8: Testing

- Gateway unit tests: request validation, image allowlist enforcement
- Tier 1 integration: scrape a static test page (local HTTP server)
- Tier 2 integration: scrape same page via Scrapling container
- Tier 3 integration: scrape a JS-rendered test page
- Tier 4 integration: run a known Apify actor (web-scraper on test URL)
- Auto-escalation test: mock 403 from Tier 1, verify escalation to Tier 2
- Timeout test: slow target, verify container killed at deadline
- Concurrent limit test: 6 simultaneous requests, verify 5 run + 1 queued

## Entrypoint delivery

Two options for getting entrypoint scripts into ephemeral containers:

**Option A — Bind mount (simpler for eval):**
```bash
docker run --rm -v ./entrypoints/cheerio.mjs:/app/entrypoint.mjs:ro \
  apify/actor-node-cheerio:22 node /app/entrypoint.mjs '{...}'
```

**Option B — Thin wrapper images (cleaner for production):**
```dockerfile
FROM apify/actor-node-cheerio:22
COPY cheerio.mjs /app/entrypoint.mjs
ENTRYPOINT ["node", "/app/entrypoint.mjs"]
```

Recommendation: Option A for eval (no custom build step). Move to Option B when stabilized.

## Open Questions

1. **Network policy for scraping containers:** They need outbound internet but shouldn't reach internal services. Custom Docker network with only default gateway? Or iptables rules?

2. **Stdout size limits:** If a scrape returns 10MB of JSON via stdout, gateway needs to handle this. Stream to /artifacts above threshold?

3. **Scrapling entrypoint API:** Need to verify `pyd4vinci/scrapling` image's default entrypoint and whether we can override it cleanly with our script.

4. **Apify actor input schemas:** Agent needs to know valid inputs for each actor. Cache actor schemas in gateway? Or fetch on demand via list_actors?

## Definition of Done

- [ ] Scrape gateway service running in docker-compose
- [ ] Gateway accepts POST /scrape with tier selection
- [ ] Tier 1 (Cheerio): spawns container, returns scraped items
- [ ] Tier 2 (Scrapling): spawns container, anti-detection working
- [ ] Tier 3 (Playwright): spawns container, JS rendering working
- [ ] Tier 4 (Apify Cloud): REST API integration, actor discovery
- [ ] Auto-escalation on failure (403 → next tier)
- [ ] Image allowlist enforced (no arbitrary docker run)
- [ ] Container resource limits (memory, CPU, timeout)
- [ ] Rate limiting per-domain
- [ ] Max 5 concurrent scraping containers
- [ ] Large results written to /artifacts with path reference
- [ ] Data agent extension (scrape, list_actors, scrape_status tools)
- [ ] Images pre-pulled in setup.sh
- [ ] APIFY_API_TOKEN documented in .env.example
- [ ] Integration tests for each tier

## Risks

- **Docker-in-Docker complexity:** Gateway spawning containers via docker.sock. Well-understood pattern but adds operational surface. Mitigation: gateway is minimal, allowlisted images only.
- **Scrapling image stability:** `pyd4vinci/scrapling` is community-maintained, may break. Mitigation: pin to specific digest, test before updating.
- **Apify budget burn:** $39/mo can drain fast with large crawls. Mitigation: agent system prompt prioritizes local tiers, uses Apify only when explicitly needed or after local failures.
- **Stdout buffer overflow:** Large scrape results could exceed Node's buffer. Mitigation: stream to temp file, read back. Or set `maxBuffer` on child process.
