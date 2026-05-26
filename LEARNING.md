# Paperclip Learnings

Running notes on issues, workarounds, and architectural observations discovered while evaluating [Paperclip](https://github.com/paperclipai/paperclip) for agent orchestration. Each entry captures what went wrong, why, and what to do about it.

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

A template config is kept at `src/agents/paperclip-config.json` and copied into the container via `docker cp` when needed.

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