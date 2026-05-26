# Web Scraping Gateway [SUPERSEDED]

> **Superseded by:** `bespoke-agent-images.md` — agents carry their own scraping deps directly. No gateway, no docker-in-docker. This plan is retained for reference only.

## Intent

Thin HTTP service that manages ephemeral scraping containers. Holds docker.sock access so no other agent container needs it. Spawns pre-approved scraping images on demand, collects results, enforces resource limits and timeouts. Always-on sidecar in docker-compose.

## Dependencies

- Docker socket access
- Pre-pulled images (setup.sh responsibility)
- Internal Docker network for agent access

## File structure

```
src/agents/scrape-gateway/
  server.mjs              HTTP server (Node, zero deps)
  Dockerfile              Gateway image (node:22-slim + docker CLI binary)
```

## Architecture

```
Data Agent
    │ POST http://scrape-gateway:8090/scrape
    ▼
┌─────────────────────────────────────────────┐
│ Scrape Gateway (:8090)                      │
│                                             │
│ - Validates request (tier, params)          │
│ - Checks image allowlist                    │
│ - Enforces concurrency limit (max 5)        │
│ - Spawns ephemeral container                │
│ - Collects stdout (JSON results)            │
│ - Kills container at timeout                │
│ - Returns results to caller                 │
└─────────────────────────────────────────────┘
    │ docker run --rm
    ▼
Ephemeral scraping container (dies after job)
```

## API

### POST /scrape

```typescript
interface ScrapeRequest {
  tier: "cheerio" | "scrapling" | "playwright" | "apify";
  params: {
    url: string;
    selector?: string;
    extract_fields?: Record<string, string>;
    pagination?: { next_selector: string; max_pages: number };
    wait_for?: string;           // Tier 3 only (JS rendering)
    actor_id?: string;           // Tier 4 only
    actor_input?: object;        // Tier 4 only
  };
  timeout?: number;              // seconds, default 60, max 120
  max_results?: number;          // cap items, default 100
  auto_escalate?: boolean;       // retry with next tier on failure
}

interface ScrapeResponse {
  items: object[];
  metadata: {
    tier_used: string;
    url: string;
    pages_crawled: number;
    items_found: number;
    items_returned: number;
    duration_ms: number;
    errors: string[];
  };
}
```

### POST /scrape/status

```typescript
interface StatusRequest { job_id: string; }
// Returns Apify run status + results if complete
```

### POST /list-actors

```typescript
interface ListActorsRequest { query: string; category?: string; }
// Returns top 5 Apify Store actors matching query
```

### GET /health

Returns `{"status": "ok", "active_containers": N}`.

## Server Implementation (server.mjs)

```javascript
import { createServer } from "http";
import { execFile, spawn } from "child_process";

const PORT = process.env.GATEWAY_PORT || 8090;
const MAX_CONCURRENT = 5;
const IMAGE_ALLOWLIST = {
  cheerio: "apify/actor-node-cheerio:22",
  scrapling: "pyd4vinci/scrapling:latest",
  playwright: "apify/actor-node-playwright-chrome:22",
};

let activeContainers = 0;
const queue = [];

const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/scrape") {
    const body = await readBody(req);
    const request = JSON.parse(body);

    // Validate
    if (request.tier === "apify") {
      return handleApify(request, res);
    }

    const image = IMAGE_ALLOWLIST[request.tier];
    if (!image) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: `Unknown tier: ${request.tier}` }));
    }

    // Concurrency gate
    if (activeContainers >= MAX_CONCURRENT) {
      await new Promise(resolve => queue.push(resolve));
    }
    activeContainers++;

    try {
      const result = await runContainer(image, request);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      if (request.auto_escalate) {
        const escalated = await tryEscalate(request);
        if (escalated) {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify(escalated));
        }
      }
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    } finally {
      activeContainers--;
      if (queue.length > 0) queue.shift()();
    }
  }
  // ... other routes
});

server.listen(PORT);
```

## Container Spawning

```javascript
async function runContainer(image, request) {
  const timeout = Math.min(request.timeout || 60, 120);
  const paramsJson = JSON.stringify(request.params);

  // Determine entrypoint based on tier
  const entrypoint = getEntrypoint(request.tier);

  return new Promise((resolve, reject) => {
    const args = [
      "run", "--rm",
      "--memory=2g",
      "--cpus=2",
      `--stop-timeout=${timeout}`,
      "--network=scrape-egress",  // outbound internet, no internal access
      "-v", `${ENTRYPOINTS_PATH}/${entrypoint}:/app/entrypoint:ro`,
      image,
      ...getRunCommand(request.tier, "/app/entrypoint"),
      paramsJson,
    ];

    const proc = spawn("docker", args);
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", d => { stdout += d; });
    proc.stderr.on("data", d => { stderr += d; });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 10_000);
      reject(new Error(`Timeout after ${timeout}s`));
    }, timeout * 1000);

    proc.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Container exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve({
          items: (parsed.items || []).slice(0, request.max_results || 100),
          metadata: {
            tier_used: request.tier,
            url: request.params.url,
            pages_crawled: parsed.pages_crawled || 1,
            items_found: parsed.items?.length || 0,
            items_returned: Math.min(parsed.items?.length || 0, request.max_results || 100),
            duration_ms: parsed.duration_ms || 0,
            errors: parsed.errors || [],
          },
        });
      } catch {
        reject(new Error(`Invalid JSON output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}
```

## Auto-Escalation

```javascript
const ESCALATION_ORDER = ["cheerio", "scrapling", "playwright"];

async function tryEscalate(originalRequest) {
  const currentIdx = ESCALATION_ORDER.indexOf(originalRequest.tier);
  for (let i = currentIdx + 1; i < ESCALATION_ORDER.length; i++) {
    const nextTier = ESCALATION_ORDER[i];
    const image = IMAGE_ALLOWLIST[nextTier];
    try {
      const result = await runContainer(image, { ...originalRequest, tier: nextTier });
      if (result.items.length > 0) return result;
    } catch {
      continue;
    }
  }
  return null;  // all tiers failed
}
```

## Security

| Constraint | Implementation |
|-----------|---------------|
| Image allowlist | Hardcoded 3 images. Rejects anything else. |
| Resource limits | `--memory=2g --cpus=2` per container |
| Timeout | Hard kill (SIGTERM → 10s → SIGKILL) |
| Network isolation | Scraping containers on `scrape-egress` network (outbound only, no access to internal services) |
| No volume mounts | Results via stdout. No filesystem access beyond container's own. |
| Concurrency cap | Max 5 containers simultaneously. Queue excess. |
| No docker.sock passthrough | Only gateway has socket. Scraping containers cannot spawn children. |

## Docker Network Setup

```yaml
networks:
  internal:
    # Agent containers, Paperclip, gateway communicate here
  scrape-egress:
    # Scraping containers: outbound internet only
    # No routes to 'internal' network
    driver: bridge
    internal: false  # allows outbound
```

Gateway connects to both networks. Scraping containers only connect to `scrape-egress`.

## docker-compose

```yaml
services:
  scrape-gateway:
    build: ./src/agents/scrape-gateway
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./src/agents/scrape-gateway/entrypoints:/entrypoints:ro
    environment:
      - GATEWAY_PORT=8090
      - APIFY_API_TOKEN=${APIFY_API_TOKEN}
      - ENTRYPOINTS_PATH=/entrypoints
    networks:
      - internal
      - scrape-egress
    deploy:
      resources:
        limits:
          memory: 256M
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8090/health"]
      interval: 30s
      timeout: 5s
```

## Gateway Dockerfile

```dockerfile
FROM node:22-slim

# Install Docker CLI (not daemon — just the client for docker run)
RUN apt-get update && apt-get install -y docker.io curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.mjs /app/

EXPOSE 8090
CMD ["node", "server.mjs"]
```

## Rate Limiting

```javascript
// Per-domain rate limiting
const domainLastRequest = new Map();  // domain → timestamp
const DOMAIN_RATE_MS = 500;           // max 2 req/s per domain
const GLOBAL_RATE_MS = 100;           // max 10 req/s total
let globalLastRequest = 0;

async function waitForRate(url) {
  const domain = new URL(url).hostname;

  // Global rate
  const globalWait = GLOBAL_RATE_MS - (Date.now() - globalLastRequest);
  if (globalWait > 0) await sleep(globalWait);
  globalLastRequest = Date.now();

  // Per-domain rate
  const last = domainLastRequest.get(domain) || 0;
  const domainWait = DOMAIN_RATE_MS - (Date.now() - last);
  if (domainWait > 0) await sleep(domainWait);
  domainLastRequest.set(domain, Date.now());
}
```

## Pre-pull in setup.sh

```bash
echo "Pulling scraping images..."
docker pull apify/actor-node-cheerio:22
docker pull pyd4vinci/scrapling:latest
docker pull apify/actor-node-playwright-chrome:22
```

## Definition of Done

- [ ] Gateway server: accepts POST /scrape, spawns containers
- [ ] Image allowlist enforced (rejects unknown images)
- [ ] Container resource limits (memory, CPU, timeout)
- [ ] Stdout collection and JSON parsing
- [ ] Auto-escalation on failure (tier 1 → 2 → 3)
- [ ] Concurrency cap (max 5, queue excess)
- [ ] Rate limiting per-domain
- [ ] Network isolation (scrape-egress network)
- [ ] Health endpoint
- [ ] docker-compose integration
- [ ] Dockerfile with Docker CLI
- [ ] setup.sh updated with image pre-pull
- [ ] Integration test: spawn Cheerio container, get results
- [ ] Timeout test: slow container killed at deadline

## Risks

- **Docker-in-Docker pattern:** Gateway spawning containers via socket. Well-understood but operational surface. Mitigated by allowlist + resource limits.
- **Stdout buffer overflow:** Large scrape output could exceed Node buffer. Mitigation: stream to temp file if >1MB, or set `maxBuffer` in spawn options.
- **Race condition on queue:** Multiple simultaneous requests hitting concurrency limit. Mitigation: simple array queue with promise-based signaling. Good enough for eval.
