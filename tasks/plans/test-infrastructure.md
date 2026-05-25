# Plan: Test Infrastructure and Observability Setup

## Intent

Enable rigorous, automated, progressive testing of the Paperclip + Pi bridge system.
Install industry-standard tools (Hurl, k6, jq), add observability to bridge.mjs
(structured logging, health endpoints, protocol capture), configure Docker healthchecks,
and write a three-tier test suite that proves the system works end-to-end under
production conditions.

---

## Phase 0: Tool Installation

### 0.1 Install Hurl (HTTP API test runner)

```powershell
winget install hurl
```

Verify: `hurl --version`

### 0.2 Install k6 (load testing)

```powershell
winget install k6
```

Verify: `k6 version`

### 0.3 Install jq (JSON parsing in shell)

```powershell
winget install jqlang.jq
```

Verify: `jq --version`

### 0.4 Verify Docker Desktop running

```powershell
docker info
docker compose version
```

---

## Phase 1: Bridge Observability (bridge.mjs modifications)

All changes stay zero-dep. No npm packages.

### 1.1 Hand-rolled JSON logger (~10 lines)

Add at top of bridge.mjs:

```javascript
const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level, event, data = {}) {
  if (LEVELS[level] < LEVELS[LOG_LEVEL]) return;
  const entry = { ts: new Date().toISOString(), level, event, pid: process.pid, ...data };
  process.stdout.write(JSON.stringify(entry) + "\n");
}
```

Usage: `log("info", "request_received", { method: req.method, url: req.url, payload_size: body.length })`

Events to log:
- `server_start` — port, provider, model
- `request_received` — method, url, payload size
- `pi_spawn` — command args
- `pi_ready` — time to ready (ms)
- `pi_response` — output length, event count, duration (ms)
- `pi_error` — error message, stderr output
- `request_complete` — status code, total duration (ms)

### 1.2 Health endpoint: GET /health

Returns:
```json
{
  "status": "ok",
  "uptime_s": 142,
  "version": "1.0.0",
  "config": {
    "provider": "openrouter",
    "model": "deepseek/deepseek-chat-v3-0324:free",
    "port": 8080
  }
}
```

Implementation: add route check before the POST /invoke handler.

### 1.3 Metrics endpoint: GET /metrics

Returns:
```json
{
  "requests_total": 47,
  "requests_active": 2,
  "requests_failed": 1,
  "avg_duration_ms": 3200,
  "last_request_at": "2026-05-25T10:30:00.000Z"
}
```

Implementation: in-memory counters incremented per request. Reset on container restart (acceptable for eval).

### 1.4 Error handling improvements

Current bridge has bare `try {} catch {}` that silently swallows JSONL parse errors.
Add:
- Catch body JSON parse errors → return 400 with `{"error": "invalid_json", "detail": "..."}`
- Catch Pi spawn errors → return 500 with `{"error": "pi_spawn_failed", "detail": "..."}`
- Catch Pi timeout → return 504 with `{"error": "timeout", "detail": "..."}`
- Log all errors as structured events

### 1.5 Configurable timeout

Add `BRIDGE_TIMEOUT_MS` env var (default 120000). If Pi doesn't emit `agent_end`
within this window, kill the process and return 504.

### 1.6 Protocol capture mode

When `LOG_LEVEL=debug`, log raw JSONL lines from Pi stdout as `pi_raw_event` entries.
This gives full protocol visibility without a separate capture tool.

---

## Phase 2: Docker Compose Enhancements

### 2.1 Add healthcheck to Dockerfile

```dockerfile
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
```

### 2.2 Add healthcheck to docker-compose.yml (per service)

```yaml
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://localhost:8080/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
  interval: 10s
  timeout: 5s
  start_period: 15s
  retries: 3
```

### 2.3 Add restart policy

```yaml
restart: unless-stopped
```

### 2.4 Add resource limits (for leak detection baseline)

```yaml
deploy:
  resources:
    limits:
      memory: 512M
```

---

## Phase 3: Test Fixtures

### 3.1 Create directory structure

```
tests/
  fixtures/
    minimal-prompt.json          # {"prompt": "respond with exactly: PONG"}
    wake-payload.json            # Realistic Paperclip wake payload
    large-payload.json           # 10KB+ payload (exceeds pi_local limit)
    malformed-empty.json         # {}
    malformed-syntax.txt         # not valid JSON
    multi-turn-1.json            # First message in conversation
    multi-turn-2.json            # Follow-up referencing first
  hurl/
    tier1-foundation.hurl
    tier2-contracts.hurl
    tier3-resilience.hurl
  k6/
    load-test.js
    memory-leak.js
  run-all.ps1                    # Orchestrator script
```

### 3.2 Wake payload fixture

Capture from Paperclip or construct from README's documented payloadTemplate:
```json
{
  "prompt": "You are the CEO agent. Review the current company status and propose next steps.",
  "systemPrompt": "You are a strategic executive AI. You make high-level decisions about company direction. Be concise and actionable.",
  "agentId": "test-agent-001",
  "runId": "test-run-001",
  "workspace": "/workspace"
}
```

### 3.3 Large payload fixture

Generate a payload with `systemPrompt` field containing 10,000+ characters of
realistic execution contract text. Must exceed 8,191 chars total to prove we bypass
the pi_local limit.

---

## Phase 4: Tier 1 Tests — Foundation

File: `tests/hurl/tier1-foundation.hurl`

### Test 1.1: Container health

```hurl
# Verify bridge is up and reports healthy
GET http://localhost:8081/health
HTTP 200
[Asserts]
jsonpath "$.status" == "ok"
jsonpath "$.config.provider" == "openrouter"
jsonpath "$.config.model" exists
duration < 1000
```

### Test 1.2: Bridge responds to POST

```hurl
# Verify bridge accepts POST and returns JSON
POST http://localhost:8081/invoke
Content-Type: application/json
{
  "prompt": "respond with exactly: PONG"
}
HTTP 200
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$.output" exists
jsonpath "$.exitCode" exists
```

### Test 1.3: Round-trip echo

```hurl
# Verify full path: HTTP → bridge → Pi RPC → LLM → response
POST http://localhost:8081/invoke
Content-Type: application/json
{
  "prompt": "Respond with ONLY the word PONG. Nothing else. No punctuation."
}
HTTP 200
[Asserts]
jsonpath "$.output" contains "PONG"
jsonpath "$.exitCode" == 0
duration < 30000
```

### Test 1.4: 404 on unknown routes

```hurl
GET http://localhost:8081/nonexistent
HTTP 404

POST http://localhost:8081/health
HTTP 404

GET http://localhost:8081/invoke
HTTP 404
```

### Test 1.5: Metrics endpoint

```hurl
GET http://localhost:8081/metrics
HTTP 200
[Asserts]
jsonpath "$.requests_total" >= 0
jsonpath "$.requests_active" >= 0
```

---

## Phase 5: Tier 2 Tests — Contract Correctness

File: `tests/hurl/tier2-contracts.hurl`

### Test 2.1: Paperclip wake payload acceptance

```hurl
# Full realistic payload Paperclip would send
POST http://localhost:8081/invoke
Content-Type: application/json
file,tests/fixtures/wake-payload.json;
HTTP 200
[Asserts]
jsonpath "$.output" != ""
jsonpath "$.output" != null
jsonpath "$.events" count > 0
jsonpath "$.exitCode" == 0
```

### Test 2.2: Large payload (bypass pi_local limit)

```hurl
# 10KB+ payload that would break pi_local
POST http://localhost:8081/invoke
Content-Type: application/json
file,tests/fixtures/large-payload.json;
HTTP 200
[Asserts]
jsonpath "$.output" != ""
jsonpath "$.exitCode" == 0
duration < 60000
```

### Test 2.3: Malformed JSON → 400

```hurl
POST http://localhost:8081/invoke
Content-Type: application/json
```not json at all```
HTTP 400
[Asserts]
jsonpath "$.error" == "invalid_json"
```

### Test 2.4: Empty body → 400

```hurl
POST http://localhost:8081/invoke
Content-Type: application/json
HTTP 400
```

### Test 2.5: System prompt passed through

```hurl
# Verify systemPrompt reaches the LLM
POST http://localhost:8081/invoke
Content-Type: application/json
{
  "prompt": "What is your role? Answer in one sentence.",
  "systemPrompt": "You are a pirate captain named Blackbeard. Always speak like a pirate."
}
HTTP 200
[Asserts]
jsonpath "$.output" matches "(?i)(pirate|arr|captain|blackbeard|matey|ye)"
jsonpath "$.exitCode" == 0
```

### Test 2.6: Concurrent agents don't cross-contaminate

Run via orchestrator script (not Hurl — needs parallel execution):
1. POST to :8081 with prompt "Your secret word is ALPHA. State it."
2. POST to :8082 with prompt "Your secret word is BETA. State it."
3. Assert response from :8081 contains "ALPHA" and NOT "BETA"
4. Assert response from :8082 contains "BETA" and NOT "ALPHA"

### Test 2.7: Events array contains expected protocol messages

```hurl
POST http://localhost:8081/invoke
Content-Type: application/json
{
  "prompt": "Say hello."
}
HTTP 200
[Asserts]
# Must contain ready event (Pi RPC handshake completed)
jsonpath "$.events[0].type" == "ready"
# Must contain at least one message_update
jsonpath "$.events[?(@.type=='message_update')]" exists
```

---

## Phase 6: Tier 3 Tests — Production Resilience

### Test 3.1: Timeout behavior (k6 or custom script)

```javascript
// tests/k6/timeout-test.js
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  iterations: 1,
  thresholds: {
    checks: ['rate==1.0'],
  },
};

export default function () {
  // Send a prompt designed to take a long time
  // Bridge should respect BRIDGE_TIMEOUT_MS and return 504
  const res = http.post('http://localhost:8081/invoke', JSON.stringify({
    prompt: 'Write a 10,000 word essay on the history of mathematics.',
  }), { headers: { 'Content-Type': 'application/json' }, timeout: '180s' });

  check(res, {
    'returns 200 or 504 (not hang)': (r) => r.status === 200 || r.status === 504,
    'response time under 130s': (r) => r.timings.duration < 130000,
  });
}
```

### Test 3.2: Pi crash recovery (orchestrator script)

Steps:
1. Send a request to bridge (fire-and-forget)
2. Immediately `docker exec <container> pkill -f "pi --mode rpc"`
3. Observe: request returns 500 (not hang)
4. Send another request — must succeed (bridge spawns new Pi)

### Test 3.3: Container restart resilience

Steps:
1. `docker restart ceo-agent`
2. Wait for healthcheck to pass
3. Send request — must succeed
4. Total recovery time must be < 30s

### Test 3.4: Memory stability under load (k6)

```javascript
// tests/k6/memory-leak.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  iterations: 50,
  thresholds: {
    http_req_failed: ['rate<0.05'],       // <5% error rate
    http_req_duration: ['p(95)<60000'],   // 95th percentile < 60s
  },
};

export default function () {
  const res = http.post('http://localhost:8081/invoke', JSON.stringify({
    prompt: 'Say OK.',
  }), { headers: { 'Content-Type': 'application/json' }, timeout: '120s' });

  check(res, {
    'status 200': (r) => r.status === 200,
    'has output': (r) => JSON.parse(r.body).output.length > 0,
  });
  sleep(1);
}
```

Memory assertion (in orchestrator):
1. Record container memory before: `docker stats --no-stream --format '{{.MemUsage}}'`
2. Run k6 test (50 requests)
3. Record container memory after
4. Assert growth < 100MB (no unbounded leak)

### Test 3.5: Paperclip end-to-end integration

Steps (via orchestrator script using curl to Paperclip API):
1. Verify Paperclip running at localhost:3100
2. Get company ID: `GET /api/companies`
3. Create test agent with HTTP adapter pointing to bridge
4. Create a simple issue/task assigned to test agent
5. Trigger a heartbeat/run
6. Poll run status until complete or timeout (120s)
7. Read transcript — verify coherent, unfragmented response
8. Clean up: delete test agent

---

## Phase 7: Test Orchestrator

File: `tests/run-all.ps1`

Responsibilities:
- Verify prerequisites (hurl, k6, jq, docker running)
- Build and start containers (`docker compose up -d --build`)
- Wait for healthchecks to pass
- Run tiers sequentially (fail-fast: stop if tier N fails)
- For tests requiring parallel requests or docker exec, use inline PowerShell
- Capture structured results: pass/fail per test, duration, output on failure
- Print summary table at end
- Exit code: 0 if all pass, 1 if any fail
- Optional `--tier N` flag to run only tier N

Output format:
```
[TIER 1] Foundation
  [PASS] 1.1 Container health (0.3s)
  [PASS] 1.2 Bridge responds (0.4s)
  [PASS] 1.3 Round-trip echo (4.2s)
  [PASS] 1.4 Unknown routes 404 (0.2s)
  [PASS] 1.5 Metrics endpoint (0.2s)

[TIER 2] Contract Correctness
  [PASS] 2.1 Wake payload (5.1s)
  ...

Results: 14/14 passed, 0 failed, 0 skipped
Total time: 3m 22s
```

---

## Implementation Order

| Step | What | Depends on | Estimated effort |
|------|------|-----------|-----------------|
| 1 | Install tools (Phase 0) | Nothing | 5 min |
| 2 | Modify bridge.mjs (Phase 1) | Nothing | 30 min |
| 3 | Update Docker config (Phase 2) | Phase 1 | 10 min |
| 4 | Create fixtures (Phase 3) | Phase 1 (need schema) | 15 min |
| 5 | Write tier 1 Hurl tests (Phase 4) | Phases 1-3 | 15 min |
| 6 | Build and validate containers | Phases 1-3 | 10 min |
| 7 | Run tier 1, fix issues | Phases 4-5 | Variable |
| 8 | Write tier 2 tests (Phase 5) | Tier 1 passing | 20 min |
| 9 | Run tier 2, fix issues | Phase 5 | Variable |
| 10 | Write tier 3 tests + k6 (Phase 6) | Tier 2 passing | 30 min |
| 11 | Write orchestrator (Phase 7) | All tests exist | 20 min |
| 12 | Run full suite, iterate | Everything | Variable |

---

## Success Criteria

The system is production-grade when:

1. All 14+ tests pass on a cold start (containers freshly built)
2. Tests are deterministic — running twice produces same results
3. No test requires human interpretation ("eyeball the output")
4. Failure messages are diagnostic — tell you what broke and where
5. Full suite completes in < 10 minutes
6. Zero false positives: a passing suite means the system actually works
7. Orchestrator can run unattended (CI-compatible)

---

## Observability Deliverables Summary

| Component | What it gives us | Format |
|-----------|-----------------|--------|
| `/health` endpoint | Is bridge alive + config correct? | JSON |
| `/metrics` endpoint | Request counts, timing, active count | JSON |
| Structured logs | Full request lifecycle, errors, timing | JSON lines on stdout |
| Protocol capture (debug mode) | Raw Pi RPC messages | JSON lines in docker logs |
| Docker healthcheck | Container-level liveness for compose/orchestrator | Docker inspect |
| Resource limits | Baseline for leak detection | Docker stats |
| Test orchestrator output | Pass/fail per test with timing | Structured console output |

---

## Open Questions

None. All decisions made:
- Logger: hand-rolled, zero deps
- Test runner: Hurl + k6 + PowerShell orchestrator
- Fixtures: static JSON files in repo
- Protocol capture: debug log level, not separate tool
- Memory check: docker stats before/after comparison
