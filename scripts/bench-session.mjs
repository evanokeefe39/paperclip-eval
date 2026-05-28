#!/usr/bin/env node
/**
 * Benchmark: createAgentSession cold-start cost.
 * Run inside agent container: node /app/scripts/bench-session.mjs
 *
 * Two modes:
 *   A) Full cold-start — createAgentSession from scratch each time
 *   B) Shared services — pre-init AuthStorage/ModelRegistry/SettingsManager/ResourceLoader,
 *      then createAgentSessionFromServices per request (only session + extension load)
 */

const SDK_PATH = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const sdk = await import(SDK_PATH);
const {
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  AuthStorage,
  FileAuthStorageBackend,
  ModelRegistry,
  SettingsManager,
  DefaultResourceLoader,
  getAgentDir,
} = sdk;
import { mkdirSync } from "node:fs";

const ITERATIONS = 5;
const CWD = "/workspace/scratch";
const AGENT_DIR = getAgentDir();

mkdirSync(CWD, { recursive: true });

console.log(`Pi SDK benchmark — createAgentSession cold-start`);
console.log(`Iterations: ${ITERATIONS}`);
console.log(`agentDir:   ${AGENT_DIR}`);
console.log(`cwd:        ${CWD}`);
console.log();

// ── Helpers ──

function stats(label, results) {
  if (results.length === 0) return;
  const avg = results.reduce((a, b) => a + b, 0) / results.length;
  const min = Math.min(...results);
  const max = Math.max(...results);
  const sorted = [...results].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)];
  console.log(`  avg: ${avg.toFixed(0)}ms  min: ${min.toFixed(0)}ms  max: ${max.toFixed(0)}ms  p50: ${p50.toFixed(0)}ms`);
}

function logIter(i, elapsed, result) {
  const extCount = result.extensionsResult?.extensions?.length ?? "?";
  const toolCount = result.extensionsResult?.tools?.length ?? "?";
  const fallback = result.modelFallbackMessage ? ` [fallback: ${result.modelFallbackMessage}]` : "";
  console.log(`  #${i + 1}: ${elapsed.toFixed(0)}ms — ${extCount} extensions, ${toolCount} tools${fallback}`);
}

// ── A) Full cold-start ──

console.log(`=== A) Full cold-start (createAgentSession) ===`);
const coldResults = [];

for (let i = 0; i < ITERATIONS; i++) {
  const t0 = performance.now();
  try {
    const result = await createAgentSession({
      cwd: CWD,
      agentDir: AGENT_DIR,
      sessionManager: SessionManager.inMemory(),
    });
    const elapsed = performance.now() - t0;
    coldResults.push(elapsed);
    logIter(i, elapsed, result);
  } catch (err) {
    console.error(`  #${i + 1} FAILED: ${err.message}`);
    console.error(err.stack);
  }
}

console.log(`--- cold-start summary ---`);
stats("cold", coldResults);
console.log();

// ── B) Shared services ──

console.log(`=== B) Shared services (createAgentSessionFromServices) ===`);

let services;
const servicesT0 = performance.now();
try {
  services = await createAgentSessionServices({
    cwd: CWD,
    agentDir: AGENT_DIR,
  });
  const servicesElapsed = performance.now() - servicesT0;
  console.log(`  Services init: ${servicesElapsed.toFixed(0)}ms (one-time cost)`);
} catch (err) {
  console.error(`  Services init FAILED: ${err.message}`);
  console.error(err.stack);
  console.log(`  Falling back — createAgentSessionServices may not exist in this version.`);
  console.log(`  Try createAgentSessionFromServices directly if available.`);
  services = null;
}

const warmResults = [];

if (services) {
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    try {
      const result = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.inMemory(),
      });
      const elapsed = performance.now() - t0;
      warmResults.push(elapsed);
      logIter(i, elapsed, result);
    } catch (err) {
      console.error(`  #${i + 1} FAILED: ${err.message}`);
      console.error(err.stack);
    }
  }

  console.log(`--- shared-services summary ---`);
  stats("warm", warmResults);
} else {
  console.log(`  Skipped — services init failed.`);
}

// ── Summary ──

console.log();
console.log(`=== Comparison ===`);
if (coldResults.length && warmResults.length) {
  const coldAvg = coldResults.reduce((a, b) => a + b, 0) / coldResults.length;
  const warmAvg = warmResults.reduce((a, b) => a + b, 0) / warmResults.length;
  const speedup = ((coldAvg - warmAvg) / coldAvg * 100).toFixed(0);
  console.log(`  Cold avg: ${coldAvg.toFixed(0)}ms`);
  console.log(`  Warm avg: ${warmAvg.toFixed(0)}ms`);
  console.log(`  Speedup:  ${speedup}% faster with shared services`);
} else {
  console.log(`  Incomplete data — check errors above.`);
}
