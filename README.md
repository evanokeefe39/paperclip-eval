# Paperclip + Pi: Containerized Agent Evaluation

Evaluation setup for running [Paperclip](https://github.com/paperclipai/paperclip) with [Pi](https://github.com/badlogic/pi-mono) agents, fully containerized via Docker Compose. Bypasses the Windows CLI argument length limit that breaks the default pi_local adapter.

## Why containers instead of pi_local

Paperclip's pi_local adapter passes the entire system prompt as a `--append-system-prompt` CLI argument. On Windows this hits the ~8,191 character cmd.exe limit, causing either "The command line is too long" errors or silent prompt fragmentation where Pi receives each word as a separate message. See [LEARNING.md](./LEARNING.md) for details.

The containerized approach uses Paperclip's HTTP adapter instead. Prompts go as JSON over HTTP, no shell, no argument limits.

## Architecture

```
Host browser (http://localhost:3100)
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  Docker Compose (agents_default network)                    │
│                                                             │
│  ┌──────────────────────┐    HTTP POST     ┌─────────────┐  │
│  │ Paperclip            │ ──────────────── │ CEO bridge  │  │
│  │ ghcr.io/paperclipai/ │  http://ceo:8080 │ bridge.mjs  │  │
│  │   paperclip:latest   │                  │   │      ▲  │  │
│  │                      │    HTTP POST     │   │stdin │  │  │
│  │ :3100 (embedded PG)  │ ──────────────── │   ▼      │  │  │
│  └──────────────────────┘  http://         │ pi --mode│  │  │
│                            researcher:8080 │    rpc   │  │  │
│                                            └─────────────┘  │
│                                            ┌─────────────┐  │
│                                            │ Researcher  │  │
│                                            │ bridge.mjs  │  │
│                                            │ pi --mode   │  │
│                                            │    rpc      │  │
│                                            └─────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

Each agent gets its own container from the same image. The bridge translates HTTP requests into Pi's JSONL stdin/stdout protocol.

## Prerequisites

- Docker Desktop
- PowerShell (Windows 11)
- LLM API keys for your providers (see `.env.example`)

No local Node.js, Paperclip, or Pi installation needed.

## Quick start

### 1. Configure API keys

```powershell
cp src/agents/.env.example src/agents/.env
# Edit .env with your provider API keys
```

### 2. First-time setup

```powershell
.\src\agents\setup.ps1
```

This starts all containers, bootstraps the Paperclip instance, creates a company, and registers the CEO and Researcher agents. Takes about 30 seconds after images are pulled.

### 3. Subsequent starts

```powershell
docker compose -f src/agents/docker-compose.yml up -d
```

The Paperclip data volume persists across restarts, no re-setup needed.

### 4. Access

- Paperclip UI: http://localhost:3100
- CEO bridge: http://localhost:8081
- Researcher bridge: http://localhost:8082

### 5. Validate

Health check:

```powershell
Invoke-RestMethod http://localhost:8081/health
Invoke-RestMethod http://localhost:8082/health
```

Direct bridge test:

```powershell
Invoke-RestMethod http://localhost:8081/invoke -Method POST `
  -ContentType 'application/json' `
  -Body '{"prompt":"Say hello."}'
```

Trigger a Paperclip heartbeat from the UI or API, then check the agent's transcript for a coherent response.

## File inventory

| File | Purpose |
|------|---------|
| `src/agents/docker-compose.yml` | Full stack: Paperclip + agent containers |
| `src/agents/bridge.mjs` | HTTP-to-RPC bridge shim (zero npm deps) |
| `src/agents/Dockerfile` | Agent container image (node:22-slim + Pi CLI) |
| `src/agents/setup.ps1` | One-shot bootstrap and agent registration |
| `src/agents/bootstrap-invite.cjs` | DB-level admin bootstrap (bypasses CLI bug) |
| `src/agents/.env.example` | Provider API key template |
| `src/agents/ceo/` | CEO agent config (AGENTS.md, Pi config) |
| `src/agents/researcher/` | Researcher agent config |
| `tests/` | Hurl, k6, and PowerShell test suite |
| `scripts/` | Backup and wipe scripts (bash/WSL) |
| `LEARNING.md` | Running log of issues and workarounds |
| `.claude/skills/paperclip-api.md` | Paperclip API reference |

## Known limitations

- Paperclip's `local_trusted` mode cannot run in Docker (requires loopback binding). Must use `authenticated` mode.
- The `paperclipai auth bootstrap-ceo` CLI does not work inside Docker containers. Workaround: `bootstrap-invite.cjs` inserts the invite directly into the embedded PostgreSQL.
- HTTP adapter is not in Paperclip's UI wizard. Agents are registered via the API during setup.
- Bridge shim is a starting point, not production-ready (no auth, no streaming, no retry).
- Cost tracking may not work since the HTTP adapter doesn't parse Pi's token usage.

## Teardown

```powershell
# Stop containers, keep data
docker compose -f src/agents/docker-compose.yml down

# Stop containers and delete all data (fresh start)
docker compose -f src/agents/docker-compose.yml down -v
```
