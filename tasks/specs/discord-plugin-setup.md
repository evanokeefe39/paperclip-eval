# Discord Integration via paperclip-plugin-discord

## Intent

Enable bidirectional Discord communication for agent escalations, notifications, and human-in-the-loop workflows by configuring the community `paperclip-plugin-discord` plugin. Replaces the planned custom adapter approach after discovering Paperclip's plugin system and the existing community ecosystem.

## Context Package

### What changed

Investigation on 2026-05-26 found:
1. Paperclip has no built-in Discord/Telegram/Slack integration — the escalate spec's claim was wrong
2. Paperclip has a fully developed plugin system (69 capabilities, 32 event types, webhooks, outbound HTTP, agent tools, UI slots)
3. Community plugins already exist: `paperclip-plugin-discord` (mvanhorn, v0.7.3, 323 tests), plus Telegram and Slack equivalents
4. A shared `PlatformAdapter` abstraction (`paperclip-plugin-chat-core`) underlies all three chat plugins
5. Paperclip's interaction API (`ask_user_questions`, `request_confirmation`, `suggest_tasks`) covers structured HITL scenarios natively

### Current state

- Plugin installed in Paperclip instance (ID: `60ba54d5-e922-43b9-bd50-a72130e0c017`, status: `ready`)
- Placeholder config set — needs real Discord credentials
- Custom `escalate.ts` disabled in bridge.mjs (file retained for potential fork/extension)
- No Discord server or bot application created yet

### Relevant code

- `src/agents/extensions/escalate.ts` — custom escalation Pi extension (disabled, retained)
- `src/agents/skills/paperclip-tools.ts` — wraps Paperclip REST API including interaction endpoints
- `src/agents/bridge.mjs` — escalate.ts load commented out (line 123)
- `src/agents/docker-compose.yml` — no changes needed (plugin runs inside Paperclip container)

### Stale docs (marked)

- `tasks/specs/discord-bridge.md` — superseded, stale header added
- `tasks/specs/escalate.md` — partially superseded, stale header added
- `docs/toyota-way-principles-integration.md` — escalate tool section updated

## Escalation Primitives: What Exists vs. What We Need

### Paperclip interaction API (built-in)

| Primitive | API | Capabilities | Limitations |
|-----------|-----|-------------|-------------|
| Multiple-choice question | `ask_user_questions` | Single/multi select, multiple questions per interaction, idempotency, `wake_assignee` continuation | **No free-text input.** Options required on every question. `selectionMode` must be `single` or `multi`. |
| Approval gate | `request_confirmation` | Accept/reject, custom button labels, optional reject reason (`allowDeclineReason`), `wake_assignee_on_accept` | Single approver only. No multi-user approval workflow. |
| Task proposal | `suggest_tasks` | Propose sub-tasks with priority/assignee, auto-creates child issues on accept | **All-or-nothing accept.** No partial selection. |

### Discord plugin escalation (`escalate_to_human`)

| Primitive | Capabilities | Limitations |
|-----------|-------------|-------------|
| Contextual escalation | Conversation history, agent reasoning, confidence score, suggested reply, timeout with auto-resolution | Requires Discord plugin configured and bot online |
| Interactive buttons | Reply to Customer, Override Agent, Use Suggested Reply, Dismiss | Discord-specific UI (Telegram/Slack plugins render differently) |
| Escalation reasons | `low_confidence`, `explicit_request`, `sensitive_topic`, `policy_violation`, `repeated_failure`, `high_value_customer`, `custom` | Reason taxonomy is fixed in `chat-core` types |

### Discord plugin notifications (event-driven, no agent action needed)

| Event | Discord rendering |
|-------|------------------|
| Issue created | Blue embed with title, description, status, priority, assignee |
| Issue done | Green embed |
| Approval requested | Yellow embed with interactive Approve/Reject buttons |
| Agent error | Red embed with error message |
| Agent run started/finished | Blue/green lifecycle embeds |

### Gap analysis

| Our need | Covered by | Gap? |
|----------|-----------|------|
| Request info (multiple choice) | `ask_user_questions` | No |
| Request info (free text) | Plugin reply routing (human replies to embed → issue comment) | No — different mechanism than interaction API, but works |
| Approval (accept/reject) | `request_confirmation` + plugin approval buttons | No |
| Approval (accept/reject/feedback) | `request_confirmation` with `allowDeclineReason: true` | No — reject reason serves as feedback |
| Multi-user approval | Neither | **Yes — future need, neither covers it** |
| Review request (non-blocking) | Plugin issue notifications (blue embed, no pause) | No |
| Alert/notification (no pause) | Plugin event subscriptions (`issue.created`, `agent.error`) | No — agent doesn't explicitly notify, plugin reacts to events |
| Escalation with context | Plugin `escalate_to_human` | No |
| Task suggestions | `suggest_tasks` | Partial — no partial accept |
| Process flag (kaizen) | Create issue with `kaizen` label, plugin notifies | No — label-based, plugin picks up via `issue.created` event |

**Conclusion:** For eval purposes, the combination of Paperclip's interaction API and the Discord plugin covers all scenarios except multi-user approval (future need) and partial task accept (low priority). Free-text input is handled through reply routing rather than the interaction API, which is acceptable.

## Deliverables

### 1. Discord server and bot setup (operator task)

Create a Discord server for the eval environment. Follow the plugin's setup requirements:

1. Create Discord application at https://discord.com/developers/applications
2. Add bot, copy token
3. Enable MESSAGE CONTENT privileged intent
4. Invite bot with `applications.commands` + `bot` scopes and permissions: Send Messages, Read Message History, Add Reactions, Send Messages in Threads, Read Messages/View Channels, Use Slash Commands
5. Create channels: `#escalations`, `#approvals`, `#agent-errors`, `#general` (or a single `#agents` channel to start)
6. Copy guild ID and channel IDs

### 2. Paperclip secrets (API calls)

Create secrets for credentials the plugin needs:

```
POST /api/companies/{companyId}/secrets
{"name": "discord-bot-token", "value": "<BOT_TOKEN>", "provider": "local_encrypted"}
→ returns secret UUID for discordBotTokenRef
```

If authenticated mode requires a board API key:
```
POST /api/agents/{agentId}/keys
→ returns API key

POST /api/companies/{companyId}/secrets
{"name": "board-api-key", "value": "<API_KEY>", "provider": "local_encrypted"}
→ returns secret UUID for paperclipBoardApiKeyRef
```

### 3. Plugin configuration (API call)

```
POST /api/plugins/60ba54d5-e922-43b9-bd50-a72130e0c017/config
{
  "configJson": {
    "discordBotTokenRef": "<secret-uuid>",
    "defaultChannelId": "<discord-channel-id>",
    "defaultGuildId": "<discord-guild-id>",
    "paperclipBaseUrl": "http://localhost:3100",
    "paperclipBoardApiKeyRef": "<board-api-key-secret-uuid>",
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

Start with minimal config (escalations + commands + inbound). Enable intelligence, media, custom commands, digest after eval confirms the basics work.

### 4. Automate plugin setup in setup.sh

Add to `src/agents/setup.sh` (after company and agent creation):

- Check if plugin is installed (`GET /api/plugins`, look for `paperclip-plugin-discord`)
- If not, install it (`POST /api/plugins/install {"packageName":"paperclip-plugin-discord"}`)
- Check if secrets exist, create if missing
- Configure plugin if `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` env vars are set
- Skip Discord setup silently if env vars are unset (same pattern as existing optional features)

New env vars in `.env.example`:

```
# Discord integration (via paperclip-plugin-discord)
# Set these to enable Discord notifications and escalations
# If unset, plugin is installed but unconfigured (no Discord features)
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
DISCORD_CHANNEL_ID=
DISCORD_APPROVALS_CHANNEL_ID=
DISCORD_ERRORS_CHANNEL_ID=
DISCORD_ESCALATION_CHANNEL_ID=
```

### 5. Setup guide

Create `docs/discord-setup.md` covering:
- Discord server and bot creation (step by step)
- Env var configuration
- Running setup.sh to auto-configure
- Verification: trigger an escalation, see Discord embed, reply, confirm comment appears
- Channel routing options (single channel vs. dedicated channels)
- Plugin feature toggles and when to enable each

### 6. Verify escalate_to_human works with HTTP adapter agents

The plugin registers `escalate_to_human` as an agent tool via Paperclip's plugin SDK. Agents using local adapters (claude_local, pi_local) get plugin tools injected automatically. Our agents use the HTTP adapter — verify that plugin-registered tools are included in the wake payload sent to HTTP adapter agents.

If plugin tools are NOT included for HTTP adapter agents:
- Option A: Add `escalate_to_human` as a Pi extension that calls the plugin's tool endpoint
- Option B: Re-enable `escalate.ts` with modifications to call the plugin's webhook instead of creating raw issues
- Option C: Use `paperclip_api_request` escape hatch from `paperclip-tools.ts` to call plugin endpoints

This is the primary risk item. Test before writing the setup guide.

## Behavioral Contracts

### Plugin installation is idempotent

GIVEN setup.sh runs and the plugin is already installed
THEN setup.sh skips installation and proceeds to configuration
AND no error is raised

### Plugin configuration is idempotent

GIVEN setup.sh runs and the plugin is already configured with the same values
THEN setup.sh overwrites config (POST is not conditional)
AND the plugin continues operating without interruption

### Escalation creates Discord notification

GIVEN the plugin is configured with valid Discord credentials
WHEN an agent calls `escalate_to_human` (or an escalation issue is created)
THEN a rich Discord embed appears in the configured escalation channel
AND the embed includes interactive buttons (Reply, Override, Use Suggested Reply, Dismiss)

### Human reply flows back to Paperclip

GIVEN an escalation embed exists in Discord
WHEN a human replies in the thread or clicks a button
THEN the response is posted as a Paperclip issue comment
AND the agent is woken on next heartbeat via `PAPERCLIP_WAKE_COMMENT_ID`

### Approval buttons work from Discord

GIVEN an approval interaction exists on a Paperclip issue
WHEN the plugin posts an approval embed with Approve/Reject buttons
AND a human clicks Approve
THEN the approval is resolved in Paperclip
AND the agent is woken per the `continuationPolicy`

### No Discord when unconfigured

GIVEN `DISCORD_BOT_TOKEN` is unset in `.env`
WHEN setup.sh runs
THEN the plugin is installed but not configured
AND agents operate normally without Discord features
AND no errors in Paperclip logs about missing Discord config

### Existing interactions still work

GIVEN the plugin is installed
THEN `ask_user_questions`, `request_confirmation`, and `suggest_tasks` via Paperclip REST API continue to work unchanged
AND the plugin renders interaction events as Discord embeds (additive, not replacing)

## Edge Cases

1. **Plugin install fails (npm/network)** — setup.sh logs warning, continues. Agents work without Discord.
2. **Discord bot token invalid** — plugin fails to connect to gateway. Paperclip logs error. Interactions still work via UI.
3. **Discord channel deleted** — plugin posts fail silently. Paperclip issue/interaction state unaffected.
4. **Multiple companies** — plugin config supports `companyChannels` mapping. One channel per company or shared.
5. **Plugin update** — `POST /api/plugins/install` with same package name updates to latest version.
6. **HTTP adapter tool injection** — if plugin tools aren't injected for HTTP adapter agents, fallback to Pi extension wrapper (deliverable 6).
7. **Concurrent escalations** — each gets its own Discord thread. Plugin handles independently.
8. **Bot rate limited by Discord** — plugin has built-in exponential backoff (max 5 failures, 60s backoff).

## Definition of Done

- [ ] Discord server created with bot application
- [ ] Bot has MESSAGE CONTENT intent enabled
- [ ] Bot invited to server with correct permissions
- [ ] Paperclip secrets created for bot token (and board API key if needed)
- [ ] Plugin configured with real Discord credentials via API
- [ ] Plugin status shows `active` (not just `ready`)
- [ ] `escalate_to_human` tool available to agents (verify with HTTP adapter)
- [ ] Escalation creates Discord embed with interactive buttons
- [ ] Human reply in Discord thread creates Paperclip issue comment
- [ ] Approval interaction renders as Discord embed with Approve/Reject buttons
- [ ] `/clip status` slash command works in Discord
- [ ] setup.sh updated with plugin install and config automation
- [ ] `.env.example` updated with Discord env vars
- [ ] `docs/discord-setup.md` written
- [ ] Custom `escalate.ts` disabled in bridge.mjs (confirmed)
- [ ] Stale docs marked (confirmed: discord-bridge.md, escalate.md, TPS integration doc)

## Negative Space

What must not change:
- `escalate.ts` file (keep, don't delete — future fork/extension reference)
- Paperclip interaction API behavior (plugin is additive)
- Other extensions (web-search, web-fetch, web-scrape, artifacts, paperclip-tools)
- Agent container images (plugin runs inside Paperclip, not agent containers)

Out of scope:
- Telegram or Slack plugin installation (evaluate after Discord is proven)
- Custom plugin development or forking (use community plugin as-is first)
- Multi-user approval workflow (future need, neither platform nor plugin supports it yet)
- Community intelligence features (enable after basic escalation is validated)
- Media pipeline (enable after basic escalation is validated)
- Daily digest (enable after basic escalation is validated)

Reserved for human review:
- Discord server naming and channel structure
- Who gets what Discord roles
- Whether to enable slash commands for non-admin Discord users
- Escalation timeout duration (default 30 min — adjust based on eval response times)

## Open Questions

(empty)
