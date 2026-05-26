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
 |  |  (includes  | -----------------------> |Researcher|  |
 |  |   Discord   |  http://researcher:8080  |  bridge  |  |
 |  |   plugin)   |                          +----------+  |
 |  |             |                                        |
 |  |             |--- Discord API -----> Discord Server   |
 |  +-------------+                                        |
 |                                                         |
 +=========================================================+
```

## Components

### Paperclip Server

- Image: `ghcr.io/paperclipai/paperclip:latest`
- Role: Orchestrates agent tasks, manages companies, handles auth
- Mode: `authenticated` with `private` exposure
- Persistent data: `paperclip-data` volume at `/paperclip`

### Agent Bridge Containers (CEO, Researcher, Coder, Data, Writer, QA)

- Image: Custom, built from shared `Dockerfile` (node:22-slim + Pi CLI)
- Role: HTTP-to-RPC translation layer between Paperclip and Pi
- Stateless per-request: each invocation spawns a fresh Pi process
- Each container runs `bridge.mjs` as its entrypoint
- Pi extensions loaded at spawn: web-search, web-fetch, escalate (v2, local/discord backend), web-scrape, paperclip-tools, artifacts, logging
- pi-otel installed for automatic OTel tracing (pi.interaction → pi.turn → pi.llm_request / pi.tool.* spans)

### Discord Plugin (paperclip-plugin-discord v0.7.3)

- Runs inside the Paperclip container, not in agent containers
- Installed as a Paperclip plugin; managed via the plugin admin API
- Registers 6 server-side tools in an in-memory PluginToolRegistry: `escalate_to_human`, `discord_signals`, `handoff_to_agent`, `discuss_with_agent`, `register_custom_command`, `register_watch`
- These tools are not injected into HTTP adapter agents. They are callable only through the plugin tool REST API (see Plugin Tool API below).
- Subscribes to Paperclip events (`issue.created`, `approval.created`, `agent.error`) and posts Discord embeds to a configured channel
- Runs 5 scheduled jobs: intelligence scan, escalation timeout, watch check, budget threshold, daily digest
- Configuration stored via `POST /api/plugins/{id}/config` with Discord bot token (stored as a Paperclip secret), channel ID, and guild ID

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
  .pi/agent/auth.json      Provider auth (gitignored, copy from root auth.json)
  agent.json               Agent registration metadata (name, role, adapter config)
  AGENTS.md                Agent persona and instructions
```

The `config.yml` defines model roles (smol, default, agentic, plan, review, commit) with fallback chains across providers (groq, nvidia, minimax, deepseek, cerebras, openrouter, mistral).

## Extension Architecture

Pi extensions are TypeScript files loaded via `-e` flags at spawn time. They register tools that the LLM can call during execution.

```
/app/extensions/             Custom tools (web search, fetch, escalate, etc.)
/app/skills/                 Paperclip platform tools (REST API wrappers)
  client.ts                  Shared auth client — session cookie with 25-min cache
  paperclip-tools.ts         40 tools matching upstream MCP server (issues, comments,
                             documents, agents, projects, goals, interactions, approvals,
                             workspace runtime, escape hatch)
```

The Paperclip skills exist because the HTTP adapter does not inject MCP tools automatically. Local adapters (claude_local, pi_local) get these tools via a built-in MCP server subprocess. HTTP adapter agents must call the REST API directly, which is what the skills extension does.

Extensions can import from relative paths (e.g., `paperclip-tools.ts` imports from `./client.js`). Pi resolves these at load time. Cross-directory imports also work (e.g., `escalate.ts` imports from `../skills/client.js`).

### Escalate Extension (v2)

The `escalate.ts` extension registers a single `escalate` tool that presents a uniform interface to agents regardless of the notification backend. Backend selection is automatic based on environment:

- Discord mode: when `PAPERCLIP_DISCORD_PLUGIN_ID` is set, the tool calls `POST /api/plugins/tools/execute` with `{pluginId}:escalate_to_human`. The plugin posts an interactive Discord embed with buttons. Human responses flow back through Discord threads into Paperclip issue comments.
- Local mode: when the env var is absent, the tool creates a Paperclip issue with an `escalation` label and attaches either a `request_confirmation` or `ask_user_questions` interaction (depending on whether the agent supplied structured inputs). The agent is paused and waits for human response in the Paperclip UI.

Both paths use the shared `skills/client.ts` for session-cookie auth. The old v1 implementation is preserved as `escalate-v1.ts`.

### Deep Research Module

The `deep-research.ts` extension delegates to a 15-file submodule at `extensions/deep-research/`. Key architectural patterns:

- **Async I/O throughout**: `store.ts`, `checkpoint.ts`, and `query.ts` use `fs/promises` for all file operations (no blocking the event loop during multi-wave research runs). The only sync calls are `existsSync` guards and `readFileSync` in the checkpoint constructor for initial load.
- **Concurrency control**: `semaphore.ts` provides a counting semaphore that caps concurrent LLM calls (`max_concurrent_llm`) and concurrent page fetches (`max_concurrent_fetch`), configured via named constants in `config.ts`.
- **Validated LLM output**: `llm.ts` `structuredCall` accepts a validator callback (from `validate.ts`) instead of bare `as T` casts, catching malformed LLM responses at the call site rather than propagating them.
- **Shared utilities**: `utils.ts` exports `sleep` and `stripHtml`, eliminating duplicated inline implementations across sweep, engine, and llm modules.
- **Config as named constants**: `config.ts` centralizes all magic numbers (content length thresholds, snippet caps, chunk sizes, concurrency limits) as exported constants with documenting names.

## Plugin Tool API

Paperclip plugins register tools in a server-side `PluginToolRegistry`. These tools are not injected into agent contexts (HTTP adapter agents do not receive them). Instead, agent-side code calls them through two REST endpoints:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/plugins/tools` | GET | List all registered plugin tools (name, description, schema) |
| `/api/plugins/tools/execute` | POST | Execute a plugin tool by qualified name |

The execute endpoint expects:

```json
{
  "tool": "{pluginId}:{toolName}",
  "parameters": { ... },
  "runContext": {
    "agentId": "...",
    "companyId": "..."
  }
}
```

The escalate extension (v2) uses this endpoint to invoke `escalate_to_human` when Discord mode is active. Other plugin tools (`discord_signals`, `handoff_to_agent`, `discuss_with_agent`, `register_custom_command`, `register_watch`) are available through the same mechanism but are not yet wrapped in agent-side extensions.

### Escalation Data Flow (Discord Mode)

```
Agent Container                Paperclip Server               Discord
   |                              |                              |
   |--- escalate tool called ---->|                              |
   |    POST /api/plugins/        |                              |
   |    tools/execute             |                              |
   |    {pluginId}:escalate_      |                              |
   |    to_human                  |--- Discord embed ----------->|
   |                              |    (buttons: approve/reject) |
   |<-- escalationId ------------|                              |
   |                              |                              |
   |    (agent paused or          |<-- button click / reply -----|
   |     waiting)                 |                              |
   |                              |--- issue comment created --->|
   |                              |--- agent wake (comment ID) ->|
   |<-- resumed with response ----|                              |
```

### Escalation Data Flow (Local Mode)

```
Agent Container                Paperclip Server               Paperclip UI
   |                              |                              |
   |--- escalate tool called ---->|                              |
   |    POST /companies/{id}/     |                              |
   |    issues (create issue)     |                              |
   |                              |                              |
   |--- POST /issues/{id}/       |                              |
   |    interactions              |                              |
   |    (request_confirmation     |                              |
   |     or ask_user_questions)   |                              |
   |                              |                              |
   |--- POST /agents/{id}/pause  |                              |
   |                              |                              |
   |<-- issue + interaction ------|--- displayed in UI --------->|
   |    created                   |                              |
   |                              |<-- human responds in UI -----|
   |                              |--- agent wake -------------->|
   |<-- resumed with response ----|                              |
```
