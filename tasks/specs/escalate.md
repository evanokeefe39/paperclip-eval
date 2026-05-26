# STALE — Partially superseded by paperclip-plugin-discord

> **2026-05-26:** The core escalation path (create Paperclip issue, pause agent, human responds,
> agent resumes) is now handled by `paperclip-plugin-discord` which provides `escalate_to_human`
> with richer features: conversation context, confidence scoring, suggested replies, interactive
> Discord buttons, configurable timeout, and the shared `PlatformAdapter` abstraction from
> `paperclip-plugin-chat-core`.
>
> Key incorrect assumptions in this spec:
> - Line 4: "Existing Paperclip plugins (Discord, Telegram, Slack) notify the human" — these
>   are community plugins, not built into the Paperclip image. They must be installed separately.
> - Line 14: implied `PAPERCLIP_API_KEY` env var — Paperclip uses session-cookie auth, not API keys.
>   The actual implementation in escalate.ts uses cookie auth.
> - `.pending-escalation` state file — unnecessary; Paperclip provides `PAPERCLIP_WAKE_REASON`
>   and `PAPERCLIP_WAKE_COMMENT_ID` env vars on agent resume.
>
> `src/agents/extensions/escalate.ts` is retained but disabled in bridge.mjs. It may be extended
> or used as reference if we fork/extend the Discord plugin in the future.
>
> Replacement spec: `tasks/specs/discord-plugin-setup.md`

---

# (Original spec below — retained for reference)

# pi-escalate

Minimal Pi extension that lets an agent escalate to a human via Paperclip issues.

## Problem

When a Pi agent runs in a container (managed by Paperclip), it sometimes needs human input: a decision, an approval, information, a manual action. There is no interactive terminal. The agent should be able to pause itself and notify the human through Paperclip's existing issue and notification infrastructure.

## How it works

1. Agent calls the `escalate` tool with a description and optional structured inputs
2. The extension creates a Paperclip issue tagged `escalation`, assigned to the board
3. The extension pauses the agent via Paperclip's API
4. Existing Paperclip plugins (Discord, Telegram, Slack) notify the human
5. The human responds by commenting on the issue
6. The agent is resumed, reads the comment, and continues

## Scope

This is a Pi extension only. No Paperclip plugin, no custom adapters, no new services. It uses Paperclip's REST API, issue system, and existing community notification plugins as-is.

## Environment

The extension activates only when these env vars are present (set by Paperclip automatically):

- `PAPERCLIP_API_URL` — e.g. `http://127.0.0.1:3100`
- `PAPERCLIP_API_KEY`
- `PAPERCLIP_AGENT_ID`
- `PAPERCLIP_COMPANY_ID`
- `PAPERCLIP_RUN_ID`

If any are missing, the extension should not register the tool (the agent is running locally/interactively and should use pi-ask-user or similar instead).

## Tool definition

The extension registers one tool: `escalate`.

```typescript
escalate({
  message: string,          // required — why the agent needs help, written by the LLM
  urgency?: "blocking" | "when_you_can",  // default: "blocking"
  inputs?: Array<{          // optional structured inputs the human can respond to
    id: string,             // short key, e.g. "db_choice"
    label: string,          // human-readable label
    type: "select" | "text",
    options?: Array<{       // required when type is "select"
      value: string,
      label: string,
      description?: string
    }>
  }>
})
```

The `inputs` array is a hint. Smart renderers (a future Paperclip plugin, or a custom dashboard) could parse it from the issue body and render a form. For now, the human just reads the message and replies in plain text. The LLM interprets the response regardless of format.

## Behaviour on escalate call

1. Build issue body as markdown:
   - The `message` as prose
   - If `inputs` are provided, render them as a readable list (e.g. "Choose one: PostgreSQL, SQLite, MongoDB")
   - Append a machine-readable JSON block at the end fenced as ` ```escalation-schema\n{...}\n``` ` so future tooling can parse it without breaking human readability

2. Call Paperclip API: `POST /api/issues` with:
   - `title`: first 80 chars of message, or a summary
   - `body`: the markdown body built above
   - `labels`: `["escalation"]`
   - Agent and company context from env vars
   - Assigned to board user (or left unassigned for board to pick up)

3. After issue creation, call Paperclip API to pause the current agent run. The exact endpoint depends on Paperclip's API — likely `POST /api/agents/:id/pause` or updating the run status. If no pause endpoint exists, the extension should return a tool result telling the LLM "I have created escalation issue #N and you should stop working and wait for a response. Do not proceed until resumed."

4. Return the tool result to the LLM with the issue URL/number so it has context when resumed.

## Behaviour on resume

When the agent is resumed (manually by the board or via Paperclip's UI), the LLM will be in a new turn. It should check the escalation issue for comments. The extension could:

- **Option A (simple):** Include in the tool result a note like "When resumed, check issue #N for the human's response." The LLM uses the Paperclip MCP tools (`get_issue`, `list_comments`) already available to it.
- **Option B (richer):** Register a second tool `check_escalation` that fetches the latest comment on a given issue ID and returns it. Low priority — option A works if the agent already has Paperclip MCP access.

Start with Option A.

## File structure

```
pi-escalate/
  package.json
  extensions/
    escalate.ts        # the extension
  README.md
```

`package.json` must include:
```json
{
  "name": "pi-escalate",
  "pi": {
    "extensions": ["extensions"]
  }
}
```

## What not to build

- No TUI rendering — this extension is for headless/container mode only
- No transport abstraction or adapter system
- No timeout/expiry logic
- No custom Paperclip plugin
- No polling loop waiting for the response
- No structured response parsing — the LLM reads the comment as text
- No environment detection beyond checking env vars exist

## API assumptions to verify

Before building, confirm against Paperclip's actual API (check docs at `PAPERCLIP_API_URL` or the repo):

1. The issue creation endpoint and required fields
2. Whether agent pause is an API call or only available via the dashboard
3. Whether labels/tags exist on issues or if tagging works differently
4. How board assignment works (is there a board user ID, or is it implicit?)

If the pause API doesn't exist, the extension still works — it creates the issue, returns a tool result telling the LLM to stop, and the human manually pauses or the LLM simply waits. The notification still fires through existing plugins.

## Future enhancements (not now)

- Paperclip plugin that parses the `escalation-schema` JSON block and renders a form in the dashboard
- Chat adapter enhancements that render structured inputs as Discord buttons / Telegram keyboards
- Automatic resume when a board comment is posted on an escalation issue
- Timeout/expiry that auto-closes stale escalations
- Local mode integration that falls back to pi-ask-user TUI when env vars are absent
- Urgency-based routing (blocking escalations get push notifications, low-priority ones just appear in the dashboard)