# Issues in backlog status don't appear in agent inbox

## Status

Resolved (documented for reference).

## Symptom

EVA-1 was created with `status: backlog` and assigned to CEO. CEO's `GET /agents/me/inbox-lite` returned empty array. CEO ran heartbeat, found nothing to do, and exited.

## Root cause

Paperclip's inbox-lite endpoint only returns issues with actionable statuses (todo, in_progress, blocked, etc.). `backlog` is a pre-triage status and is excluded from inbox by design.

## Fix

Changed EVA-1 to `status: todo` via PATCH. Immediately appeared in inbox. CEO picked it up on next heartbeat.

## Lesson

When creating issues for agents to pick up, use `status: todo` not `status: backlog`. The API accepts `backlog` as a valid status but agents will never see it in their inbox.

Update issue creation in setup scripts and any automated issue creation to default to `todo`.
