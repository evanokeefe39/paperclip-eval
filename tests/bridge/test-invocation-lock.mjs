/**
 * Test: bridge returns 503 when a Pi process is already running.
 *
 * Usage (against live bridge):
 *   BRIDGE_URL=http://localhost:8081 node tests/bridge/test-invocation-lock.mjs
 *
 * The test sends two concurrent /invoke requests. The first acquires the busy
 * flag and begins spawning Pi (which will take 60+ seconds or fail — either is
 * fine). The second request, sent 500ms later, must receive HTTP 503 with
 * { error: "agent_busy" } immediately rather than queuing.
 */

import { strict as assert } from "node:assert";

const BRIDGE_URL = process.env.BRIDGE_URL || "http://localhost:8081";
const payload = JSON.stringify({
  agentId: "test",
  runId: "test-lock",
  context: { paperclipTaskMarkdown: "test prompt for lock contention check" },
});
const headers = { "Content-Type": "application/json" };

console.log(`Testing bridge at ${BRIDGE_URL}`);

// Verify bridge is reachable
try {
  const health = await fetch(`${BRIDGE_URL}/health`);
  assert.equal(health.status, 200, "Bridge health check failed");
  const healthBody = await health.json();
  console.log(`Bridge healthy: v${healthBody.version}, busy=${healthBody.busy}`);
  if (healthBody.busy) {
    console.log("SKIP: bridge is already busy — cannot run concurrency test");
    process.exit(0);
  }
} catch (err) {
  console.error(`Cannot reach bridge at ${BRIDGE_URL}: ${err.message}`);
  console.log("SKIP: bridge not running");
  process.exit(0);
}

// Send first request (will hold the busy flag for the duration of Pi execution)
const firstController = new AbortController();
const first = fetch(`${BRIDGE_URL}/invoke`, {
  method: "POST",
  headers,
  body: payload,
  signal: firstController.signal,
});

// Wait for the first request to be processed and acquire the busy flag
await new Promise((r) => setTimeout(r, 500));

// Second request should get 503 immediately
const second = await fetch(`${BRIDGE_URL}/invoke`, {
  method: "POST",
  headers,
  body: payload,
});

assert.equal(second.status, 503, `Expected 503 but got ${second.status}`);

const body = await second.json();
assert.equal(body.error, "agent_busy", `Expected error "agent_busy" but got "${body.error}"`);
assert.ok(body.detail, "Response should include detail message");

// Check Retry-After header
const retryAfter = second.headers.get("retry-after");
assert.ok(retryAfter, "Response should include Retry-After header");
assert.equal(retryAfter, "30", `Expected Retry-After: 30 but got ${retryAfter}`);

console.log("PASS: concurrent invoke returns 503 with agent_busy error");

// Clean up the first request — abort it since we don't need the result
firstController.abort();
first.catch(() => {});

// Brief pause to let the bridge process the abort and release the flag
await new Promise((r) => setTimeout(r, 200));
