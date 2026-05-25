# Web Scraping — Apify Cloud Integration (Tier 4)

## Intent

Apify Cloud REST API integration for managed scraping with residential proxies. Escalation path when local tiers (Cheerio, Scrapling, Playwright) get blocked. $39/month budget. Actor discovery, execution, and result retrieval.

## Dependencies

- Scrape gateway (web-scraping-gateway.md) — routes Tier 4 requests here
- Apify API token (APIFY_API_TOKEN env var)
- No Docker container needed — API calls from gateway directly

## Architecture

Unlike Tiers 1-3 (ephemeral containers), Tier 4 is pure HTTP API calls from the gateway:

```
Gateway receives tier: "apify"
    │ (no container spawn)
    ▼
Apify REST API v2
    │
    ├── Actor discovery (Store search)
    ├── Actor execution (run with waitForFinish)
    └── Dataset retrieval (paginated items)
```

## API Client

### Endpoints

```typescript
const APIFY_BASE = "https://api.apify.com/v2";

// Actor discovery
// GET /store?search={query}&limit=5
async function listActors(query: string, token: string): Promise<ActorInfo[]>

// Actor input schema
// GET /acts/{actorId}
async function getActorSchema(actorId: string, token: string): Promise<ActorSchema>

// Run actor
// POST /acts/{actorId}/runs?waitForFinish={seconds}
async function runActor(actorId: string, input: object, waitSecs: number, token: string): Promise<RunResult>

// Get run status
// GET /actor-runs/{runId}
async function getRunStatus(runId: string, token: string): Promise<RunStatus>

// Get dataset items
// GET /datasets/{datasetId}/items?limit={n}&offset={o}&format=json
async function getDatasetItems(datasetId: string, limit: number, offset: number, token: string): Promise<object[]>
```

### Implementation (inside gateway server.mjs)

```javascript
const APIFY_BASE = "https://api.apify.com/v2";
const APIFY_TOKEN = process.env.APIFY_API_TOKEN;

async function handleApify(request, res) {
  if (!APIFY_TOKEN) {
    res.writeHead(500);
    return res.end(JSON.stringify({ error: "APIFY_API_TOKEN not configured" }));
  }

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${APIFY_TOKEN}`,
  };

  const { actor_id, actor_input } = request.params;
  const waitSecs = Math.min(request.timeout || 45, 60);
  const maxResults = request.max_results || 50;

  // Run actor
  const runRes = await fetch(
    `${APIFY_BASE}/acts/${actor_id}/runs?waitForFinish=${waitSecs}`,
    { method: "POST", headers, body: JSON.stringify(actor_input) }
  );

  if (!runRes.ok) {
    const err = await runRes.text();
    res.writeHead(runRes.status);
    return res.end(JSON.stringify({ error: `Apify API: ${err}` }));
  }

  const run = await runRes.json();
  const runData = run.data;

  // Check if completed
  if (runData.status === "SUCCEEDED") {
    // Fetch results
    const itemsRes = await fetch(
      `${APIFY_BASE}/datasets/${runData.defaultDatasetId}/items?limit=${maxResults}&format=json`,
      { headers }
    );
    const items = await itemsRes.json();

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      items,
      metadata: {
        tier_used: "apify",
        actor_id,
        url: request.params.url || "",
        pages_crawled: 0,
        items_found: items.length,
        items_returned: items.length,
        duration_ms: runData.stats?.runTimeSecs ? runData.stats.runTimeSecs * 1000 : 0,
        errors: [],
        run_id: runData.id,
        cost_usd: runData.usage?.USD || 0,
      },
    }));
  }

  // Still running — return job_id for polling
  res.writeHead(202, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    items: [],
    metadata: {
      tier_used: "apify",
      status: runData.status,
      run_id: runData.id,
      message: "Actor still running. Poll via /scrape/status",
    },
  }));
}
```

### Status polling

```javascript
async function handleStatus(request, res) {
  const { job_id } = request;
  const headers = { Authorization: `Bearer ${APIFY_TOKEN}` };

  const runRes = await fetch(`${APIFY_BASE}/actor-runs/${job_id}`, { headers });
  const run = await runRes.json();
  const runData = run.data;

  if (runData.status === "SUCCEEDED") {
    const maxResults = request.max_results || 50;
    const itemsRes = await fetch(
      `${APIFY_BASE}/datasets/${runData.defaultDatasetId}/items?limit=${maxResults}&format=json`,
      { headers }
    );
    const items = await itemsRes.json();

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "complete", items, run_id: job_id }));
  }

  if (["FAILED", "ABORTED", "TIMED-OUT"].includes(runData.status)) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "failed", error: runData.status, run_id: job_id }));
  }

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "running", run_id: job_id }));
}
```

### Actor discovery

```javascript
async function handleListActors(request, res) {
  const { query } = request;
  const headers = { Authorization: `Bearer ${APIFY_TOKEN}` };

  const searchRes = await fetch(
    `${APIFY_BASE}/store?search=${encodeURIComponent(query)}&limit=5`,
    { headers }
  );
  const data = await searchRes.json();

  const actors = (data.data?.items || []).map(a => ({
    id: a.id,
    name: a.username ? `${a.username}/${a.name}` : a.name,
    title: a.title,
    description: a.description?.slice(0, 200),
    runs: a.stats?.totalRuns || 0,
    rating: a.stats?.rating,
    pricing: a.pricing,
  }));

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ actors }));
}
```

## Budget Management

$39/month Apify credit. Need to be deliberate about usage.

### Cost awareness

- Each actor run has a cost (varies by actor: $0.01-$5+ depending on complexity)
- Residential proxy usage costs extra (~$8/GB)
- Agent system prompt should prefer local tiers first
- Gateway logs cost per run from `usage.USD` field

### Monitoring

```javascript
// Track monthly spend (in-memory, reset on restart — sufficient for eval)
let monthlySpend = 0;
const MONTHLY_BUDGET = 39;

function checkBudget(runCost) {
  monthlySpend += runCost;
  if (monthlySpend > MONTHLY_BUDGET * 0.8) {
    console.warn(`Apify spend at ${(monthlySpend/MONTHLY_BUDGET*100).toFixed(0)}% of budget`);
  }
}
```

## Common Actors (pre-identified)

| Actor | Use case | Typical cost |
|-------|----------|-------------|
| `apify/web-scraper` | General web scraping | $0.01-0.10 |
| `apify/google-search-scraper` | Google SERP results | $0.01/query |
| `apify/instagram-scraper` | Instagram profiles/posts | $0.05-0.50 |
| `apify/linkedin-scraper` | LinkedIn profiles | $0.10-1.00 |
| `apify/twitter-scraper` | Twitter/X posts | $0.05-0.50 |
| `apify/amazon-product-scraper` | Amazon product data | $0.01-0.10 |
| `apify/google-maps-scraper` | Google Maps listings | $0.01-0.05 |

Agent discovers actors via `list-actors` endpoint. These are reference for system prompt guidance.

## Data Agent Extension Tools

These are registered in the Data agent's web-scraping.ts extension and call the gateway:

```typescript
pi.registerTool({
  name: "scrape",
  label: "Web Scrape",
  description: "Scrape a web page. Picks scraping method by tier: cheerio (fast HTML), scrapling (anti-detection), playwright (JS rendering), apify (residential proxies). Set auto_escalate=true to try tiers until success.",
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
    actor_id: Type.Optional(Type.String()),
    actor_input: Type.Optional(Type.Any()),
    auto_escalate: Type.Optional(Type.Boolean()),
    max_results: Type.Optional(Type.Number()),
  }),
  async execute(_id, params, signal) {
    const res = await fetch("http://scrape-gateway:8090/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier: params.tier || "cheerio", params, ...params }),
      signal,
    });
    const data = await res.json();

    // Large results → write to artifacts
    if (data.items?.length > 50) {
      const path = `/artifacts/data/${Date.now()}-scrape.json`;
      writeFileSync(path, JSON.stringify(data, null, 2));
      const preview = data.items.slice(0, 5).map(i => JSON.stringify(i).slice(0, 100)).join("\n");
      return { content: [{ type: "text", text: `Scraped ${data.items.length} items → ${path}\nPreview:\n${preview}` }] };
    }

    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  },
});

pi.registerTool({
  name: "list_actors",
  label: "List Scraping Actors",
  description: "Search Apify Store for scraping actors. Use to find the right actor for a specific site or data type.",
  parameters: Type.Object({
    query: Type.String({ description: "Search query (e.g. 'linkedin scraper', 'google maps')" }),
  }),
  async execute(_id, params, signal) {
    const res = await fetch("http://scrape-gateway:8090/list-actors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal,
    });
    return { content: [{ type: "text", text: await res.text() }] };
  },
});

pi.registerTool({
  name: "scrape_status",
  label: "Scrape Status",
  description: "Poll status of a long-running Apify scrape job. Returns results when complete.",
  parameters: Type.Object({
    job_id: Type.String({ description: "Run ID from a previous scrape call" }),
  }),
  async execute(_id, params, signal) {
    const res = await fetch("http://scrape-gateway:8090/scrape/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal,
    });
    return { content: [{ type: "text", text: await res.text() }] };
  },
});
```

## .env.example addition

```
# Apify Cloud (Tier 4 scraping — residential proxies, managed actors)
# $39/month plan. Used when local scraping tiers fail.
APIFY_API_TOKEN=apify_api_xxxxxxxxxxxxx
```

## Definition of Done

- [ ] Actor discovery: search Store, return top matches
- [ ] Actor execution: run with waitForFinish, return results
- [ ] Status polling: check running jobs, return results when complete
- [ ] Dataset retrieval: paginated item fetch
- [ ] Budget tracking: log cost per run, warn at 80%
- [ ] Data agent tools: scrape, list_actors, scrape_status registered
- [ ] Large results written to /artifacts
- [ ] Error handling: API failures return clear messages
- [ ] Integration test: list actors for known query
- [ ] Integration test: run web-scraper actor on test URL
- [ ] APIFY_API_TOKEN in .env.example

## Risks

- **Budget drain:** Single expensive actor can burn $5+. Mitigation: agent system prompt guides toward local tiers first. Budget warning at 80%.
- **Actor input schemas:** Each actor has unique input format. Agent must discover via list_actors then read schema. May require extra API call for complex actors.
- **Wait timeout:** Some actors run 5+ minutes. waitForFinish caps at 60s in gateway. Long runs return job_id for polling. Agent must handle async pattern.
- **Apify API changes:** v2 API is stable but actor-specific behavior varies. Mitigation: we only use core endpoints (run, dataset, store). Actor-specific logic is in the actor itself.
