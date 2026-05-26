# Bespoke Agent Images + Scraping Test Spike

## Intent

Establish the pattern for agents that need custom Docker images beyond the shared base. First use case: a data/researcher agent that needs Python + Scrapling for anti-detection scraping. Includes a spike to verify Pi extensions can spawn subprocesses (Python from TypeScript), and rigorous test specs for all scraping tiers invokable via Pi JSON mode locally.

## Context Package

### Relevant existing code

- `src/agents/Dockerfile` — shared base image (node:22-slim + Pi CLI + git)
- `src/agents/docker-compose.yml` — YAML anchor `x-agent` defines shared agent config, each service overrides `AGENT_NAME` build arg
- `src/agents/bridge.mjs` — spawns Pi in RPC mode, loads extensions via `-e` flags
- `src/agents/extensions/web-fetch.ts` — existing extension, uses `fetch()` and Jina Reader. Pure TS, no subprocess.
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

### Anti-patterns to avoid

- Bloating base image with deps only one agent needs
- Gateway/docker-in-docker for things that can run in-process
- Installing full browser stack when HTTP-only scraping suffices

## Part 1: Bespoke Image Pattern

### Directory convention

```
src/agents/
  Dockerfile                  # base image — all agents inherit unless overridden
  {agent-name}/
    Dockerfile                # OPTIONAL — bespoke image for this agent
    agent.json
    .pi/agent/...
    extensions/               # OPTIONAL — agent-specific extensions (not shared)
```

When `src/agents/{agent-name}/Dockerfile` exists, docker-compose uses it. Otherwise falls back to base.

### docker-compose pattern

```yaml
x-agent: &agent
  build:
    context: .
    dockerfile: Dockerfile    # base default
  # ... shared config ...

services:
  ceo:
    <<: *agent
    build:
      context: .
      dockerfile: Dockerfile  # uses base — no bespoke image needed
      args:
        AGENT_NAME: ceo

  researcher:
    <<: *agent
    build:
      context: .
      dockerfile: researcher/Dockerfile  # bespoke — has python + scrapling
      args:
        AGENT_NAME: researcher
```

### Bespoke Dockerfile template

```dockerfile
# src/agents/researcher/Dockerfile
# Extends base agent with Python + Scrapling for anti-detection scraping

FROM node:22-slim AS base

# --- Base agent setup (same as shared Dockerfile) ---
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# --- Bespoke: Python + Scrapling ---
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*
RUN pip3 install --break-system-packages scrapling

# --- Agent setup (same pattern as base) ---
ARG AGENT_NAME
WORKDIR /app

COPY bridge.mjs .
COPY extensions/ /app/extensions/
COPY ${AGENT_NAME}/.pi/agent/config.yml /root/.pi/agent/config.yml
COPY ${AGENT_NAME}/.pi/agent/models.json /root/.pi/agent/models.json
COPY ${AGENT_NAME}/.pi/agent/settings.json /root/.pi/agent/settings.json
COPY ${AGENT_NAME}/.pi/agent/auth.json /root/.pi/agent/auth.json
COPY ${AGENT_NAME}/AGENTS.md /app/AGENTS.md

RUN pi extensions install npm:shitty-extensions npm:@ifi/pi-extension-subagents || true
RUN mkdir -p /workspace

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "bridge.mjs"]
```

### Multi-stage optimization (future)

When multiple agents share the base, use a named stage:

```dockerfile
FROM node:22-slim AS agent-base
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Then bespoke images: `FROM agent-base AS researcher`. Not needed for eval — two agents don't justify the complexity. Document for when agent count grows.

### setup.sh changes

setup.sh currently does `docker compose build`. No changes needed — docker-compose already resolves per-service `dockerfile` paths. Just needs to be aware that build times vary by agent.

## Part 2: Subprocess Spike — Python from Pi Extension

### Question

Can a Pi extension's `execute()` function call `child_process.spawn()` to run a Python script and collect stdout?

### Spike test

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
# Inside researcher container (bespoke image with python3):
pi --mode json \
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
- Alternative B: Scrapling HTTP microservice as sidecar container (like current gateway plan but simpler — single `flask`/`fastapi` endpoint)
- Alternative C: Use scrapling's Fetcher via its HTTP mode if available

Decision deferred until spike result known.

## Part 3: Scraping Extension Architecture (Post-Spike)

Assuming subprocess works, the scraping extension registers three tools that run in-process or via subprocess:

| Tool | Runtime | Dependency |
|------|---------|-----------|
| `scrape_static` | Node (in-process) | cheerio (npm, install in Dockerfile) |
| `scrape_stealth` | Python subprocess | scrapling Fetcher (pip, bespoke image) |
| `scrape_browser` | Python subprocess | scrapling PlayWrightFetcher OR Crawlee (heavy image) |

Tier 3 (browser) has two options:
- A: `scrapling[fetchers]` with `scrapling install` (downloads Camoufox/Playwright — huge image, 1GB+)
- B: Separate Playwright container via gateway (keeps agent image small)

For eval: start with tiers 1-2 only. Tier 3 deferred — most scraping tasks don't need JS rendering.

## Part 4: Test Specifications

All tests invoke Pi locally with `--mode json` and assert on JSONL output. Tests run against the agent container (bespoke image) to validate the full path: Pi → extension → tool execution → result.

### Test infrastructure

```
tests/
  scraping/
    run-tests.sh              # Bash orchestrator (WSL)
    fixtures/
      static-server.mjs       # Node HTTP server serving test HTML pages
      static-page.html        # Simple page with known structure
      paginated/              # Multi-page fixture (page1.html, page2.html)
      js-rendered.html        # Page where content requires JS (for tier 3 future)
      blocked-page.html       # Returns 403 to non-stealth requests
    expected/
      static-extract.json     # Expected output from static page scrape
      paginated-extract.json  # Expected output from paginated scrape
```

### Fixture server

```javascript
// tests/scraping/fixtures/static-server.mjs
import { createServer } from "http";
import { readFileSync } from "fs";

const pages = {
  "/": readFileSync("static-page.html", "utf-8"),
  "/page1": readFileSync("paginated/page1.html", "utf-8"),
  "/page2": readFileSync("paginated/page2.html", "utf-8"),
  "/blocked": null,  // returns 403
};

createServer((req, res) => {
  if (req.url === "/blocked") {
    const ua = req.headers["user-agent"] || "";
    // Block requests without realistic browser fingerprint
    if (!ua.includes("Mozilla")) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
  }
  const html = pages[req.url];
  if (!html) { res.writeHead(404); return res.end(); }
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

Run inside bespoke container. These must pass before any scraping tests.

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

### 4.2 Tier 1 Tests — Cheerio (Static HTML, In-Process)

```bash
# Start fixture server on host (accessible from container via host.docker.internal)
node tests/scraping/fixtures/static-server.mjs &
FIXTURE_PID=$!

# TEST T1.1: Basic extraction — CSS selector, extract_fields
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

# TEST T1.2: Pagination — follows next link
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_static on http://host.docker.internal:9999/page1 with selector ".item", extract title from ".title", paginate via ".next" up to 3 pages'
# ASSERT: tool_result items array has 4 items (2 per page, 2 pages)
# ASSERT: items[0].title == "Item 1"
# ASSERT: items[3].title == "Item 4"
# ASSERT: metadata.pages_crawled == 2

# TEST T1.3: max_items cap
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_static on http://host.docker.internal:9999/ with selector ".product", max 2 items'
# ASSERT: items array length == 2 (not 3)

# TEST T1.4: No results — bad selector
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_static on http://host.docker.internal:9999/ with selector ".nonexistent"'
# ASSERT: items array is empty
# ASSERT: No crash, no tool_error — graceful empty result

# TEST T1.5: Invalid URL
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_static on http://host.docker.internal:9999/does-not-exist'
# ASSERT: tool_result contains error (HTTP 404)
# ASSERT: agent_end reached (not crashed)

# TEST T1.6: Timeout — unreachable host
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_static on http://192.0.2.1:9999/ with selector "body"'
# ASSERT: tool_result or tool_error contains timeout message
# ASSERT: Completes within 20 seconds (fetch timeout, not hung)

kill $FIXTURE_PID
```

### 4.3 Tier 2 Tests — Scrapling Stealth (Python Subprocess)

```bash
node tests/scraping/fixtures/static-server.mjs &
FIXTURE_PID=$!

# TEST T2.1: Basic stealth fetch
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_stealth on http://host.docker.internal:9999/ with selector ".product", extract name from ".name" and price from ".price"'
# ASSERT: JSONL tool_call with name "scrape_stealth"
# ASSERT: tool_result items has 3 objects
# ASSERT: items match same values as T1.1 (same page, different method)

# TEST T2.2: Anti-detection — blocked page
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_stealth on http://host.docker.internal:9999/blocked with selector "body"'
# ASSERT: tool_result has content (Scrapling's realistic UA passes the check)
# ASSERT: No 403 error in result
# Compare: scrape_static on /blocked should fail (basic UA gets 403)

# TEST T2.3: Stealth pagination
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_stealth on http://host.docker.internal:9999/page1 with selector ".item", extract title from ".title", paginate via ".next" max 3 pages'
# ASSERT: 4 items across 2 pages (same as T1.2)

# TEST T2.4: Python error handling
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_stealth on http://host.docker.internal:9999/does-not-exist with selector ".item"'
# ASSERT: tool_result includes error info, not a Python traceback crash
# ASSERT: agent_end reached

# TEST T2.5: Large page — output size
# (Use fixture server with a page returning 500+ items)
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape_stealth on http://host.docker.internal:9999/large with selector ".row", max 100 items'
# ASSERT: items capped at 100
# ASSERT: JSON output well-formed (no truncation)

kill $FIXTURE_PID
```

### 4.4 Cross-Tier Tests — Tool Selection and Escalation

```bash
node tests/scraping/fixtures/static-server.mjs &
FIXTURE_PID=$!

# TEST X.1: Agent picks correct tier given guidance
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  --append-system-prompt "For static HTML pages use scrape_static. For pages that block bots use scrape_stealth." \
  -p 'Scrape the product listings from http://host.docker.internal:9999/ — this is a simple static page'
# ASSERT: tool_call name is "scrape_static" (not scrape_stealth)

# TEST X.2: Agent escalates to stealth when static fails
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  --append-system-prompt "Try scrape_static first. If you get a 403 or empty result, retry with scrape_stealth." \
  -p 'Scrape http://host.docker.internal:9999/blocked for body content'
# ASSERT: first tool_call is "scrape_static"
# ASSERT: scrape_static result contains 403 or empty
# ASSERT: second tool_call is "scrape_stealth"
# ASSERT: scrape_stealth result has content

# TEST X.3: Both tools registered and visible
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'List all available tools you have'
# ASSERT: output mentions "scrape_static" and "scrape_stealth"
# ASSERT: descriptions match what was registered

kill $FIXTURE_PID
```

### 4.5 Apify Tests (Tier 4) — API-Level

These don't need container-level testing. They're HTTP calls from the extension to Apify's REST API. Test via Pi JSON mode with real or mocked API.

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
  -p 'Use scrape with tier "apify", actor_id "apify/web-scraper", and scrape http://example.com for the h1 text'
# ASSERT: tool_call with name "scrape"
# ASSERT: tool_result has items or run_id (may be async)
# ASSERT: No API auth errors

# TEST A.3: Missing API token
docker exec researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use list_actors to search for "scraper"'
# ASSERT: tool_error or tool_result with clear "APIFY_API_TOKEN not configured" message
# ASSERT: agent_end reached (not crashed)

# TEST A.4: Invalid actor ID
docker exec -e APIFY_API_TOKEN=$APIFY_API_TOKEN researcher pi --mode json \
  -e /app/extensions/web-scrape.ts \
  -p 'Use scrape with tier "apify", actor_id "fake/nonexistent-actor", on http://example.com'
# ASSERT: tool_result contains Apify API error (404 or similar)
# ASSERT: No crash
```

### 4.6 Gateway Tests (HTTP Contract)

Only needed if gateway is built (tier 3 browser scraping). Hurl-based, matching existing test patterns.

```hurl
# tests/hurl/scrape-gateway.hurl

# TEST G.1: Health endpoint
GET http://localhost:8090/health
HTTP 200
[Asserts]
jsonpath "$.status" == "ok"
jsonpath "$.active_containers" >= 0

# TEST G.2: Unknown tier rejected
POST http://localhost:8090/scrape
Content-Type: application/json
{"tier": "fake_tier", "params": {"url": "http://example.com"}}
HTTP 400
[Asserts]
jsonpath "$.error" contains "Unknown tier"

# TEST G.3: Cheerio tier — basic extraction
POST http://localhost:8090/scrape
Content-Type: application/json
{
  "tier": "cheerio",
  "params": {
    "url": "http://host.docker.internal:9999/",
    "selector": ".product",
    "extract_fields": {"name": ".name", "price": ".price"}
  }
}
HTTP 200
[Asserts]
jsonpath "$.items" count == 3
jsonpath "$.items[0].name" == "Widget A"
jsonpath "$.metadata.tier_used" == "cheerio"
jsonpath "$.metadata.pages_crawled" == 1
duration < 30000

# TEST G.4: Auto-escalation (cheerio fails → scrapling)
POST http://localhost:8090/scrape
Content-Type: application/json
{
  "tier": "cheerio",
  "params": {"url": "http://host.docker.internal:9999/blocked", "selector": "body"},
  "auto_escalate": true
}
HTTP 200
[Asserts]
jsonpath "$.metadata.tier_used" != "cheerio"
jsonpath "$.items" count > 0

# TEST G.5: Concurrency cap (fire 6 requests, 6th should queue)
# Run via orchestrator script — not expressible in Hurl

# TEST G.6: Timeout — container killed at deadline
POST http://localhost:8090/scrape
Content-Type: application/json
{
  "tier": "cheerio",
  "params": {"url": "http://192.0.2.1:9999/"},
  "timeout": 5
}
HTTP 500
[Asserts]
jsonpath "$.error" contains "Timeout"
duration < 15000

# TEST G.7: Rate limiting — same domain rapid fire
# Run via orchestrator — need 3 rapid requests to same domain, verify spacing
```

### 4.7 Entrypoint Script Tests (Standalone Container)

Test each tier's entrypoint independently via `docker run`, no Pi involved. Validates the script contract in isolation.

```bash
# Start fixture server
node tests/scraping/fixtures/static-server.mjs &
FIXTURE_PID=$!

# TEST E.1: Cheerio entrypoint — extraction
docker run --rm --network host \
  -v $(pwd)/src/agents/scrape-gateway/entrypoints/cheerio.mjs:/app/e.mjs:ro \
  node:22-slim node /app/e.mjs \
  '{"url":"http://localhost:9999/","selector":".product","extract_fields":{"name":".name","price":".price"}}'
# ASSERT: valid JSON on stdout
# ASSERT: .items has 3 objects
# ASSERT: .items[0].name == "Widget A"
# ASSERT: .pages_crawled == 1
# ASSERT: .errors == []

# TEST E.2: Cheerio entrypoint — pagination
docker run --rm --network host \
  -v $(pwd)/src/agents/scrape-gateway/entrypoints/cheerio.mjs:/app/e.mjs:ro \
  node:22-slim node /app/e.mjs \
  '{"url":"http://localhost:9999/page1","selector":".item","extract_fields":{"title":".title"},"pagination":{"next_selector":".next","max_pages":3}}'
# ASSERT: .items has 4 objects
# ASSERT: .pages_crawled == 2

# TEST E.3: Scrapling entrypoint — stealth extraction
docker run --rm --network host \
  -v $(pwd)/src/agents/scrape-gateway/entrypoints/scrapling.py:/app/e.py:ro \
  pyd4vinci/scrapling:latest python /app/e.py \
  '{"url":"http://localhost:9999/","selector":".product","extract_fields":{"name":".name","price":".price"}}'
# ASSERT: valid JSON on stdout
# ASSERT: .items has 3 objects

# TEST E.4: Scrapling entrypoint — anti-detection
docker run --rm --network host \
  -v $(pwd)/src/agents/scrape-gateway/entrypoints/scrapling.py:/app/e.py:ro \
  pyd4vinci/scrapling:latest python /app/e.py \
  '{"url":"http://localhost:9999/blocked","selector":"body"}'
# ASSERT: .items is non-empty (stealth UA passes)
# ASSERT: .errors is empty

# TEST E.5: Output contract — all entrypoints produce same schema
# For each entrypoint output, validate:
#   - JSON parseable
#   - Has "items" (array)
#   - Has "pages_crawled" (number)
#   - Has "duration_ms" (number)
#   - Has "errors" (array)

# TEST E.6: Bad URL — entrypoint doesn't crash
docker run --rm --network host \
  -v $(pwd)/src/agents/scrape-gateway/entrypoints/cheerio.mjs:/app/e.mjs:ro \
  node:22-slim node /app/e.mjs \
  '{"url":"http://localhost:9999/nonexistent","selector":"body"}'
# ASSERT: valid JSON (not crash/stack trace)
# ASSERT: .errors is non-empty

kill $FIXTURE_PID
```

### Test runner script

```bash
#!/usr/bin/env bash
# tests/scraping/run-tests.sh
# Usage: ./run-tests.sh [spike|tier1|tier2|cross|apify|gateway|entrypoint|all]

set -euo pipefail

TIER="${1:-all}"
PASS=0
FAIL=0
FIXTURE_PID=""

start_fixture() {
  node tests/scraping/fixtures/static-server.mjs &
  FIXTURE_PID=$!
  sleep 1
}

stop_fixture() {
  [ -n "$FIXTURE_PID" ] && kill "$FIXTURE_PID" 2>/dev/null || true
}

assert_jsonl_contains() {
  local output="$1" event_type="$2" field="$3" expected="$4"
  if echo "$output" | grep -q "\"type\":\"$event_type\"" && echo "$output" | grep -q "\"$field\":\"$expected\""; then
    PASS=$((PASS + 1))
    echo "  [PASS] $5"
  else
    FAIL=$((FAIL + 1))
    echo "  [FAIL] $5"
    echo "    Expected $event_type with $field=$expected"
    echo "    Got: $(echo "$output" | head -5)"
  fi
}

trap stop_fixture EXIT

# ... test functions per tier ...

echo ""
echo "Results: $PASS passed, $FAIL failed"
exit $FAIL
```

## Behavioral Contracts

GIVEN a bespoke Dockerfile exists at `src/agents/{name}/Dockerfile`
WHEN `docker compose build {name}` runs
THEN the bespoke image is built (not the base)

GIVEN no Dockerfile exists in agent directory
WHEN `docker compose build {name}` runs
THEN the base Dockerfile is used

GIVEN the bespoke image includes python3 + scrapling
WHEN a Pi extension calls `execFileSync("python3", ["-c", "from scrapling import Fetcher; print('ok')"])`
THEN stdout returns "ok" and exit code is 0

GIVEN the fixture server is running on host port 9999
WHEN Pi invokes `scrape_static` on `http://host.docker.internal:9999/` with selector `.product`
THEN tool_result contains 3 items with correct name/price fields

GIVEN the fixture server returns 403 for non-stealth User-Agents on /blocked
WHEN Pi invokes `scrape_stealth` on that URL
THEN tool_result contains page content (Scrapling's stealth UA passes)

GIVEN APIFY_API_TOKEN is not set
WHEN Pi invokes any Apify tool
THEN tool returns clear error message (not crash)

## Edge Case Inventory

- Python not installed in base image → scrape_stealth fails with clear "python3 not found" error
- Scrapling not installed → import error caught, returned as tool error
- Subprocess hangs → timeout kills it within 10s, tool returns timeout error
- Fixture server not running → fetch timeout, tool returns error (not hang)
- Container lacks network access to host → host.docker.internal resolution fails, clear error
- Extension loaded but wrong container (base image, no python) → tool registers but fails on call with diagnostic message
- Concurrent subprocess calls from same extension → no shared state, each gets own process
- Python script outputs non-JSON → extension catches parse error, wraps in error message
- Very large Python stdout (>1MB) → maxBuffer in execFileSync prevents hang, returns truncation error

## Definition of Done

- [ ] Bespoke Dockerfile pattern documented in this plan
- [ ] docker-compose.yml updated to reference per-agent Dockerfile when present
- [ ] Spike extension (spike-subprocess.ts) written and tested
- [ ] Spike confirms subprocess works from Pi extension (or documents failure + alternative)
- [ ] Fixture server with static/paginated/blocked pages
- [ ] Test runner script (run-tests.sh)
- [ ] Spike tests (S.1-S.4) pass
- [ ] Tier 1 tests (T1.1-T1.6) pass
- [ ] Tier 2 tests (T2.1-T2.5) pass
- [ ] Cross-tier tests (X.1-X.3) pass
- [ ] Apify tests (A.1-A.4) pass
- [ ] Gateway tests (G.1-G.7) pass (if gateway built)
- [ ] Entrypoint tests (E.1-E.6) pass (if entrypoints built)
- [ ] CLAUDE.md updated with bespoke image pattern
- [ ] All tests invokable with single command
- [ ] tasks/todo.md updated

## Open Questions

None. Decisions made:
- Subprocess approach: `execFileSync` from extension (spike to confirm)
- Fallback if subprocess blocked: sidecar microservice
- Tier 3 (browser): deferred, not needed for eval
- Multi-stage build: deferred until agent count > 2
- Test runner: bash script (WSL), not PowerShell (consistency with existing scripts/)
