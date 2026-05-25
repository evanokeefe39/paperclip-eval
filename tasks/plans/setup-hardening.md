# Setup Script Hardening Plan

Rewrite bootstrap/setup tooling for robustness, portability, and CI readiness.

## Problem Statement

Current setup.ps1 works but has portability, idempotency, and security gaps that block unattended or CI-driven deployments. bootstrap-invite.cjs has a fragile hardcoded dependency path. No .dockerignore protects secrets from image builds.

## Scope

In scope: setup script, bootstrap-invite script, docker-compose healthcheck, .dockerignore, credential handling, idempotency.

Out of scope: bridge.mjs changes, agent prompt/config changes, new agent types, streaming, auth tokens for bridge endpoints.

---

## Phase 1 — Docker Foundations

### 1.1 Add .dockerignore

Create `src/agents/.dockerignore` to exclude secrets and non-build files from image context.

```
.env
.env.*
!.env.example
docker-compose.yml
setup.sh
setup.ps1
bootstrap-invite.cjs
paperclip-config.json
*.md
```

Why: `.env` contains real API keys. Without .dockerignore, `COPY` and build context send it into every image layer. Anyone pulling the image can extract them.

### 1.2 Add Paperclip healthcheck to docker-compose.yml

Add a healthcheck to the `paperclip` service so compose can express startup dependencies properly.

```yaml
paperclip:
  ...
  healthcheck:
    test: ["CMD", "node", "-e", "fetch('http://localhost:3100/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
    interval: 5s
    timeout: 5s
    start_period: 30s
    retries: 12
```

Change agent `depends_on` from `service_started` to `service_healthy`:

```yaml
depends_on:
  paperclip:
    condition: service_healthy
```

Why: Eliminates race condition where agents start before Paperclip is ready. Setup script can also wait on `docker compose up --wait` instead of a manual poll loop.

---

## Phase 2 — Fix bootstrap-invite.cjs

### 2.1 Fix fragile pg require path

Replace hardcoded pnpm path:

```js
// Before
const { Client } = require("/app/node_modules/.pnpm/pg@8.18.0/node_modules/pg");

// After — walk up from /app to find pg
const { Client } = require(require.resolve("pg", { paths: ["/app"] }));
```

`require.resolve` with `paths` searches node_modules trees rooted at `/app` regardless of pnpm version or layout. Survives Paperclip image upgrades.

### 2.2 Make connection string configurable

Read from environment with fallback to current default:

```js
const connStr = process.env.PG_CONNECTION_STRING
  || "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
```

### 2.3 Add idempotency

Check if a bootstrap invite already exists before inserting:

```js
const existing = await c.query(
  "SELECT 1 FROM invites WHERE invite_type = 'bootstrap_ceo' AND expires_at > NOW() LIMIT 1"
);
if (existing.rowCount > 0) {
  // Already bootstrapped — exit cleanly
}
```

---

## Phase 3 — Rewrite setup script as bash

### 3.1 Create setup.sh

Replace `setup.ps1` with `src/agents/setup.sh`. Bash is the standard for deployment scripts — works in CI runners, WSL, Linux hosts, and devops agent containers. Uses `curl` and `jq` (universally available) instead of PowerShell cmdlets.

Structure:

```
#!/usr/bin/env bash
set -euo pipefail

# --- Config (env vars with defaults) ---
# --- Functions ---
#   wait_healthy()    — poll /api/health or use docker compose --wait
#   api_post()        — curl wrapper with session cookie, error checking
#   authenticate()    — signup or signin, capture session cookie
#   bootstrap()       — docker exec bootstrap-invite.cjs, accept invite
#   create_company()  — POST /api/companies (idempotent)
#   register_agent()  — POST /api/companies/{id}/agent-hires (idempotent)
#   discover_agents() — find agent dirs with .pi/agent/config.yml
# --- Main ---
```

### 3.2 Credential handling

All credentials sourced from environment with safe defaults:

```bash
PAPERCLIP_URL="${PAPERCLIP_URL:-http://localhost:3100}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@eval.local}"
ADMIN_PASS="${ADMIN_PASS:-eval-admin-2026}"
COMPANY_NAME="${COMPANY_NAME:-eval}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
```

### 3.3 Idempotency checks

Each create operation checks for existing state first:

- **Company**: `GET /api/companies` — search by name, skip if found, return existing ID
- **Agents**: `GET /api/companies/{id}/agents` — search by name, skip if found
- **Auth**: Try signin first (fast path for re-runs), fall back to signup
- **Bootstrap invite**: Handled by 2.3 above

This makes `setup.sh` safe to run repeatedly — first run creates everything, subsequent runs are no-ops that print existing IDs.

### 3.4 Agent discovery

Instead of hardcoding CEO and Researcher definitions, discover agents from directory structure:

```bash
for agent_dir in */; do
  if [ -f "${agent_dir}.pi/agent/config.yml" ]; then
    # Extract name, role, capabilities from config.yml or AGENTS.md
    register_agent "$agent_dir"
  fi
done
```

Agent adapter config (role, title, icon, capabilities) stored in a small JSON sidecar per agent directory — e.g., `ceo/agent.json`:

```json
{
  "name": "CEO",
  "role": "ceo",
  "title": "Chief Executive Officer",
  "icon": "crown",
  "capabilities": "Strategic leadership, task prioritization, cross-agent coordination"
}
```

This means adding a new agent = adding a directory. No setup script changes needed.

### 3.5 Error handling

- `set -euo pipefail` — fail on any error, undefined var, or pipe failure
- Every `curl` call checks HTTP status code, logs response body on failure
- Meaningful exit messages: "Failed to create company: 409 — already exists" not just "curl failed"
- Trap handler for cleanup messaging on unexpected exit

### 3.6 Output

On success, print a summary block:

```
Setup complete.
  UI:         http://localhost:3100
  Company:    <id>
  CEO:        <id>
  Researcher: <id>
```

On re-run:

```
Already configured.
  Company:    <id> (existing)
  CEO:        <id> (existing)
  Researcher: <id> (existing)
```

---

## Phase 4 — Keep PowerShell as thin wrapper (optional)

If local Windows dev convenience matters, keep a minimal `setup.ps1` that just calls:

```powershell
wsl bash -c "cd /mnt/c/Users/evano/repos/paperclip-eval/src/agents && ./setup.sh"
```

One line. All logic lives in bash.

---

## Phase 5 — Documentation

### 5.1 Update CLAUDE.md

- Change "First-time setup: run setup.ps1" to "First-time setup: run setup.sh"
- Add setup.sh and agent.json to repo layout

### 5.2 Update README.md

- Document env vars for setup customization
- Document adding new agents via directory convention

### 5.3 Update LEARNING.md

- Add entry for the pg require path fix
- Add entry for idempotency pattern

---

## File Change Summary

| File | Action |
|------|--------|
| `src/agents/.dockerignore` | Create |
| `src/agents/docker-compose.yml` | Add Paperclip healthcheck, change depends_on to service_healthy |
| `src/agents/bootstrap-invite.cjs` | Fix require path, add idempotency, configurable connection string |
| `src/agents/setup.sh` | Create (replaces setup.ps1 as canonical script) |
| `src/agents/setup.ps1` | Reduce to WSL wrapper or delete |
| `src/agents/ceo/agent.json` | Create — agent registration metadata |
| `src/agents/researcher/agent.json` | Create — agent registration metadata |
| `CLAUDE.md` | Update repo layout and setup instructions |
| `LEARNING.md` | Add entries for pg path fix and idempotency |

## Dependencies

- `jq` must be available in the environment running setup.sh (standard on CI runners, installable via apt/brew)
- `curl` must be available (universal)
- No Node/Bun dependency for the setup script itself — bootstrap-invite.cjs runs inside the Paperclip container which already has Node

## Risks

- Paperclip API endpoints for listing companies/agents may not exist or may behave differently than expected — verify against running instance before implementing idempotency
- Agent discovery pattern assumes one agent per subdirectory — confirm no edge cases
- The `pg` module resolution via `require.resolve` depends on Node's module resolution algorithm being stable in the Paperclip image — low risk but worth a smoke test

## Definition of Done

- [x] .dockerignore prevents .env from entering build context
- [x] Paperclip healthcheck in compose, agents depend on service_healthy
- [x] bootstrap-invite.cjs survives Paperclip image version bumps
- [x] setup.sh runs clean on first invocation (creates everything)
- [x] setup.sh runs clean on second invocation (skips everything, prints existing IDs)
- [x] setup.sh fails loudly on network/API errors with actionable messages
- [x] No credentials hardcoded in script source — all from env with defaults
- [x] Adding a new agent requires only a new directory with config files
- [x] CLAUDE.md and LEARNING.md updated
