# CLAUDE.md
Never use powershell
## What this is

Evaluation repo for running Paperclip agent orchestration with Pi agents via Docker containers on Windows. Workaround for the pi_local adapter's CLI argument length limit (see LEARNING.md).

## Repo layout

```
src/agents/
  bridge.mjs               HTTP-to-RPC bridge shim (Node, zero deps)
  Dockerfile               Shared image — node:22-slim + Pi CLI
  docker-compose.yml        Full stack: Paperclip + agent containers (healthcheck on Paperclip)
  setup.sh                  Canonical setup script (bash) — idempotent, env-configurable
  setup.ps1                 Thin WSL wrapper for setup.sh
  bootstrap-invite.cjs      DB-level bootstrap invite creator (idempotent, bypasses CLI)
  paperclip-config.json     Config template for Paperclip CLI compatibility
  .dockerignore             Excludes .env and non-build files from image context
  .env.example              Template for provider API keys
  extensions/               Pi extensions loaded into all agent containers
    web-search.ts           Exa-backed web search tool (registered as web_search)
    web-fetch.ts            URL fetch tool with Jina Reader fallback (registered as web_fetch)
    web-scrape.ts           Web scraping tool
    escalate.ts             Human escalation via Paperclip issues
    artifacts.ts            Shared artifact helpers
    logging.ts              Structured logging extension
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
  skills/                   Paperclip platform tools (Pi extensions wrapping Paperclip REST API)
    client.ts               Shared Paperclip API client — session-cookie auth with caching
    paperclip-tools.ts      Pi extension registering all 40 Paperclip MCP tools
  ceo/                      CEO agent config and prompt
    agent.json              Agent registration metadata (name, role, adapter config)
    .pi/agent/config.yml
    .pi/agent/models.json
    .pi/agent/auth.json     Provider auth (gitignored, copy from root auth.json)
    AGENTS.md
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
auth.json                    Master auth file — copy into agent .pi/agent/ dirs
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
- Paperclip UI at http://localhost:3100, agents at :8081, :8082
- On Docker network: Paperclip reaches agents at http://ceo:8080, http://researcher:8080
- Agents registered via HTTP adapter, not pi_local (bypasses CLI arg length limit)
- Pi runs in RPC mode inside containers — JSONL over stdin/stdout
- bridge.mjs translates between HTTP POST and Pi's JSONL protocol
- Pi requires auth.json at ~/.pi/agent/auth.json inside containers (provider-specific structure for minimax/deepseek)
- First-time setup: run setup.sh (or setup.ps1 from PowerShell, which delegates to setup.sh via WSL). Subsequent starts: docker compose up -d
- setup.sh is idempotent — safe to re-run. Skips existing companies/agents and prints their IDs
- All setup config via env vars: PAPERCLIP_URL, ADMIN_EMAIL, ADMIN_PASS, COMPANY_NAME, COMPOSE_FILE, SKIP_BUILD
- Adding a new agent: create a directory with .pi/agent/config.yml and agent.json, then re-run setup.sh

## Paperclip skills (platform tools)

- HTTP adapter agents don't receive Paperclip's built-in MCP tools — those are only injected for local adapters (claude_local, codex_local, pi_local)
- `src/agents/skills/paperclip-tools.ts` is a Pi extension that re-implements all 40 Paperclip MCP tools as Pi-native tools wrapping the REST API
- Shared client at `src/agents/skills/client.ts` handles session-cookie auth with 25-minute cache
- Tools cover: issues (CRUD, checkout, release), comments, documents, projects, goals, agents/inbox, interactions (suggest_tasks, ask_user_questions, request_confirmation), approvals (full lifecycle), workspace runtime, and an escape-hatch `paperclip_api_request` for anything not covered
- Loaded in bridge.mjs via `-e /app/skills/paperclip-tools.ts`, copied into container by Dockerfile
- Requires same env vars as escalate: `PAPERCLIP_API_URL`, `PAPERCLIP_ADMIN_EMAIL`, `PAPERCLIP_ADMIN_PASS`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`
- If any of the three auth env vars are missing, the extension silently skips registration (no crash)
- API paths match the upstream MCP server at `packages/mcp-server/src/tools.ts` — all paths relative to `/api`
- Tests: `node tests/paperclip-tools/unit-test.mjs` (162 tests, fake server) and `bash tests/paperclip-tools/integration-test.sh` (live stack)

## Agent web tools

- Pi has no built-in web search — custom extensions at `src/agents/extensions/` provide `web_search` (Exa API) and `web_fetch` (direct + Jina Reader fallback)
- Extensions loaded via `-e` flags in bridge.mjs spawn args, copied into container at `/app/extensions/`
- Requires `EXA_API_KEY` env var in `.env`
- DeepSeek handles tool calling reliably; Groq is flaky with function calls — avoid for agentic web search tasks
- Test extensions locally via bash: `pi --mode json -e extensions/web-search.ts -p "query"` (PowerShell cannot capture Pi stdout)

## Agent escalation

- `escalate` tool (src/agents/extensions/escalate.ts) lets agents pause and request human input via Paperclip issues
- Requires env vars: `PAPERCLIP_API_URL`, `PAPERCLIP_ADMIN_EMAIL`, `PAPERCLIP_ADMIN_PASS`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`
- Agent IDs set per-container in docker-compose.yml via `CEO_AGENT_ID` / `RESEARCHER_AGENT_ID` in `.env`
- Auth is session-cookie based (no API keys) — extension signs in as admin to create issues and pause agents
- Creates issue with `escalation` label, pauses agent, returns tool result telling LLM to wait
- On resume, LLM checks issue comments via Paperclip skills (paperclip_get_issue, paperclip_list_comments)
- `PAPERCLIP_PUBLIC_URL` must be set to `http://paperclip:3100` (docker hostname) for container-to-Paperclip auth to work

## Agent web scraping

- 4-tier scraping: static (cheerio), stealth (Scrapling Fetcher), browser (Scrapling DynamicFetcher), cloud (Apify)
- Extension: `src/agents/extensions/web-scrape.ts` — conditionally registers tools based on available deps
- Python workers: `scripts/scrape_stealth.py` (researcher + data), `scripts/scrape_browser.py` (data only)
- Tool registration is conditional: cheerio → tier 1, Scrapling Fetcher → tier 2, marker file `/app/.browsers-installed` → tier 3, Apify → always
- Researcher image: lightweight (Python + scrapling Fetcher + cheerio, ~600MB)
- Data image: heavy (Python + scrapling[fetchers] + Chromium + Playwright, ~1.5GB, 2G memory limit)
- Requires `APIFY_API_TOKEN` env var for tier 4 tools
- Test infrastructure: `tests/scraping/` (fixtures, runner, unit tests), `tests/e2e/e2e-9-scraping.sh`

## Bespoke Docker images

- Pattern: agent-specific Dockerfiles in `src/agents/{agent}/Dockerfile` with hardcoded agent name in COPY paths
- Build context remains `src/agents/` — COPY paths relative to that directory
- CEO uses shared `src/agents/Dockerfile` with AGENT_NAME build arg
- Researcher uses `src/agents/researcher/Dockerfile` (lightweight bespoke: Python + scrapling + cheerio)
- Data uses `src/agents/data/Dockerfile` (heavy bespoke: Python + scrapling[fetchers] + Chromium)
- Bespoke Dockerfiles don't use AGENT_NAME arg — paths are hardcoded
- Agent-specific scripts go in `src/agents/{agent}/scripts/`, copied to `/app/scripts/` in container

## Inter-agent artifact sharing

- Paperclip has no native file/artifact storage — all orchestration is text-in-prompt
- Shared Docker volume `shared-artifacts` mounted at `/artifacts` in all agent containers
- Agents write files to `/artifacts/{context}/{filename}`, pass path references in text output (not file content)
- Consuming agent reads from `/artifacts/...` path received in its wake payload
- This is the eval-stage solution (Option A). ROADMAP.md describes Option B (MinIO with S3 URIs, presigned URLs, access control)

## Platform

- Windows 11, PowerShell primary shell
- Bash scripts run under WSL2
- Docker Desktop for containers

## Working with the bridge

- bridge.mjs is a starting point, not production code — no auth, no streaming, no retry
- Environment variables: `BRIDGE_PORT`, `PI_PROVIDER`, `PI_MODEL`, plus provider API keys
- Each agent gets its own container instance from the same image
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
