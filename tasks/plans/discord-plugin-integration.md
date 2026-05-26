# Implementation Plan: Discord Plugin Integration

Integrate `paperclip-plugin-discord` (v0.7.3) for agent escalations, notifications, and HITL workflows. Replace custom `escalate.ts` with plugin's `escalate_to_human` tool.

Spec: `tasks/specs/discord-plugin-setup.md`

---

## Phase 0: Spikes (answer unknowns before building)

### Spike 0.1: Do HTTP adapter agents receive plugin-registered tools?

**Risk:** Highest. The plugin registers `escalate_to_human` via `agent.tools.register`. Local adapter agents (claude_local, pi_local) get plugin tools injected automatically. Our agents use the HTTP adapter — we don't know if Paperclip includes plugin tools in the HTTP wake payload.

**Method:**
1. Plugin is already installed. Configure it with a dummy bot token (it'll fail to connect to Discord gateway, but the tool registration should still happen).
2. Invoke an agent via the bridge: `curl -X POST http://localhost:8081/invoke -d '{"prompt":"List every tool available to you. Include exact names."}'`
3. Check if `escalate_to_human` appears in the output alongside `web_search`, `web_fetch`, `paperclip_get_issue`, etc.
4. If yes: HTTP adapter agents get plugin tools. Proceed as planned.
5. If no: need a shim. Options documented in spec deliverable 6.

**Success criteria:** Agent output includes `escalate_to_human` in its tool list.

**Fallback if fails:** Write a thin Pi extension (`extensions/escalate-shim.ts`) that calls the plugin's tool endpoint via Paperclip API. The shim is a wrapper, not a reimplementation — it delegates to the plugin.

### Spike 0.2: Plugin activation lifecycle

**Risk:** Medium. We configured the plugin with placeholder values. Need to understand: does reconfiguring with real values activate the bot immediately, or does the plugin need a restart?

**Method:**
1. POST real config to `/api/plugins/{id}/config` with valid Discord credentials.
2. Check plugin status: `GET /api/plugins/{id}` — does status change from `ready` to `active`?
3. Check Paperclip logs for Discord gateway connection attempts.
4. If the bot doesn't start: try `POST /api/plugins/{id}/restart` or similar lifecycle endpoints.
5. If no restart endpoint exists: restart the Paperclip container (`docker compose restart paperclip`).

**Success criteria:** Plugin status shows `active`, Discord bot appears online in the server.

### Spike 0.3: Plugin tool invocation format

**Risk:** Low-medium. The plugin's `escalate_to_human` has specific parameters (from `paperclip-plugin-chat-core` types: reason, context, suggestedReply, etc.). Need to confirm the exact schema the tool expects when called by an agent.

**Method:**
1. After spike 0.1 confirms tool availability, invoke the agent with a prompt to call `escalate_to_human`.
2. Capture the Pi RPC events from bridge.mjs (LOG_LEVEL=debug) to see the tool call schema.
3. If the tool has parameters the LLM struggles with, document them for agent prompt tuning.
4. Also check: does `escalate_to_human` work when Discord gateway is not connected? Does it fall back to Paperclip-only escalation, or does it fail?

**Success criteria:** Agent successfully calls `escalate_to_human`, tool result returned to LLM even if Discord delivery fails.

### Spike 0.4: Secrets and authenticated mode

**Risk:** Low. The plugin config has `paperclipBoardApiKeyRef` for authenticated mode. We run in authenticated mode. Need to confirm: does the plugin need a board API key to call Paperclip's internal APIs, or does it have internal access since it runs inside the Paperclip process?

**Method:**
1. Configure plugin WITHOUT `paperclipBoardApiKeyRef`.
2. Trigger an event that the plugin should react to (create an issue).
3. Check if the plugin posts to Discord. If yes, it has internal access.
4. If no, create a board API key (`POST /api/agents/{id}/keys`), store as secret, add to config.

**Success criteria:** Plugin can read Paperclip data and react to events without a separate API key, OR the API key path works.

---

## Phase 1: Discord Server Setup (operator, manual)

### 1.1 Create Discord server

- Create server named "Paperclip Eval" (or use existing)
- Create channels: `#escalations`, `#approvals`, `#agent-errors`, `#general`
- Enable Developer Mode in Discord settings (for copying IDs)

### 1.2 Create bot application

- Discord Developer Portal > New Application > "Paperclip Agents"
- Bot tab > Reset Token > save token securely
- Bot tab > enable MESSAGE CONTENT INTENT
- OAuth2 > URL Generator:
  - Scopes: `bot`, `applications.commands`
  - Permissions: Send Messages, Read Message History, Add Reactions, Send Messages in Threads, Read Messages/View Channels, Use Slash Commands
- Open generated URL in browser, add bot to server

### 1.3 Collect IDs

- Copy guild (server) ID
- Copy channel IDs for each channel
- Record in `.env`

**Success criteria:** Bot appears in server member list (offline). All IDs collected.

---

## Phase 2: Plugin Configuration (automated in setup.sh)

### 2.1 Create Paperclip secrets

```bash
# Bot token secret
POST /api/companies/{cid}/secrets
{"name":"discord-bot-token","value":"<token>","provider":"local_encrypted"}
→ save UUID as DISCORD_BOT_TOKEN_REF

# Board API key (if spike 0.4 shows it's needed)
POST /api/agents/{ceoAgentId}/keys → get key
POST /api/companies/{cid}/secrets
{"name":"board-api-key","value":"<key>","provider":"local_encrypted"}
→ save UUID as BOARD_API_KEY_REF
```

### 2.2 Configure plugin

```bash
POST /api/plugins/{pluginId}/config
{
  "configJson": {
    "discordBotTokenRef": "<DISCORD_BOT_TOKEN_REF>",
    "defaultChannelId": "<DISCORD_CHANNEL_ID>",
    "defaultGuildId": "<DISCORD_GUILD_ID>",
    "escalationChannelId": "<DISCORD_ESCALATION_CHANNEL_ID>",
    "approvalsChannelId": "<DISCORD_APPROVALS_CHANNEL_ID>",
    "errorsChannelId": "<DISCORD_ERRORS_CHANNEL_ID>",
    "paperclipBaseUrl": "http://localhost:3100",
    "enableEscalations": true,
    "enableCommands": true,
    "enableInbound": true,
    "escalationTimeoutMinutes": 30,
    "enableIntelligence": false,
    "enableMediaPipeline": false,
    "enableCustomCommands": false,
    "enableProactiveSuggestions": false,
    "digestMode": "off"
  }
}
```

### 2.3 Verify activation

- `GET /api/plugins/{id}` shows status `active`
- Discord bot appears online in server
- `/clip status` slash command responds

**Success criteria:** Plugin active, bot online, slash commands registered.

---

## Phase 3: setup.sh Automation

### 3.1 Add plugin install to setup.sh

After company and agent creation, add:

```bash
# --- Discord plugin ---
install_discord_plugin() {
  # Check if installed
  PLUGIN_ID=$(api_get "/api/plugins" | jq -r '.[] | select(.packageName == "paperclip-plugin-discord") | .id // empty')
  if [ -n "$PLUGIN_ID" ]; then
    log "Discord plugin already installed: $PLUGIN_ID"
  else
    log "Installing paperclip-plugin-discord..."
    INSTALL_RESP=$(api_post "/api/plugins/install" '{"packageName":"paperclip-plugin-discord"}')
    PLUGIN_ID=$(echo "$INSTALL_RESP" | jq -r '.id // empty')
    log "Installed: $PLUGIN_ID"
  fi

  # Skip config if Discord vars not set
  if [ -z "$DISCORD_BOT_TOKEN" ] || [ -z "$DISCORD_CHANNEL_ID" ]; then
    log "DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID not set — skipping Discord config"
    return 0
  fi

  # Create/find secrets
  # ... (create bot token secret, optionally board API key secret)

  # Configure plugin
  # ... (POST config with real values)
}
```

### 3.2 Idempotency

- Plugin install is idempotent (returns existing plugin if already installed)
- Secret creation is NOT idempotent (creates duplicates) — check by name first via `GET /api/companies/{cid}/secrets`
- Plugin config POST overwrites — safe to re-run

**Success criteria:** `setup.sh` can be run repeatedly without errors. Discord plugin configured if env vars present, skipped gracefully if not.

---

## Phase 4: Agent Prompt Tuning

### 4.1 Update AGENTS.md for each agent

Add to each agent's AGENTS.md (system prompt):

```markdown
## Escalation

When you need human input, approval, or cannot proceed:
- Use the `escalate_to_human` tool for unstructured escalation (questions, context, suggested replies)
- Use `paperclip_ask_user_questions` for structured multiple-choice questions
- Use `paperclip_request_confirmation` for accept/reject gates
- Use `paperclip_suggest_tasks` to propose sub-tasks for human review

Do not create raw issues for escalation — use the tools above.
```

### 4.2 Remove escalate references from prompts

Grep all AGENTS.md files for references to the old `escalate` tool and update to reference `escalate_to_human`.

**Success criteria:** Agents use plugin tools for escalation, not the disabled `escalate.ts`.

---

## Phase 5: Tests

### 5.1 Spike validation tests (run once, confirm spikes)

File: `tests/discord-plugin/spike-tests.sh`

```
Spike 0.1 — HTTP adapter tool injection
  ▸ Agent lists escalate_to_human in available tools
  ▸ Agent lists discord_signals in available tools
  ▸ Tool list includes both Pi extension tools AND plugin tools

Spike 0.2 — Plugin activation
  ▸ Plugin status is active after config
  ▸ Plugin status endpoint returns tool count = 6

Spike 0.3 — Tool invocation
  ▸ Agent can call escalate_to_human (may fail Discord delivery, but tool executes)
  ▸ Tool result returned to agent even if Discord unavailable

Spike 0.4 — Auth mode
  ▸ Plugin can read company data (issues list) without board API key
  ▸ OR: Plugin works with board API key secret configured
```

### 5.2 Plugin API tests (no Discord required)

File: `tests/discord-plugin/unit-test.sh`

Tests against the Paperclip plugin API surface. No Discord server needed.

```
Section 1: Plugin lifecycle
  ▸ GET /api/plugins returns array with discord plugin
  ▸ Plugin has status ready or active
  ▸ Plugin manifest declares 6 tools
  ▸ Plugin manifest declares 5 jobs
  ▸ Plugin manifest declares 1 webhook endpoint

Section 2: Plugin configuration
  ▸ GET /api/plugins/{id}/config returns current config
  ▸ POST /api/plugins/{id}/config with valid schema succeeds
  ▸ POST /api/plugins/{id}/config with missing required field fails (discordBotTokenRef)
  ▸ POST /api/plugins/{id}/config with missing required field fails (defaultChannelId)
  ▸ Config idempotency: POST same config twice, GET returns consistent state

Section 3: Secrets management
  ▸ POST /api/companies/{cid}/secrets creates secret, returns UUID
  ▸ GET /api/companies/{cid}/secrets lists secrets (name visible, value hidden)
  ▸ Duplicate secret name creates separate entry (not idempotent — document this)

Section 4: Plugin tools registered
  ▸ Plugin manifest tools array contains escalate_to_human
  ▸ Plugin manifest tools array contains discord_signals
  ▸ Plugin manifest tools array contains handoff_to_agent
  ▸ Plugin manifest tools array contains discuss_with_agent
  ▸ Plugin manifest tools array contains register_custom_command
  ▸ Plugin manifest tools array contains register_watch
```

### 5.3 Interaction API tests (no Discord required)

File: `tests/discord-plugin/interaction-test.sh`

Validates Paperclip's interaction API which the plugin renders to Discord. These tests work without Discord configured.

```
Section 1: ask_user_questions
  ▸ Create single-select question → status pending
  ▸ Create multi-select question → status pending
  ▸ Mixed: two questions in one interaction
  ▸ Respond with valid optionIds → status answered
  ▸ Respond with invalid questionId → 422
  ▸ Respond with invalid optionId → 422
  ▸ Cancel pending question → status cancelled, cancellationReason stored
  ▸ Re-resolve answered interaction → 409
  ▸ Idempotency: same idempotencyKey returns same interaction
  ▸ Free-text question (no options) → 400 (documents the gap)

Section 2: request_confirmation
  ▸ Create basic confirmation → status pending
  ▸ Create with custom accept/reject labels
  ▸ Accept → status accepted, result.outcome = accepted
  ▸ Reject with reason → status rejected, result.reason stored
  ▸ Reject without reason → status rejected, result.reason null
  ▸ accept on ask_user_questions → 422 (cross-type enforcement)
  ▸ respond on request_confirmation → 422 (cross-type enforcement)

Section 3: suggest_tasks
  ▸ Create task suggestion → status pending
  ▸ Accept → creates child issues, returns createdTasks
  ▸ Child issues have correct parentId
  ▸ Child issues carry priority and assigneeAgentId
  ▸ Reject with reason → status rejected
  ▸ All-or-nothing: no partial accept (document gap)

Section 4: Continuation policies
  ▸ wake_assignee triggers agent run on resolution
  ▸ none does not trigger agent run
  ▸ wake_assignee_on_accept triggers on accept, not reject

Section 5: Activity events
  ▸ Creating interaction generates issue.thread_interaction_created activity
  ▸ Resolving generates issue.thread_interaction_answered/accepted/rejected activity
```

### 5.4 E2E escalation tests (requires Discord)

File: `tests/e2e/e2e-10-discord-escalation.sh`

Full loop through agent → Paperclip → Discord → human reply → Paperclip → agent. Requires live Discord server with bot configured.

```
Prerequisites:
  ▸ Stack healthy (Paperclip + agents)
  ▸ Plugin status is active
  ▸ Discord bot is online (slash command responds)

Test 1: escalate_to_human tool is available
  ▸ Invoke agent, ask to list tools
  ▸ Output contains escalate_to_human

Test 2: Agent calls escalate_to_human
  ▸ Prompt agent to escalate with specific message
  ▸ Verify Paperclip issue created (issue count increases)
  ▸ Verify agent output references escalation
  ▸ Verify Discord embed appears in escalation channel (poll Discord API)

Test 3: Discord embed content matches escalation
  ▸ Fetch last message in escalation channel via Discord API
  ▸ Embed title contains issue identifier
  ▸ Embed description contains escalation message
  ▸ Embed has interactive buttons (Reply, Override, Suggested Reply, Dismiss)

Test 4: Reply in Discord creates Paperclip comment
  ▸ Create a thread reply via Discord API (bot sends on behalf of test)
  ▸ Wait 5 seconds
  ▸ GET /api/issues/{id}/comments — verify new comment with reply text
  ▸ Verify the issue is unblocked / agent woken

Test 5: Approval interaction renders in Discord
  ▸ Create request_confirmation interaction on an issue via Paperclip API
  ▸ Verify Discord embed appears with Approve/Reject buttons
  ▸ Click Approve via Discord API
  ▸ Verify interaction status is accepted in Paperclip

Test 6: Issue creation triggers notification
  ▸ Create issue via Paperclip API
  ▸ Verify blue embed appears in default channel
  ▸ Embed contains issue title and identifier

Test 7: Agent error triggers notification
  ▸ Trigger an agent run that fails (invalid prompt or timeout)
  ▸ Verify red error embed appears in errors channel

Test 8: Slash command /clip status
  ▸ Invoke /clip status via Discord API
  ▸ Verify response lists agents with status

Test 9: Escalation timeout
  ▸ Set escalationTimeoutMinutes to minimum (5)
  ▸ Trigger escalation
  ▸ Wait for timeout (or check timeout job behavior)
  ▸ Verify escalation embed updated to timed-out state

Test 10: Multiple agents escalate independently
  ▸ CEO escalates
  ▸ Researcher escalates
  ▸ Verify two separate Discord embeds
  ▸ Reply to each independently
  ▸ Verify correct comment on correct issue
```

### 5.5 E2E interaction tests (no Discord required)

File: `tests/e2e/e2e-11-interactions.sh`

Tests the built-in interaction tools through the agent bridge, verifying agents can use `paperclip_ask_user_questions` and `paperclip_request_confirmation`.

```
Test 1: Agent uses ask_user_questions
  ▸ Prompt agent to create a structured question on its current issue
  ▸ Verify interaction created (GET /api/issues/{id}/interactions)
  ▸ Resolve interaction via API
  ▸ Verify agent wake (if continuationPolicy = wake_assignee)

Test 2: Agent uses request_confirmation
  ▸ Prompt agent to request approval
  ▸ Verify confirmation interaction created
  ▸ Accept via API
  ▸ Verify interaction resolved

Test 3: Agent uses suggest_tasks
  ▸ Prompt agent to suggest sub-tasks
  ▸ Verify suggest_tasks interaction created
  ▸ Accept via API
  ▸ Verify child issues created
```

### 5.6 setup.sh automation tests

File: `tests/e2e/e2e-12-discord-setup.sh`

```
Test 1: setup.sh installs plugin
  ▸ Wipe and re-run setup.sh with DISCORD_BOT_TOKEN set
  ▸ Plugin appears in GET /api/plugins
  ▸ Plugin config has correct values

Test 2: setup.sh is idempotent
  ▸ Run setup.sh twice
  ▸ No duplicate plugins
  ▸ No duplicate secrets (check by name)
  ▸ Config unchanged

Test 3: setup.sh skips Discord when unconfigured
  ▸ Unset DISCORD_BOT_TOKEN, run setup.sh
  ▸ Plugin installed but unconfigured (config is null or placeholder)
  ▸ No errors in output
```

---

## Phase 6: Documentation

### 6.1 Discord setup guide

File: `docs/discord-setup.md`

Covers: server creation, bot application, intents, permissions, env vars, running setup.sh, verification checklist, channel routing options, feature toggles guide, troubleshooting (bot offline, commands not registered, embeds not appearing).

### 6.2 Update LEARNING.md

Add entry documenting:
- Paperclip has no built-in chat integrations — community plugins required
- Plugin system is the correct extensibility path (not custom adapters)
- `ask_user_questions` has no free-text mode (options required)
- `suggest_tasks` is all-or-nothing (no partial accept)
- HTTP adapter tool injection status (from spike 0.1)

---

## Execution Order

```
Phase 0 (spikes)     — 0.1 → 0.2 → 0.3 → 0.4  (sequential, each informs next)
Phase 1 (server)     — parallel with Phase 0
Phase 2 (config)     — after Phase 0 + 1
Phase 3 (setup.sh)   — after Phase 2
Phase 4 (prompts)    — after spike 0.1 confirms tool availability
Phase 5.1 (spikes)   — during Phase 0 (codify spike results as tests)
Phase 5.2 (plugin)   — after Phase 2
Phase 5.3 (interact) — after Phase 2 (independent of Discord)
Phase 5.4 (e2e disc) — after Phase 2 + 1 (requires live Discord)
Phase 5.5 (e2e intr) — after Phase 4 (requires agent prompt updates)
Phase 5.6 (setup)    — after Phase 3
Phase 6 (docs)       — after all tests pass
```

## Success Criteria (overall)

1. Agent calls `escalate_to_human` → Discord embed appears within 10 seconds
2. Human replies in Discord thread → Paperclip issue comment within 5 seconds
3. Agent wakes on next heartbeat with `PAPERCLIP_WAKE_COMMENT_ID` set
4. Approval interaction → Discord buttons → click approve → interaction resolved in Paperclip
5. Issue created → blue notification embed in Discord (no agent action needed)
6. Agent error → red embed in errors channel
7. `/clip status` returns agent list
8. `setup.sh` configures everything from env vars, is idempotent, skips Discord when unconfigured
9. All spike tests, plugin API tests, interaction tests, and e2e tests pass
10. Custom `escalate.ts` disabled, no regression in other agent capabilities
