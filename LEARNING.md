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