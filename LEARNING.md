# Paperclip Learnings

Running notes on issues, workarounds, and architectural observations discovered while evaluating [Paperclip](https://github.com/paperclipai/paperclip) for agent orchestration. Each entry captures what went wrong, why, and what to do about it.

---

## Bridge payload structure was completely wrong (2026-05-27)

### Problem
Bridge assumed local-adapter payload shape: `body.prompt`, `body.systemPrompt`, `body.env.PAPERCLIP_WAKE_REASON`, etc. HTTP adapter actually sends `{ agentId, runId, context }` — no prompt, no systemPrompt, no env dict. Every agent invocation fell through to hardcoded "Continue your work." prompt, discarding all rich task context Paperclip provides (issue title, description, wake comments, workspace info).

### Root cause
HTTP adapter is a dumb pipe — it forwards context as-is. Prompt assembly is a local-adapter responsibility. Bridge was written assuming local-adapter conventions apply to HTTP adapter. They don't.

### Fix
Rewrote bridge.mjs payload parsing: reads `body.context.*` for wake metadata, builds prompt from `context.paperclipTaskMarkdown` (Paperclip's pre-rendered task markdown) with fallbacks to `context.paperclipWake` and `context.paperclipIssue`. Removed `body.env` spreading from Pi spawn env.

### Key takeaway
HTTP adapter payload structure is underdocumented. The SKILL.md and heartbeat docs assume local adapters. Always check the actual adapter source (`server/src/adapters/http/execute.ts`) when building HTTP bridges.

---

## CEO agent: strip work tools, enforce delegation (2026-05-27)

### Problem
CEO had all extensions loaded (web-search, web-fetch, web-scrape, duckdb, etc.) and would do research/writing work itself instead of delegating to specialist agents. Shortest path to "done" was using its own tools, not creating sub-issues.

### Fix
Added `BRIDGE_EXTENSIONS` env var to bridge.mjs for per-agent extension control. CEO docker-compose service overrides with minimal set: paperclip-tools (coordination), artifacts (read other agents' output), logging (observability), escalate (human HITL). No research, scraping, or data tools.

### Key takeaway
Paperclip has no built-in tool-gating per agent role. Without explicit extension stripping, agents will use whatever tools are available. Prompt discipline alone is insufficient — remove the tools entirely.

---

## 2026-05-26 — wakeOnDemand does not trigger on issue assignment

### What happened
CEO created child issues with `assigneeAgentId` set to worker agents. Workers never received POST /invoke. Multi-agent delegation was completely broken.

### Root cause
Paperclip uses a poll-plus-event hybrid model. Heartbeat polling is the primary work-intake mechanism. `wakeOnDemand` only fires for specific lifecycle events: `issue_blockers_resolved`, `issue_children_completed`, `issue_commented`, `issue_comment_mentioned`, `approval_resolved`. Initial issue assignment is NOT a wake trigger. With `heartbeat.enabled: false`, agents had no way to discover new work.

### Systemic issues found
1. `client.ts` was not sending `X-Paperclip-Run-Id` header on mutating API calls. SKILL.md requires this for all issue-modifying requests (run audit trail). Fixed: header now sent on all non-GET requests when `PAPERCLIP_RUN_ID` is set.
2. No tool existed for CEO to explicitly invoke another agent. Fixed: added `paperclip_invoke_agent` tool wrapping `POST /api/agents/{id}/heartbeat/invoke`.

### Fix
1. Enabled heartbeat on all agents: `{ "enabled": true, "intervalSec": 120, "wakeOnDemand": true }`. Heartbeat handles work discovery, wakeOnDemand handles reactive events. NOTE: Paperclip reads `intervalSec` (seconds), NOT `intervalMs`. Using `intervalMs` causes silent fallback to 0, disabling heartbeat entirely.
2. Added `X-Paperclip-Run-Id` header to `client.ts` for mutating requests.
3. Added `paperclip_invoke_agent` tool so CEO can explicitly invoke delegated agents (belt-and-suspenders).
4. Added wake context logging in `bridge.mjs` for observability.

### Key takeaway
`wakeOnDemand: true` with `heartbeat.enabled: false` means "wake on specific lifecycle events only." It does NOT mean "wake whenever there's work." Agents need heartbeat enabled to discover new assignments. Explicit invoke after delegation eliminates the 0-120s latency gap.

---

## 2026-05-25 — pi_local adapter hits Windows command line length limit

### What happened

The pi_local adapter failed with `The command line is too long` when Paperclip attempted to invoke the Pi CLI. The assembled command included agent instructions (AGENTS.md), the execution contract, the wake payload, and a continuation summary — all passed inline as a single `--append-system-prompt` argument. On Windows, `cmd.exe` enforces a hard ~8,191 character limit on total command line length, and the prompt easily exceeded that.

### Root cause

The pi_local adapter injects the system prompt as a CLI argument rather than writing it to a temp file and passing a file path. The claude_local adapter already avoids this by using `--append-system-prompt-file`, but pi_local hasn't adopted that pattern. The problem compounds over time because wake payloads and continuation summaries grow with each heartbeat, so even a short AGENTS.md will eventually hit the limit on non-trivial tasks.

### Silent degradation mode

When the command doesn't outright fail, Windows can truncate or fragment the argument. Pi then receives each word as a separate message (e.g. "are", "the", "CEO.") and responds to gibberish, burning tokens on nonsense replies. This is documented in issues [#3114](https://github.com/paperclipai/paperclip/issues/3114) and [#3180](https://github.com/paperclipai/paperclip/issues/3180).

### Additional observation

The execution contract text appeared twice in the assembled command — once from the adapter's standard injection and once from the wake payload. This redundancy accelerates hitting the limit and is worth flagging as a separate bug.

### Workarounds

1. **Run Paperclip inside WSL2** — Linux has a ~2MB argument limit, which eliminates the problem entirely. Requires installing Node.js, pnpm, and pi inside the WSL2 distro.
2. **Trim AGENTS.md** — Reduces headroom pressure but won't hold long-term as continuation summaries grow across heartbeats.

### Status

Open bug as of v2026.517.0. No fix in any current release.

### References

- [Issue #3114 — fragmented message to pi agent](https://github.com/paperclipai/paperclip/issues/3114)
- [Issue #3180 — Pi adapter sends fragmented messages word by word](https://github.com/paperclipai/paperclip/issues/3180)
- [Issue #1673 — Windows/WSL2 setup guide for local adapters](https://github.com/paperclipai/paperclip/issues/1673)

---

## 2026-05-25 — Paperclip Docker deployment requires authenticated mode

### What happened

Attempted to run Paperclip in Docker using `local_trusted` deployment mode (the default). The server refused to start with `local_trusted requires server.bind=loopback`. Docker containers must bind to `0.0.0.0` for port forwarding to work, which is incompatible with loopback-only binding.

### Root cause

`local_trusted` mode hardcodes `server.bind=loopback` and rejects any override. This is intentional security — unauthenticated mode should only be reachable from the local machine. In Docker, binding to `127.0.0.1` means other containers on the same network cannot reach the service, and the host cannot reach it through published ports.

### Solution

Run Paperclip in `authenticated` mode with `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`. This allows `HOST=0.0.0.0` binding while requiring session-based auth for API access. Trade-off: requires a bootstrap flow to create the first admin user.

### References

- Environment vars: `PAPERCLIP_DEPLOYMENT_MODE`, `PAPERCLIP_DEPLOYMENT_EXPOSURE`, `HOST`
- Valid `server.bind` values in config.json: `loopback`, `lan`, `tailnet`, `custom`
- The server itself accepts `wildcard` via env var but the CLI config schema does not

---

## 2026-05-25 — bootstrap-ceo CLI does not work inside Docker

### What happened

The `paperclipai auth bootstrap-ceo` CLI command, which generates the admin invite token for a fresh authenticated instance, refuses to run inside the Paperclip Docker container. It detects `local_trusted` deployment mode regardless of environment variables or config.json content, and exits with "Bootstrap CEO invite is only required for authenticated mode."

### Root cause

The CLI has its own deployment mode detection that overrides the config file. It appears to detect that it is running on localhost and forces `local_trusted` mode. This detection runs before reading any config or env vars. The `--yes` flag on `onboard` has the same behavior — it forces `local_trusted` with loopback binding, ignoring all env overrides.

### What did not work

1. Setting `PAPERCLIP_DEPLOYMENT_MODE=authenticated` as env var on `docker exec`
2. Writing a `config.json` with `deployment.mode: "authenticated"` — CLI still detected `local_trusted`
3. Running the CLI from the Windows host pointing at `--base-url http://localhost:3100` — same detection issue
4. Running `onboard --yes` inside container — it forces `local_trusted` and starts a second server on loopback

### Solution

Bypass the CLI entirely. The bootstrap invite is just a database insert into the `invites` table. Created `bootstrap-invite.cjs` which uses the `pg` module already present in the Paperclip image at `/app/node_modules/.pnpm/pg@8.18.0/node_modules/pg` to connect to the embedded PostgreSQL at `127.0.0.1:54329` and insert a `bootstrap_ceo` invite directly. The invite token is then accepted via the `POST /api/invites/{token}/accept` API endpoint.

### Key details

- Embedded PostgreSQL connection: `postgres://paperclip:paperclip@127.0.0.1:54329/paperclip`
- Invite token format: `pcp_bootstrap_` + 24 random hex bytes
- Token is stored as SHA-256 hash in the `invites` table
- The `create-auth-bootstrap-invite.ts` script in the Paperclip repo (`packages/db/scripts/`) was the reference implementation

### References

- `bootstrap-invite.cjs` in `src/agents/`
- Paperclip source: `packages/db/scripts/create-auth-bootstrap-invite.ts`
- Paperclip source: `cli/src/commands/auth-bootstrap-ceo.ts`

---

## 2026-05-25 — Paperclip GHCR image vs building from source

### What happened

Explored options for running Paperclip in Docker. The repo has a Dockerfile and quickstart docker-compose, but also publishes pre-built images.

### Finding

Paperclip publishes multi-arch images to GitHub Container Registry at `ghcr.io/paperclipai/paperclip:latest`. Tags include `latest` (from master), semver tags, and SHA-based tags. No Docker Hub image exists.

The CI workflow is at `.github/workflows/docker.yml`. Images are built for `linux/amd64` and `linux/arm64`.

### Decision

Use the GHCR image instead of cloning and building from source. Avoids needing the full repo (~large monorepo) in the project.

### Config.json requirement

The server starts fine from env vars alone — no config.json needed for the server process. However, the `paperclipai` CLI (used for bootstrap-ceo, configure, doctor) requires a valid `config.json` at `$PAPERCLIP_HOME/instances/default/config.json`. The schema requires `$meta.version`, `$meta.updatedAt`, `$meta.source` (enum: `onboard`, `configure`, `doctor`), and `server.bind` (enum: `loopback`, `lan`, `tailnet`, `custom`).

A template config is kept at `src/agents/paperclip-config.json` and piped into the container via `cat | docker exec` during setup.

---

## 2026-05-25 — Docker networking between Paperclip and agent bridges

### What happened

Initially ran Paperclip on the host and agent bridges in Docker. Agent adapter URLs used `http://host.docker.internal:8081` (wrong — Paperclip on host should use `localhost:8081`). Later moved everything into Docker.

### Finding

When all services are in the same docker-compose, they share a Docker network and can reach each other by service name:
- Paperclip reaches CEO bridge at `http://ceo:8080` (internal port, not published port)
- Paperclip reaches Researcher bridge at `http://researcher:8080`
- Host browser reaches Paperclip UI at `http://localhost:3100` (published port)
- Host reaches bridges at `http://localhost:8081`, `http://localhost:8082` (published ports)

`host.docker.internal` is only needed when a container needs to reach a host-only service. With everything in Docker, it is not needed.

### Agent adapter URL pattern

When registering agents via the Paperclip API, use the Docker service name and internal port:
```json
{
  "adapterConfig": {
    "url": "http://ceo:8080/invoke"
  }
}
```

Not `http://localhost:8081/invoke` (host port) or `http://host.docker.internal:8081/invoke`.

---

## 2026-05-25 — Pi requires auth.json for provider-specific auth structure

### What happened

After fixing the bridge protocol (removing the fragile "wait for ready" approach), invocations returned 401 from minimax despite the `MINIMAX_API_KEY` env var being correctly set inside the container.

### Root cause

Pi does not use env vars directly for all providers. It reads `~/.pi/agent/auth.json` which has a dual structure: flat `"PROVIDER_API_KEY": "value"` entries plus provider-keyed objects with `{"type": "api_key", "key": "value"}`. Minimax and deepseek specifically require the provider-keyed structure to authenticate correctly. The env var alone is insufficient.

### auth.json structure

```json
{
  "MINIMAX_API_KEY": "sk-...",
  "DEEPSEEK_API_KEY": "sk-...",
  "minimax": { "type": "api_key", "key": "sk-..." },
  "deepseek": { "type": "api_key", "key": "sk-..." }
}
```

### Solution

Copy auth.json into each agent's `.pi/agent/` directory and add a `COPY` line to the Dockerfile. The file is gitignored since it contains secrets.

### Key details

- Container path: `/root/.pi/agent/auth.json`
- Source: root `auth.json` in repo (gitignored)
- Dockerfile line: `COPY ${AGENT_NAME}/.pi/agent/auth.json /root/.pi/agent/auth.json`
- Other providers (groq, cerebras, nvidia, openrouter, mistral) work with env vars alone

---

## 2026-05-25 — Pi does not emit "ready" event; bridge must send prompt immediately

### What happened

The bridge waited for first stdout data before sending the prompt, assuming Pi would emit a "ready" event. With oh-my-pi extensions installed, Pi emits `extension_ui_request` events instead. The 5-second fallback timeout masked this but added latency and was fragile.

### Root cause

Pi accepts stdin input immediately after spawn. There is no "ready" event in the protocol. The stdout wait was a workaround for a race condition that doesn't exist — Pi's stdin buffer is ready before any stdout is produced.

### Protocol lifecycle (with extensions)

```
spawn → extension_ui_request(s) → [prompt sent immediately] → response{success:true} → agent_start → message_update(s) → agent_end
```

### Solution

Send prompt to stdin immediately after spawn. Wait for `agent_start` as confirmation of processing. Also check for `response{success:false}` as prompt rejection. The `agent_start` event is always emitted regardless of extensions.

### References

- `src/agents/bridge.mjs` — protocol implementation
- `docs/pi-rpc-protocol.md` — full protocol documentation

---

## 2026-05-25 — PowerShell `$ErrorActionPreference = "Stop"` breaks native command stderr capture

### What happened

The test runner (`tests/run-all.ps1`) crashed on the first hurl invocation despite hurl reporting "Success". The script exited with code 1 and no further tests ran.

### Root cause

The script set `$ErrorActionPreference = "Stop"` globally (line 6) and used `$output = & hurl --test $hurlFile 2>&1` to capture output. In PowerShell 5.1, `2>&1` wraps each stderr line as a `System.Management.Automation.ErrorRecord` (specifically `NativeCommandError`). With `$ErrorActionPreference = "Stop"`, the first ErrorRecord becomes a terminating error, killing the script.

hurl writes its progress and summary to stderr by design (e.g., `Success ... (7 request(s) in 11617 ms)`). The same applies to k6, which writes its dashboard to stderr.

### Solution

Toggle `$ErrorActionPreference` to `"Continue"` around any native command invocation that uses `2>&1`:

```powershell
$savedEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$output = & hurl --test $hurlFile 2>&1
$exitCode = $LASTEXITCODE
$ErrorActionPreference = $savedEAP
```

`$LASTEXITCODE` still correctly reflects the native command's exit code regardless of `$ErrorActionPreference`.

### Key details

- Affects PowerShell 5.1 (Windows PowerShell). PowerShell 7+ behaves differently with native commands.
- The `| Out-Null` pipeline does not prevent the error — the ErrorRecord is created before reaching the pipeline.
- Alternative: use `cmd /c "hurl --test file 2>&1"` to keep stderr as plain text, but this loses structured error info.

---

## 2026-05-25 — Hurl `file,` body paths resolve relative to `--file-root`, not CWD

### What happened

Tier 2 contract tests failed with `file tests/fixtures/wake-payload.json can not be read` despite the file existing at the expected repo-root-relative path.

### Root cause

Hurl resolves `file,<path>` body references relative to its file root, which defaults to the hurl file's directory — not the caller's working directory. The hurl file at `tests/hurl/tier2-contracts.hurl` referenced `tests/fixtures/wake-payload.json`, so hurl looked for `tests/hurl/tests/fixtures/wake-payload.json`.

### Solution

Pass `--file-root $RepoRoot` to hurl invocations so file paths resolve relative to the repository root:

```powershell
& hurl --test --file-root $script:RepoRoot $hurlFile
```

### Alternative

Change the file paths in the hurl files to be relative to the hurl file's directory (e.g., `../fixtures/wake-payload.json`). The `--file-root` approach is preferred because it keeps paths consistent with the repo layout.

---

## 2026-05-25 — pnpm hardcoded paths break on image upgrades

### What happened

`bootstrap-invite.cjs` used `require("/app/node_modules/.pnpm/pg@8.18.0/node_modules/pg")` — a path that includes the exact pnpm version hash. When the Paperclip image updated pg or pnpm, the path stopped existing and the script failed.

### Root cause

pnpm stores packages in a content-addressable layout at `.pnpm/<name>@<version>/node_modules/<name>`. The version component changes on every dependency bump. Hardcoding it couples the script to a specific lockfile state.

### Solution

Use `require.resolve("pg", { paths: ["/app"] })` which walks the `node_modules` tree from `/app` using Node's module resolution algorithm. Survives pnpm version bumps, lockfile changes, and hoisting layout changes.

### Key details

- `require.resolve` with `paths` option is stable Node API (v8.9+)
- The Paperclip image always has pg installed at `/app` — it's a direct dependency of the server

---

## 2026-05-25 — Setup scripts must be idempotent for CI and re-runs

### What happened

`setup.ps1` and `bootstrap-invite.cjs` assumed a fresh Paperclip instance. Running them twice would fail: duplicate invite inserts, duplicate company creation (409), duplicate agent registration.

### Root cause

No existence checks before create operations. Each script assumed it was the first run.

### Solution

Every create operation now checks for existing state first:

- **bootstrap-invite.cjs**: queries for unexpired `bootstrap_ceo` invite before inserting. Exits cleanly if one exists.
- **setup.sh create_company()**: GETs `/api/companies`, searches by name, returns existing ID if found.
- **setup.sh register_agent()**: GETs `/api/companies/{id}/agents`, searches by name, skips if found.
- **setup.sh authenticate()**: tries sign-up first, falls back to sign-in (existing user).

### Key details

- Idempotency makes the script safe for CI pipelines where the environment may persist between runs
- Re-runs print "(existing)" next to each ID so the operator knows nothing was created
- The pattern: check → skip-if-exists → create-if-new → return-id-either-way

---

## 2026-05-25 — Hurl JSONPath filter `count` fails on single-match results

### What happened

Test 2.7 (protocol events structure) failed with `invalid filter input type — actual: object, expected: list, bytes or nodeset` on assertions like:

```
jsonpath "$.events[?(@.type=='agent_start')]" count >= 1
```

### Root cause

When a JSONPath filter expression matches exactly one element, hurl's JSONPath implementation returns a single object rather than a one-element list. The `count` predicate requires a collection type (list, bytes, or nodeset) and rejects a bare object.

### Solution

Use `exists` instead of `count >= 1` for assertions that just need to confirm at least one match:

```
jsonpath "$.events[?(@.type=='agent_start')]" exists
```

`exists` works on any non-null value, regardless of whether it's an object or a list. Use `count` only on expressions guaranteed to return collections (e.g., `jsonpath "$.events"` which is always an array).

---

## 2026-05-25 — Paperclip has no native artifact or file storage

### What happened

Investigated whether Paperclip exposes any file/artifact/document storage API for inter-agent data sharing.

### Finding

Paperclip has no file storage API. The API covers auth, health, companies, agents, and org-tree only. All inter-agent communication is text-in-prompt — Paperclip composes the wake payload server-side, embedding prior agent outputs as text in the `prompt` or `renderedPrompt` field. Agents never talk to each other directly and do not share a filesystem. Each agent container has an isolated workspace volume.

The `"storage": { "provider": "local_disk" }` in paperclip-config.json is Paperclip's internal storage config (database, logs, secrets), not a user-facing file API.

### Solution

Added a shared Docker volume (`shared-artifacts`) mounted at `/artifacts` in all agent containers. Agents write files there and pass path references in their text output. The consuming agent reads from the path received in its wake payload.

This is the eval-stage solution. ROADMAP.md describes the next step: MinIO (S3-compatible) for HTTP access, bucket policies, and presigned URLs.

### Key details

- Volume: `shared-artifacts:/artifacts` in docker-compose.yml
- Convention: write to `/artifacts/{context}/{filename}`, return path as reference
- Agents pass references, not file content — better for security and token efficiency

---

## 2026-05-25 — Pi web search via custom extensions (Exa API)

### What happened

Pi has no built-in web search tool. Its built-in tools are filesystem/coding only: read, bash, edit, write, grep, find, ls. Tested whether agents could do web research.

### Finding

Pi supports custom tool registration via extensions (TypeScript files loaded with `-e` flag). Created two extensions:

- `web-search.ts` — registers `web_search` tool backed by Exa API (`POST https://api.exa.ai/search` with `x-api-key` header). Returns titles, URLs, highlights, and text content.
- `web-fetch.ts` — registers `web_fetch` tool for fetching individual URLs. Tries direct HTTP fetch first, falls back to Jina Reader (`https://r.jina.ai/`) for JS-rendered pages.

### Provider tool-calling compatibility

Not all providers handle tool calling reliably:

- **DeepSeek (deepseek-chat / deepseek-v4-flash)**: works correctly. Generated valid tool calls, processed results, produced structured summaries.
- **Groq (llama-3.3-70b-versatile)**: flaky. First attempt generated a valid tool call but subsequent attempts failed with "Failed to call a function. Please adjust your prompt." Error comes from Groq's API, not Pi.
- **NVIDIA (llama-4-maverick)**: untested for tool calling (401 auth issue in test, unrelated to tools).

### Extension gotchas

- Exa's `score` field can be undefined — guard with null check before `.toFixed()`
- Keep tool parameter schemas simple (no `Type.Optional`, no `Type.Union`) for maximum provider compatibility — Groq rejects complex schemas
- `--no-extensions` only disables auto-discovery; explicit `-e` paths still load
- `--no-tools` disables ALL tools including extension-registered ones — don't use it when testing extensions
- Extensions need `typebox` for parameter schemas — Pi bundles it at `node_modules/typebox`

### References

- `src/agents/extensions/web-search.ts` — Exa search extension
- `src/agents/extensions/web-fetch.ts` — URL fetch extension
- Reference implementation: github.com/amosblomqvist/pi-config/blob/main/extensions/web-fetch/index.ts
- Exa API: `POST https://api.exa.ai/search` with `x-api-key` header
- Jina Reader: `GET https://r.jina.ai/{url}` with `Accept: text/markdown`

---

## 2026-05-25 — PowerShell cannot capture Pi's stdout in non-interactive mode

### What happened

Multiple attempts to run Pi with `-p` (print mode) via PowerShell produced empty output files. Exit code 255 from background tasks, empty stdout/stderr captures.

### Root cause

Pi writes its output (JSON mode, RPC mode) to stdout using Node.js streams that PowerShell's `Start-Process -RedirectStandardOutput` and `*>` redirection cannot reliably capture. The issue is specific to PowerShell 5.1's handling of Node.js process output — likely related to encoding or stream buffering differences.

### Solution

Use bash (WSL) for Pi CLI testing. Output captures correctly with standard shell redirection and piping:

```bash
pi --mode json --no-session ... -p "prompt" 2>&1 | grep -E '"type":"tool_execution_end"'
```

### Key details

- PowerShell `*> file` produces empty files even though Pi runs and exits
- `Start-Process -RedirectStandardOutput` also fails
- `cmd /c "pi ... 2>&1"` from PowerShell also produces empty output
- Bash captures everything correctly — use it for all Pi CLI testing

---

## 2026-05-26 — Paperclip hostname validation blocks container-to-container auth

### What happened

The escalate extension running inside an agent container tried to authenticate with Paperclip at `http://paperclip:3100` (the Docker service name). Paperclip returned 403: "Hostname 'paperclip' is not allowed for this Paperclip instance."

### Root cause

Paperclip validates incoming request hostnames against its public URL. When `PAPERCLIP_PUBLIC_URL=http://localhost:3100`, requests arriving via the Docker network hostname `paperclip` are rejected. The validation is in the server itself, not a reverse proxy — `Host` header overrides do not bypass it.

### What did not work

1. Config file `server.allowedHostnames` array — Paperclip ignores this field
2. `paperclipai allowed-hostname paperclip` CLI — requires `local_trusted` mode (incompatible with Docker)
3. Overriding the `Host` header in fetch — server checks actual hostname, not the header

### Solution

Set `PAPERCLIP_PUBLIC_URL=http://paperclip:3100` in docker-compose.yml for the Paperclip service. This makes Paperclip accept the Docker network hostname. The host browser can still reach `http://localhost:3100` — Paperclip accepts both the public URL hostname and localhost.

### Key details

- `PAPERCLIP_PUBLIC_URL` controls which hostnames are accepted for API requests
- Setting it to the Docker hostname does not break localhost access from the host
- Agent containers use `http://paperclip:3100` for all API calls (auth, issues, pause/resume)
- Session cookie auth is the only auth mechanism — no API keys or bearer tokens exist

---

## 2026-05-26 — Paperclip issue API: labels are IDs, not strings

### What happened

Creating an issue with `labels: ["escalation"]` returned 201 but the labels array was empty. The field was silently ignored.

### Root cause

Paperclip labels are a separate resource. The issue creation endpoint accepts `labelIds` (array of UUIDs), not `labels` (array of strings). Labels must be created first via `POST /api/companies/{cid}/labels` with `name` and `color` fields, then referenced by ID.

### API surface for issues

- `POST /api/companies/{cid}/labels` — create label (returns `{id, name, color}`)
- `GET /api/companies/{cid}/labels` — list labels
- `POST /api/companies/{cid}/issues` — create issue (fields: `title`, `description`, `priority`, `labelIds`)
- `GET /api/companies/{cid}/issues` — list issues
- Body field is `description`, not `body`
- `priority` accepts: `low`, `medium`, `high`, `urgent`
- `createdByAgentId` is accepted but ignored when using session auth (always set to null)
- No DELETE endpoint for issues

---

## 2026-05-26 — HTTP adapter agents do not receive Paperclip MCP tools

### What happened

Agents registered with the HTTP adapter had no way to interact with Paperclip's coordination features (issues, comments, documents, approvals, interactions). The escalate extension could create issues and pause agents, but agents had no tools to list their inbox, read comments, create sub-issues, suggest tasks, or perform any other Paperclip operation.

### Root cause

Paperclip injects MCP tools only for local adapters (claude_local, codex_local, pi_local). These adapters run a built-in MCP server as a stdio subprocess that provides 40 tools wrapping the REST API. The HTTP adapter simply POSTs a JSON payload (`{prompt, systemPrompt}`) to the agent URL — no tools, no skills, no MCP server.

The MCP server source is at `packages/mcp-server/src/tools.ts` in the Paperclip repo. The API client at `packages/mcp-server/src/client.ts` uses `Authorization: Bearer ${apiKey}` headers, but our eval setup uses session-cookie auth since agents authenticate via admin credentials, not API keys.

### Solution

Created Pi extensions at `src/agents/skills/` that re-implement all 40 Paperclip MCP tools as Pi-native tools:

- `client.ts` — shared Paperclip API client using session-cookie auth (matching the existing escalate.ts pattern) with a 25-minute session cache
- `paperclip-tools.ts` — Pi extension that registers all 40 tools with TypeBox schemas

The extension is loaded via `-e /app/skills/paperclip-tools.ts` in bridge.mjs spawn args. The Dockerfile copies `skills/` into `/app/skills/`.

### Key details

- API paths match the upstream MCP server exactly — all paths relative to `/api` (e.g., `/agents/me`, `/issues/{id}/checkout`, `/companies/{cid}/issues`)
- Session-cookie auth instead of API key auth — the MCP server uses `Authorization: Bearer`, our extension uses `Cookie:` from `POST /api/auth/sign-in/email`
- Session cached for 25 minutes (sessions typically last 30) to avoid re-authenticating on every tool call within a single agent run
- `isConfigured()` gate: if any of the three auth env vars are missing, the extension silently skips registration (no crash, no error)
- Tool names use snake_case (`paperclip_me`, `paperclip_list_issues`) matching Pi convention, not camelCase like the MCP tools

### Tool categories (40 total)

- Identity & inbox (4): me, inbox, list/get agents
- Issues (7): list, get, create, update, checkout, release, heartbeat context
- Comments (3): list, get, add (with resume/reopen/interrupt flags)
- Documents (5): list, get, upsert, list revisions, restore revision
- Projects & goals (4): list/get each
- Interactions (3): suggest_tasks, ask_user_questions, request_confirmation
- Approvals (8): CRUD, decisions, link/unlink to issues, comments
- Workspace runtime (3): get, control services, wait for service
- Escape hatch (1): paperclip_api_request for any /api endpoint

### References

- Upstream MCP server: `packages/mcp-server/src/tools.ts` in the Paperclip repo
- Upstream client: `packages/mcp-server/src/client.ts`
- Local extension: `src/agents/skills/paperclip-tools.ts`
- Tests: `tests/paperclip-tools/unit-test.mjs` (162 tests), `tests/paperclip-tools/integration-test.sh`

---

## 2026-05-26 — Deep-research extension remediation: async I/O, concurrency, validation

### What happened

The deep-research extension (`src/agents/extensions/deep-research/`) had accumulated several code quality issues during initial development: synchronous filesystem calls blocking the event loop, unbounded concurrent LLM and fetch calls, unchecked `as T` casts on LLM structured output, duplicated utility functions across modules, and magic numbers scattered throughout.

### What was done

Remediation across all 12 existing files plus 3 new modules (15 files total):

1. **semaphore.ts** (new) — counting semaphore for bounding concurrent async work. Used by `llm.ts` (LLM call concurrency) and `sweep.ts` (page fetch concurrency). Limits configured as named constants in `config.ts` (`max_concurrent_llm`, `max_concurrent_fetch`).

2. **validate.ts** (new) — runtime validator functions for LLM structured output. Each validator checks the shape and required fields of a parsed response, replacing bare `as T` casts that silently passed malformed data. Used by `llm.ts` `structuredCall`, `extract.ts`, and `engine.ts`.

3. **utils.ts** (new) — shared `sleep` and `stripHtml` helpers. Eliminates three duplicate `sleep` implementations (previously inline in llm.ts, engine.ts, sweep.ts) and two duplicate HTML-stripping functions (sweep.ts, extract.ts).

4. **config.ts** — 7 new named constants added: `min_content_length`, `snippet_cap_for_llm`, `min_chunk_length`, `key_claims_cap`, `claim_preview_length`, `max_concurrent_llm`, `max_concurrent_fetch`. All former magic numbers now reference these.

5. **Async I/O migration** — `store.ts`, `checkpoint.ts`, `query.ts` converted from `fs.readFileSync`/`writeFileSync` to `fs/promises` (`readFile`/`writeFile`). Callers in `engine.ts`, `extract.ts`, `deep-research.ts` updated to `await` all store and checkpoint calls. Exceptions: `existsSync` guards and `readFileSync` in the checkpoint constructor (synchronous by design for initial load).

6. **sweep.ts** — `fetchPages` now returns `failedUrls` alongside results. Page extraction uses `Promise.allSettled` instead of `Promise.all` so a single page failure does not abort the entire sweep. Uses `stripHtml` from utils instead of inline implementation.

7. **llm.ts** — `structuredCall` signature changed to accept a `validate` callback parameter. All LLM calls wrapped by the semaphore. Imports shared `sleep` from utils.

### Key patterns

- **Semaphore for concurrency**: wrap async work in `semaphore.acquire()` / `release()` rather than unbounded `Promise.all`. Prevents API rate limit hits and memory pressure from parallel LLM calls.
- **Validator callbacks over as-casts**: `structuredCall<T>(prompt, schema, validate)` where `validate: (raw: unknown) => T` throws on malformed input. Catches LLM output issues at the call boundary, not downstream.
- **Shared utils to eliminate duplication**: when three modules implement the same helper, extract it. Reduces bug surface and keeps behavior consistent.
- **Async I/O by default**: filesystem calls in an async pipeline should use `fs/promises`. Sync variants are acceptable only in constructors or one-time initialization.

### References

- Module directory: `src/agents/extensions/deep-research/`
- Tests: `tests/deep-research/`

---

## 2026-05-26 — Scrapling 0.4.8 API breaks: class renames, property changes, missing methods

### What happened

Implemented 4-tier web scraping using scrapling. Plan was based on scrapling's documented API (`Fetcher`, `PlayWrightFetcher`, `.text()`, `.css_first()`). All four broke against scrapling 0.4.8.

### Changes in scrapling 0.4.8

| Expected | Actual in 0.4.8 | Impact |
|----------|-----------------|--------|
| `PlayWrightFetcher` class | `DynamicFetcher` class | Import fails, class renamed |
| `Fetcher.get(url)` | Still works but deprecated; `StealthyFetcher.fetch(url)` is preferred | Deprecation warning, functional |
| `DynamicFetcher.get(url)` | `DynamicFetcher.fetch(url)` | Method renamed |
| `element.text()` (method) | `element.text` (property, `TextHandler` type) | `TypeError: 'TextHandler' object is not callable` |
| `element.css_first(sel)` | Does not exist on `Selector` | `AttributeError: 'Selector' object has no attribute 'css_first'` |
| `from scrapling import PlayWrightFetcher` | `from scrapling import DynamicFetcher` | Old name not exported |
| `fetcher.kill()` | Method does not exist on `DynamicFetcher` | Cleanup code fails |

### Additional finding: pip install `scrapling` vs `scrapling[fetchers]`

Bare `pip install scrapling` installs the package but NOT its fetcher dependencies (`curl_cffi`, `browserforge`, `playwright`, `patchright`). The `Fetcher` class exists but importing it triggers a chain of missing modules. `scrapling[fetchers]` is required for any actual scraping — this is not documented clearly.

### Additional finding: `from scrapling import DynamicFetcher` succeeds without browser binaries

`scrapling[fetchers]` installs the `playwright` and `patchright` pip packages but NOT the browser binaries. `from scrapling import DynamicFetcher` succeeds in containers without browsers — the import doesn't validate that binaries exist. `scrapling install` downloads the actual Chromium/Camoufox binaries. Detection must check for binaries, not just importability.

### Solutions applied

1. **Class rename**: `PlayWrightFetcher` → `DynamicFetcher` in scrape_browser.py
2. **Method rename**: `.get()` → `.fetch()` for DynamicFetcher
3. **Property access**: `el.text()` → `str(el.text)` in all Python scripts
4. **Sub-selection**: `el.css_first(sel)` → `(el.css(sel) or [None])[0]`
5. **Dep install**: `pip install scrapling` → `pip install "scrapling[fetchers]"` in researcher Dockerfile
6. **Browser detection**: replaced import-based check with marker file (`/app/.browsers-installed`) created in data Dockerfile after `scrapling install`
7. **Cleanup**: removed `fetcher.kill()` call (method doesn't exist)

### Key takeaway

Scrapling's API is unstable between minor versions. Pin the version in Dockerfiles and test against the exact version in CI. Do not rely on docs or README examples — always verify against the installed version inside the container.

### References

- Python scripts: `src/agents/{researcher,data}/scripts/scrape_stealth.py`, `src/agents/data/scripts/scrape_browser.py`
- Extension: `src/agents/extensions/web-scrape.ts`
- Dockerfiles: `src/agents/{researcher,data}/Dockerfile`

---

## 2026-05-26 — Pi extension packages dominate Docker image size

### What happened

CEO image (base, no Python, no scraping) is 1.5GB. Investigated layer breakdown.

### Finding

| Layer | Size | Command |
|-------|------|---------|
| node:22-slim base | ~500MB | FROM |
| git | ~98MB | apt-get install git |
| Pi CLI | 187MB | npm install -g @earendil-works/pi-coding-agent |
| Pi extensions | **689MB** | pi extensions install npm:shitty-extensions npm:@ifi/pi-extension-subagents |

`shitty-extensions` + `@ifi/pi-extension-subagents` = 689MB — nearly half the total image. CEO probably doesn't need subagent extensions since Paperclip handles orchestration. Need to audit which extensions each agent actually uses.

### References

- `docker history agents-ceo --format "{{.Size}}\t{{.CreatedBy}}"`
- ROADMAP.md: "Planned: Docker image size optimization"

---

## 2026-05-26 — Cheerio global install not resolvable from /app in data container

### What happened

T1 (cheerio) scraping tier failed with `Cannot find module 'cheerio'` in the real-world scraping campaign. All 15 T1 tests returned 0 items with 0ms duration — immediate failure, not a site blocking issue.

### Root cause

The data Dockerfile installs cheerio globally (`npm install -g cheerio`), placing it at `/usr/local/lib/node_modules/cheerio`. The test runner (`real-world-tests.sh`) uses `docker compose exec data node -e "..."` to run inline Node scripts. Node's `require()` only resolves modules from `node_modules/` directories in the file's ancestry chain — it does not search the global prefix. Since the script runs from `/app` (WORKDIR), and `/app/node_modules/cheerio` does not exist, `require("cheerio")` fails.

### What did not work

1. `docker compose exec -e NODE_PATH=/usr/local/lib/node_modules` — the `-e` flag on `docker compose exec` did not propagate the env var to the Node process
2. Setting NODE_PATH in the compose service environment — not appropriate since this is a test runner concern, not a runtime concern

### Solution

Use absolute path in the inline require: `require("/usr/local/lib/node_modules/cheerio")`. This is ugly but deterministic — the global install path is stable across node:22-slim images.

### Better long-term fix

Install cheerio locally in `/app` during the Dockerfile build: `cd /app && npm install cheerio`. Or add `NODE_PATH=/usr/local/lib/node_modules` as an ENV directive in the Dockerfile so all Node processes in the container can resolve global packages.

### Key details

- Only affects the test runner's inline Node scripts — the web-scrape.ts extension uses its own import path (loaded by Pi, which has its own module resolution)
- The docker compose exec `-e` flag behavior may differ between Docker Compose v1 and v2
- Fix applied in `tests/scraping/real-world-tests.sh` line 54

---

## 2026-05-26 — Real-world scraping campaign: 4-tier stack validation across 15 sites

### Campaign summary

Tested 15 websites spanning 4 difficulty levels against the 4-tier scraping stack (cheerio, scrapling Fetcher, scrapling DynamicFetcher, Apify). T4 (Apify) was not tested — APIFY_API_TOKEN not set.

### Tier success rates

| Tier | Attempted | PASS | BLOCK | EMPTY | Success Rate |
|------|-----------|------|-------|-------|-------------|
| T1 (cheerio) | 14 | 8 | 3 | 3 | 57% |
| T2 (stealth) | 8 | 4 | 0 | 4 | 50% |
| T3 (browser) | 11 | 8 | 0 | 3 | 73% |

### Key finding 1: T2 (stealth) selector compatibility bug

T2 returned EMPTY on multiple sites where T1 PASSED — Reddit, Amazon, Zillow. Scrapling's Fetcher gets the page successfully (no HTTP errors, no blocks) but CSS selector matching differs from cheerio. The HTML DOM tree that Scrapling returns may normalize differently (attribute ordering, whitespace handling, element structure) causing selectors that work in cheerio to miss in Scrapling's adapter. This is the most actionable bug found.

### Key finding 2: anti-bot systems are less aggressive on single requests

Amazon (AWS WAF), Zillow (PerimeterX), and Reddit (Cloudflare) all passed T1 on single requests from a datacenter IP. The anti-bot systems appear to be rate-based or behavioral — a single request with proper UA headers passes through. Volume testing needed to find actual thresholds.

### Key finding 3: DataDome is the hardest anti-bot

Etsy (DataDome) blocked all three local tiers. DataDome uses behavioral/intent analysis that detects Playwright automation despite scrapling's anti-detection measures. This is the only anti-bot system that completely defeated T3.

### Key finding 4: T3 (browser) handles PerimeterX on some sites

Booking.com (PerimeterX) and Zillow (PerimeterX) both passed T3. But Walmart (PerimeterX with "variable aggressiveness") returned EMPTY at T3. PerimeterX configuration varies by customer — not a binary pass/fail.

### Key finding 5: JS-rendered sites need T3 minimum

IMDb and Booking.com returned EMPTY at T1 and T2 but PASSED at T3. Content lives in client-side JavaScript that only renders in a browser environment.

### Self-scrape beats Apify hypothesis results

| Site | Hypothesis | Actual | Notes |
|------|-----------|--------|-------|
| eBay | Self-scrape wins | T1 BLOCK, T2 EMPTY | Needs Apify or T3 (not tested) |
| Reddit | Self-scrape wins | T1 PASS | Confirmed — no Apify needed |
| Yelp | Self-scrape wins | All tiers FAIL | Needs Apify or selector update |
| Etsy | Self-scrape wins | DataDome blocks all | Needs Apify (if actor exists) |

### Revised tier escalation model

```
T1 PASS → done (57% of sites)
T1 BLOCK → T2 (defeats basic Cloudflare)
T1 EMPTY → T3 (JS rendering needed, skip T2 — selector bug)
T3 EMPTY/BLOCK → T4 Apify (DataDome, aggressive PerimeterX, SPAs)
```

### References

- Campaign plan: `tasks/plans/real-world-scrape-campaign.md`
- Test runner: `tests/scraping/real-world-tests.sh`
- Results: `tests/results/real-world-campaign-20260526.md`

---

## 2026-05-26 — setup.sh on Windows: resolved issues and patterns

### WSL env var pass-through

`SKIP_BUILD=1 wsl bash src/agents/setup.sh` does not propagate env vars into WSL. Fixed by adding `--skip-build` CLI flag to setup.sh and forwarding args from setup.ps1.

### auth.json symlinks vs Docker build context

Agent dirs used symlinks (`auth.json -> ../../../../../auth.json`) pointing outside the Docker build context (`src/agents/`). Docker cannot follow symlinks that escape the context. Previously worked only because layers were cached.

**Fix**: setup.sh `copy_auth_json` function copies the real file into each agent dir before building. Both symlinks and copies are gitignored.

### Git Bash MSYS path mangling

MSYS translates Unix-style paths into Windows paths. `MSYS_NO_PATHCONV=1` helps for `docker exec` args but doesn't fix `docker cp` (the `container:/path` syntax gets mangled) or `pwd` output (returns `/c/Users/...` which native tools like jq can't read).

Fixes applied:
- `docker cp` replaced with `cat file | dc exec -T container sh -c 'cat > /path'` — avoids `container:/path` syntax entirely
- `SCRIPT_DIR`/`REPO_ROOT` use `cygpath -w` when available (Git Bash) to produce Windows paths for native tools
- `dc()` helper does `(cd "$REPO_ROOT" && docker compose ...)` to avoid `-f` path issues
- Health check uses `dc exec -T paperclip node -e '...'` instead of host-side `curl` (avoids localhost DNS resolution differences)
- Default `PAPERCLIP_URL` uses `127.0.0.1` instead of `localhost` (bypasses DNS for remaining curl calls)

### Paperclip agent registration enum validation

Paperclip validates `role` and `icon` against fixed enums. Custom values rejected with 422.

Valid roles: `ceo`, `cto`, `cmo`, `cfo`, `security`, `engineer`, `designer`, `pm`, `qa`, `devops`, `researcher`, `general`

Valid icons: `bot`, `cpu`, `brain`, `zap`, `rocket`, `code`, `terminal`, `shield`, `eye`, `search`, `wrench`, `hammer`, `lightbulb`, `sparkles`, `star`, `heart`, `flame`, `bug`, `cog`, `database`, `globe`, `lock`, `mail`, `message-square`, `file-code`, `git-branch`, `package`, `puzzle`, `target`, `wand`, `atom`, `circuit-board`, `radar`, `swords`, `telescope`, `microscope`, `crown`, `gem`, `hexagon`, `pentagon`, `fingerprint`

Mapping: Data → `engineer`, Writer → `general`, Coder → `engineer`. Writer icon `pencil` → `message-square`. QA icon `shield-check` → `shield`.

### bootstrap-invite.cjs pnpm compatibility

Paperclip switched to pnpm, so `require.resolve("pg", { paths: ["/app"] })` no longer works — pg is nested under `.pnpm/`. Fixed with a fallback that finds the module via `find`.

### Docker Compose project name and volumes

Docker Compose derives project name from directory name. Renaming the repo caused stale containers (port conflicts) and orphaned volumes (data loss). Fixed by pinning `name: paperclip-eval` in docker-compose.yml and giving all volumes explicit names (`paperclip-eval-data`, etc.).

### Stale API keys on fresh instance

setup.sh skipped API key creation if any `pcp_` key existed in the agent `.env` file — even if the Paperclip instance was fresh (new volume). Keys from a previous instance are invalid. Fixed by only skipping key creation when the agent already exists in the *current* instance (checked via `EXISTING_FLAGS`).

### PAPERCLIP_PUBLIC_URL origin validation

Paperclip's auth (Better Auth) validates browser request origins against `PAPERCLIP_PUBLIC_URL`. Setting it to the Docker-internal hostname (`http://paperclip:3100`) causes "Invalid origin" errors in the browser. Must be set to `http://localhost:3100` to match browser origin.

### docker compose restart does not reload env vars

`docker compose restart <service>` restarts the existing container process but does NOT re-read `docker-compose.yml` or `.env` files. If you change an env var in docker-compose.yml or any `env_file`, you must use `docker compose up -d <service>` to recreate the container. `restart` only sends SIGTERM/SIGSTART to the running container with its original environment. This has caused multiple debugging dead-ends where env changes appeared to have no effect.

### Remaining open issues

See `tasks/issues/`.