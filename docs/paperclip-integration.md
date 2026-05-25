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

| Endpoint                                  | Method | Purpose                     |
|-------------------------------------------|--------|-----------------------------|
| /api/health                               | GET    | Readiness check             |
| /api/auth/sign-up/email                   | POST   | Create admin account        |
| /api/auth/sign-in/email                   | POST   | Authenticate (if exists)    |
| /api/invites/{token}/accept               | POST   | Accept bootstrap invite     |
| /api/companies                            | POST   | Create company              |
| /api/companies/{id}/agent-hires           | POST   | Register agent              |

## Heartbeat and Health Checks

Paperclip periodically pings `/health` on registered agent URLs to verify they are reachable. The bridge responds with status, uptime, and configuration metadata. If an agent becomes unreachable, Paperclip marks it unavailable for task assignment.

Docker's own HEALTHCHECK (defined in the Dockerfile) independently monitors bridge availability with a 10-second interval and 15-second start period.
