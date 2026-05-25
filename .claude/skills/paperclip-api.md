# Paperclip API Skill

## Overview

Reference for working with the Paperclip orchestration API running in Docker at http://localhost:3100.

## Authentication

Paperclip runs in authenticated mode. All mutating API calls need:
1. A session cookie from sign-in
2. An `Origin: http://localhost:3100` header (CSRF protection)

Sign in:
```
POST /api/auth/sign-in/email
{"email":"admin@eval.local","password":"eval-admin-2026"}
```

PowerShell pattern:
```powershell
$ws = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$hdrs = @{ Origin = 'http://localhost:3100' }
$null = Invoke-WebRequest -Uri 'http://localhost:3100/api/auth/sign-in/email' `
    -Method POST -ContentType 'application/json' `
    -Body '{"email":"admin@eval.local","password":"eval-admin-2026"}' `
    -WebSession $ws -UseBasicParsing -Headers $hdrs
```

Then pass `-WebSession $ws -Headers $hdrs` on all subsequent calls.

## Bootstrap (fresh instance only)

The `bootstrap-ceo` CLI does not work inside Docker due to deployment mode detection issues. Instead, use the `bootstrap-invite.cjs` script:

```powershell
docker cp src/agents/bootstrap-invite.cjs paperclip-container:/tmp/bootstrap-invite.cjs
$url = docker exec paperclip-container node /tmp/bootstrap-invite.cjs
# Extract token from URL, then:
POST /api/invites/{token}/accept  {"requestType":"human"}
```

This directly inserts a bootstrap invite into the embedded postgres.

## Core Endpoints

### Health
```
GET /api/health
```
Returns `bootstrapStatus`, `deploymentMode`.

### Companies
```
GET  /api/companies                          # list
POST /api/companies                          # create: {"name":"..."}
```

### Agents
```
GET  /api/companies/{cid}/agents             # list agents
GET  /api/agents/{id}                        # get agent
POST /api/companies/{cid}/agent-hires        # create agent
PATCH /api/agents/{id}                       # update agent
POST /api/agents/{id}/pause                  # pause
POST /api/agents/{id}/resume                 # resume
POST /api/agents/{id}/terminate              # permanent deactivate
POST /api/agents/{id}/keys                   # create API key
POST /api/agents/{id}/heartbeat/invoke       # trigger manually
GET  /api/companies/{cid}/org                # org tree
```

### Agent Hire Body (HTTP adapter)
```json
{
  "name": "AgentName",
  "role": "role-slug",
  "title": "Display Title",
  "icon": "crown",
  "reportsTo": "parent-agent-id",
  "capabilities": "what the agent does",
  "adapterType": "http",
  "adapterConfig": {
    "url": "http://container-name:8080/invoke",
    "timeoutSec": 300
  },
  "runtimeConfig": {
    "heartbeat": {
      "enabled": false,
      "wakeOnDemand": true
    }
  }
}
```

### Icons
```
GET /llms/agent-icons.txt
```
Valid values: bot, cpu, brain, zap, rocket, code, terminal, shield, search, wrench, crown, gem, etc.

### Adapter Reference
```
GET /llms/agent-configuration.txt
GET /llms/agent-configuration/http.txt
```

## What Paperclip sends to HTTP adapter

POST to the configured `adapterConfig.url` with a JSON body containing:
- `renderedPrompt` or `prompt` - the agent's instructions
- `systemPrompt` - system-level context
- Agent/run metadata

The bridge (bridge.mjs) extracts `prompt` and `systemPrompt` from this payload and passes them to Pi via JSONL RPC.

## Docker Networking

All services share the `agents_default` Docker network:
- Paperclip reaches agents by container service name: `http://ceo:8080`, `http://researcher:8080`
- Agents reach Paperclip at `http://paperclip:3100`
- Host accesses Paperclip UI at `http://localhost:3100`
- Host accesses agent bridges at `http://localhost:8081`, `http://localhost:8082`

## Setup

Run `src/agents/setup.ps1` for automated first-time setup:
- Starts all containers
- Creates admin user and bootstraps instance
- Creates company
- Registers CEO and Researcher agents

For subsequent starts: `docker compose -f src/agents/docker-compose.yml up -d`
