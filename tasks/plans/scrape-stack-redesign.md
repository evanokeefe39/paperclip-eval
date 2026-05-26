# Scrape Stack Redesign: Decouple Fetch from Parse + Data-Driven Runner

Status: Draft
Created: 2026-05-26
Fixes: systemic-fetch-parse-coupling, systemic-procedural-runner, t2-selector-compat, cheerio-global-resolve, yelp-selectors-stale, ebay-t3-not-tested, t4-apify-untested

## Intent

Fix the two systemic design issues discovered in the real-world scraping campaign. After this work, all scraping tiers use the same parser (eliminating selector portability bugs), and the test runner is data-driven (eliminating coverage gaps and making selector updates trivial).

## Context

### Current architecture (broken)

```
Agent calls scrape_static  → Node fetch() + cheerio parse   → items
Agent calls scrape_stealth → Python scrapling Fetcher + lxml → items
Agent calls scrape_browser → Python scrapling DynamicFetcher + lxml → items
Agent calls scrape_apify   → Apify cloud API → items
```

Three parsers. Same selectors produce different results. Extraction logic duplicated in 2 languages across 4 files.

### Target architecture

```
Agent calls scrape_web(url, selector, ..., tier_hint?)
  → Fetch layer picks tier based on hint or auto-escalation
    → T1: Node fetch()           → raw HTML
    → T2: Python scrapling Fetch → raw HTML
    → T3: Python scrapling DynamicFetcher → raw HTML
    → T4: Apify actor            → structured data (bypass parse)
  → Detect layer: inspect HTML for challenge page signatures
    → If challenge detected: escalate to next tier or report block
  → Parse layer: cheerio extracts items from raw HTML
    → Same parser for all local tiers
  → Return items + diagnostics
```

One parser. Fetch is a pure HTML-fetching concern. Detection layer sits between fetch and parse.

## Constraints

- Pi extension API: tools are registered at startup, cannot change at runtime. The unified tool approach requires one tool with a tier_hint parameter, or keep separate tool names but share the parse layer internally.
- Python scripts run via execFileSync from Node — can return stdout. Changing their output from JSON items to raw HTML is a protocol change.
- Apify returns structured data, not HTML. T4 bypasses the parse layer.
- The test runner must work without the Pi extension (calls scripts directly in containers).

## Decisions reserved for review

- **Unified tool vs separate tools**: one `scrape_web` tool with tier_hint, or keep `scrape_static`/`scrape_stealth`/`scrape_browser` but share parsing internally? Unified is cleaner but changes the agent-facing interface.
- **Auto-escalation in extension vs agent-driven**: should the extension auto-escalate through tiers, or should the agent decide when to try a higher tier? Auto-escalation is simpler for the agent but less transparent.

---

## Phase 1: Decouple fetch from parse (fixes systemic issue A)

### Step 1.1: Python fetch-only scripts

Convert `scrape_stealth.py` and `scrape_browser.py` from "fetch + parse + extract" to "fetch only." New contract:

**Input (unchanged):** JSON on argv[1] with `url` field (plus `wait_for` for browser)

**Output (changed):** JSON to stdout:
```json
{
  "html": "<full page HTML>",
  "status_code": 200,
  "url": "https://...",
  "duration_ms": 1234,
  "errors": []
}
```

No more `selector`, `extract_fields`, `pagination`, `max_items` in the Python scripts. Those move to the parse layer.

Files to change:
- [ ] `src/agents/data/scripts/scrape_stealth.py` — strip extraction, return HTML
- [ ] `src/agents/data/scripts/scrape_browser.py` — strip extraction, return HTML
- [ ] `src/agents/researcher/scripts/scrape_stealth.py` — same changes

### Step 1.2: Shared cheerio parse function in web-scrape.ts

Extract the T1 extraction logic into a reusable function:

```typescript
function extractWithCheerio(
  html: string,
  selector: string,
  extractFields?: Record<string, string>,
  maxItems?: number
): { items: (Record<string, string> | string)[]; matchCount: number }
```

All three local tiers call this after fetching. T4 bypasses it (Apify returns structured data).

Files to change:
- [ ] `src/agents/extensions/web-scrape.ts` — extract shared parse function, refactor T1/T2/T3 tool implementations to use it

### Step 1.3: Challenge page detection

Add a detection step between fetch and parse:

```typescript
function detectChallenge(html: string): {
  isChallenge: boolean;
  vendor?: "cloudflare" | "datadome" | "perimeterx" | "aws_waf" | "unknown";
  signature?: string;
}
```

Signatures to detect:
- Cloudflare: `<title>Just a moment...</title>`, `cf-browser-verification`
- DataDome: `<title>datadome</title>`, `dd.js`, `window._ddc`
- PerimeterX: `_px`, `captcha.px-cdn.net`, `perimeterx`
- AWS WAF: `aws-waf-token`, captcha page patterns

When detected: return a structured result telling the agent what blocked it and suggesting T4.

Files to change:
- [ ] `src/agents/extensions/web-scrape.ts` — add detectChallenge, call between fetch and parse

### Step 1.4: Dockerfile NODE_PATH fix

Add `ENV NODE_PATH=/usr/local/lib/node_modules` to both bespoke Dockerfiles. Resolves cheerio-global-resolve issue and ensures any future global packages are resolvable.

Files to change:
- [ ] `src/agents/data/Dockerfile` — add ENV line after global npm installs
- [ ] `src/agents/researcher/Dockerfile` — same

### Step 1.5: Update test runner T1 to use shared parse

After the Python scripts return raw HTML, the test runner's `run_t1` inline Node script stays mostly the same (it already uses cheerio). But `run_t2` and `run_t3` need to change: call the Python fetch script, capture HTML, then parse with cheerio in Node.

New pattern for run_t2/run_t3 in the test runner:

```bash
run_t2() {
    # Python fetches HTML
    local html_json=$(docker compose exec -T data python3 /app/scripts/scrape_stealth.py "$input")
    # Node parses with cheerio
    docker compose exec -T data node -e "$parse_script" -- "$html_json" "$selector" "$fields" "$max_items"
}
```

The parse_script is the same cheerio extraction logic used by run_t1 but accepting HTML as input instead of fetching.

Files to change:
- [ ] `tests/scraping/real-world-tests.sh` — refactor run_t2, run_t3 to fetch-then-parse pattern

---

## Phase 2: Data-driven test runner (fixes systemic issue B)

### Step 2.1: Site config table

Create `tests/scraping/sites.json`:

```json
[
  {
    "name": "hackernews",
    "label": "Hacker News",
    "url": "https://news.ycombinator.com",
    "selector": ".titleline",
    "extract_fields": {"title": "a"},
    "tiers": ["t1", "t2", "t3"],
    "risk": "low",
    "phase": 1,
    "apify_actor": null,
    "expected": {"t1": "PASS", "t2": "PASS", "t3": "PASS"},
    "notes": "Level 1 baseline"
  },
  ...
]
```

All 15 sites in one file. Single source of truth for URLs, selectors, tier flags.

Files to create:
- [ ] `tests/scraping/sites.json`

### Step 2.2: Generic runner

Replace the 15 test_* functions with one generic function:

```bash
run_site() {
    local config="$1"  # JSON object for one site
    local name=$(echo "$config" | jq -r '.name')
    local url=$(echo "$config" | jq -r '.url')
    local selector=$(echo "$config" | jq -r '.selector')
    local fields=$(echo "$config" | jq '.extract_fields')
    local tiers=$(echo "$config" | jq -r '.tiers[]')

    begin_test "$name"
    for tier in $tiers; do
        run_tier "$tier" "$url" "$selector" "$fields"
        sleep "$SAME_SITE_DELAY"
    done
    classify_and_record ...
}
```

Phase selection: `jq '[.[] | select(.phase == 1)]' sites.json` feeds phase1.
Site selection: `jq '[.[] | select(.name == "hackernews")]' sites.json` feeds single-site mode.

Files to change:
- [ ] `tests/scraping/real-world-tests.sh` — replace test_* functions with generic runner

### Step 2.3: Pre-flight readiness check

At startup, scan sites.json for required capabilities and validate:

```bash
preflight() {
    # Check data container
    docker compose exec -T data echo "ok" || fatal "Data container not running"

    # Check tier capabilities
    local needs_t4=$(jq '[.[] | select(.tiers[] == "t4")] | length' sites.json)
    if [ "$needs_t4" -gt 0 ] && [ -z "$APIFY_API_TOKEN" ]; then
        warn "APIFY_API_TOKEN not set — $needs_t4 sites will SKIP T4"
    fi

    # Check Python/scrapling for T2/T3
    local needs_t2=$(jq '[.[] | select(.tiers[] == "t2")] | length' sites.json)
    if [ "$needs_t2" -gt 0 ]; then
        docker compose exec -T data python3 -c "from scrapling import Fetcher" || fatal "T2 requires scrapling"
    fi
}
```

Files to change:
- [ ] `tests/scraping/real-world-tests.sh` — add preflight function, call before any tests

### Step 2.4: Populate sites.json from campaign results

Use actual campaign results to set expected outcomes and tier flags. Add T3 to eBay. Add Apify actor IDs where known.

---

## Phase 3: Update extension tool interface (optional, eval-stage polish)

### Step 3.1: Decide unified vs separate tools

Gather feedback on whether agents are better served by one `scrape_web` tool or three separate tools. Separate tools are more explicit (agent sees which tier it's choosing). Unified tool is simpler (agent just says "scrape this URL").

For eval stage, keep separate tools but share the parse layer internally. Revisit for production.

### Step 3.2: Add diagnostic output

When extraction returns zero items, include diagnostic info in the tool response:
- Was HTML fetched successfully? (status code, content length)
- Was a challenge page detected? (vendor, signature)
- Did the selector match anything at all? (match count on the base selector)
- First 500 chars of page title and meta description (helps agent understand what page it got)

This gives the agent a diagnostic path when EMPTY occurs instead of a dead end.

---

## Ordering and dependencies

```
Phase 1 (fetch-parse decouple):
  1.4 Dockerfile fix ← independent, do first
  1.1 Python fetch-only ← no deps
  1.2 Shared cheerio parse ← depends on 1.1 (needs new Python output format)
  1.3 Challenge detection ← depends on 1.2 (needs raw HTML flowing through)
  1.5 Test runner update ← depends on 1.1 + 1.2

Phase 2 (data-driven runner):
  2.1 sites.json ← no deps, can start in parallel with Phase 1
  2.2 Generic runner ← depends on 2.1 + 1.5
  2.3 Preflight check ← depends on 2.1
  2.4 Populate from results ← depends on 2.1

Phase 3 (extension polish):
  3.1 Tool interface decision ← after Phase 1 complete
  3.2 Diagnostic output ← depends on 1.2 + 1.3
```

Recommended execution: 1.4 → 1.1 → 1.2 → 1.3 → 1.5, then 2.1 → 2.2/2.3/2.4. Phase 3 is optional.

## Definition of done

- [ ] All local tiers use cheerio for extraction — zero lxml parsing of selectors
- [ ] Python scripts output raw HTML, not extracted items
- [ ] Challenge page detection identifies Cloudflare, DataDome, PerimeterX, AWS WAF
- [ ] Test runner driven by sites.json, no per-site functions
- [ ] Pre-flight check validates tier capabilities before running
- [ ] eBay tested with T3
- [ ] Re-run full campaign, compare results to 2026-05-26 baseline
- [ ] Selectors that failed due to parser differences now pass (Reddit T2, etc.)
- [ ] NODE_PATH set in Dockerfiles

## Out of scope

- T4 Apify testing (requires token, separate effort)
- Updating stale Yelp selectors (requires browser inspection, do after parser is unified)
- Auto-escalation logic in the extension (Phase 3 decision)
- Behavioral simulation for DataDome/PerimeterX (architectural ceiling, not fixable here)
