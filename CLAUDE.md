# CLAUDE.md

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
  ceo/                      CEO agent config and prompt
    agent.json              Agent registration metadata (name, role, adapter config)
    .pi/agent/config.yml
    .pi/agent/models.json
    .pi/agent/auth.json     Provider auth (gitignored, copy from root auth.json)
    AGENTS.md
  researcher/               Researcher agent config and prompt
    agent.json              Agent registration metadata (name, role, adapter config)
    .pi/agent/config.yml
    .pi/agent/models.json
    .pi/agent/auth.json     Provider auth (gitignored, copy from root auth.json)
    AGENTS.md
auth.json                    Master auth file — copy into agent .pi/agent/ dirs
scripts/backup.sh            Backup Paperclip instance (bash/WSL)
scripts/wipe.sh              Wipe and reset Paperclip instance (bash/WSL)
tests/                       Hurl, k6, and fixture-based test suite
tests/results/               Timestamped test run reports
.claude/skills/paperclip-api.md  API reference skill
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

## Agent web tools

- Pi has no built-in web search — custom extensions at `src/agents/extensions/` provide `web_search` (Exa API) and `web_fetch` (direct + Jina Reader fallback)
- Extensions loaded via `-e` flags in bridge.mjs spawn args, copied into container at `/app/extensions/`
- Requires `EXA_API_KEY` env var in `.env`
- DeepSeek handles tool calling reliably; Groq is flaky with function calls — avoid for agentic web search tasks
- Test extensions locally via bash: `pi --mode json -e extensions/web-search.ts -p "query"` (PowerShell cannot capture Pi stdout)

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
