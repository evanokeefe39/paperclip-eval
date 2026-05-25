# System Architecture

## High-Level Diagram

```
 Host Machine (Windows 11)
 +---------------------------------------------------------+
 |  Browser                                                |
 |    http://localhost:3100  (Paperclip UI)                 |
 |    http://localhost:8081  (CEO bridge, debug)            |
 |    http://localhost:8082  (Researcher bridge, debug)     |
 +---------------------------------------------------------+
        |               |               |
        | :3100         | :8081         | :8082
        v               v               v
 Docker Network (paperclip-eval_default)
 +=========================================================+
 |                                                         |
 |  +-------------+    HTTP POST /invoke     +---------+   |
 |  |  Paperclip  | -----------------------> |   CEO   |   |
 |  |  Server     |    http://ceo:8080       | bridge  |   |
 |  |             |                          +---------+   |
 |  |  :3100      |    HTTP POST /invoke     +----------+  |
 |  |             | -----------------------> |Researcher|  |
 |  |             |  http://researcher:8080  |  bridge  |  |
 |  +-------------+                          +----------+  |
 |                                                         |
 +=========================================================+
```

## Components

### Paperclip Server

- Image: `ghcr.io/paperclipai/paperclip:latest`
- Role: Orchestrates agent tasks, manages companies, handles auth
- Mode: `authenticated` with `private` exposure
- Persistent data: `paperclip-data` volume at `/paperclip`

### Agent Bridge Containers (CEO, Researcher)

- Image: Custom, built from shared `Dockerfile` (node:22-slim + Pi CLI)
- Role: HTTP-to-RPC translation layer between Paperclip and Pi
- Stateless per-request: each invocation spawns a fresh Pi process
- Each container runs `bridge.mjs` as its entrypoint

### Pi CLI

- Installed globally in agent containers via `@earendil-works/pi-coding-agent`
- Runs in RPC mode (`--mode rpc --no-session`)
- Communicates via JSONL over stdin/stdout
- Provider and model configured per-container via environment variables

## Docker Networking

All services share a single compose-managed network. Internal communication uses service names as hostnames on port 8080 (the container-internal port). Published ports are for host access only.

| Service    | Internal Address         | Published Port |
|------------|--------------------------|----------------|
| paperclip  | paperclip:3100           | 3100           |
| ceo        | ceo:8080                 | 8081           |
| researcher | researcher:8080          | 8082           |

Paperclip registers agent adapter URLs using internal addresses (`http://ceo:8080/invoke`, `http://researcher:8080/invoke`). Never use `localhost` or `host.docker.internal` for inter-container communication.

## Container Lifecycle

`docker-compose.yml` manages all three containers. Agent containers depend on Paperclip (`service_started` condition). All containers have `restart: unless-stopped`.

Agent containers are stateless: each HTTP request to `/invoke` spawns a new Pi process that lives for the duration of that request. No persistent connections, no session state. Workspace volumes exist for Pi to read/write files during execution but are not critical state.

Resource limits: agent containers are capped at 512MB memory.

## Data Flow

```
Paperclip                    Bridge Container               Pi Process
   |                              |                            |
   |--- POST /invoke ----------->|                            |
   |    {prompt, systemPrompt}   |                            |
   |                              |--- spawn pi (RPC mode) -->|
   |                              |--- write prompt to stdin ->|
   |                              |                            |
   |                              |<-- extension_ui_request ---|  (optional)
   |                              |<-- agent_start ------------|
   |                              |<-- message_update(s) ------|
   |                              |<-- agent_end --------------|
   |                              |                            |
   |                              |--- stdin.end() ----------->|
   |                              |                         (exit)
   |<-- 200 {output, events} ----|                            |
```

## Agent Configuration

Each agent has its own configuration directory copied into the container at build time:

```
src/agents/{agent_name}/
  .pi/agent/config.yml     Model roles, retry/fallback chains, feature flags
  .pi/agent/models.json    Provider credentials and endpoint config
  .pi/agent/settings.json  Pi settings
  AGENTS.md                Agent persona and instructions
```

The `config.yml` defines model roles (smol, default, agentic, plan, review, commit) with fallback chains across providers (groq, nvidia, minimax, deepseek, cerebras, openrouter, mistral).
