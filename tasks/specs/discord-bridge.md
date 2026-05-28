# STALE — Superseded by paperclip-plugin-discord

> **2026-05-26:** This spec assumed we needed to build a custom adapter service for Discord
> notifications. Investigation found that Paperclip has a fully developed plugin system (69
> capabilities, event subscriptions, webhooks, outbound HTTP) and that a community plugin
> `paperclip-plugin-discord` (mvanhorn, v0.7.3, 323 tests) already provides everything
> specced here and more — including `escalate_to_human` tool, interactive approval buttons,
> reply routing, slash commands, multi-agent threads, and a shared `PlatformAdapter`
> abstraction via `paperclip-plugin-chat-core`. Sibling plugins exist for Telegram and Slack.
>
> Replacement spec: `tasks/specs/discord-plugin-setup.md`
>
> Kept for historical context. Do not implement.

---

# (Original spec below — do not implement)

# Escalation Notification System — Discord Adapter

## Intent

Deliver agent escalations to humans outside the Paperclip UI, starting with Discord. The escalate tool creates the Paperclip issue and optionally notifies an adapter. The adapter translates to a channel-specific format (Discord embed) and relays human responses back to Paperclip as issue comments. The tool never knows which channel is downstream. The adapter never knows which agent is upstream.

## Context Package

### Relevant existing code

- `src/agents/extensions/escalate.ts` — current escalate tool. Creates a Paperclip issue tagged `escalation`, pauses the agent, returns tool result telling LLM to wait. No outbound notification. Parameters: `message`, `urgency` (blocking/when_you_can), `inputs` (optional structured choices).
- `src/agents/skills/client.ts` — shared Paperclip API client with session-cookie auth and 25-minute cache. Escalate.ts has its own duplicate auth logic.
- `src/agents/bridge.mjs` — HTTP-to-RPC bridge. Spawns Pi with `-e` flags for extensions. Extension load order defined here.
- `src/agents/docker-compose.yml` — full stack. Adapter container goes here.
- `src/agents/.env.example` — template for env vars.
- `docs/toyota-way/principles-integration.md` (escalate tool section) — TPS design specifying escalation types, Discord routing, and Paperclip wake context env vars.
- `tasks/specs/escalate.md` (line 4) — "Existing Paperclip plugins (Discord, Telegram, Slack) notify the human." The tool was designed to be notification-agnostic from day one.
- `tasks/specs/escalate.md` (line 128) — "Chat adapter enhancements that render structured inputs as Discord buttons / Telegram keyboards." Already framed as adapters in the original spec.

### Architectural constraints

- The escalate tool must not contain Discord-specific code, imports, or env vars. It knows "there may be a notification adapter" — nothing more.
- Agents are stateless per-invocation. A persistent bot cannot live inside agent containers.
- All Paperclip API access uses session-cookie auth (no API keys).
- Agents and adapters reach Paperclip at `http://paperclip:3100` on the Docker network.
- Zero npm dependencies in agent containers. Native `fetch` only.
- If no adapter is configured, the escalation system works exactly as it does today (Paperclip issue only).

### Prior decisions

- The escalate tool creates Paperclip issues; notification is a downstream concern (escalate spec, line 4).
- Paperclip's community notification plugins handle this in production setups. Since those are unavailable in eval, we build the adapter ourselves.
- TPS integration spec defines five escalation types. Current escalate.ts only has `urgency`. This spec adds the `type` parameter.
- Paperclip manages all escalation state. `PAPERCLIP_WAKE_REASON` and `PAPERCLIP_WAKE_COMMENT_ID` env vars on agent resume provide the return path (TPS integration spec, line 157). No local state files.

### Anti-patterns to avoid

- Do not embed channel-specific logic (Discord embeds, Telegram keyboards, etc.) in escalate.ts.
- Do not poll from inside agent containers. Agents are ephemeral.
- Do not build a generic multi-channel abstraction up front. Build the adapter interface and one concrete adapter (Discord). The interface proves the pattern; more adapters come later.
- Do not parse human replies into structured data. The LLM reads the comment as text and interprets it.

## System Architecture

```
Agent calls escalate tool
  → escalate.ts creates Paperclip issue (always, source of truth)
  → escalate.ts POSTs to ESCALATION_ADAPTER_URL (if configured)
     → Adapter receives normalized escalation payload
     → Adapter translates to channel-specific format
        → Discord adapter → Discord webhook embed
        → (future) Telegram adapter → Telegram bot message
        → (future) TUI adapter → terminal prompt

Human responds in channel (e.g. Discord thread reply)
  → Adapter posts reply as Paperclip issue comment
  → Paperclip wakes agent on next heartbeat
  → Agent reads response via PAPERCLIP_WAKE_COMMENT_ID
```

Three boundaries, three contracts:
1. **escalate.ts → Paperclip**: issue creation, agent pause (existing, unchanged)
2. **escalate.ts → adapter**: normalized POST with escalation metadata (new, generic)
3. **adapter → Paperclip**: comment creation, issue unblock (new, per-adapter)

## Deliverables

### 1. Escalation type parameter (escalate.ts)

Add `type` to the tool schema alongside existing `urgency`:

```typescript
type: Type.Optional(
  Type.Union([
    Type.Literal("ask_user"),
    Type.Literal("block_for_review"),
    Type.Literal("request_decision"),
    Type.Literal("report_failure"),
    Type.Literal("flag_for_kaizen"),
  ])
)
```

Default: `ask_user`. Retained `urgency` for backwards compatibility.

Type influences Paperclip issue properties:
- `ask_user` — standard escalation, current default behavior
- `block_for_review` — issue status set to review state if API supports it
- `request_decision` — same as `ask_user` but semantically distinct for adapters
- `report_failure` — title prefixed `[FAILURE]`, priority set to `urgent`
- `flag_for_kaizen` — urgency forced to `when_you_can`, tagged with `kaizen` label in addition to `escalation`

### 2. Adapter notification interface (escalate.ts)

After creating the Paperclip issue (existing step), if `ESCALATION_ADAPTER_URL` is set, POST a normalized payload:

```json
{
  "issue_id": "<paperclip issue ID>",
  "issue_identifier": "<e.g. ESC-12>",
  "issue_url": "<PAPERCLIP_PUBLIC_URL>/issue/<identifier>",
  "agent_name": "<PAPERCLIP_AGENT_NAME or container hostname>",
  "type": "<ask_user|block_for_review|request_decision|report_failure|flag_for_kaizen>",
  "urgency": "<blocking|when_you_can>",
  "message": "<full escalation message>",
  "inputs": [<structured inputs array, if provided>]
}
```

This is the adapter contract. Every field a downstream adapter might need is in this payload. The adapter decides how to render it for its channel.

Rules:
- Fire-and-forget. If the POST fails, log a warning and continue. The Paperclip issue is the source of truth.
- The tool result to the LLM is identical whether the adapter POST succeeded or not. The LLM does not know adapters exist.
- If `ESCALATION_ADAPTER_URL` is empty or unset, no POST, no warning, no code path — identical to current behavior.

Env vars added to escalate.ts:

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `ESCALATION_ADAPTER_URL` | No | (empty) | URL to POST escalation payload. If unset, no adapter notification. |
| `PAPERCLIP_AGENT_NAME` | No | container hostname | Human-readable agent name included in payload. |
| `PAPERCLIP_PUBLIC_URL` | No | same as `PAPERCLIP_API_URL` | Externally reachable Paperclip URL for issue links. |

### 3. Shared auth extraction

The current escalate.ts has its own `authenticate()` function that duplicates `skills/client.ts`. Extract session-cookie auth into a shared module at `src/agents/extensions/lib/paperclip-auth.ts`. Import from both escalate.ts and client.ts. This is the only refactor in scope.

### 4. Discord adapter (new service)

A standalone service that:
- Receives escalation payloads from escalate.ts (inbound HTTP)
- Translates to Discord webhook embeds (outbound to Discord)
- Listens for Discord thread replies (inbound from Discord)
- Posts replies as Paperclip issue comments (outbound to Paperclip)

#### Location

```
src/agents/discord-adapter/
  adapter.mjs       # HTTP server + Discord gateway client
  Dockerfile         # node:22-slim, zero npm deps
```

#### Inbound from escalate.ts

HTTP server on port 8090. Single endpoint: `POST /notify`.

Receives the normalized escalation payload (section 2 above). Translates to a Discord webhook embed:

- Embed title: `Escalation: <issue_identifier>`
- Embed description: message (truncated to 2000 chars if needed)
- Embed color mapped from type:
  - `ask_user`, `request_decision` — red (0xDC2626)
  - `block_for_review` — amber (0xF59E0B)
  - `report_failure` — purple (0x7C3AED)
  - `flag_for_kaizen` — grey (0x6B7280)
- Fields: agent name, type, urgency (inline)
- If `inputs` provided: choices rendered as numbered list in a field
- Footer: `Issue <identifier> | Reply in this thread to respond`

Mention behavior (content field, outside embed):
- `ask_user` + `blocking`, or `report_failure` → `@here`
- Everything else → no mention

POSTs the embed to `DISCORD_WEBHOOK_URL` (env var on the adapter, not on agent containers). Returns 200 to escalate.ts regardless of Discord result (the adapter handles Discord errors internally).

#### Inbound from Discord (reply loop)

Connects to Discord gateway via raw WebSocket (Node 22 built-in). Listens for `MESSAGE_CREATE` events in threads under webhook embeds.

When a non-bot user replies in an escalation thread:
1. Extract Paperclip issue identifier from parent embed footer text.
2. Look up issue via Paperclip API: `GET /api/companies/{cid}/issues?search=<identifier>`.
3. POST reply text as a comment on the issue.
4. React with checkmark on success, cross-mark on failure.

Gateway intents: `GUILDS` (1 << 0) + `GUILD_MESSAGES` (1 << 9) + `MESSAGE_CONTENT` (1 << 15) = 33281.

Must handle: HELLO (heartbeat start), HEARTBEAT/HEARTBEAT_ACK (keepalive), READY (session store), RECONNECT/INVALID_SESSION (reconnect with resume).

#### Health

`GET /health` on port 8090 — returns gateway connection status and last notification timestamp.

#### Env vars (on the adapter container, not agent containers)

| Var | Required | Default | Purpose |
|-----|----------|---------|---------|
| `DISCORD_WEBHOOK_URL` | Yes | — | Discord channel webhook URL for outbound embeds |
| `DISCORD_BOT_TOKEN` | Yes | — | Bot token for gateway connection (thread reply listener) |
| `DISCORD_CHANNEL_ID` | Yes | — | Channel ID to filter events |
| `PAPERCLIP_API_URL` | Yes | — | Paperclip internal URL |
| `PAPERCLIP_ADMIN_EMAIL` | Yes | — | Paperclip auth |
| `PAPERCLIP_ADMIN_PASS` | Yes | — | Paperclip auth |
| `PAPERCLIP_COMPANY_ID` | Yes | — | Company context for API calls |
| `ADAPTER_PORT` | No | 8090 | HTTP server port |

If `DISCORD_BOT_TOKEN` is empty, the adapter runs in outbound-only mode: accepts `/notify` POSTs and sends Discord embeds, but does not connect to the gateway (no reply loop). Replies must go through Paperclip UI.

If `DISCORD_WEBHOOK_URL` is also empty, the container exits with code 0 and an info log.

### 5. Docker compose changes

Add the discord-adapter service:

```yaml
discord-adapter:
  build:
    context: .
    dockerfile: discord-adapter/Dockerfile
  restart: unless-stopped
  env_file: .env
  environment:
    PAPERCLIP_API_URL: "http://paperclip:3100"
    PAPERCLIP_ADMIN_EMAIL: "${PAPERCLIP_ADMIN_EMAIL:-admin@eval.local}"
    PAPERCLIP_ADMIN_PASS: "${PAPERCLIP_ADMIN_PASS:-eval-admin-2026}"
    PAPERCLIP_COMPANY_ID: "${PAPERCLIP_COMPANY_ID:-}"
    DISCORD_WEBHOOK_URL: "${DISCORD_WEBHOOK_URL:-}"
    DISCORD_BOT_TOKEN: "${DISCORD_BOT_TOKEN:-}"
    DISCORD_CHANNEL_ID: "${DISCORD_CHANNEL_ID:-}"
  deploy:
    resources:
      limits:
        memory: 128M
  depends_on:
    paperclip:
      condition: service_healthy
```

Agent containers get one new env var each: `ESCALATION_ADAPTER_URL: "http://discord-adapter:8090/notify"`. This is set in docker-compose, not in the extension code — the extension just reads the env var.

### 6. Env var additions to .env.example

```
# Escalation notification adapter
# Set ESCALATION_ADAPTER_URL on agent containers to enable adapter notification
# Currently: Discord adapter at http://discord-adapter:8090/notify
ESCALATION_ADAPTER_URL=

# Discord adapter — set these on the discord-adapter container
DISCORD_WEBHOOK_URL=
DISCORD_BOT_TOKEN=
DISCORD_CHANNEL_ID=
```

### 7. Discord server setup guide

Create `docs/discord-setup.md` with operator instructions covering:
- Server and channel creation
- Webhook creation (channel settings > integrations)
- Bot application creation (Discord Developer Portal)
- MESSAGE CONTENT INTENT enablement
- Bot OAuth2 permissions: Send Messages, Read Message History, Add Reactions, Send Messages in Threads, Read Messages/View Channels
- Bot invite URL generation and server add
- Channel ID retrieval (developer mode)
- `.env` configuration
- Verification steps

## Behavioral Contracts

### Adapter interface: escalate.ts posts normalized payload

GIVEN `ESCALATION_ADAPTER_URL` is set
WHEN an agent calls `escalate` with any type and urgency
THEN escalate.ts POSTs the normalized JSON payload to that URL after creating the Paperclip issue
AND the payload contains: issue_id, issue_identifier, issue_url, agent_name, type, urgency, message, inputs
AND the Paperclip issue is created regardless of whether the adapter POST succeeds

### Adapter interface: no notification when unconfigured

GIVEN `ESCALATION_ADAPTER_URL` is empty or unset
WHEN an agent calls `escalate`
THEN behavior is identical to current escalate.ts (issue created, agent paused, no adapter call)
AND no error or warning is logged about adapters

### Adapter interface: failure is non-fatal

GIVEN `ESCALATION_ADAPTER_URL` is set but the adapter is down or returns an error
WHEN an agent calls `escalate`
THEN the Paperclip issue is created and the agent is paused (normal behavior)
AND a warning is logged: `escalation_notify_failed` with the HTTP status or error
AND the tool result to the LLM does not mention the adapter (the LLM does not know adapters exist)

### Discord adapter: outbound notification

GIVEN the adapter receives a valid escalation payload on `POST /notify`
THEN it sends a Discord webhook embed within 2 seconds
AND the embed contains the issue identifier, agent name, type, urgency, and message
AND the embed color matches the type
AND structured inputs are rendered as a numbered list in an embed field
AND the adapter returns 200 to the caller regardless of Discord webhook result

### Discord adapter: mention routing

GIVEN an escalation payload with type `ask_user` + urgency `blocking`, or type `report_failure`
THEN the Discord message includes `@here` in the content field

GIVEN any other type/urgency combination
THEN no mention is included

### Discord adapter: inbound reply becomes Paperclip comment

GIVEN the adapter is connected to the Discord gateway
WHEN a non-bot user replies in a thread under an escalation embed
THEN the adapter posts the reply text as a comment on the corresponding Paperclip issue within 3 seconds
AND adds a checkmark reaction to the Discord message

### Discord adapter: issue matching from embed footer

GIVEN a thread reply under an escalation embed
WHEN the adapter processes the reply
THEN it extracts the Paperclip issue identifier from the parent embed footer text
AND resolves the issue via Paperclip API search
AND posts the comment to that issue

### Discord adapter: Paperclip API failure on comment

GIVEN the adapter receives a thread reply but the Paperclip API call fails
THEN the adapter adds a cross-mark reaction to the Discord message
AND logs the error with the issue identifier and HTTP status
AND does not retry

### Discord adapter: ignores irrelevant messages

GIVEN a message in the channel that is not a thread reply to a webhook escalation embed
THEN the adapter ignores it (no API calls, no reactions, no logs)

### Discord adapter: outbound-only mode

GIVEN `DISCORD_BOT_TOKEN` is empty but `DISCORD_WEBHOOK_URL` is set
THEN the adapter accepts `/notify` POSTs and sends Discord embeds
AND does not connect to the Discord gateway (no reply loop)

### Discord adapter: graceful exit when unconfigured

GIVEN `DISCORD_WEBHOOK_URL` and `DISCORD_BOT_TOKEN` are both empty
WHEN the adapter container starts
THEN it logs "No Discord configuration, exiting" at info level and exits with code 0

### Discord adapter: reconnection

GIVEN the Discord gateway sends `RECONNECT` or the websocket drops
THEN the adapter reconnects with session resume within 10 seconds

### Escalation types: Paperclip issue behavior

GIVEN type is `report_failure`
THEN the Paperclip issue title is prefixed with `[FAILURE]` and priority is set to `urgent`

GIVEN type is `flag_for_kaizen`
THEN urgency is forced to `when_you_can` regardless of what the agent passed
AND the issue is tagged with both `escalation` and `kaizen` labels

GIVEN type is `block_for_review`
THEN the issue status is set to a review state if the Paperclip API supports it

### Agent resume: Paperclip wake context

GIVEN an agent was paused due to escalation and a human has responded
WHEN Paperclip wakes the agent on the next heartbeat
THEN `PAPERCLIP_WAKE_REASON` and `PAPERCLIP_WAKE_COMMENT_ID` are set in the agent's environment
AND the agent reads the human's response via `PAPERCLIP_WAKE_COMMENT_ID` using Paperclip skills
AND no local filesystem state is required

## Edge Case Inventory

1. **Adapter URL is malformed** — fetch throws, caught by try/catch in escalate.ts, logged as warning, escalation continues.
2. **Adapter is slow (>5s)** — escalate.ts does not await the adapter POST beyond a 5-second timeout. Issue creation and agent pause are not blocked.
3. **Discord webhook returns 429 (rate limit)** — adapter logs warning with `retry_after` from response headers. Does not retry for this notification. Paperclip issue exists regardless.
4. **Message exceeds Discord 2000-char embed description limit** — adapter truncates to 1997 chars + `...`.
5. **Multiple escalations from same agent before human responds** — each gets its own issue and Discord embed. No deduplication. Paperclip tracks each independently.
6. **Human replies multiple times in same thread** — each reply becomes a separate Paperclip comment. Correct behavior.
7. **Adapter receives reply for an already-resolved issue** — adapter still posts the comment. Paperclip handles idempotency.
8. **Two agents escalate simultaneously** — two separate adapter POSTs, two embeds, two threads. Independent flows.
9. **Discord channel deleted or bot loses access** — webhook returns 404/403, adapter logs warning. Paperclip issue unaffected.
10. **Paperclip down when adapter tries to post comment** — cross-mark reaction, error logged. Human can re-post or go to Paperclip UI.
11. **Adapter container restarts while thread has unread replies** — adapter does not replay missed messages. Human can re-post or use Paperclip UI. Acceptable for eval.
12. **Outbound-only mode (webhook set, bot token empty)** — embeds posted, no reply loop. Human responds via Paperclip UI. Valid configuration.
13. **Adapter receives malformed payload on /notify** — returns 400, logs warning. Does not crash.

## Definition of Done

- [ ] `escalate.ts` accepts `type` parameter with five escalation types, defaults to `ask_user`
- [ ] Type influences Paperclip issue properties (priority, title prefix, labels) per behavioral contracts
- [ ] `escalate.ts` POSTs normalized payload to `ESCALATION_ADAPTER_URL` when set
- [ ] Adapter POST is fire-and-forget with 5-second timeout, failure does not affect issue creation or agent pause
- [ ] Tool result to LLM is identical whether adapter POST succeeded or not
- [ ] No Discord-specific code, imports, or env vars in escalate.ts
- [ ] Shared auth module extracted to `src/agents/extensions/lib/paperclip-auth.ts`
- [ ] `escalate.ts` and `skills/client.ts` both import from shared auth module
- [ ] `src/agents/discord-adapter/adapter.mjs` accepts `/notify` POST and sends Discord webhook embeds
- [ ] Embed color and mention behavior matches type/urgency mapping per behavioral contracts
- [ ] Structured inputs rendered as numbered list in embed field
- [ ] Adapter connects to Discord gateway and listens for thread replies
- [ ] Thread replies posted as Paperclip issue comments, checkmark on success, cross-mark on failure
- [ ] Adapter ignores messages outside escalation threads
- [ ] Adapter supports outbound-only mode (no bot token)
- [ ] Adapter exits cleanly when fully unconfigured
- [ ] Adapter reconnects on gateway disconnect
- [ ] `src/agents/discord-adapter/Dockerfile` builds from node:22-slim, zero npm deps
- [ ] `discord-adapter` service added to `docker-compose.yml` with `ESCALATION_ADAPTER_URL` set on agent containers
- [ ] `.env.example` updated with adapter and Discord env vars
- [ ] `docs/discord-setup.md` written with operator setup instructions
- [ ] All behavioral contracts have corresponding tests
- [ ] All edge cases in the inventory have corresponding tests
- [ ] Existing escalate tests still pass (no regression)
- [ ] Reasoning trace written
- [ ] Assumption log written

## Negative Space

What must not change:
- Behavior when `ESCALATION_ADAPTER_URL` is unset (current escalate.ts behavior preserved exactly)
- Paperclip issue creation logic (adapter is additive, not a replacement)
- bridge.mjs (no changes)
- Other extensions (web-search, web-fetch, web-scrape, artifacts, paperclip-tools)
- Agent container images (no new dependencies in agent Dockerfiles)

What is explicitly out of scope:
- Telegram, Slack, or email adapters (the interface supports them; building them is future work)
- Discord slash commands or interactive components (buttons, dropdowns)
- Structured response parsing (adapter posts raw text, LLM interprets)
- Automatic agent resume from the adapter (agent resumes on next Paperclip heartbeat naturally)
- Local TUI adapter (separate future work)
- Kaizen metrics pipeline integration for `flag_for_kaizen` type (issue created and tagged, but no pipeline exists yet)
- Thread management (archiving, auto-lock)
- Multi-adapter routing (one `ESCALATION_ADAPTER_URL` per agent container; fan-out is future work)

What decisions are reserved for human review:
- Discord server and channel naming
- Notification role configuration in Discord
- Whether outbound-only mode is sufficient for eval
- Whether the adapter should be deployable outside Docker

## Open Questions

(empty)

## Test Plan

### Unit tests: escalate.ts

Located at `tests/escalate/`:

1. **type parameter defaults** — call escalate with no type, verify `ask_user` behavior.
2. **type parameter routing** — call with each of five types, verify issue priority, title prefix, label behavior.
3. **adapter POST payload** — mock fetch, set `ESCALATION_ADAPTER_URL`, verify normalized JSON payload structure.
4. **adapter POST failure** — mock fetch to return 500, verify Paperclip issue still created, warning logged, tool result unchanged.
5. **adapter unconfigured** — unset `ESCALATION_ADAPTER_URL`, verify no fetch call, no warning, identical to current behavior.
6. **adapter timeout** — mock fetch to hang, verify escalation completes within 5 seconds.
7. **kaizen type forces urgency** — call with type `flag_for_kaizen` and urgency `blocking`, verify urgency overridden to `when_you_can`.
8. **no Discord-specific content** — verify adapter payload contains no Discord-specific fields (no embed, no color, no mention).

### Unit tests: Discord adapter

Located at `tests/discord-adapter/`:

1. **/notify payload validation** — POST valid and invalid payloads, verify 200 vs 400 responses.
2. **embed translation** — POST each escalation type, verify Discord webhook payload has correct color, mention, fields.
3. **message truncation** — POST 3000-char message, verify embed description truncated to 2000 chars.
4. **structured inputs** — POST payload with select inputs, verify embed field renders numbered list.
5. **embed footer parsing** — given footer text `Issue ESC-12 | Reply in this thread to respond`, extract `ESC-12`.
6. **non-bot message filtering** — verify adapter ignores bot messages, non-thread messages, wrong-channel messages.
7. **comment posting** — mock Paperclip API, verify POST to correct issue comments endpoint.
8. **Paperclip API failure** — mock 500 response, verify cross-mark reaction, error logged.
9. **clean exit when unconfigured** — start with empty env vars, verify exit code 0.
10. **outbound-only mode** — set `DISCORD_WEBHOOK_URL` only, verify `/notify` works, no gateway connection.

### Integration tests

Located at `tests/discord-adapter/integration-test.sh`:

1. **Full loop** — start stack with Discord env vars pointing to a test server. Trigger escalation via agent bridge. Verify Discord embed appears. Reply in thread. Verify Paperclip issue comment created.
2. **Outbound-only** — set webhook URL but no bot token. Trigger escalation. Verify embed appears. Verify adapter running in outbound-only mode.

### Manual verification

1. Create test Discord server following `docs/discord-setup.md`.
2. Configure `.env` with webhook URL, bot token, channel ID. Set `ESCALATION_ADAPTER_URL=http://discord-adapter:8090/notify` on agent containers.
3. `docker compose up -d`.
4. Trigger escalation: `curl -X POST http://localhost:8081/invoke -d '{"prompt":"Use the escalate tool to ask the human which database to use. Provide PostgreSQL, SQLite, and MongoDB as options."}'`
5. Verify: Discord embed appears with correct color, @here mention, numbered choices.
6. Reply in Discord thread: "PostgreSQL".
7. Verify: Paperclip issue has a new comment with "PostgreSQL". Agent's next invocation reads it via `PAPERCLIP_WAKE_COMMENT_ID`.

## File Structure

```
src/agents/
  extensions/
    lib/
      paperclip-auth.ts          # extracted shared Paperclip session auth
    escalate.ts                  # modified: +type param, +adapter POST
  skills/
    client.ts                    # modified: import auth from lib/paperclip-auth.ts
  discord-adapter/
    adapter.mjs                  # HTTP server + Discord gateway client
    Dockerfile                   # node:22-slim, zero npm deps
  docker-compose.yml             # modified: +discord-adapter service, +ESCALATION_ADAPTER_URL on agents
  .env.example                   # modified: +adapter and Discord env vars
docs/
  discord-setup.md               # operator setup guide
tests/
  escalate/                      # existing + new tests for type param and adapter POST
  discord-adapter/               # new: unit + integration tests
```
