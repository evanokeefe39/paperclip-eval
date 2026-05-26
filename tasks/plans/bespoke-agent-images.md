# Bespoke Agent Images + Scraping Tests

## Intent

Establish the pattern for agents that need custom Docker images beyond the shared base. No gateway — each agent carries the dependencies it needs. First use case: scraping agent with tiers from lightweight (cheerio, in-process) through heavy (Playwright + Chromium, 1GB+ image). Includes subprocess spike (Python from TS extension) and rigorous Pi JSON mode test specs for all four scraping tiers.

## Context Package

### Relevant existing code

- `src/agents/Dockerfile` — shared base image (node:22-slim + Pi CLI + git)
- `src/agents/docker-compose.yml` — YAML anchor `x-agent` defines shared agent config, each service overrides `AGENT_NAME` build arg
- `src/agents/bridge.mjs` — spawns Pi in RPC mode, loads extensions via `-e` flags
- `src/agents/extensions/web-fetch.ts` — existing extension, uses `fetch()` and Jina Reader. Pure TS.
- `src/agents/extensions/web-search.ts` — existing extension, calls Exa API. Pure TS.
- `src/agents/extensions/escalate.ts` — existing extension, calls Paperclip API. Pure TS.
- `src/agents/extensions/web-scrape.ts` — empty placeholder

### Architectural constraints

- Zero npm deps in bridge (by design)
- Extensions are TypeScript, loaded by Pi via `-e` flag
- Pi runs inside container, extensions execute in Pi's Node process
- docker-compose uses YAML anchors for shared config — per-agent overrides via `<<: *agent` merge
- All agent containers share same base image today

### Prior decisions

- HTTP adapter over pi_local (CLI arg length limit)
- Extensions over MCP tools (simpler, in-process)
- Shared artifacts via Docker volume at /artifacts
- No gateway — killed. Agents carry their own deps. No docker-in-docker.

### Anti-patterns to avoid

- Gateway / docker-in-docker / ephemeral container spawning (eliminated)
- Bloating base image with deps only one agent needs
- Assuming all agents can share one image forever

## Part 1: Bespoke Image Pattern

### The problem

Today every agent uses the same Dockerfile. Works when all agents need the same stack (Node + Pi). Breaks when one agent needs Python, another needs Chromium, a third needs ffmpeg. The base image shouldn't carry everyone's dependencies.

### Directory convention

```
src/agents/
  Dockerfile                  # base image — all agents inherit unless overridden
  Dockerfile.base             # FUTURE: named build stage for multi-stage (not yet)
  {agent-name}/
    Dockerfile                # OPTIONAL — bespoke image, overrides base for this agent
    agent.json
    .pi/agent/...
    scripts/                  # OPTIONAL — helper scripts (e.g. Python scraping workers)
```

When `src/agents/{agent-name}/Dockerfile` exists, docker-compose points to it. Otherwise uses shared base.

### docker-compose pattern

```yaml
x-agent: &agent
  build:
    context: .
    dockerfile: Dockerfile    # base default
  restart: unless-stopped
  env_file: .env
  deploy:
    resources:
      limits:
        memory: 512M

services:
  ceo:
    <<: *agent
    build:
      context: .
      dockerfile: Dockerfile        # no override — uses base
      args:
        AGENT_NAME: ceo

  researcher:
    <<: *agent
    build:
      context: .
      dockerfile: researcher/Dockerfile   # bespoke: python + scrapling (lightweight)
      args:
        AGENT_NAME: researcher

  data-agent:
    <<: *agent
    build:
      context: .
      dockerfile: data-agent/Dockerfile   # bespoke: python + scrapling[fetchers] + playwright + chromium (heavy)
      args:
        AGENT_NAME: data-agent
    deploy:
      resources:
        limits:
          memory: 2G                      # heavy image needs more RAM for browser
```

### Image size tiers

| Image type | Example agent | Added deps | Approx. size delta |
|-----------|--------------|-----------|-------------------|
| Base | CEO | none | 0 (baseline ~300MB) |
| Lightweight bespoke | Researcher | python3 + scrapling (Fetcher only) | +80MB |
| Heavy bespoke | Data agent | python3 + scrapling[fetchers] + playwright + chromium | +1.2GB |

The heavy image is the whole point of this pattern — prove it works, document the tradeoffs, establish conventions so future agents can follow.

### Lightweight bespoke Dockerfile (Tier 1-2: Cheerio + Scrapling Fetcher)

```dockerfile
# src/agents/researcher/Dockerfile
# Base agent + Python + Scrapling (HTTP-only, no browser)

FROM node:22-slim

# --- Base agent deps ---
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# --- Bespoke: Python + Scrapling (Fetcher class only, no browser) ---
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages scrapling

# --- Bespoke: Cheerio for in-process HTML parsing ---
RUN npm install -g cheerio

# --- Standard agent setup ---
ARG AGENT_NAME
WORKDIR /app

COPY bridge.mjs .
COPY extensions/ /app/extensions/
COPY ${AGENT_NAME}/.pi/agent/config.yml /root/.pi/agent/config.yml
COPY ${AGENT_NAME}/.pi/agent/models.json /root/.pi/agent/models.json
COPY ${AGENT_NAME}/.pi/agent/settings.json /root/.pi/agent/settings.json
COPY ${AGENT_NAME}/.pi/agent/auth.json /root/.pi/agent/auth.json
COPY ${AGENT_NAME}/AGENTS.md /app/AGENTS.md
# Copy agent-specific scripts if present
COPY ${AGENT_NAME}/scripts/ /app/scripts/

RUN pi extensions install npm:shitty-extensions npm:@ifi/pi-extension-subagents || true
RUN mkdir -p /workspace

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "bridge.mjs"]
```

### Heavy bespoke Dockerfile (Tier 3: Playwright + Chromium)

```dockerfile
# src/agents/data-agent/Dockerfile
# Full scraping agent: Cheerio + Scrapling + Playwright + Chromium
# WARNING: ~1.5GB image. Only for agents that need JS rendering.

FROM node:22-slim

# --- Base agent deps ---
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# --- Python + Scrapling (full install with browser fetchers) ---
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 python3-pip \
      # Playwright system deps (Chromium needs these)
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
      libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
      libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 \
      libcairo2 libasound2 libxshmfence1 \
      # Fonts for rendering
      fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages "scrapling[fetchers]"
# Downloads Camoufox (patched Firefox) + Playwright browsers
RUN scrapling install

# --- Cheerio for lightweight in-process parsing ---
RUN npm install -g cheerio

# --- Node Playwright as alternative to Python Playwright ---
RUN npx playwright install chromium

# --- Standard agent setup ---
ARG AGENT_NAME
WORKDIR /app

COPY bridge.mjs .
COPY extensions/ /app/extensions/
COPY ${AGENT_NAME}/.pi/agent/config.yml /root/.pi/agent/config.yml
COPY ${AGENT_NAME}/.pi/agent/models.json /root/.pi/agent/models.json
COPY ${AGENT_NAME}/.pi/agent/settings.json /root/.pi/agent/settings.json
COPY ${AGENT_NAME}/.pi/agent/auth.json /root/.pi/agent/auth.json
COPY ${AGENT_NAME}/AGENTS.md /app/AGENTS.md
COPY ${AGENT_NAME}/scripts/ /app/scripts/

RUN pi extensions install npm:shitty-extensions npm:@ifi/pi-extension-subagents || true
RUN mkdir -p /workspace

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "bridge.mjs"]
```

### Build time expectations

| Image | Cold build | Cached rebuild (code change only) |
|-------|-----------|----------------------------------|
| Base | ~45s | ~5s |
| Lightweight bespoke | ~90s | ~5s |
| Heavy bespoke | ~5-8 min | ~5s (if only COPY layers change) |

Heavy image build is slow but cached. Day-to-day code changes only hit COPY layers at the bottom, so rebuilds stay fast after first pull.

### Convention rules

1. Bespoke Dockerfile MUST replicate the base agent setup section (COPY bridge.mjs, extensions, config, HEALTHCHECK, CMD). No inheritance from base Dockerfile — each is self-contained.
2. Bespoke Dockerfile SHOULD group deps by purpose with comments.
3. Heavy deps (browsers, ML models) go early in Dockerfile for better layer caching.
4. Agent-specific scripts live in `{agent-name}/scripts/`, copied to `/app/scripts/`.
5. docker-compose memory limit MUST increase for heavy images (2G minimum for browser agents).
6. `.dockerignore` applies to build context (src/agents/), not per-agent. Agent dirs shouldn't contain large non-build files.

### Multi-stage optimization (future, not now)

When 3+ agents share the base layer, extract to a named stage:

```dockerfile
# Dockerfile.base
FROM node:22-slim AS agent-base
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Then bespoke images: `FROM agent-base`. Not needed for eval — two or three agents don't justify the indirection. Documented here so the pattern is known when agent count grows.

## Part 2: Subprocess Spike — Python from Pi Extension

### Question

Can a Pi extension's `execute()` function call `child_process.spawn()` to run a Python script and collect stdout?

### Spike test extension

```typescript
// src/agents/extensions/spike-subprocess.ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "spike_python",
    label: "Spike Python",
    description: "Test: can Pi extension spawn Python subprocess?",
    parameters: Type.Object({
      code: Type.String({ description: "Python code to execute" }),
    }),
    execute(_id, params) {
      const result = execFileSync("python3", ["-c", params.code], {
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: 5 * 1024 * 1024,
      });
      return {
        content: [{ type: "text" as const, text: result }],
      };
    },
  });
}
```

### How to run spike

```bash
# Inside bespoke container (must have python3):
docker exec researcher pi --mode json \
  -e /app/extensions/spike-subprocess.ts \
  -p "Use the spike_python tool to run: print('hello from python')"
```

### Expected JSONL output (success)

```jsonl
{"type":"agent_start", ...}
{"type":"tool_call","name":"spike_python","arguments":{"code":"print('hello from python')"}}
{"type":"tool_result","content":[{"type":"text","text":"hello from python\n"}]}
{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"..."}}
{"type":"agent_end", ...}
```

### Expected JSONL output (failure — python3 not found)

```jsonl
{"type":"tool_call","name":"spike_python","arguments":{"code":"print('hello')"}}
{"type":"tool_error","error":"spawn python3 ENOENT"}
```

### Spike success criteria

- [ ] `execFileSync("python3", ...)` works inside Pi extension execute()
- [ ] stdout captured and returned as tool result
- [ ] stderr surfaced as error (not swallowed)
- [ ] Timeout kills hung Python process
- [ ] Pi doesn't sandbox extensions from child_process (no permission error)

### Spike failure paths

If Pi sandboxes `child_process`:
- Alternative A: Write params to temp file, have bridge.mjs run Python before/after Pi (loses tool-call integration)
- Alternative B: Scrapling HTTP microservice as sidecar container (tiny Flask/FastAPI app, separate service in docker-compose)
- Alternative C: Use Node's Playwright directly (skip Python for tier 3)

Decision deferred until spike result known.

## Part 3: Scraping Extension Architecture

No gateway. Each tool runs inside the agent's own container via in-process code or subprocess.

### Tool → runtime mapping

| Tool | Tier | Runtime | Dependency | Image type |
|------|------|---------|-----------|-----------|
| `scrape_static` | 1 | Node in-process | cheerio (npm) | Lightweight bespoke |
| `scrape_stealth` | 2 | Python subprocess | scrapling Fetcher (pip) | Lightweight bespoke |
| `scrape_browser` | 3 | Python subprocess | scrapling PlayWrightFetcher (pip + browsers) | Heavy bespoke |
| `scrape_apify` | 4 | Node in-process (fetch) | none — HTTP API calls | Any image |
| `list_actors` | 4 | Node in-process (fetch) | none — HTTP API calls | Any image |
| `scrape_status` | 4 | Node in-process (fetch) | none — HTTP API calls | Any image |

### How subprocess tools work

Extension `execute()` calls `execFileSync("python3", ["/app/scripts/scrape_stealth.py", JSON.stringify(params)])`. Python script writes JSON to stdout. Extension parses it, returns as tool result.

```
Pi extension execute()
  │ execFileSync("python3", ["script.py", paramsJson])
  ▼
Python script
  │ parse params from argv
  │ scrapling.Fetcher().get(url) or PlayWrightFetcher().get(url)
  │ extract data
  │ print(json.dumps(result))
  ▼
Extension parses stdout JSON → returns tool_result
```

### Python worker scripts

Live in `{agent-name}/scripts/`, copied to `/app/scripts/` in Docker build.

```
src/agents/researcher/scripts/
  scrape_stealth.py         # Tier 2: Scrapling Fetcher (HTTP-only)

src/agents/data-agent/scripts/
  scrape_stealth.py         # Tier 2: same script
  scrape_browser.py         # Tier 3: Scrapling PlayWrightFetcher (browser)
```

### Shared input/output contract for Python workers

Input: JSON string as first CLI argument.

```json
{
  "url": "https://example.com",
  "selector": ".product",
  "extract_fields": {"name": ".name", "price": ".price"},
  "pagination": {"next_selector": ".next", "max_pages": 3},
  "max_items": 100,
  "wait_for": ".dynamic-content"
}
```

Output: JSON to stdout.

```json
{
  "items": [{"name": "Widget A", "price": "$19.99"}],
  "pages_crawled": 1,
  "duration_ms": 1200,
  "errors": []
}
```

## Part 4: Test Specifications

All tests invoke Pi locally with `--mode json` and assert on JSONL output. Tests run against agent containers (bespoke images) to validate the full path: Pi → extension → tool execution (in-process or subprocess) → result.

### Test infrastructure

```
tests/
  scraping/
    run-tests.sh              # Bash orchestrator (WSL)
    fixtures/
      static-server.mjs       # Node HTTP server serving test HTML pages
      static-page.html        # Simple page with known structure
      paginated/
        page1.html            # Page 1 with next link
        page2.html            # Page 2 (terminal)
      js-rendered.html        # Page where content only appears after JS execution
      blocked-page.html       # Returns 403 to non-stealth User-Agents
      large-page.html         # 500+ items for output size testing
    expected/
      static-extract.json     # Expected output from static page scrape
      paginated-extract.json  # Expected output from paginated scrape
```

### Fixture server

```javascript
// tests/scraping/fixtures/static-server.mjs
import { createServer } from "http";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(__dir, f), "utf-8");

// Generate large page with 500 items
function generateLargePage() {
  const items = Array.from({ length: 500 }, (_, i) =>
    `<div class="row"><span class="id">${i + 1}</span><span class="val">Item ${i + 1}</span></div>`
  ).join("\n");
  return `<html><body>${items}</body></html>`;
}

// JS-rendered page: content injected by inline script
const jsRendered = `<html><body>
  <div id="app">Loading...</div>
  <script>
    setTimeout(() => {
      document.getElementById("app").innerHTML =
        '<div class="dynamic"><h2 class="title">Dynamic Content</h2><p class="body">Rendered by JS</p></div>';
    }, 500);
  </script>
</body></html>`;

const pages = {
  "/":      read("static-page.html"),
  "/page1": read("paginated/page1.html"),
  "/page2": read("paginated/page2.html"),
  "/large": generateLargePage(),
  "/js":    jsRendered,
};

createServer((req, res) => {
  // /blocked: reject non-browser User-Agents
  if (req.url === "/blocked") {
    const ua = req.headers["user-agent"] || "";
    if (!ua.includes("Mozilla") || ua.includes("node-fetch") || ua.includes("undici")) {
      res.writeHead(403);
      return res.end("Forbidden: bot detected");
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end("<html><body><div class='content'>Secret content behind bot protection</div></body></html>");
  }

  const html = pages[req.url];
  if (!html) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
}).listen(9999, () => console.log("Fixture server on :9999"));
```

### Test HTML fixtures

```html
<!-- tests/scraping/fixtures/static-page.html -->
<html><body>
  <div class="product">
    <h2 class="name">Widget A</h2>
    <span class="price">$19.99</span>
    <a class="link" href="/product/a">Details</a>
  </div>
  <div class="product">
    <h2 class="name">Widget B</h2>
    <span class="price">$29.99</span>
    <a class="link" href="/product/b">Details</a>
  </div>
  <div class="product">
    <h2 class="name">Widget C</h2>
    <span class="price">$9.99</span>
    <a class="link" href="/product/c">Details</a>
  </div>
</body></html>
```

```html
<!-- tests/scraping/fixtures/paginated/page1.html -->
<html><body>
  <div class="item"><span class="title">Item 1</span></div>
  <div class="item"><span class="title">Item 2</span></div>
  <a class="next" href="/page2">Next</a>
</body></html>
```

```html
<!-- tests/scraping/fixtures/paginated/page2.html -->
<html><body>
  <div class="item"><span class="title">Item 3</span></div>
  <div class="item"><span class="title">Item 4</span></div>
</body></html>
```

### 4.1 Spike Tests — Subprocess Verification

Run inside bespoke container. Gate: must pass before any scraping tests.

```bash
# TEST S.1: Python3 available in container
docker exec researcher python3 --version
# ASSERT: exit 0, output matches "Python 3.x.x"

# TEST S.2: Scrapling importable
docker exec researcher python3 -c "from scrapling import Fetcher; print('ok')"
# ASSERT: exit 0, output "ok"

# TEST S.3: Pi extension can spawn Python
docker exec researcher pi --mode json \
  -e /app/extensions/spike-subprocess.ts \
  -p "Use spike_python to run: import sys; print(sys.version)"
# ASSERT: JSONL contains tool_call with name "spike_python"
# ASSERT: JSONL contains tool_result with Python version string
# ASSERT: JSONL contains agent_end (completed, not crashed)

# TEST S.4: Subprocess timeout
docker exec researcher pi --mode json \
  -e /app/extensions/spike-subprocess.ts \
  -p "Use spike_python to run: import time; time.sleep(30)"
# ASSERT: JSONL contains tool_error (timeout, not hang)
# ASSERT: Process exits within 15 seconds
```

### 4.2 Heavy Image Spike Tests — Browser Dependencies

Run inside heavy bespoke container. Validates the large image built correctly and browser deps work.

```bash
# TEST H.1: Scrapling full install available
docker exec data-agent python3 -c "from scrapling import PlayWrightFetcher; print('ok')"
# ASSERT: exit 0, output "ok"

# TEST H.2: Chromium binary present
docker exec data-agent python3 -c "
from scrapling import PlayWrightFetcher
f = PlayWrightFetcher()
# Just verify it can instantiate — don't fetch anything
print('playwright ready')
"
# ASSERT: exit 0, output "playwright ready"
# NOTE: May take a few seconds on first run (browser startup)

# TEST H.3: Node Playwright available (alternative to Python)
docker exec data-agent npx playwright --version
# ASSERT: exit 0, version string

# TEST H.4: Container memory under limit
docker stats --no-stream --format '{{.MemUsage}}' data-agent
# ASSERT: idle memory < 500MB (Chromium not running until scrape requested)

# TEST H.5: Image size sanity
docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | grep data-agent
# ASSERT: size between 1GB and 2.5GB (sanity bounds — not 5GB, not 200MB)

# TEST H.6: Build caching — code-only change is fast
# Modify bridge.mjs (touch a comment), rebuild:
time docker compose build data-agent
# ASSERT: rebuild < 30s (only COPY layers rerun, heavy deps cached)
```

### 4.3 Tier 1 Tests — Cheerio (Static HTML, In-Process Node)

```bash
# Prerequisite: fixture server running on host
node tests/scraping/fixtures/static-server.mjs &
FIXTURE_PID=$!

# TEST T1.1: Basic extraction — CSS selector + extract_fields
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_static to scrape http://host.docker.internal:9999/ with selector ".product" and extract fields: name from ".name", price from ".price"'
# ASSERT: JSONL tool_call with name "scrape_static"
# ASSERT: JSONL tool_result contains items array with 3 objects
# ASSERT: items[0].name == "Widget A"
# ASSERT: items[0].price == "$19.99"
# ASSERT: items[2].name == "Widget C"
# ASSERT: metadata.pages_crawled == 1
# ASSERT: metadata.errors == [] (empty)

# TEST T1.2: Pagination — follows next link across pages
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_static on http://host.docker.internal:9999/page1 with selector ".item", extract title from ".title", paginate via ".next" up to 3 pages'
# ASSERT: tool_result items array has 4 items (2 per page, 2 pages)
# ASSERT: items[0].title == "Item 1"
# ASSERT: items[3].title == "Item 4"
# ASSERT: metadata.pages_crawled == 2

# TEST T1.3: max_items cap respected
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_static on http://host.docker.internal:9999/ with selector ".product", max 2 items'
# ASSERT: items array length == 2 (not 3)

# TEST T1.4: No results — bad selector returns empty, not crash
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_static on http://host.docker.internal:9999/ with selector ".nonexistent"'
# ASSERT: items array is empty
# ASSERT: No tool_error — graceful empty result
# ASSERT: agent_end reached

# TEST T1.5: HTTP error surfaced cleanly
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_static on http://host.docker.internal:9999/does-not-exist'
# ASSERT: tool_result contains error (HTTP 404)
# ASSERT: agent_end reached (not crashed)

# TEST T1.6: Timeout on unreachable host
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_static on http://192.0.2.1:9999/ with selector "body"'
# ASSERT: tool_result or tool_error contains timeout message
# ASSERT: Completes within 20 seconds (fetch timeout, not process hang)

kill $FIXTURE_PID
```

### 4.4 Tier 2 Tests — Scrapling Stealth (Python Subprocess, HTTP-Only)

```bash
node tests/scraping/fixtures/static-server.mjs &
FIXTURE_PID=$!

# TEST T2.1: Basic stealth fetch — same data as tier 1
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_stealth on http://host.docker.internal:9999/ with selector ".product", extract name from ".name" and price from ".price"'
# ASSERT: JSONL tool_call with name "scrape_stealth"
# ASSERT: tool_result items has 3 objects
# ASSERT: items match same values as T1.1 (same page, different method)
# ASSERT: metadata.tier == "stealth" or similar

# TEST T2.2: Anti-detection — passes bot check that tier 1 fails
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_stealth on http://host.docker.internal:9999/blocked with selector ".content"'
# ASSERT: tool_result has content ("Secret content behind bot protection")
# ASSERT: No 403 error in result

# TEST T2.2b: Verify tier 1 actually fails on /blocked (control test)
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_static on http://host.docker.internal:9999/blocked with selector ".content"'
# ASSERT: tool_result contains 403 error or empty items
# This proves T2.2 is meaningful — stealth passes where static fails

# TEST T2.3: Stealth pagination
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_stealth on http://host.docker.internal:9999/page1 with selector ".item", extract title from ".title", paginate via ".next" max 3 pages'
# ASSERT: 4 items across 2 pages (same as T1.2)

# TEST T2.4: Python error handling — bad URL
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_stealth on http://host.docker.internal:9999/does-not-exist with selector ".item"'
# ASSERT: tool_result includes error info (not raw Python traceback)
# ASSERT: agent_end reached

# TEST T2.5: Large page — output cap
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_stealth on http://host.docker.internal:9999/large with selector ".row", max 100 items'
# ASSERT: items capped at 100 (page has 500)
# ASSERT: JSON output well-formed (no truncation from subprocess buffer)

# TEST T2.6: Subprocess stdout isolation — no Python logging leaks
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_stealth on http://host.docker.internal:9999/ with selector ".product"' \
  2>/dev/null | jq -r '.type' | sort -u
# ASSERT: Only valid JSONL event types (agent_start, tool_call, tool_result, message_update, agent_end)
# ASSERT: No raw Python print() output mixed into JSONL stream

kill $FIXTURE_PID
```

### 4.5 Tier 3 Tests — Browser Rendering (Python Subprocess, Heavy Image)

These run against the heavy bespoke image (data-agent). Tests the full Playwright/Chromium path.

```bash
node tests/scraping/fixtures/static-server.mjs &
FIXTURE_PID=$!

# TEST T3.1: JS-rendered page — content only appears after script execution
docker exec data-agent pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_browser on http://host.docker.internal:9999/js with selector ".dynamic", extract title from ".title" and body from ".body"'
# ASSERT: JSONL tool_call with name "scrape_browser"
# ASSERT: tool_result items has 1 object
# ASSERT: items[0].title == "Dynamic Content"
# ASSERT: items[0].body == "Rendered by JS"
# KEY TEST: This page returns "Loading..." without JS execution.
#           If items contain "Loading..." instead of "Dynamic Content", browser rendering failed.

# TEST T3.1b: Verify tier 1 fails on JS page (control)
docker exec data-agent pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_static on http://host.docker.internal:9999/js with selector ".dynamic"'
# ASSERT: items is empty (Cheerio can't execute JS, .dynamic div doesn't exist in raw HTML)
# This proves T3.1 is meaningful — browser rendering is required

# TEST T3.2: wait_for selector — explicit wait for dynamic content
docker exec data-agent pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_browser on http://host.docker.internal:9999/js, wait for ".dynamic" to appear, then extract with selector ".dynamic"'
# ASSERT: tool_result has content
# ASSERT: Faster/more reliable than T3.1 (explicit wait vs implicit)

# TEST T3.3: Browser can scrape static pages too (superset of tier 1)
docker exec data-agent pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_browser on http://host.docker.internal:9999/ with selector ".product", extract name from ".name" and price from ".price"'
# ASSERT: Same 3 items as T1.1
# ASSERT: Slower than T1.1 (browser overhead) but correct

# TEST T3.4: Browser passes bot detection (superset of tier 2)
docker exec data-agent pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_browser on http://host.docker.internal:9999/blocked with selector ".content"'
# ASSERT: tool_result has content (real browser UA passes check)

# TEST T3.5: Browser pagination
docker exec data-agent pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_browser on http://host.docker.internal:9999/page1 with selector ".item", extract title from ".title", paginate via ".next" max 3 pages'
# ASSERT: 4 items across 2 pages

# TEST T3.6: Browser memory — doesn't OOM container
docker stats --no-stream --format '{{.MemUsage}}' data-agent
# BEFORE: record baseline
docker exec data-agent pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_browser on http://host.docker.internal:9999/ with selector ".product"'
docker stats --no-stream --format '{{.MemUsage}}' data-agent
# AFTER: record post-scrape
# ASSERT: memory delta < 500MB (browser launched and exited, not leaked)
# ASSERT: container still healthy (healthcheck passes)

# TEST T3.7: Browser timeout — slow page
docker exec data-agent pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_browser on http://192.0.2.1:9999/ with selector "body"'
# ASSERT: tool_result or tool_error contains timeout
# ASSERT: Browser process killed (not orphaned)
# ASSERT: Completes within 30 seconds

# TEST T3.8: Browser cleanup — no orphan processes after scrape
docker exec data-agent pgrep -c chromium || echo "0"
# ASSERT: 0 (no lingering browser processes between scrape calls)

# TEST T3.9: Large page with browser — 500 items
docker exec data-agent pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_browser on http://host.docker.internal:9999/large with selector ".row", max 50 items'
# ASSERT: items capped at 50
# ASSERT: duration_ms reasonable (< 30s — browser shouldn't choke on 500 DOM nodes)

kill $FIXTURE_PID
```

### 4.6 Cross-Tier Tests — Tool Selection and Escalation

```bash
node tests/scraping/fixtures/static-server.mjs &
FIXTURE_PID=$!

# TEST X.1: Agent picks static tier for simple page
docker exec data-agent pi --mode json \
  -e /app/extensions/web-scrape.ts \
  --append-system-prompt "You have three scraping tools. Use scrape_static for simple HTML. Use scrape_stealth for bot-protected sites. Use scrape_browser for JS-rendered pages." \
  -p 'Scrape the product listings from http://host.docker.internal:9999/ — this is a simple static HTML page'
# ASSERT: tool_call name is "scrape_static" (cheapest tier)

# TEST X.2: Agent picks browser tier for JS page
docker exec data-agent pi --mode json \
  -e /app/extensions/web-scrape.ts \
  --append-system-prompt "You have three scraping tools. Use scrape_static for simple HTML. Use scrape_stealth for bot-protected sites. Use scrape_browser for JS-rendered pages." \
  -p 'Scrape http://host.docker.internal:9999/js — this page uses JavaScript to render content dynamically'
# ASSERT: tool_call name is "scrape_browser" (only tier that handles JS)

# TEST X.3: Agent escalates static → stealth on 403
docker exec data-agent pi --mode json \
  -e /app/extensions/web-scrape.ts \
  --append-system-prompt "Try scrape_static first. If you get a 403 or blocked error, retry with scrape_stealth. If content is empty or says Loading, retry with scrape_browser." \
  -p 'Scrape http://host.docker.internal:9999/blocked for the page content'
# ASSERT: first tool_call is "scrape_static"
# ASSERT: scrape_static result contains 403 or "Forbidden"
# ASSERT: second tool_call is "scrape_stealth"
# ASSERT: scrape_stealth result has content

# TEST X.4: Agent escalates static → browser on JS page
docker exec data-agent pi --mode json \
  -e /app/extensions/web-scrape.ts \
  --append-system-prompt "Try scrape_static first. If content is empty or says Loading, retry with scrape_browser." \
  -p 'Scrape http://host.docker.internal:9999/js for the dynamic content'
# ASSERT: first tool_call is "scrape_static"
# ASSERT: scrape_static result is empty or contains "Loading..."
# ASSERT: second tool_call is "scrape_browser"
# ASSERT: scrape_browser result contains "Dynamic Content"

# TEST X.5: All tools registered and visible
docker exec data-agent pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'List all your available scraping tools and describe what each one does'
# ASSERT: output mentions "scrape_static", "scrape_stealth", "scrape_browser"
# ASSERT: descriptions distinguish the tiers

# TEST X.6: Lightweight image only has tiers 1-2
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'List all your available scraping tools'
# ASSERT: output mentions "scrape_static" and "scrape_stealth"
# ASSERT: output does NOT mention "scrape_browser" (not available in lightweight image)
# NOTE: Extension should detect missing browser deps and not register scrape_browser

kill $FIXTURE_PID
```

### 4.7 Apify Tests (Tier 4) — API-Level

HTTP calls from extension to Apify REST API. No special image deps.

```bash
# TEST A.1: Actor discovery (requires APIFY_API_TOKEN)
docker exec -e APIFY_API_TOKEN=$APIFY_API_TOKEN researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use list_actors to search for "web scraper"'
# ASSERT: tool_call with name "list_actors"
# ASSERT: tool_result contains actors array with id, name, title fields
# ASSERT: at least 1 result

# TEST A.2: Actor execution on test URL
docker exec -e APIFY_API_TOKEN=$APIFY_API_TOKEN researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_apify with actor_id "apify/web-scraper" to scrape http://example.com for the h1 text'
# ASSERT: tool_call with name "scrape_apify"
# ASSERT: tool_result has items or run_id (may be async)
# ASSERT: No API auth errors

# TEST A.3: Missing API token — clear error
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use list_actors to search for "scraper"'
# ASSERT: tool_error or tool_result with "APIFY_API_TOKEN not configured" message
# ASSERT: agent_end reached (not crashed)

# TEST A.4: Invalid actor ID — API error surfaced
docker exec -e APIFY_API_TOKEN=$APIFY_API_TOKEN researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_apify with actor_id "fake/nonexistent-actor" on http://example.com'
# ASSERT: tool_result contains Apify API error (404 or similar)
# ASSERT: No crash
```

### 4.8 Image Build Tests

Validates the bespoke image pattern itself works correctly.

```bash
# TEST B.1: Base image builds
docker compose build ceo
# ASSERT: exit 0
# ASSERT: image uses shared Dockerfile (docker inspect confirms)

# TEST B.2: Lightweight bespoke image builds
docker compose build researcher
# ASSERT: exit 0
# ASSERT: image uses researcher/Dockerfile
# ASSERT: python3 available: docker exec researcher python3 --version

# TEST B.3: Heavy bespoke image builds
docker compose build data-agent
# ASSERT: exit 0
# ASSERT: image uses data-agent/Dockerfile
# ASSERT: playwright available: docker exec data-agent python3 -c "from scrapling import PlayWrightFetcher; print('ok')"

# TEST B.4: Base image does NOT have Python
docker exec ceo python3 --version
# ASSERT: exit non-zero (python3 not found — base stays lean)

# TEST B.5: Lightweight image does NOT have Playwright browsers
docker exec researcher python3 -c "from scrapling import PlayWrightFetcher; print('ok')"
# ASSERT: exit non-zero (PlayWrightFetcher not installed — only Fetcher)

# TEST B.6: All images share same bridge behavior
for agent in ceo researcher data-agent; do
  curl -s http://localhost:$(docker port $agent 8080 | cut -d: -f2)/health | jq .status
done
# ASSERT: all return "ok" — bespoke deps don't break base functionality

# TEST B.7: docker-compose up starts all services
docker compose up -d
docker compose ps --format '{{.Service}} {{.State}}'
# ASSERT: all services "running"
# ASSERT: healthchecks pass within 60s
```

### Test runner script

```bash
#!/usr/bin/env bash
# tests/scraping/run-tests.sh
# Usage: ./run-tests.sh [spike|heavy|tier1|tier2|tier3|cross|apify|build|all]
#
# Runs scraping test suite against running containers.
# Prerequisites:
#   - docker compose up -d (all services running)
#   - Fixture server started by this script

set -euo pipefail

SUITE="${1:-all}"
PASS=0
FAIL=0
SKIP=0
FIXTURE_PID=""
RESULTS_DIR="tests/results/scraping-$(date +%Y%m%d-%H%M%S)"

mkdir -p "$RESULTS_DIR"

start_fixture() {
  echo "Starting fixture server on :9999..."
  node tests/scraping/fixtures/static-server.mjs &
  FIXTURE_PID=$!
  sleep 1
  if ! kill -0 "$FIXTURE_PID" 2>/dev/null; then
    echo "FATAL: fixture server failed to start"
    exit 1
  fi
}

stop_fixture() {
  [ -n "$FIXTURE_PID" ] && kill "$FIXTURE_PID" 2>/dev/null || true
  FIXTURE_PID=""
}

# Run a Pi JSON mode test inside a container.
# Usage: run_pi_test <container> <test_name> <extension> <prompt> [extra_pi_args...]
# Captures JSONL output to results dir.
run_pi_test() {
  local container="$1" test_name="$2" extension="$3" prompt="$4"
  shift 4
  local outfile="$RESULTS_DIR/${test_name}.jsonl"

  echo -n "  [$test_name] "
  if docker exec "$container" pi --mode json -e "$extension" "$@" -p "$prompt" > "$outfile" 2>&1; then
    echo "$outfile"
    return 0
  else
    echo "EXEC FAILED (exit $?)" | tee -a "$outfile"
    return 1
  fi
}

# Assert JSONL output contains event with field value
assert_jsonl() {
  local file="$1" description="$2" pattern="$3"
  if grep -q "$pattern" "$file"; then
    PASS=$((PASS + 1))
    echo "    [PASS] $description"
  else
    FAIL=$((FAIL + 1))
    echo "    [FAIL] $description"
    echo "           Pattern not found: $pattern"
    echo "           First 5 lines: $(head -5 "$file")"
  fi
}

assert_not_jsonl() {
  local file="$1" description="$2" pattern="$3"
  if ! grep -q "$pattern" "$file"; then
    PASS=$((PASS + 1))
    echo "    [PASS] $description"
  else
    FAIL=$((FAIL + 1))
    echo "    [FAIL] $description (pattern should NOT match)"
  fi
}

trap stop_fixture EXIT

run_spike() {
  echo "[SPIKE] Subprocess verification"
  # S.1 - S.4 tests here
}

run_heavy() {
  echo "[HEAVY] Heavy image spike"
  # H.1 - H.6 tests here
}

run_tier1() {
  echo "[TIER 1] Cheerio — static HTML"
  start_fixture
  # T1.1 - T1.6 tests here
  stop_fixture
}

run_tier2() {
  echo "[TIER 2] Scrapling — stealth"
  start_fixture
  # T2.1 - T2.6 tests here
  stop_fixture
}

run_tier3() {
  echo "[TIER 3] Playwright — browser rendering"
  start_fixture
  # T3.1 - T3.9 tests here
  stop_fixture
}

run_cross() {
  echo "[CROSS] Tool selection + escalation"
  start_fixture
  # X.1 - X.6 tests here
  stop_fixture
}

run_apify() {
  echo "[APIFY] Tier 4 — API"
  # A.1 - A.4 tests here
}

run_build() {
  echo "[BUILD] Image build verification"
  # B.1 - B.7 tests here
}

case "$SUITE" in
  spike)    run_spike ;;
  heavy)    run_heavy ;;
  tier1)    run_tier1 ;;
  tier2)    run_tier2 ;;
  tier3)    run_tier3 ;;
  cross)    run_cross ;;
  apify)    run_apify ;;
  build)    run_build ;;
  all)
    run_build
    run_spike
    run_heavy
    run_tier1
    run_tier2
    run_tier3
    run_cross
    run_apify
    ;;
  *)
    echo "Usage: $0 [spike|heavy|tier1|tier2|tier3|cross|apify|build|all]"
    exit 1
    ;;
esac

echo ""
echo "================================"
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"
echo "Output:  $RESULTS_DIR/"
echo "================================"
exit $FAIL
```

## Behavioral Contracts

GIVEN a bespoke Dockerfile exists at `src/agents/{name}/Dockerfile`
WHEN `docker compose build {name}` runs
THEN the bespoke image is built (not the base)

GIVEN no Dockerfile exists in agent directory
WHEN `docker compose build {name}` runs
THEN the base Dockerfile is used

GIVEN the lightweight bespoke image
WHEN `python3 -c "from scrapling import Fetcher"` runs inside container
THEN it succeeds (Fetcher available)
AND `python3 -c "from scrapling import PlayWrightFetcher"` fails (not installed)

GIVEN the heavy bespoke image
WHEN `python3 -c "from scrapling import PlayWrightFetcher"` runs inside container
THEN it succeeds (full scrapling with browsers available)

GIVEN the base image
WHEN `python3 --version` runs inside container
THEN it fails (Python not installed — base stays lean)

GIVEN the fixture server serves JS-rendered content at /js
WHEN `scrape_static` is used on /js
THEN items are empty (Cheerio can't execute JS)
AND when `scrape_browser` is used on /js
THEN items contain "Dynamic Content" (browser executed JS)

GIVEN the fixture server returns 403 to non-stealth UAs on /blocked
WHEN `scrape_static` is used on /blocked
THEN result contains 403 error
AND when `scrape_stealth` is used on /blocked
THEN result contains page content (stealth UA passes)

GIVEN the extension detects missing browser dependencies at registration time
WHEN loaded in lightweight image (no Playwright)
THEN `scrape_browser` tool is NOT registered
AND `scrape_static` and `scrape_stealth` ARE registered

GIVEN APIFY_API_TOKEN is not set
WHEN Pi invokes any Apify tool
THEN tool returns clear error message (not crash)

GIVEN a browser scrape completes
WHEN checking for orphan processes
THEN no chromium/firefox processes remain running

## Edge Case Inventory

- Python not in base image → scrape_stealth/scrape_browser register but fail with "python3 not found" diagnostic
- Scrapling not installed → import error caught, returned as tool error
- PlayWrightFetcher not installed (lightweight image) → scrape_browser not registered at all
- Subprocess hangs → execFileSync timeout kills it within 10s
- Fixture server not running → fetch timeout, tool returns error (not hang)
- Container lacks host network access → host.docker.internal resolution fails, clear error
- Concurrent subprocess calls → no shared state, each gets own process
- Python script outputs non-JSON → extension catches parse error, wraps in error message
- Very large stdout (>5MB) → maxBuffer in execFileSync prevents hang, returns truncation error
- Browser process orphaned after timeout → extension must ensure cleanup (try/finally in Python script)
- Heavy image OOM during browser scrape → container restart policy (unless-stopped) recovers
- Multiple browser scrapes in sequence → memory should return to baseline between calls
- JS page with infinite loading spinner → wait_for timeout prevents hang, returns partial or error

## Definition of Done

- [ ] Bespoke Dockerfile pattern documented
- [ ] Lightweight bespoke Dockerfile (researcher) — python3 + scrapling + cheerio
- [ ] Heavy bespoke Dockerfile (data-agent) — python3 + scrapling[fetchers] + playwright + chromium
- [ ] docker-compose.yml updated: per-agent dockerfile paths, memory limits for heavy image
- [ ] Spike extension (spike-subprocess.ts) written and tested
- [ ] Spike confirms subprocess works from Pi extension (or documents failure + alternative)
- [ ] Python worker scripts: scrape_stealth.py, scrape_browser.py
- [ ] web-scrape.ts extension: registers scrape_static, scrape_stealth, scrape_browser (conditional), Apify tools
- [ ] Fixture server with static/paginated/blocked/js-rendered/large pages
- [ ] Test runner script (run-tests.sh) with per-suite invocation
- [ ] Spike tests (S.1-S.4) pass
- [ ] Heavy image tests (H.1-H.6) pass
- [ ] Tier 1 tests (T1.1-T1.6) pass
- [ ] Tier 2 tests (T2.1-T2.6) pass
- [ ] Tier 3 tests (T3.1-T3.9) pass
- [ ] Cross-tier tests (X.1-X.6) pass
- [ ] Apify tests (A.1-A.4) pass
- [ ] Image build tests (B.1-B.7) pass
- [ ] CLAUDE.md updated with bespoke image pattern
- [ ] All tests invokable with single command
- [ ] tasks/todo.md updated

## Open Questions

None. Decisions made:
- No gateway. Agents carry own deps. Docker-in-docker eliminated.
- Subprocess approach: execFileSync from extension (spike to confirm)
- Fallback if subprocess blocked: sidecar microservice
- Tier 3 included — heavy image validates the pattern for large deps
- Extension conditionally registers tools based on available deps
- Multi-stage build: deferred until agent count > 3
- Test runner: bash script (WSL), matches existing scripts/ convention
