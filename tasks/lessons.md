# Lessons Learned

Patterns and corrections from implementation cycles. Review before starting work.

---

## 2026-05-28: Pi RPC mode is persistent — stop killing the process

**What happened:** Bridge spawned a new Pi process on every /invoke request and killed it via `pi.stdin.end()` after `agent_end`. Every request paid 1.7-2.6s cold start (Node.js startup + TypeScript transpilation + extension loading). Over a delegation chain of 5 invocations, that's 10+ seconds of pure waste.

**Root cause:** Misunderstanding of Pi's RPC lifecycle. `agent_end` means "this prompt is done," not "process is done." The process stays alive and listening on stdin for the next prompt. The `--no-session` flag only disables disk persistence of conversation history — in-memory context survives between prompts within the same process.

**Discovery:** Pi's RPC protocol supports `new_session` command to reset conversation context between independent invocations. It also supports `follow_up`, `steer`, `abort`, `get_state`, `compact`, and session management commands — all on the same persistent process.

**Fix:** Bridge v2.0.0 spawns Pi once at startup, reuses across all /invoke requests. Sends `{"type":"new_session"}` between independent Paperclip heartbeat invocations to reset context. Auto-respawns on crash with exponential backoff (1s, 2s, 4s, max 3 attempts). FIFO queue serializes access to the single Pi process.

**Rule:** Pi's RPC mode is a persistent service. Spawn once, keep stdin open, send new_session between independent invocations. Never close stdin unless shutting down the container. This eliminates cold-start overhead entirely for all requests after the first.

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

**Rule:** Pi does native extension discovery from `~/.pi/agent/extensions/` — it loads flat `*.ts` files and `*/index.ts` subdirectory entries. The bridge plays no role in extension discovery. What's on disk IS the config — controlled by Dockerfile COPY into that path. No env vars, no hardcoded lists, no bridge-level autodiscovery.

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

---

## 2026-05-28: Concurrent Pi spawns corrupt npm node_modules

**What happened:** Paperclip dispatches multiple invocations to an agent simultaneously (heartbeat + issue_assigned). Each Pi spawn runs `npm install` for settings.json packages (pi-otel, pi-permission-system, etc.) in the same `/root/.pi/agent/npm/node_modules/` directory. Concurrent npm operations cause ENOTEMPTY errors and corrupted state that persists across retries.

**Root cause:** Bridge spawns Pi on every `/invoke` request with no serialization. Two concurrent spawns = two concurrent npm installs = filesystem corruption.

**Fix:** Two-layer: (1) Pre-install packages in Dockerfile so Pi finds them at startup without running npm install. (2) Invocation lock in bridge.mjs prevents concurrent Pi spawns entirely.

**Rule:** Any package in an agent's `.pi/agent/settings.json` must also be pre-installed in the Dockerfile via `npm install --prefix /root/.pi/agent/npm`. Never rely on Pi's runtime package installation in containerized agents — it's not concurrency-safe.

---

## 2026-05-28: AGENT_NAME env var must be set in docker-compose

**What happened:** Extensions that gate on agent identity (workproduct for researcher, triage-workflow for ceo) check `process.env.AGENT_NAME`. This was never set in docker-compose.yml, so all agents reported `AGENT_NAME="unknown"` and extensions skipped self-registration.

**Rule:** Every agent service in docker-compose.yml must set `AGENT_NAME` environment variable matching the agent's directory name (ceo, researcher, data, writer).

---

## 2026-05-28: bootstrap-invite.cjs needs external Postgres URL

**What happened:** After migrating Paperclip to external Postgres (artifact-store-v2), the bootstrap-invite.cjs still had the old embedded Postgres default URL (`127.0.0.1:54329`). Connection refused on every bootstrap attempt.

**Rule:** When changing infrastructure (database, storage), update ALL scripts that connect directly — not just the main application config. The bootstrap-invite.cjs default should match the compose DATABASE_URL, or use `process.env.DATABASE_URL` as fallback.

---

## 2026-05-28: Paperclip invite acceptance requires Origin header

**What happened:** `POST /api/invites/{token}/accept` returns "Board mutation requires trusted browser origin" without an `Origin` header matching `BETTER_AUTH_TRUSTED_ORIGINS`.

**Rule:** All Paperclip API mutations via curl need `-H "Origin: http://localhost:3100"` (or whatever PAPERCLIP_URL is). The api_post helper in setup.sh already does this, but manual curl commands must include it too.

---

## 2026-05-28: Pi process hangs during long tool-use chains (MiniMax)

**What happened:** During M0.1 testing, 5 timeout errors occurred across CEO (3), Researcher (1), and Writer (1). Pattern: Pi process starts successfully (pi_ready fires with extensions_active=true), then hangs during execution. Bridge timeout (300s for CEO, 120s for others) catches it. No stderr output — Pi didn't crash, it got stuck mid-inference.

**Root cause:** MiniMax-M2.7 appears to hang during long multi-turn tool-use chains. The API stops responding without error. DeepSeek-chat (used by Writer) showed the same pattern once. All timeouts occurred during active multi-tool runs, not during simple prompt processing.

**Rule:** Bridge timeout is the safety net. Keep BRIDGE_TIMEOUT_MS conservative (120-300s). For agents with complex tool flows (CEO triage, researcher deep-research), consider a Pi-level keepalive or streaming heartbeat to distinguish "working slowly" from "hung".

---

## 2026-05-28: Agents publish same artifact multiple times under different types

**What happened:** During M0.1, researchers and data agents published the same document 2-5 times under different artifact_types (report, research, brief, dataset, code, analysis, output, document). 56 MinIO objects total, estimated 25% redundant by content. Same content_hash appearing in multiple rows.

**Root cause:** artifact_type is free-text in the write_artifact tool. Agents pick whatever label sounds appropriate on each call. No deduplication check on content_hash. No controlled vocabulary enforcement.

**Rule:** Add content_hash deduplication in artifact service — reject writes with identical hash unless force flag is set. Define a controlled vocabulary for artifact_type and validate on write. Consider making the first write canonical and subsequent writes aliases.

---

## 2026-05-28: CEO creates escalation issues from stale crash-loop context

**What happened:** After fixing the concurrent Pi spawn bug and restarting with clean containers, the CEO agent created 3 escalation issues (EVA-57, EVA-58, EVA-69) reporting "systemic adapter failures blocking research." These were false positives — the failures were from the pre-fix crash loop. Old Paperclip issue comments describing errors persisted in the CEO's context window.

**Root cause:** Paperclip issue comments are append-only. When EVA-55 was created fresh, the CEO still saw comments from prior failed runs on related issues. The CEO correctly pattern-matched "adapter failures" but couldn't distinguish historical from current state.

**Rule:** When restarting a milestone after infrastructure fixes, either (a) wipe the Paperclip instance entirely (scripts/wipe.sh) or (b) clean up error comments on active issues before re-running. Stale error context in Paperclip comments will contaminate agent decision-making.

---

## 2026-05-28: Pi SDK exists — don't build a subprocess bridge

**What happened:** Built a 792-line bridge.mjs that spawns Pi as a subprocess in RPC mode (JSONL over stdin/stdout), then manually handles: JSONL line buffering, stdout event routing, new_session RPC with timeout/retry, agent_start readiness polling, crash detection with exponential backoff respawn, activeCollector state machine, pendingNewSession promise plumbing, graceful stdin teardown. Iterated through two major versions (v1 per-request spawn, v2 persistent process) over multiple days. The Pi SDK (`@earendil-works/pi-coding-agent`) exports `createAgentSession` and `createAgentSessionFromServices` — a programmatic API that handles all of this internally with zero subprocess management.

**Root cause (Five Whys):**
1. Why build a subprocess bridge? Because we needed to translate HTTP POST from Paperclip into Pi agent invocations.
2. Why use subprocess RPC? Because Pi's `--mode rpc` was documented and we found it first.
3. Why not check for a programmatic SDK? Because Pi is installed as a CLI tool (`pi` binary), so we treated it as a CLI-only interface.
4. Why assume CLI-only? Because the npm package name (`@earendil-works/pi-coding-agent`) suggests a standalone agent, not an embeddable library.
5. **Why not read the SDK docs?** Because we started from the CLI `--help` output and Docker container patterns instead of checking `pi.dev/docs/latest/sdk` for a programmatic API. The package has `"main": "./dist/index.js"` and exports `createAgentSession` — it was always designed for embedding.

**What the SDK gives for free:** Extension auto-discovery from `~/.pi/agent/extensions/`, skill loading via `DefaultResourceLoader`, auth.json/models.json/settings.json resolution, tool execution and routing, streaming via `session.subscribe()`, session management. Benchmark shows `createAgentSessionServices` once at boot (~700ms-1.8s), then `createAgentSessionFromServices` per request at **1-2ms** — faster than the RPC `new_session` command ever was.

**Fix:** server.mjs replaces bridge.mjs. 260 lines. `node:http` + Pi SDK. No subprocess, no JSONL parsing, no crash recovery, no RPC protocol. `session.prompt(text)` is a single await that handles agent_start, tool execution, turns, and agent_end internally.

**Rule:** When integrating any CLI tool into a server, check for a programmatic SDK/library export before building subprocess wrappers. Read the package.json `exports` field. Check `{tool}.dev/docs` for an SDK page. The presence of a `bin` field does not mean CLI is the only interface — most modern tools are library-first, CLI-second.
