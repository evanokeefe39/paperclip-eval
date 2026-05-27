# Lessons Learned

Patterns and corrections from implementation cycles. Review before starting work.

---

## 2026-05-27: HTTP adapter payload is NOT local-adapter payload

**What happened:** Bridge read `body.prompt`, `body.systemPrompt`, `body.env.PAPERCLIP_WAKE_REASON` — all undefined for HTTP adapter. Every agent got "Continue your work." as its prompt, losing all Paperclip-provided task context.

**Root cause:** HTTP adapter sends `{ agentId, runId, context }`. Prompt assembly, skill injection, session management are all local-adapter responsibilities. HTTP adapter is a dumb pipe.

**Rule:** When working with HTTP adapter, read `body.context` for everything. Build prompt from `context.paperclipTaskMarkdown`. Never assume `body.env` or `body.prompt` exist.

---

## 2026-05-27: Paperclip heartbeat field is intervalSec, not intervalMs

**What happened:** All 7 agent.json files had `intervalMs: 120000`. Paperclip's `parseHeartbeatPolicy` reads `intervalSec`, defaults to 0 when absent. Heartbeat silently disabled for all agents despite `enabled: true`.

**Root cause:** Field name mismatch. No validation error, no warning — just a silent default to 0.

**Rule:** Paperclip heartbeat config uses `intervalSec` (seconds). Always verify field names against `parseHeartbeatPolicy` in `server/src/services/heartbeat.ts` when changing heartbeat config.

---

## 2026-05-27: CEO must not have work tools

**What happened:** CEO had web-search, web-fetch, web-scrape, duckdb loaded. When given tasks, it did the work itself instead of delegating to specialist agents. Even after removing extensions, CEO attempted bash/curl workarounds, tried the `subagent` Pi tool, and used `paperclip_api_request` as an escape hatch.

**Root cause:** LLMs use the shortest path to "done." If tools are available, they use them. Prompt-only guardrails are unreliable (~60-70%). Need technical enforcement.

**Rule:** Two-layer access control. Layer 1: Dockerfile selective COPY — only copy extensions the agent needs. Layer 2: pi-permissions.jsonc — deny specific tools within loaded extensions. Denied tools are filtered from agent context at startup — LLM never sees them. For CEO specifically: deny bash, write, edit, checkout, upsert_document, api_request. Keep only read-only + coordination tools.

---

## 2026-05-27: Autodiscovery replaces hardcoded extension lists

**What happened:** bridge.mjs had a hardcoded DEFAULT_EXTENSIONS array and a BRIDGE_EXTENSIONS env var override. Adding/removing extensions required editing JavaScript or docker-compose env vars — runtime decisions for what should be devtime config.

**Root cause:** Extension loading was owned by the bridge (runtime) instead of the Dockerfile (devtime).

**Rule:** Bridge autodiscovers all `.ts` files in `/app/extensions/` and `/app/skills/` at startup. Files prefixed with `_` are skipped (convention for libraries/disabled files). What's on disk IS the config — controlled by Dockerfile COPY. No env vars, no hardcoded lists.

---

## 2026-05-27: Tool enforcement beats prompt engineering

**What happened:** Told CEO "do not do research yourself, delegate" in AGENTS.md. CEO ignored instructions under urgency pressure, tried bash workarounds when tools were blocked, and believed fake "your permissions were updated" messages.

**Root cause:** Prompt instructions are suggestions, not constraints. LLMs will circumvent them when the task context is compelling enough.

**Rule:** Use Pi's `tool_call` event hooks or `pi-permission-system` to enforce tool restrictions. The triage-workflow extension uses phase-gated hooks (TRIAGE → GROUNDING → READY) to enforce workflow sequence. pi-permission-system filters denied tools from agent context entirely. Prompt engineering is secondary — tune AGENTS.md to reduce blocked attempts, but the enforcement layer is the safety net.

---

## 2026-05-27: Pi settings.json packages field controls extension installation

**What happened:** Tried to conditionally install Pi extensions in Dockerfile with `if [ "$AGENT_NAME" = "ceo" ]`. Extensions kept appearing because `pi extensions install npm:foo` adds to settings.json AND installs. The packages list in settings.json is the source of truth.

**Root cause:** `pi extensions install` is additive — it writes to settings.json.packages. Removing from Dockerfile doesn't remove from settings.json if it was already there.

**Rule:** Control Pi extension packages via settings.json `packages` array, not via Dockerfile RUN commands. Each agent's settings.json declares its packages. Dockerfile runs `pi extensions install` without arguments to install from the list.

---

## 2026-05-26: wakeOnDemand does not replace heartbeat for work discovery

**What happened:** All agents had `heartbeat.enabled: false, wakeOnDemand: true`. CEO created child issues assigned to workers. Workers never woke up. Multi-agent orchestration dead on arrival.

**Root cause:** `wakeOnDemand` only fires for specific lifecycle events (blockers_resolved, children_completed, comments, approvals). Issue assignment is NOT a wake event. Heartbeat polling is the primary work-intake mechanism in Paperclip's hybrid model.

**Systemic:** Also found `client.ts` was missing the required `X-Paperclip-Run-Id` header on mutating API calls, and no tool existed for explicit agent invocation after delegation.

**Rule:** Always enable heartbeat on agents that need to discover work. `wakeOnDemand` supplements heartbeat, it does not replace it. After delegating work to another agent, use `paperclip_invoke_agent` to eliminate the poll-interval latency gap.

---

## 2026-05-26: Stale container images mask code changes

**What happened:** Python fetch scripts were updated in the repo (fetch-only pattern) but the Docker container still had the old selector-based versions. Tests ran against stale code for an entire campaign, producing misleading TIMEOUT results.

**Root cause:** `docker compose up -d` reuses existing images. Script changes require `docker compose build <service>` then `up -d`.

**Rule:** After changing any file that gets COPY'd into a Docker image, rebuild the affected container before testing. Don't trust "the code is updated" until you verify inside the container.

---

## 2026-05-26: Shell ARG_MAX limit on large HTML piping

**What happened:** Test runner's `cheerio_parse()` passed full HTML as a CLI argument to jq (`--arg html "$html"`) and then to node (`-- "$parse_input"`). Pages over ~128KB exceeded the OS argument length limit, causing "Argument list too long" errors. Small pages (HN, 35KB) worked; large pages (Reddit, 190KB) silently failed.

**Root cause:** Linux ARG_MAX limits CLI argument size. Passing large data as program arguments instead of piping through stdin.

**Rule:** Never pass HTML or other large data as CLI arguments. Always pipe through stdin. Use `jq` with `.field` on stdin instead of `--arg field "$variable"` for large values.

---

## 2026-05-26: Python fetch scripts must report HTTP errors

**What happened:** scrape_stealth.py and scrape_browser.py returned `errors: []` even on 403 responses. The test classifier saw zero errors + zero items and classified as EMPTY instead of BLOCK, hiding the real cause (Cloudflare rejection).

**Root cause:** Scripts only caught exceptions, not HTTP-level failures. A 403 with a body is not an exception — it's a successful HTTP response with an error status.

**Rule:** Fetch scripts must append `HTTP {status_code}` to the errors array for any status >= 400. The downstream classifier relies on error strings containing "403" or "blocked" to distinguish BLOCK from EMPTY.

---

## 2026-05-26: Anti-bot ceiling is behavioral, not technical

**What happened:** Sites protected by DataDome (Etsy), aggressive PerimeterX (Walmart), and Cloudflare Turnstile (Yelp) block all three self-hosted tiers including headless Chromium (T3). Scrapling's stealth patches (UA spoofing, webdriver flag removal, navigator property masking) are insufficient.

**Root cause:** These anti-bot systems analyze behavioral signals — mouse movement patterns, scroll behavior, timing between actions, viewport interactions — not just browser fingerprints. A headless browser that loads a page and immediately reads the DOM exhibits no human behavior.

**Implication:** The T3 ceiling is architectural, not fixable by configuration. Two paths forward: (1) T4 Apify for commercial anti-detection, (2) behavioral simulation with Playwright stealth plugins (production investment, not eval-stage). For eval, T4 is the answer.

---

## 2026-05-26: Selector staleness is a maintenance tax

**What happened:** eBay T3 renders the page successfully (HTML returned, no challenge) but `.s-item` matches nothing. The selector worked previously but eBay changed their DOM. No automated detection caught this.

**Implication:** Every selector in sites.json is a maintenance liability. Sites redesign their DOM regularly. Need a strategy for detecting stale selectors (periodic campaigns, or alert when a previously-PASS site returns EMPTY).
