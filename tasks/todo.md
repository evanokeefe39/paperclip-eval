# E2E / Integration Test Suite

## Goal
Validate agents are prod-ready by testing the full Paperclip dispatch chain, not just bridge-level HTTP.

## Test Architecture

**Bash scripts** (tests/e2e/) — API-level E2E via curl + jq. CI-ready, portable.
**Playwright** (future) — browser-level UI verification for cross-agent visibility.

Shared helpers in `tests/e2e/helpers.sh`: auth, health polling, HTTP assertions.

## Tests — Priority Order

### E2E-1: Agent Registration Verification
- Authenticate with Paperclip API
- GET /api/companies → find company ID
- GET /api/companies/{cid}/agents → verify CEO and Researcher exist
- GET /api/companies/{cid}/org → verify org tree structure (researcher reports to CEO)
- Assert adapter config points to correct internal URLs

### E2E-2: Paperclip-to-Agent Invocation
- Authenticate, find company and CEO agent ID
- POST /api/agents/{id}/heartbeat/invoke → trigger CEO through Paperclip dispatch
- Verify Paperclip forwards to http://ceo:8080/invoke inside Docker network
- Assert response indicates successful agent execution (not timeout/error)

### E2E-3: Cross-Agent Visibility
- Trigger CEO with a task that references researcher's domain
- Verify both agents accessible via org tree API
- Check that agent outputs are queryable through Paperclip API
- (Playwright follow-up: verify in UI that CEO can see researcher output)

### E2E-4: Character Limit Regression
- Send payload with systemPrompt > 8,191 chars through Paperclip dispatch
- Assert response is coherent (contains expected acknowledgment, not gibberish)
- This is the pi_local CLI arg limit that drove the HTTP adapter design

## File Plan

```
tests/
  e2e/
    helpers.sh              Shared: auth, wait, assert functions
    e2e-1-registration.sh   Agent registration verification
    e2e-2-invocation.sh     Paperclip-to-agent dispatch
    e2e-3-cross-agent.sh    Cross-agent visibility
    e2e-4-charlimit.sh      Character limit regression
    run-e2e.sh              Runner: orchestrates all E2E tests
```

## Prerequisites
- Docker stack running (docker compose up)
- Setup completed (setup.ps1 or future setup.sh)
- curl, jq available
- Agents healthy on :8081, :8082
- Paperclip healthy on :3100

## Status
- [x] Plan written
- [ ] helpers.sh
- [ ] e2e-1-registration.sh
- [ ] e2e-2-invocation.sh
- [ ] e2e-3-cross-agent.sh
- [ ] e2e-4-charlimit.sh
- [ ] run-e2e.sh
