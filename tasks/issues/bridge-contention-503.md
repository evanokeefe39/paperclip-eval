# Bridge Contention — 503 Rejection Cascades into Recovery Reassignment

**Status:** Fixed (bridge.mjs v1.2.0 — bounded FIFO queue)
**Severity:** P0 — blocks M0.1 delegation chain
**Date:** 2026-05-28

## Problem

When Paperclip dispatches two or more issues to the same agent near-simultaneously,
the bridge rejects the second request with HTTP 503. Paperclip interprets 503 as
`adapter_failed`, triggers `stranded_assigned_issue` recovery, and reassigns the
issue back to the creating agent (CEO). This makes correct delegation appear broken.

## Five Whys

```
Problem: E2E-13 reports CEO self-assigned issues to itself
Why 1: Test checked assignee after Paperclip recovery reassigned EVA-5 back to CEO
Why 2: Paperclip triggered stranded_assigned_issue recovery on EVA-5
Why 3: Researcher run on EVA-5 failed with adapter_failed
Why 4: Bridge returned 503 (invoke_rejected_busy) — Researcher still processing EVA-4
Why 5: Bridge is single-Pi-process per container — rejects concurrent invocations
Root:  Bridge contention. Single-threaded Pi cannot handle concurrent dispatch.
```

## Evidence

From researcher bridge logs during E2E-13 run:

```json
{"event":"invoke_rejected_busy","reason":"Pi process already running"}
```

Repeated 15+ times across the run. Each rejection = one Paperclip dispatch attempt
that triggers recovery escalation.

From Paperclip issue data (EVA-5):

```json
{
  "status": "blocked",
  "assigneeAgentId": "e911f1aa (CEO)",
  "activeRecoveryAction": {
    "kind": "stranded_assigned_issue",
    "previousOwnerAgentId": "eea647f3 (Researcher)",
    "evidence": { "latestRunErrorCode": "adapter_failed" }
  }
}
```

CEO delegated correctly. Paperclip recovery undid the delegation.

## Impact

- Delegation chain broken for any multi-issue dispatch
- E2E-13 (delegation chain) fails
- E2E-14 (researcher direct) fails if bridge still busy from prior run
- M0.1 milestone blocked — "CEO delegates all research work" criterion cannot pass

## Constraints

- Pi is single-process: one RPC session per spawn, blocking stdin/stdout
- Bridge spawns Pi per invocation, kills on completion — no persistent process pool
- Paperclip dispatches issues on assignment, retries on timer — no backoff or queue awareness
- Paperclip treats any non-2xx adapter response as agent failure

## Prior Art

This was identified as F2 in `tasks/plans/m0.1-failure-fixes.md`. Original fix was
"bridge returns 503 on lock contention instead of queuing." That framing was wrong —
503 IS the current behavior and it causes the cascade. The fix is to queue, not reject.

## Design Discussion

See design section below for industry-standard approaches to single-worker
request contention.

---

## Design: Request Queue for Single-Worker Bridge

### The fundamental constraint

Pi runs as a single RPC process. It processes one prompt at a time over stdin/stdout.
This is not a limitation we can remove — Pi's architecture requires exclusive process
access. The bridge must mediate between Paperclip's concurrent HTTP dispatch and Pi's
serial execution.

### Industry patterns for this class of problem

**1. Bounded in-process queue (worker-thread pattern)**

How it works: incoming requests enter a FIFO queue. The bridge processes them
one at a time, spawning Pi for each. Subsequent requests wait until the current
Pi process completes. Queue has a max depth to prevent unbounded memory growth.

Pros:
- Simple. No new infrastructure. Fits the zero-dependency bridge constraint.
- Paperclip sees 200 (accepted) instead of 503 (failed), no recovery cascade.
- Natural backpressure — queue depth signals overload.

Cons:
- Waiting requests hold HTTP connections open (long-polling).
- If queue fills, must still reject (but with 429 + Retry-After, not 503).
- Total latency = sum of all queued items. Paperclip may timeout waiting.

Industry examples: Celery's prefork worker, Sidekiq's per-thread queue,
Node.js single-threaded event loop with callback queue.

**2. Accept-and-callback (async job pattern)**

How it works: bridge immediately returns 202 Accepted with a job ID. Queues
the work internally. When Pi completes, bridge calls back to Paperclip with
the result (or Paperclip polls a status endpoint).

Pros:
- No long-held HTTP connections. Paperclip gets immediate response.
- Decouples dispatch latency from execution latency.
- Standard pattern for long-running agent work.

Cons:
- Requires Paperclip to support async result delivery (callback URL or polling).
- More complex bridge code (job tracking, callback, retry on callback failure).
- Need to check if Paperclip's HTTP adapter protocol supports 202 + callback.

Industry examples: GitHub Actions webhook + check runs, AWS Lambda async invoke,
Temporal activity task queues.

**3. External message queue (broker pattern)**

How it works: bridge publishes to Redis/RabbitMQ/SQS queue. Separate consumer
process drains queue and invokes Pi serially.

Pros:
- Durable. Survives bridge restart. Supports dead-letter for failed jobs.
- Production-grade backpressure and observability built in.

Cons:
- New infrastructure dependency. Violates zero-dep bridge constraint.
- Overkill for eval stage. We have one agent per container.

Industry examples: Bull/BullMQ (Redis), Celery (RabbitMQ/Redis), SQS + Lambda.

**4. Paperclip-side rate limiting (dispatch throttle)**

How it works: configure Paperclip to dispatch one issue at a time per agent,
waiting for the run to complete before dispatching the next.

Pros:
- No bridge changes. Fix at the orchestrator level.
- Paperclip already has execution locking (`executionLockedAt`).

Cons:
- We don't control Paperclip's dispatch behavior. May not be configurable.
- Masks the problem — bridge should handle contention regardless.

### Recommendation

**Pattern 1 (bounded in-process queue)** for eval stage. Reasons:

- Zero new dependencies. Fits bridge.mjs design philosophy.
- Paperclip sees success, no recovery cascade.
- Queue depth of 3-5 is sufficient — CEO rarely creates more than 2-3 child issues.
- Timeout per queued item prevents unbounded wait.
- Path to Pattern 2 later if Paperclip adds async adapter support.

### Implementation sketch

```
Request arrives → if Pi idle, spawn and process immediately
                → if Pi busy, add to queue (FIFO, max depth N)
                → if queue full, return 429 + Retry-After header
Queue drain    → on Pi completion, check queue, process next if non-empty
Timeout        → each queued request has individual timeout (BRIDGE_TIMEOUT_MS)
                → on timeout, remove from queue, return 504 to that request
```

Queue state visible in logs: enqueue/dequeue events with queue depth, wait time.

---

## Resolution: Bridge v2.0.0 — Persistent Pi + FIFO Queue

**Date:** 2026-05-28

The bounded FIFO queue (v1.2.0) was an intermediate fix that prevented the 503
cascade. Bridge v2.0.0 goes further by eliminating the spawn-per-request pattern
entirely.

Pi now runs as a persistent process — spawned once at bridge startup, reused across
all /invoke requests. The FIFO queue serializes access to the single Pi process.
Each request sends `new_session` to reset context, then sends its prompt.

Result:
- No more 503 rejections (concurrent requests queue, not reject)
- No more 1.7-2.6s cold start per request (Pi already running)
- No more recovery cascade (Paperclip sees 200 for every dispatched request)
- Auto-respawn on crash with exponential backoff (max 3 attempts)

The root cause (single-threaded Pi + concurrent dispatch) is unchanged — Pi still
processes one prompt at a time. But the bridge now mediates correctly between
Paperclip's concurrent dispatch and Pi's serial execution.
