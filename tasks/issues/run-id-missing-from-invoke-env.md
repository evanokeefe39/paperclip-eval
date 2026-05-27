# PAPERCLIP_RUN_ID missing from invoke payload env

## Status

Fix applied, not fully deployed.

## Symptom

All mutating API calls (PATCH issues, POST comments, POST checkout) from agents return 401 with `"Agent run id required"`. Agents can read (GET) but can't write anything to Paperclip.

## Root cause

Paperclip sends the run ID at `body.runId` in the invoke HTTP payload, not at `body.env.PAPERCLIP_RUN_ID`. The bridge was only looking in `body.env.PAPERCLIP_RUN_ID`, finding null, and not passing it to the Pi process environment. Without `PAPERCLIP_RUN_ID` env var, `client.ts` never sets the `X-Paperclip-Run-Id` header on mutating requests.

## Fix

bridge.mjs updated to extract run ID from `body.runId` as fallback:

```js
const runId = body.env?.PAPERCLIP_RUN_ID || body.runId || null;
```

And inject it into Pi spawn env:

```js
env: { ...process.env, ...body.env, TRACEPARENT: traceparent, ...(runId ? { PAPERCLIP_RUN_ID: runId } : {}) },
```

## Deploy status

- CEO: rebuilt and verified (runId populated in logs)
- Researcher, Data, Writer: NOT rebuilt yet. Need `docker compose up -d --build researcher data writer`.

## Impact

Critical. Without this fix, agents can check inbox and read issues but cannot checkout, update status, add comments, or create sub-issues. All orchestration writes fail silently from the agent's perspective (tool returns error but agent may retry or give up).
