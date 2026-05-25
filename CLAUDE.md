# CLAUDE.md

## What this is

Evaluation repo for running Paperclip agent orchestration with Pi agents via Docker containers on Windows. Workaround for the pi_local adapter's CLI argument length limit (see LEARNING.md).

## Repo layout

```
pi-bridge/bridge.mjs        HTTP-to-RPC bridge shim (Node, ~80 lines)
pi-bridge/Dockerfile         Container image — node:20-slim + Pi CLI
pi-bridge/docker-compose.yml Per-agent container config (ports, providers, API keys)
scripts/backup.sh            Backup Paperclip instance (bash/WSL)
scripts/wipe.sh              Wipe and reset Paperclip instance (bash/WSL)
LEARNING.md                  Running log of issues and workarounds
README.md                    Setup guide
```

## Key context

- Paperclip runs on host at http://localhost:3100 (embedded PostgreSQL)
- Bridge containers expose per-agent HTTP endpoints (8081, 8082, etc.)
- Paperclip talks to agents via its HTTP adapter, not pi_local
- Pi runs in RPC mode inside containers — JSONL over stdin/stdout
- bridge.mjs translates between HTTP POST and Pi's JSONL protocol
- The HTTP adapter is not in Paperclip's UI wizard — agents created via API only

## Platform

- Windows 11, PowerShell primary shell
- Bash scripts run under WSL2
- Docker Desktop for containers

## Working with the bridge

- bridge.mjs is a starting point, not production code — no auth, no streaming, no retry
- Environment variables: `BRIDGE_PORT`, `PI_PROVIDER`, `PI_MODEL`, plus provider API keys
- Each agent gets its own container instance from the same image
- Workspace mounted at `/workspace` inside containers

## Known bugs in upstream

- pi_local adapter CLI argument limit: issues #3114, #3180 on paperclip repo
- Execution contract text duplicated in wake payload (wastes tokens, accelerates limit)
- `paperclipai --version` can report stale version — check UI settings page instead

## Style

- No Microsoft formats. Markdown and CSV only.
- Keep scripts in bash (WSL). Keep bridge code in plain Node (no framework, no transpiler).
- Minimal dependencies — the bridge has zero npm deps by design.
