# Paperclip Integration

## Why HTTP Adapter

The `pi_local` adapter assembles the entire system prompt (AGENTS.md + execution contract + wake payload + continuation summary) as a CLI argument. On Windows, this hits the ~8,191 character `cmd.exe` limit. Even on Linux, the payload grows with each heartbeat as continuation summaries accumulate.

The HTTP adapter avoids this entirely: prompts are sent as JSON POST bodies with no size constraint. This is the primary reason this project uses Docker containers running bridge.mjs rather than the built-in pi_local adapter.

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
      "enabled": false,
      "wakeOnDemand": true
    }
  }
}
```

API endpoint: `POST /api/companies/{companyId}/agent-hires`

Heartbeat is disabled; agents are woken on demand. Paperclip still pings `/health` on registered agents to verify availability.

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

## Paperclip Skills (Platform Tools for HTTP Adapter Agents)

Local adapters (claude_local, pi_local) automatically receive Paperclip's MCP tools via a built-in MCP server subprocess. The HTTP adapter does not — it simply POSTs a JSON payload to the agent URL with no tool injection.

To give HTTP-adapter agents the same coordination capabilities, the project includes a Pi extension at `src/agents/skills/paperclip-tools.ts` that re-implements all 40 Paperclip MCP tools as Pi-native tools. These tools wrap the Paperclip REST API using session-cookie auth.

### How it works

1. `skills/client.ts` exports a shared API client that authenticates via `POST /api/auth/sign-in/email` and caches the session cookie for 25 minutes
2. `skills/paperclip-tools.ts` is a Pi extension that registers 40 tools covering the full Paperclip API surface
3. The bridge loads the extension via `-e /app/skills/paperclip-tools.ts` in the Pi spawn args
4. The Dockerfile copies `skills/` into `/app/skills/` in the container image

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

Same as the escalate extension — already configured per-container in docker-compose.yml:

| Variable | Purpose |
|----------|---------|
| PAPERCLIP_API_URL | Base URL (e.g., http://paperclip:3100) |
| PAPERCLIP_ADMIN_EMAIL | Auth email |
| PAPERCLIP_ADMIN_PASS | Auth password |
| PAPERCLIP_AGENT_ID | This agent's UUID (for resolveAgentId default) |
| PAPERCLIP_COMPANY_ID | Company UUID (for resolveCompanyId default) |

If any of the three auth vars (URL, email, password) are missing, the extension silently skips registration.

### Testing

- Unit tests: `node tests/paperclip-tools/unit-test.mjs` (162 tests against fake HTTP server)
- Integration tests: `bash tests/paperclip-tools/integration-test.sh` (requires live Docker stack)

## Heartbeat and Health Checks

Paperclip periodically pings `/health` on registered agent URLs to verify they are reachable. The bridge responds with status, uptime, and configuration metadata. If an agent becomes unreachable, Paperclip marks it unavailable for task assignment.

Docker's own HEALTHCHECK (defined in the Dockerfile) independently monitors bridge availability with a 10-second interval and 15-second start period.
