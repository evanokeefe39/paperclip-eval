# CLAUDE.md
Never use powershell
## What this is

Evaluation repo for running Paperclip agent orchestration with Pi agents via Docker containers on Windows. Workaround for the pi_local adapter's CLI argument length limit (see LEARNING.md).

## Repo layout

```
docker-compose.yml          Full stack: Paperclip + agent containers (healthcheck on Paperclip)
.env.example                Template for shared provider API keys and bridge defaults
artifacts/                  Shared agent artifact storage (bind-mounted into containers at /artifacts)
scripts/init-artifact-db.sql  Postgres init script (artifact_store + paperclip databases)
src/artifact-service/       Bun-based artifact storage service (HTTP API, MinIO, Postgres)
src/agents/
  bridge.mjs               HTTP-to-RPC bridge shim (Node, zero deps)
  Dockerfile               Shared image — node:22-slim + Pi CLI
  setup.sh                  Canonical setup script (bash) — idempotent, env-configurable
  setup.ps1                 Thin WSL wrapper for setup.sh
  bootstrap-invite.cjs      DB-level bootstrap invite creator (idempotent, bypasses CLI)
  paperclip-config.json     Config template for Paperclip CLI compatibility
  rbac.json                 Per-agent artifact access control rules
  .dockerignore             Excludes .env and non-build files from image context
  extensions/               Pi extensions — selectively copied per agent by Dockerfile
    web-search.ts           Exa-backed web search tool (registered as web_search)
    web-fetch.ts            URL fetch tool with Jina Reader fallback (registered as web_fetch)
    web-scrape.ts           Web scraping tool
    escalate.ts             Human escalation via Paperclip issues
    artifact-client.ts      Shared HTTP client for artifact service
    artifacts.ts            Artifact tools (write/read/list via artifact-client.ts)
    logging.ts              OTel-backed logging (uses logging/ subdir, pi-otel + Aspire Dashboard)
    logging/                Submodules for logging extension
      types.ts              LogEntry, LogLevel types
      buffer.ts             Ring buffer for in-memory log queries
      jsonl.ts              JSONL log writer (via artifact-client.ts to logs bucket)
      otel.ts               pi-otel event bus integration (structured logs to Aspire)
    findings.ts             Structured findings with ADMIRALTY grading (via artifact-client.ts)
    triage-workflow.ts      CEO triage gate — web grounding + routing before delegation
    workproduct/            Shared primitives for standardized work products
      ulid.ts               Monotonic ULID generator (Crockford Base32, no deps)
      validate.ts           Two-level required/encouraged field validation framework
    deep-research.ts        Multi-iteration research tool (uses deep-research/ subdir)
    deep-research/          Engine, prompts, cache, types, validators, concurrency for deep research
      config.ts             Named constants (caps, concurrency limits, content thresholds)
      types.ts              Shared TypeScript types
      prompts.ts            LLM prompt templates
      cache.ts              LRU cache for search results and page content
      store.ts              Async filesystem store (findings, sources, metadata)
      checkpoint.ts         Async checkpoint save/restore for resumable runs
      query.ts              Async local findings index search
      llm.ts                LLM calls with semaphore concurrency cap and validator callbacks
      rank.ts               Snippet scoring and top-K selection
      sweep.ts              Page fetch, chunk, extract pipeline (Promise.allSettled)
      extract.ts            Finding extraction from page chunks with validators
      engine.ts             Orchestrator: plan, search, rank, extract, reflect loop
      semaphore.ts          Counting semaphore for bounding concurrent async work
      validate.ts           Runtime validators for LLM structured output
      utils.ts              Shared helpers (sleep, stripHtml)
  skills/                   Paperclip platform tools and behavioral skills
    _client.ts              Shared Paperclip API client — underscore prefix = skipped by autodiscovery
    paperclip-tools.ts      Pi extension registering all 40 Paperclip MCP tools
    paperclip-skills/       Behavioral skills fetched from Paperclip repo (gitignored)
      paperclip/            Core heartbeat protocol, API reference, coordination
      paperclip-converting-plans-to-tasks/  Plan-to-issue decomposition
      para-memory-files/    PARA-method persistent agent memory
  ceo/                      CEO agent config and prompt
    agent.json              Agent registration metadata (name, role, adapter config)
    .pi/agent/config.yml
    .pi/agent/models.json
    .pi/agent/auth.json     Provider auth (gitignored, symlink to root auth.json)
    .pi/agent/pi-permissions.jsonc  Tool access control (allow/deny per tool, pi-permission-system)
    .pi/agent/settings.json Packages, model defaults, otel config
  researcher/               Researcher agent config and prompt
    (same structure as ceo/)
  coder/                    Coder agent config and prompt
    (same structure as ceo/)
  data/                     Data agent config and prompt
    (same structure as ceo/)
  writer/                   Writer agent config and prompt
    (same structure as ceo/)
  qa/                       QA agent config and prompt
    (same structure as ceo/)
auth.json                    Master auth file — symlinked into agent .pi/agent/ dirs
scripts/backup.sh            Backup Paperclip instance (bash/WSL)
scripts/wipe.sh              Wipe and reset Paperclip instance (bash/WSL)
tests/                       Hurl, k6, and fixture-based test suite
  paperclip-tools/           Unit + integration tests for Paperclip tools extension
  escalate/                  Unit + integration tests for escalate extension
  deep-research/             Unit tests for deep-research submodules (semaphore, validate, utils, config)
  e2e/                       End-to-end bash test suite
  hurl/                      HTTP contract tests
  k6/                        Load tests
  fixtures/                  Test payloads
  results/                   Timestamped test run reports
.claude/skills/paperclip-api.md  API reference skill
docs/                        Architecture, design, and integration docs
LEARNING.md                  Running log of issues and workarounds
ROADMAP.md                   Planned improvements (MinIO, etc) — eval stage
tasks/                       Plans, todos, lessons
```

## Project stage

Evaluation. Validating Paperclip + Pi orchestration patterns before committing to production infrastructure. See ROADMAP.md for planned next steps (MinIO artifact storage, etc).

## Key context

- Everything runs in Docker via docker-compose (Paperclip + agent bridges)
- Paperclip image: ghcr.io/paperclipai/paperclip:latest (authenticated mode)
- Paperclip UI at http://localhost:3100, agents at :8081 (CEO), :8082 (Researcher), :8083 (Data), :8084 (Writer)
- Postgres shared between Paperclip (DATABASE_URL) and artifact service (artifact_store DB)
- Artifact service at http://artifact-service:8090 on Docker network, :8090 on host
- MinIO at http://minio:9000 on Docker network, :9000 (API) and :9001 (console) on host
- Infrastructure ports: 3100 (Paperclip), 5432 (Postgres), 8090 (artifact service), 9000 (MinIO API), 9001 (MinIO console), 18888 (Aspire Dashboard)
- On Docker network: Paperclip reaches agents at http://ceo:8080, http://researcher:8080
- Agents registered via HTTP adapter, not pi_local (bypasses CLI arg length limit)
- Pi runs in RPC mode inside containers — JSONL over stdin/stdout
- bridge.mjs translates between HTTP POST and Pi's JSONL protocol
- Pi requires auth.json at ~/.pi/agent/auth.json inside containers (provider-specific structure for minimax/deepseek)
- First-time setup: `bash src/agents/setup.sh` (works from Git Bash, WSL, or PowerShell via `setup.ps1`). Subsequent starts: `docker compose up -d`
- Docker Compose project name pinned to `paperclip-eval` via `name:` key — safe to rename/move the repo directory
- setup.sh is idempotent — safe to re-run. Fetches latest Paperclip skills from GitHub, skips existing companies/agents, creates API keys, writes per-agent `.env` files
- All setup config via env vars: PAPERCLIP_URL, ADMIN_EMAIL, ADMIN_PASS, COMPANY_NAME, COMPOSE_FILE, SKIP_BUILD
- Adding a new agent: create a directory with .pi/agent/config.yml and agent.json, then re-run setup.sh
- Per-agent config in `src/agents/{name}/.env` — Paperclip credentials (API key, agent ID, company ID) plus agent-specific overrides (PI_PROVIDER, BRIDGE_TIMEOUT_MS, etc.)
- docker-compose loads both root `.env` (shared API keys) and per-agent `.env` (Paperclip identity + overrides)
- Agent API keys created automatically by setup.sh via `POST /api/agents/{id}/keys`, tokens prefixed `pcp_`
- `docker compose restart` does NOT reload env vars — use `docker compose up -d <service>` to pick up changes (see LEARNING.md)

## Paperclip skills (platform tools)

- HTTP adapter agents don't receive Paperclip's built-in MCP tools — those are only injected for local adapters (claude_local, codex_local, pi_local)
- `src/agents/skills/paperclip-tools.ts` is a Pi extension that re-implements all 40 Paperclip MCP tools as Pi-native tools wrapping the REST API
- Shared client at `src/agents/skills/_client.ts` uses per-agent API key auth (`Authorization: Bearer <PAPERCLIP_API_KEY>`)
- Tools cover: issues (CRUD, checkout, release), comments, documents, projects, goals, agents/inbox, interactions (suggest_tasks, ask_user_questions, request_confirmation), approvals (full lifecycle), workspace runtime, and an escape-hatch `paperclip_api_request` for anything not covered
- Autodiscovered by bridge.mjs from `/app/skills/paperclip-tools.ts`, copied into container by Dockerfile
- Requires env vars: `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID` (all in per-agent `.env`)
- If PAPERCLIP_API_URL or PAPERCLIP_API_KEY is missing, the extension silently skips registration (no crash)
- API paths match the upstream MCP server at `packages/mcp-server/src/tools.ts` — all paths relative to `/api`
- Tests: `node tests/paperclip-tools/unit-test.mjs` (162 tests, fake server) and `bash tests/paperclip-tools/integration-test.sh` (live stack)

## Paperclip skills (behavioral — heartbeat protocol)

- HTTP adapter agents also don't receive Paperclip's bundled behavioral skills (SKILL.md files that teach agents the heartbeat protocol, delegation patterns, memory)
- Local adapters get skills via `syncSkills` — symlinked into agent CLI discovery path. HTTP adapter has no `syncSkills` implementation.
- Solution: setup.sh fetches SKILL.md files from `github.com/paperclipai/paperclip/master/skills/` into `src/agents/skills/paperclip-skills/`
- bridge.mjs passes `--skill /app/skills/paperclip-skills/{name}` for each skill to Pi's spawn args
- Pi loads skills natively with progressive disclosure: only skill descriptions in context, full SKILL.md content loaded on demand when agent needs it
- Default skills (configurable via `PAPERCLIP_SKILLS` env var): `paperclip` (core heartbeat protocol + API reference), `paperclip-converting-plans-to-tasks` (issue decomposition), `para-memory-files` (PARA-method persistent memory)
- Skills include reference files under `references/` subdirectories — available on disk for agent file reads
- Fetched content is gitignored — always pulled fresh from GitHub at setup time
- Paperclip repo has 8 bundled skills total; we fetch the 3 relevant to agent coordination (the others are for Paperclip development, benchmarking, or plugin creation)

## Agent web tools

- Pi has no built-in web search — custom extensions at `src/agents/extensions/` provide `web_search` (Exa API) and `web_fetch` (direct + Jina Reader fallback)
- Extensions autodiscovered from `/app/extensions/` at bridge startup, passed via `-e` flags to Pi
- Requires `EXA_API_KEY` env var in `.env`
- DeepSeek handles tool calling reliably; Groq is flaky with function calls — avoid for agentic web search tasks
- Test extensions locally via bash: `pi --mode json -e extensions/web-search.ts -p "query"` (PowerShell cannot capture Pi stdout)

## Agent escalation and Discord

- Escalation handled by `paperclip-plugin-discord` (community plugin, v0.7.3, installed in Paperclip instance)
- Plugin provides `escalate_to_human` tool with conversation context, suggested replies, interactive Discord buttons, configurable timeout
- Plugin subscribes to Paperclip events (issue.created, approval.created, agent.error) and posts Discord embeds automatically
- Human replies in Discord threads become Paperclip issue comments; agent wakes via `PAPERCLIP_WAKE_COMMENT_ID`
- Paperclip's built-in interaction API covers structured HITL: `ask_user_questions` (forced-choice only, no free text), `request_confirmation` (accept/reject with optional reason), `suggest_tasks` (all-or-nothing accept)
- Plugin config via `POST /api/plugins/{id}/config` — requires Discord bot token (stored as Paperclip secret), channel ID, guild ID
- Sibling plugins exist for Telegram (`paperclip-plugin-telegram`) and Slack (`paperclip-plugin-slack`) using shared `PlatformAdapter` from `paperclip-plugin-chat-core`
- `escalate.ts` extension provides local Paperclip-native escalation (issue + interaction); Discord plugin is the preferred channel when configured
- Setup spec: `tasks/specs/discord-plugin-setup.md`

## Agent web scraping

- 4-tier scraping: static (cheerio), stealth (Scrapling Fetcher), browser (Scrapling DynamicFetcher), cloud (Apify)
- Architecture: fetch decoupled from parse. Python scripts return raw HTML. Cheerio handles all extraction (one parser for T1/T2/T3). T4 bypasses parse (Apify returns structured data).
- Challenge detection between fetch and parse: identifies Cloudflare, DataDome, PerimeterX, AWS WAF
- Diagnostic output on zero items: HTTP status, HTML length, challenge vendor, selector match count, page title
- Extension: `src/agents/extensions/web-scrape.ts` — conditionally registers tools based on available deps
- Python fetch-only scripts: `scripts/scrape_stealth.py` (researcher + data), `scripts/scrape_browser.py` (data only). Input: `{url, wait_for?}`. Output: `{html, status_code, url, duration_ms, errors}`.
- Tool registration: cheerio -> T1, scrapling Fetcher + cheerio -> T2, `.browsers-installed` marker + cheerio -> T3, Apify -> always
- Researcher image: lightweight (Python + scrapling Fetcher + cheerio, ~600MB)
- Data image: heavy (Python + scrapling[fetchers] + Chromium + Playwright, ~1.5GB, 2G memory limit)
- Requires `APIFY_API_TOKEN` env var for tier 4 tools
- Test infrastructure: `tests/scraping/sites.json` (data-driven config), `tests/scraping/real-world-tests.sh` (generic runner), `tests/e2e/e2e-9-scraping.sh`

## Bespoke Docker images

- Pattern: agent-specific Dockerfiles in `src/agents/{agent}/Dockerfile` with hardcoded agent name in COPY paths
- Build context remains `src/agents/` — COPY paths relative to that directory
- CEO uses shared `src/agents/Dockerfile` with AGENT_NAME build arg
- Researcher uses `src/agents/researcher/Dockerfile` (lightweight bespoke: Python + scrapling + cheerio)
- Data uses `src/agents/data/Dockerfile` (heavy bespoke: Python + scrapling[fetchers] + Chromium)
- Writer uses `src/agents/writer/Dockerfile` (Vale linter + style extensions)
- Each Dockerfile selectively COPYs only the extensions that agent needs (universal base + role-specific). Bridge autodiscovers whatever is on disk.
- Universal extensions (every agent): artifacts.ts, logging.ts, escalate.ts, types/, paperclip-tools.ts
- Agent-specific scripts go in `src/agents/{agent}/scripts/`, copied to `/app/scripts/` in container

## Agent permissions (pi-permission-system)

- Every agent has `pi-permission-system` npm package installed via settings.json
- Per-agent `pi-permissions.jsonc` in `.pi/agent/` controls tool access with allow/deny rules and wildcard patterns
- Denied tools are filtered from agent context before startup — LLM never sees them
- Two-layer access control: Dockerfile COPY (coarse — what's on disk) + pi-permissions.jsonc (fine — what LLM sees within loaded extensions)
- CEO: read-only coordinator. Denied: bash, write, edit, checkout, upsert_document, api_request. Allowed: read, grep, find, ls, web_search, triage_task, create_issue, invoke_agent, escalate
- Executor agents (researcher, data, writer): full file access (bash, read, write, edit). Denied: create_issue, invoke_agent, api_request (coordination tools reserved for CEO)
- Review logs written to JSONL by pi-permission-system for auditing blocked attempts

## CEO triage workflow

- `triage-workflow.ts` extension provides phase-gated workflow for CEO only (self-gates on AGENT_NAME=ceo)
- Three phases enforced by tool_call hooks: TRIAGE → GROUNDING → READY
- TRIAGE: CEO must call `triage_task` before any delegation. Classifies complexity, suggests searches and agents.
- GROUNDING: web_search unlocked (max 2 queries for domain context), escalate/ask_user_questions available for clarification
- READY: `advance_to_delegation` unlocks create_issue, invoke_agent, add_comment for delegation
- CEO cannot skip phases — hooks block tools not allowed in current phase
- Audit log at `/artifacts/ceo/triage.log.jsonl` tracks phase transitions and blocked attempts

## Observability (OTel + Aspire Dashboard)

- pi-otel extension installed in all agent containers — automatic tracing of LLM calls, tool executions, agent turns
- Aspire Dashboard container in docker-compose at http://localhost:18888 — traces, structured logs, metrics
- pi-otel exports via OTLP gRPC to `dashboard:18889`
- Each agent's `.pi/agent/settings.json` has `otel` config with per-agent `serviceName`
- Span hierarchy: `pi.interaction` → `pi.turn` → `pi.llm_request` / `pi.tool.<name>`
- logging.ts extension emits structured logs to dashboard via `pi.events.emit("pi-otel:log", ...)`
- logging.ts also writes JSONL to `/artifacts/{agent}/run.log.jsonl` and maintains in-memory ring buffer
- Tools: `log_event` (structured logging), `get_log` (query buffer), `get_trace_id` (cross-agent correlation)
- Bridge generates W3C TRACEPARENT per /invoke request, propagates to Pi process
- Bridge extracts token usage from `turn_end` events, POSTs to Paperclip cost-events API
- Response JSON includes `trace_id` and `usage` summary
- Tests: `node --test tests/logging/unit-test.mjs` (23 tests)

## Inter-agent artifact sharing

- Artifact service at `src/artifact-service/` — Bun HTTP service on :8090 behind Docker network
- Blob storage: MinIO (S3-compatible) with 3 buckets: artifacts, logs, state
- Metadata: Postgres with JSONB column for type-specific fields, GIN index for queries
- Agents write via `artifact-client.ts` (shared HTTP client), never touch filesystem directly
- Artifacts referenced by `artifact://` URIs (e.g. `artifact://default/default/run123/researcher/research/01JHX_findings.md`)
- Downstream agent resolves URI via `read_artifact` tool when it needs content
- RBAC via `src/agents/rbac.json` — glob-pattern read/write rules per agent
- CEO and QA have full read access; other agents read only from their own namespace and specified peers
- `docker compose down -v` destroys Postgres AND MinIO data — use backup scripts before wiping
- MinIO console at :9001 for inspecting stored artifacts during eval

## Platform

- Windows 11, PowerShell primary shell
- Bash scripts run under WSL2
- Docker Desktop for containers

## Working with the bridge

- bridge.mjs is a starting point, not production code — no auth, no streaming, no retry
- Environment variables: `BRIDGE_PORT`, `PI_PROVIDER`, `PI_MODEL`, `BRIDGE_TIMEOUT_MS`, plus provider API keys
- Infrastructure env vars in root `.env`: `POSTGRES_PASSWORD`, `ARTIFACT_DB_PASSWORD`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`
- `ARTIFACT_SERVICE_URL` set per-agent in both docker-compose environment and agent `.env` files (defaults to `http://artifact-service:8090`)
- Extension loading: bridge autodiscovers all `.ts` files in `/app/extensions/` and `/app/skills/` at startup. Files prefixed with `_` are skipped. No hardcoded list.
- Which extensions are on disk is controlled by Dockerfile COPY (devtime decision). Which tools the LLM can see is controlled by `pi-permissions.jsonc` (runtime enforcement).
- HTTP adapter sends `{ agentId, runId, context }` — bridge builds prompt from `context.paperclipTaskMarkdown`, NOT from `body.prompt`/`body.env`
- Each agent gets its own container instance
- Workspace mounted at `/workspace` inside containers

## Known issues

- pi_local adapter CLI argument limit: issues #3114, #3180 on paperclip repo
- Execution contract text duplicated in wake payload (wastes tokens, accelerates limit)
- `paperclipai --version` can report stale version — check UI settings page instead
- `local_trusted` mode cannot run in Docker (requires loopback bind, incompatible with port forwarding)
- `paperclipai auth bootstrap-ceo` CLI force-detects `local_trusted` inside Docker — use bootstrap-invite.cjs instead
- `paperclipai onboard --yes` ignores all env var overrides and forces local_trusted/loopback
- Pi env var API keys alone are insufficient for minimax/deepseek — auth.json with provider-keyed structure required

## Style

- No Microsoft formats. Markdown and CSV only.
- Keep scripts in bash (WSL). Keep bridge code in plain Node (no framework, no transpiler).
- Minimal dependencies — the bridge has zero npm deps by design.
