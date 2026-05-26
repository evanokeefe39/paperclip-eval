# Paperclip rejects Docker-internal hostname in Host header

**Severity:** Critical (blocks all agent-to-Paperclip API calls)
**Component:** docker-compose.yml, Paperclip instance config
**Found:** 2026-05-26

## Problem

Agents inside Docker call Paperclip at `http://paperclip:3100` (Docker network hostname). Paperclip rejects these requests with 403:

```
Hostname 'paperclip' is not allowed for this Paperclip instance.
```

The check is on the HTTP `Host` header, not the `Origin` header. `BETTER_AUTH_TRUSTED_ORIGINS` only controls Origin validation — a separate hostname allowlist controls Host header validation.

## What we tried

1. **config.json `server.allowedHostnames`** — Added `["localhost", "paperclip"]` to `server.allowedHostnames` in `/paperclip/instances/default/config.json`. File loads (visible in startup logs) but the field has no effect on the hostname check.

2. **DB `instance_settings.general.allowedHostnames`** — Inserted directly via pg. No effect after restart.

3. **`paperclipai allowed-hostname paperclip` CLI** — CLI refuses to run inside Docker container. Forces `local_trusted` mode detection, rejects `bind: "lan"` config. Same issue documented in LEARNING.md (bootstrap-ceo CLI).

4. **`BETTER_AUTH_TRUSTED_ORIGINS` env var** — Added `http://paperclip:3100`. This fixed the Better Auth origin check but the hostname check is a separate layer.

5. **Removing Origin header from client.ts/bridge.mjs** — Confirmed not the issue. 403 persists even with no Origin header.

## Likely fix

One of:
- Find the correct env var or config path for allowed hostnames (may be in a different config section or an undocumented env var)
- Set `PAPERCLIP_PUBLIC_URL=http://paperclip:3100` — makes agents work but the public URL would be a Docker-internal hostname. Browser UI still accessible at localhost:3100 directly.
- Run the CLI from outside Docker (host machine) pointed at the containerized instance

## Workaround

Set `PAPERCLIP_PUBLIC_URL` back to `http://paperclip:3100` in docker-compose.yml. The UI is accessed at `http://localhost:3100` regardless — browsers don't use `PAPERCLIP_PUBLIC_URL`.
