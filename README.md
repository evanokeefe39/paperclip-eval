# Paperclip + Pi: Containerized Agent Setup

Evaluation setup for running [Paperclip](https://github.com/paperclipai/paperclip) with [Pi](https://github.com/badlogic/pi-mono) agents in Docker containers, bypassing the Windows CLI argument length limit that breaks the default pi_local adapter.

## Why containers instead of pi_local

Paperclip's pi_local adapter passes the entire system prompt as a `--append-system-prompt` CLI argument. On Windows this hits the ~8,191 character cmd.exe limit, causing either "The command line is too long" errors or silent prompt fragmentation. See [LEARNING.md](./LEARNING.md) for details.

The containerized approach uses Paperclip's HTTP adapter instead. Prompts go as JSON over HTTP — no shell, no argument limits.

## Architecture

```
Paperclip server (host or container)
    │
    │  HTTP POST (JSON payload with prompt + context)
    ▼
┌─────────────────────────┐
│  Pi agent container      │
│  HTTP-to-RPC bridge      │  ← pi-bridge/bridge.mjs
│    │          ▲           │
│    │ stdin    │ stdout    │
│    ▼          │           │
│  pi --mode rpc            │
└─────────────────────────┘
```

Each agent gets its own container from the same image. The bridge translates HTTP requests into Pi's JSONL stdin/stdout protocol.

## Prerequisites

- Docker and Docker Compose
- Node.js 20+
- Git
- A working LLM API key (OpenRouter, DeepSeek, etc.)

## Quick start

### 1. Install Paperclip

```powershell
npx paperclipai onboard --yes
```

Starts the server at http://localhost:3100 with embedded PostgreSQL.

### 2. Install Pi

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Verify standalone:

```powershell
pi --mode rpc --no-session --provider openrouter --model deepseek/deepseek-chat-v3-0324:free
```

Type `{"type":"prompt","message":"Say hello"}` and press Enter. You should see JSONL events ending with `agent_end`. Ctrl+C to exit.

### 3. Build and start bridge containers

```powershell
cd pi-bridge
docker compose up -d --build
```

Edit `pi-bridge/docker-compose.yml` to configure providers, models, and API keys per agent. See the file for the full schema.

### 4. Configure Paperclip to use HTTP adapter

The HTTP adapter is built in but not in the UI wizard. Create agents via API:

```powershell
curl -X POST http://localhost:3100/api/companies/<COMPANY_ID>/agents ^
  -H "Content-Type: application/json" ^
  -d "{
    \"name\": \"CEO\",
    \"role\": \"ceo\",
    \"adapterType\": \"http\",
    \"adapterConfig\": {
      \"url\": \"http://host.docker.internal:8081/invoke\",
      \"method\": \"POST\",
      \"headers\": { \"Content-Type\": \"application/json\" },
      \"timeoutMs\": 300000,
      \"payloadTemplate\": {
        \"prompt\": \"{{renderedPrompt}}\",
        \"systemPrompt\": \"{{systemPrompt}}\",
        \"agentId\": \"{{agent.id}}\",
        \"runId\": \"{{run.id}}\"
      }
    }
  }"
```

Replace `<COMPANY_ID>` with your company UUID from the Paperclip UI. If Paperclip also runs in Docker, use the container service name instead of `host.docker.internal`.

### 5. Validate

**Bridge health check:**

```powershell
curl http://localhost:8081/invoke ^
  -H "Content-Type: application/json" ^
  -d "{\"prompt\": \"Say hello and confirm you are working.\"}"
```

**Paperclip heartbeat test:** Create an issue in the UI, assign to your HTTP-adapter agent, trigger a heartbeat from the Runs page. Check the transcript for a coherent, unfragmented response.

**Argument length test:** Create a task with 500+ words. If the run succeeds with a coherent response, the CLI limit is no longer a factor.

## Known limitations

- HTTP adapter not in UI wizard — agents must be created via API or config edit
- Session persistence across heartbeats requires mounting a volume and passing `--session-dir` to Pi
- Bridge shim is a starting point, not production-ready (no auth, no streaming, no retry)
- Payload template variables (`{{renderedPrompt}}`, `{{systemPrompt}}`) need verification against your Paperclip version
- Cost tracking may not work since the HTTP adapter doesn't parse Pi's token usage

## File inventory

| File | Purpose |
|------|---------|
| README.md | This file |
| CLAUDE.md | Agent instructions and project context |
| LEARNING.md | Running log of issues found during evaluation |
| pi-bridge/bridge.mjs | HTTP-to-RPC bridge shim |
| pi-bridge/Dockerfile | Container image for Pi agents |
| pi-bridge/docker-compose.yml | Multi-agent container orchestration |
| scripts/ | Utility scripts (backup, wipe) |
