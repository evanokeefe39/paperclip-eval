# Paperclip Integration

## Why HTTP Adapter

The `pi_local` adapter assembles the entire system prompt (AGENTS.md + execution contract + wake payload + continuation summary) as a CLI argument. On Windows, this hits the ~8,191 character `cmd.exe` limit. Even on Linux, the payload grows with each heartbeat as continuation summaries accumulate.

The HTTP adapter avoids this entirely: prompts are sent as JSON POST bodies with no size constraint. This is the primary reason this project uses Docker containers running server.mjs (Pi SDK AgentSession) rather than the built-in pi_local adapter.

References: Paperclip issues [#3114](https://github.com/paperclipai/paperclip/issues/3114), [#3180](https://github.com/paperclipai/paperclip/issues/3180).

## Agent Registration

Agents are registered via the Paperclip API with adapter type `http`. The adapter config points to the Docker-internal URL (service name + internal port):

```json
{
  "name": "CEO",
  "role": "ceo",
  "adapterType": "http",
  "adapterConfig": {
    "url": "http://ceo:8080/invoke",
    "timeoutSec": 300
  },
  "runtimeConfig": {
    "heartbeat": {
      "enabled": true,
      "intervalSec": 120,
      "wakeOnDemand": true
    }
  }
}
```

API endpoint: `POST /api/companies/{companyId}/agent-hires`

Heartbeat runs every 120s for work discovery. `wakeOnDemand` supplements heartbeat with reactive wakes for lifecycle events (blockers resolved, children completed, comments, approvals). Note: initial issue assignment does NOT trigger a wake — agents discover new assignments via heartbeat polling or explicit invoke (`POST /api/agents/{id}/heartbeat/invoke`).

## Bootstrap Flow

Paperclip in authenticated mode requires an admin user before agents can be registered. The bootstrap sequence (automated by `setup.ps1`):

```
1. docker compose up -d --build
2. Wait for Paperclip /api/health to return 200
3. Sign up admin user via POST /api/auth/sign-up/email
4. Copy bootstrap-invite.cjs into Paperclip container
5. Execute bootstrap-invite.cjs inside container (inserts invite into DB)
6. Accept invite via POST /api/invites/{token}/accept
7. Create company via POST /api/companies
8. Register CEO agent via POST /api/companies/{id}/agent-hires
9. Register Researcher agent via POST /api/companies/{id}/agent-hires
```

### Why bootstrap-invite.cjs exists

The `paperclipai auth bootstrap-ceo` CLI command cannot run inside Docker. It has hardcoded deployment mode detection that forces `local_trusted` regardless of environment variables or config files. Since `local_trusted` requires loopback binding (incompatible with Docker networking), the CLI refuses to create the bootstrap invite.

`bootstrap-invite.cjs` bypasses the CLI by inserting directly into the embedded PostgreSQL:
- Connection: `postgres://paperclip:paperclip@127.0.0.1:54329/paperclip`
- Token format: `pcp_bootstrap_` + 24 random hex bytes
- Stored as SHA-256 hash in the `invites` table

### What else does not work in Docker

- `paperclipai onboard --yes` forces `local_trusted` mode and starts a second server on loopback
- `local_trusted` deployment mode requires `server.bind=loopback`, incompatible with container port forwarding
- The CLI's deployment mode detection overrides config.json and environment variables

## Authentication Model

Paperclip runs in `authenticated` mode with `private` exposure:
- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`
- `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`
- `BETTER_AUTH_SECRET` set via environment variable
- Session-based auth (cookies) for API access
- Admin credentials: `admin@eval.local` / `eval-admin-2026` (eval-only, not production)

## API Endpoints Used

### Setup and bootstrap

| Endpoint                                  | Method | Purpose                     |
|-------------------------------------------|--------|-----------------------------|
| /api/health                               | GET    | Readiness check             |
| /api/auth/sign-up/email                   | POST   | Create admin account        |
| /api/auth/sign-in/email                   | POST   | Authenticate (session cookie) |
| /api/invites/{token}/accept               | POST   | Accept bootstrap invite     |
| /api/companies                            | POST   | Create company              |
| /api/companies/{id}/agent-hires           | POST   | Register agent              |
| /api/companies/{cid}/secrets              | POST   | Create encrypted secret     |
| /api/plugins/{id}/config                  | POST   | Configure installed plugin  |

### Used by plugin tools (agent runtime)

| Endpoint                                  | Method | Purpose                     |
|-------------------------------------------|--------|-----------------------------|
| /api/plugins/tools                        | GET    | Discover plugin-registered tools |
| /api/plugins/tools/execute                | POST   | Invoke a plugin tool        |

### Used by Paperclip skills extension (agent runtime)

| Endpoint                                                    | Method | Purpose                        |
|-------------------------------------------------------------|--------|--------------------------------|
| /api/agents/me                                              | GET    | Agent identity                 |
| /api/agents/me/inbox-lite                                   | GET    | Agent inbox                    |
| /api/agents/{id}                                            | GET    | Get agent details              |
| /api/companies/{cid}/agents                                 | GET    | List agents                    |
| /api/companies/{cid}/issues                                 | GET    | List issues (with filters)     |
| /api/companies/{cid}/issues                                 | POST   | Create issue                   |
| /api/issues/{id}                                            | GET    | Get issue                      |
| /api/issues/{id}                                            | PATCH  | Update issue (+comment/resume) |
| /api/issues/{id}/checkout                                   | POST   | Checkout issue for agent       |
| /api/issues/{id}/release                                    | POST   | Release issue checkout         |
| /api/issues/{id}/heartbeat-context                          | GET    | Compact issue context          |
| /api/issues/{id}/comments                                   | GET    | List comments                  |
| /api/issues/{id}/comments                                   | POST   | Add comment (+resume/interrupt)|
| /api/issues/{id}/comments/{cid}                             | GET    | Get single comment             |
| /api/issues/{id}/documents                                  | GET    | List documents                 |
| /api/issues/{id}/documents/{key}                            | GET    | Get document                   |
| /api/issues/{id}/documents/{key}                            | PUT    | Create/update document         |
| /api/issues/{id}/documents/{key}/revisions                  | GET    | List document revisions        |
| /api/issues/{id}/documents/{key}/revisions/{rid}/restore    | POST   | Restore document revision      |
| /api/issues/{id}/interactions                               | POST   | Create interaction (tasks/questions/confirm) |
| /api/issues/{id}/approvals                                  | GET    | List issue approvals           |
| /api/issues/{id}/approvals                                  | POST   | Link approval to issue         |
| /api/issues/{id}/approvals/{aid}                            | DELETE | Unlink approval from issue     |
| /api/companies/{cid}/projects                               | GET    | List projects                  |
| /api/projects/{id}                                          | GET    | Get project                    |
| /api/companies/{cid}/goals                                  | GET    | List goals                     |
| /api/goals/{id}                                             | GET    | Get goal                       |
| /api/companies/{cid}/approvals                              | GET    | List approvals                 |
| /api/companies/{cid}/approvals                              | POST   | Create approval                |
| /api/approvals/{id}                                         | GET    | Get approval                   |
| /api/approvals/{id}/approve                                 | POST   | Approve                        |
| /api/approvals/{id}/reject                                  | POST   | Reject                         |
| /api/approvals/{id}/request-revision                        | POST   | Request revision               |
| /api/approvals/{id}/resubmit                                | POST   | Resubmit                       |
| /api/approvals/{id}/issues                                  | GET    | List approval's linked issues  |
| /api/approvals/{id}/comments                                | GET    | List approval comments         |
| /api/approvals/{id}/comments                                | POST   | Add approval comment           |
| /api/execution-workspaces/{id}/runtime-services/{action}    | POST   | Control workspace services     |

### Used by server.mjs (cost reporting)

| Endpoint                                                    | Method | Purpose                        |
|-------------------------------------------------------------|--------|--------------------------------|
| /api/auth/sign-in/email                                     | POST   | Auth for cost reporting (admin credentials, setup-time only) |
| /api/companies/{cid}/cost-events                            | POST   | Report token usage per run     |

## Paperclip Skills (Platform Tools for HTTP Adapter Agents)

Local adapters (claude_local, pi_local) automatically receive Paperclip's MCP tools via a built-in MCP server subprocess. The HTTP adapter does not — it simply POSTs a JSON payload to the agent URL with no tool injection.

To give HTTP-adapter agents the same coordination capabilities, the project includes a Pi extension at `src/agents/extensions/paperclip/index.ts` that re-implements all 40 Paperclip MCP tools as Pi-native tools. These tools wrap the Paperclip REST API using Bearer token auth with per-agent API keys.

### How it works

1. `extensions/paperclip/_client.ts` exports a shared API client that authenticates via Bearer token using the per-agent `PAPERCLIP_API_KEY` environment variable
2. `extensions/paperclip/index.ts` is a Pi extension that registers 40 tools covering the full Paperclip API surface
3. Pi discovers the extension natively from `/root/.pi/agent/extensions/paperclip/index.ts` — no `-e` flag required
4. The Dockerfile copies `extensions/paperclip/` into the container image at the Pi-native discovery path

### Tool categories

| Category | Tools | Key operations |
|----------|-------|----------------|
| Identity & inbox | 4 | paperclip_me, paperclip_inbox, list/get agents |
| Issues | 7 | list, get, create, update, checkout, release, heartbeat context |
| Comments | 3 | list, get, add (with resume/reopen/interrupt flags) |
| Documents | 4 | list, get, upsert, revisions, restore |
| Projects & goals | 4 | list/get each |
| Interactions | 3 | suggest_tasks, ask_user_questions, request_confirmation |
| Approvals | 8 | CRUD, decisions (approve/reject/revise/resubmit), link/unlink to issues |
| Workspace runtime | 3 | get runtime, control services, wait for service |
| Escape hatch | 1 | paperclip_api_request — raw method/path/body to any /api endpoint |

### API path mapping

Tool paths match the upstream MCP server source at `packages/mcp-server/src/tools.ts`. All paths are relative to `/api` (the client prepends `${PAPERCLIP_API_URL}/api`). Examples:

- `paperclip_me` → `GET /api/agents/me`
- `paperclip_list_issues` → `GET /api/companies/{cid}/issues?status=...&q=...`
- `paperclip_create_issue` → `POST /api/companies/{cid}/issues`
- `paperclip_update_issue` → `PATCH /api/issues/{id}` (accepts comment, resume, interrupt fields)
- `paperclip_add_comment` → `POST /api/issues/{id}/comments` (resume=true wakes agent)
- `paperclip_checkout_issue` → `POST /api/issues/{id}/checkout`
- `paperclip_suggest_tasks` → `POST /api/issues/{id}/interactions` (kind: suggest_tasks)

### Environment variables

Same as the escalate v2 extension — already configured per-container in docker-compose.yml:

| Variable | Purpose |
|----------|---------|
| PAPERCLIP_API_URL | Base URL (e.g., http://paperclip:3100) |
| PAPERCLIP_API_KEY | Per-agent API key (Bearer token auth) |
| PAPERCLIP_AGENT_ID | This agent's UUID (for resolveAgentId default) |
| PAPERCLIP_COMPANY_ID | Company UUID (for resolveCompanyId default) |

If PAPERCLIP_API_URL or PAPERCLIP_API_KEY is missing, the extension silently skips registration.

### Testing

- Unit tests: `node tests/paperclip-tools/unit-test.mjs` (162 tests against fake HTTP server)
- Integration tests: `bash tests/paperclip-tools/integration-test.sh` (requires live Docker stack)

## Paperclip Behavioral Skills (Heartbeat Protocol)

Beyond MCP tools, Paperclip provides bundled behavioral skills — SKILL.md markdown files that teach agents how to operate within Paperclip's coordination model (heartbeat protocol, checkout/release discipline, delegation patterns, memory).

Local adapters receive these skills automatically via `syncSkills` (symlinked into agent CLI discovery path at `~/.pi/agent/skills/`). The HTTP adapter does not implement `syncSkills`, so HTTP-adapted agents get neither tools nor skills by default.

### How this project provides skills to HTTP adapter agents

1. `setup.sh` fetches SKILL.md files (and their reference documents) from `github.com/paperclipai/paperclip/master/skills/` into `src/agents/skills/paperclip-skills/`
2. The Dockerfile copies them into `/root/.pi/agent/skills/` (the SDK's discovery path)
3. Pi SDK's `DefaultResourceLoader` discovers skills automatically at session creation
4. Pi loads skills with progressive disclosure: only the skill's `description` from frontmatter is injected into context; the full SKILL.md content is loaded on demand when the agent decides the skill is relevant

### Skills loaded

| Skill | Purpose | Reference files |
|-------|---------|-----------------|
| `paperclip` | 9-step heartbeat protocol, authentication, checkout/release, comment handling, delegation, planning, API reference | api-reference.md, company-skills.md, issue-workspaces.md, routines.md, workflows.md |
| `paperclip-converting-plans-to-tasks` | Translating plans into executable issue trees with correct specialty assignments, dependencies, and parallelization | (none) |
| `para-memory-files` | Three-layer persistent memory: PARA knowledge graph, daily notes, tacit knowledge | schemas.md |

### Configuration

The `PAPERCLIP_SKILLS` environment variable controls which skills are loaded (comma-separated names). Defaults to all three. Override per-agent via the agent's `.env` file.

Skills are fetched fresh from GitHub on every `setup.sh` run and are gitignored (not source-controlled). The `.dockerignore` has an explicit `!skills/paperclip-skills/` whitelist since `*.md` is otherwise excluded from the build context.

## Plugins

Paperclip supports a plugin system where community or first-party plugins run inside the Paperclip server process. Plugins register tools via the `agent.tools.register` capability, subscribe to platform events (issue creation, approval lifecycle, agent errors), and extend the UI with custom views.

Plugin tools are server-side only. They are not injected into HTTP adapter wake payloads. This means HTTP adapter agents (our setup) cannot call plugin tools through the normal tool-calling flow that local adapters enjoy.

### How local adapter agents access plugin tools

For agents using a local adapter (claude_local, pi_local), Paperclip delivers plugin knowledge through managed "skills" — prompt and script packages installed at `~/.pi/agent/skills/` inside the agent process. The skill prompt describes the tool interface; the script handles the call. This is automatic and requires no configuration beyond installing the plugin.

### How HTTP adapter agents access plugin tools

HTTP adapter agents must call two REST endpoints directly:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| /api/plugins/tools | GET | Returns all tools registered by all active plugins, including input schemas |
| /api/plugins/tools/execute | POST | Invokes a specific plugin tool |

The execute endpoint accepts a JSON body:

```json
{
  "tool": "{pluginId}:tool_name",
  "parameters": { ... },
  "runContext": {
    "agentId": "...",
    "issueId": "...",
    "companyId": "..."
  }
}
```

The tool name is prefixed with the plugin's UUID and a colon. The `runContext` provides the calling agent's identity and current issue so the plugin can act on behalf of that agent.

In this project, the `extensions/paperclip/_client.ts` shared API client handles authentication for these calls using the same Bearer token mechanism used by the Paperclip skills extension.

## Discord Plugin

### Overview

`paperclip-plugin-discord` (v0.7.3, by mvanhorn) is installed in the Paperclip instance with plugin ID `60ba54d5-e922-43b9-bd50-a72130e0c017`. It bridges Paperclip's coordination layer to Discord, providing human-in-the-loop escalation via Discord threads, interactive buttons for approvals and confirmations, and automatic event notifications.

### Plugin lifecycle

The plugin transitions through three states:

1. **installed** -- plugin code loaded, no config
2. **ready** -- valid config applied, not yet connected
3. **active** -- Discord gateway connection established, tools available

### Configuration

Configuration is applied via `POST /api/plugins/{id}/config` with a JSON body containing `configJson`:

| Field | Required | Description |
|-------|----------|-------------|
| discordBotTokenRef | yes | Secret UUID referencing an encrypted Discord bot token |
| defaultChannelId | yes | Discord channel ID for general notifications |
| defaultGuildId | no | Discord server (guild) ID |
| escalationChannelId | no | Dedicated channel for escalation threads |
| approvalsChannelId | no | Dedicated channel for approval requests |
| errorsChannelId | no | Dedicated channel for agent error alerts |
| paperclipBoardApiKeyRef | no | Secret UUID for API key (needed in authenticated mode) |

Secrets are created via `POST /api/companies/{cid}/secrets` with the plaintext value. Paperclip encrypts the value and returns a UUID. That UUID is used as the `*Ref` value in plugin config.

### Event subscriptions

The plugin subscribes to Paperclip platform events and posts Discord embeds automatically:

- `issue.created` -- new issue notification with assignee and priority
- `approval.created` -- approval request with accept/reject buttons
- `agent.error` -- error alert with stack trace summary

### Plugin tools

The plugin registers the following tools (accessible via `/api/plugins/tools/execute`):

| Tool | Purpose |
|------|---------|
| `escalate_to_human` | Creates a Discord thread with conversation context, suggested replies, and interactive buttons. Supports configurable timeout. |

Human replies in Discord threads are relayed back as Paperclip issue comments. The agent is woken via the `PAPERCLIP_WAKE_COMMENT_ID` mechanism when a human responds.

### Escalation v2

The escalate extension at `extensions/escalate.ts` (v2) provides a unified `escalate` tool registered as a Pi extension. It replaces the v1 implementation (preserved at `extensions/escalate-v1.ts`, not loaded).

The v2 extension selects its backend based on the `PAPERCLIP_DISCORD_PLUGIN_ID` environment variable:

| PAPERCLIP_DISCORD_PLUGIN_ID | Backend | Behavior |
|-----------------------------|---------|----------|
| unset | local | Creates an issue with "escalation" label, then calls `request_confirmation` (or `ask_user_questions` if structured inputs provided) via the Paperclip interactions API. Sets `continuationPolicy=wake_assignee` so the agent resumes when the human responds. |
| set (plugin UUID) | discord | Calls `POST /api/plugins/tools/execute` with tool `{pluginId}:escalate_to_human`, delegating the full escalation flow to the Discord plugin. |

Both backends use the shared `extensions/paperclip/_client.ts` API client for authentication. The tool interface is identical regardless of backend -- agents call `escalate` with the same parameters and get consistent behavior.

| Variable | Purpose |
|----------|---------|
| PAPERCLIP_DISCORD_PLUGIN_ID | Plugin UUID; presence selects Discord backend |
| PAPERCLIP_API_URL | Base URL for API calls |
| PAPERCLIP_API_KEY | Per-agent API key (Bearer token auth) |
| PAPERCLIP_AGENT_ID | Calling agent's UUID |
| PAPERCLIP_COMPANY_ID | Company UUID |

## Heartbeat and Health Checks

Paperclip periodically pings `/health` on registered agent URLs to verify they are reachable. The server responds with status, uptime, and configuration metadata. If an agent becomes unreachable, Paperclip marks it unavailable for task assignment.

Docker's own HEALTHCHECK (defined in the Dockerfile) independently monitors server availability with a 10-second interval and 15-second start period.
