# Discord Integration Setup Guide

How to connect the Paperclip agent stack to Discord for escalations, approvals, and error notifications via the `paperclip-plugin-discord` community plugin (v0.7.3).

---

## Prerequisites

- Paperclip stack running (`docker compose up -d` from `src/agents/`)
- `setup.sh` completed (company and agents registered)
- Discord account

## Discord Server and Bot Setup

### 1. Create or choose a Discord server

Create a new server (suggested name: "Paperclip Eval") or use an existing one.

### 2. Create channels

Start with a single `#agents` channel, or set up dedicated channels for routing:

- `#escalations` -- agent escalation embeds and human replies
- `#approvals` -- approval request embeds with Approve/Reject buttons
- `#agent-errors` -- error notification embeds
- `#general` -- catch-all

You can start with one channel and split later. The plugin uses `defaultChannelId` as a fallback when no per-event channel is configured.

### 3. Enable Developer Mode

User Settings > App Settings > Advanced > Developer Mode. This lets you right-click any server, channel, or user to copy its ID.

### 4. Create a Discord application and bot

Go to https://discord.com/developers/applications.

1. Click **New Application**, name it "Paperclip Agents"
2. Go to the **Bot** tab:
   - Click **Reset Token**, copy the token, save it securely
   - Under **Privileged Gateway Intents**, enable **MESSAGE CONTENT INTENT**
3. Go to **OAuth2 > URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot Permissions: Send Messages, Read Message History, Add Reactions, Send Messages in Threads, Read Messages/View Channels, Use Slash Commands
4. Copy the generated URL, open it in a browser, select your server, authorize

### 5. Copy IDs

With Developer Mode enabled, right-click to copy:

- **Guild (server) ID** -- right-click the server name
- **Channel IDs** -- right-click each channel

## Environment Variables

Add the following to `src/agents/.env`:

```
DISCORD_BOT_TOKEN=<your-bot-token>
DISCORD_GUILD_ID=<guild-id>
DISCORD_CHANNEL_ID=<default-channel-id>
DISCORD_ESCALATION_CHANNEL_ID=<escalation-channel-id>
DISCORD_APPROVALS_CHANNEL_ID=<approvals-channel-id>
DISCORD_ERRORS_CHANNEL_ID=<errors-channel-id>
PAPERCLIP_DISCORD_PLUGIN_ID=60ba54d5-e922-43b9-bd50-a72130e0c017
```

The `PAPERCLIP_DISCORD_PLUGIN_ID` variable controls escalation routing. When set, the `escalate` tool in all agent containers routes through Discord instead of the Paperclip UI. When unset, escalations create Paperclip issues with interactions and agents operate without Discord.

See `src/agents/.env.example` for the full template.

## Plugin Configuration via setup.sh

`setup.sh` handles plugin installation and configuration automatically when the Discord env vars are present:

- Installs `paperclip-plugin-discord` if not already installed
- Creates Paperclip secrets for the bot token and board API key
- Configures the plugin with channel IDs and guild ID
- If `DISCORD_BOT_TOKEN` is unset, the plugin is installed but not configured -- agents still work, escalations go through the Paperclip UI
- Both install and config are idempotent. Re-running `setup.sh` is safe.

To run:

```bash
# From WSL or bash
cd src/agents && bash setup.sh
```

## Manual Plugin Configuration

For manual setup or debugging, use the Paperclip REST API directly. All calls require an authenticated session (cookie from `POST /api/auth/login`).

### 1. Create secret for bot token

```
POST /api/companies/{companyId}/secrets
{
  "name": "discord-bot-token",
  "value": "<BOT_TOKEN>",
  "provider": "local_encrypted"
}
```

Returns `{"id": "<secret-uuid>"}`. Save this UUID.

### 2. Create board API key (required for authenticated mode)

```
POST /api/agents/{agentId}/keys
```

Returns an API key string.

```
POST /api/companies/{companyId}/secrets
{
  "name": "board-api-key",
  "value": "<api-key>",
  "provider": "local_encrypted"
}
```

Returns `{"id": "<secret-uuid>"}`. Save this UUID.

### 3. Configure the plugin

```
POST /api/plugins/60ba54d5-e922-43b9-bd50-a72130e0c017/config
{
  "configJson": {
    "discordBotTokenRef": "<bot-token-secret-uuid>",
    "defaultChannelId": "<channel-id>",
    "defaultGuildId": "<guild-id>",
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

Start with minimal config (escalations, commands, inbound). Enable intelligence, media pipeline, custom commands, and digest after the basics are validated.

### 4. Verify plugin status

```
GET /api/plugins/60ba54d5-e922-43b9-bd50-a72130e0c017
```

Response should show `status: "active"`. If it shows `"ready"`, the config is missing required fields (`discordBotTokenRef`, `defaultChannelId`).

## How Escalation Routing Works

The `escalate` Pi extension (`src/agents/extensions/escalate.ts`) provides a single `escalate` tool to all agents. It is loaded in every agent container via `bridge.mjs`. The backend it targets switches based on whether `PAPERCLIP_DISCORD_PLUGIN_ID` is set in the environment.

### Local mode (no Discord)

When `PAPERCLIP_DISCORD_PLUGIN_ID` is not set:

1. Agent calls `escalate` with a message and optional structured inputs
2. Extension creates a Paperclip issue with the `escalation` label
3. If structured inputs are provided (select-type questions): creates an `ask_user_questions` interaction on the issue
4. If no structured inputs: creates a `request_confirmation` interaction
5. Interactions use `continuationPolicy: wake_assignee` -- the agent wakes when the human responds
6. Extension attempts to pause the agent via `POST /api/agents/{id}/pause`
7. Human responds in the Paperclip UI at http://localhost:3100

### Discord mode

When `PAPERCLIP_DISCORD_PLUGIN_ID` is set:

1. Agent calls `escalate` with a message
2. Extension calls `POST /api/plugins/tools/execute` with tool `{pluginId}:escalate_to_human`
3. Plugin posts a rich Discord embed with interactive buttons (Reply, Override, Suggested Reply, Dismiss)
4. Human replies in the Discord thread -- plugin creates a Paperclip issue comment -- agent wakes via `PAPERCLIP_WAKE_COMMENT_ID`
5. Escalation timeout (default 30 minutes) auto-resolves if no response

### Tool interface (same for both modes)

```
escalate({
  message: "Why you need help -- be specific",
  urgency: "blocking" | "when_you_can",    // optional, default blocking
  inputs: [{                                // optional, structured questions
    id: "db_choice",
    label: "Which database?",
    type: "select",
    options: [{value: "pg", label: "PostgreSQL"}, ...]
  }],
  suggestedReply: "Try restarting the service",  // optional, discord mode only
  confidenceScore: 0.3                            // optional, discord mode only
})
```

The `inputs` parameter only has effect in local mode (creates `ask_user_questions` interactions). The `suggestedReply` and `confidenceScore` parameters only have effect in Discord mode (passed to `escalate_to_human`).

## Verification Checklist

After setup, verify each item:

- [ ] Bot appears online in the Discord server
- [ ] `GET /api/plugins/60ba54d5-e922-43b9-bd50-a72130e0c017` shows `status: "active"`
- [ ] Agent tool list includes `escalate` (invoke an agent via the bridge, check available tools)
- [ ] Escalation creates a Discord embed in the configured channel (Discord mode)
- [ ] OR escalation creates a Paperclip issue with an interaction (local mode)
- [ ] Human reply flows back: Discord thread reply becomes a Paperclip issue comment, OR Paperclip UI response wakes the agent

## Troubleshooting

**Bot offline in Discord.** Check that `DISCORD_BOT_TOKEN` is correct and that MESSAGE CONTENT INTENT is enabled in the Discord Developer Portal under Bot > Privileged Gateway Intents.

**Plugin status shows "ready" instead of "active".** The config is missing required fields. At minimum, `discordBotTokenRef`, `defaultChannelId`, and `defaultGuildId` must be set. Re-run the config POST.

**No embeds appearing in Discord.** Verify channel IDs match the actual channels. Confirm the bot has Send Messages and Read Messages/View Channels permissions in those channels.

**401 on plugin tool execute.** The board API key secret is missing. Create it via `POST /api/agents/{agentId}/keys` and store as a Paperclip secret, then reference it in `paperclipBoardApiKeyRef`.

**`escalate` tool missing from agent.** Rebuild containers: `docker compose build && docker compose up -d`. The extension is loaded via `-e /app/extensions/escalate.ts` in `bridge.mjs` spawn args.

**Escalation goes to Paperclip UI instead of Discord.** `PAPERCLIP_DISCORD_PLUGIN_ID` is not set in the container environment. Add it to `src/agents/.env` and restart: `docker compose up -d`.

**Plugin install fails during setup.sh.** Network or npm issue. setup.sh logs a warning and continues. Agents work without Discord. Re-run setup.sh after resolving connectivity.
