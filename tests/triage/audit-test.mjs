/**
 * Unit tests for triage-workflow local audit log.
 *
 * Tests the JSONL audit trail that records CEO triage phase transitions
 * when using the local filesystem instead of the artifact service.
 *
 * Re-implements the auditLog helper from the refactored triage-workflow.ts
 * inline (post local-first refactor — see tasks/specs/local-first-extensions.md).
 *
 * Run:  node --test tests/triage/audit-test.mjs
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Inline re-implementation of the refactored auditLog helper.
//
// Source: src/agents/extensions/triage-workflow.ts (post local-first refactor)
// Spec:   tasks/specs/local-first-extensions.md §7
//
// function auditLog(cwd: string, entry: Record<string, unknown>): void {
//   const dir = path.join(cwd, "triage");
//   fs.mkdirSync(dir, { recursive: true });
//   fs.appendFileSync(
//     path.join(dir, "audit.jsonl"),
//     JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"
//   );
// }
// ---------------------------------------------------------------------------

function auditLog(cwd, entry) {
  const dir = path.join(cwd, "triage");
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, "audit.jsonl"),
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"
  );
}

// Helper: read all parsed lines from an audit.jsonl file
function readLines(cwd) {
  const p = path.join(cwd, "triage", "audit.jsonl");
  return fs.readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Test state — one temp dir per test, cleaned up in afterEach
// ---------------------------------------------------------------------------

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "triage-audit-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Audit log creation
// ---------------------------------------------------------------------------

describe("audit log creation", () => {
  it("creates triage directory and audit.jsonl", () => {
    auditLog(tmpDir, { agent: "ceo", phase: "TRIAGE", event: "triage_complete" });

    const auditPath = path.join(tmpDir, "triage", "audit.jsonl");
    assert.ok(fs.existsSync(auditPath), "audit.jsonl should exist");
  });

  it("writes valid JSONL", () => {
    auditLog(tmpDir, { agent: "ceo", phase: "TRIAGE", event: "triage_complete" });

    const auditPath = path.join(tmpDir, "triage", "audit.jsonl");
    const content = fs.readFileSync(auditPath, "utf8");

    for (const line of content.split("\n").filter(Boolean)) {
      assert.doesNotThrow(() => JSON.parse(line), `line should parse as JSON: ${line}`);
    }
  });

  it("includes required fields", () => {
    auditLog(tmpDir, { agent: "ceo", phase: "TRIAGE", event: "triage_complete" });

    const [entry] = readLines(tmpDir);
    assert.ok("ts" in entry, "entry should have ts field");
    assert.ok("agent" in entry, "entry should have agent field");
    assert.ok("event" in entry, "entry should have event field");
  });
});

// ---------------------------------------------------------------------------
// 2. Append behavior
// ---------------------------------------------------------------------------

describe("append behavior", () => {
  it("appends multiple events", () => {
    auditLog(tmpDir, { agent: "ceo", phase: "TRIAGE", event: "triage_complete" });
    auditLog(tmpDir, { agent: "ceo", phase: "GROUNDING", event: "search_used" });
    auditLog(tmpDir, { agent: "ceo", phase: "READY", event: "delegation_unlocked" });

    const lines = readLines(tmpDir);
    assert.strictEqual(lines.length, 3, "should have 3 lines");
  });

  it("each line is independent JSON", () => {
    auditLog(tmpDir, { agent: "ceo", phase: "TRIAGE", event: "e1" });
    auditLog(tmpDir, { agent: "ceo", phase: "GROUNDING", event: "e2" });
    auditLog(tmpDir, { agent: "ceo", phase: "READY", event: "e3" });

    const raw = fs.readFileSync(path.join(tmpDir, "triage", "audit.jsonl"), "utf8");
    const lines = raw.split("\n").filter(Boolean);
    assert.strictEqual(lines.length, 3);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `line should parse independently: ${line}`);
    }
  });

  it("preserves order", () => {
    auditLog(tmpDir, { agent: "ceo", phase: "TRIAGE", event: "first" });
    auditLog(tmpDir, { agent: "ceo", phase: "GROUNDING", event: "second" });
    auditLog(tmpDir, { agent: "ceo", phase: "READY", event: "third" });

    const lines = readLines(tmpDir);
    assert.strictEqual(lines[0].event, "first");
    assert.strictEqual(lines[1].event, "second");
    assert.strictEqual(lines[2].event, "third");
  });
});

// ---------------------------------------------------------------------------
// 3. Phase transitions
// ---------------------------------------------------------------------------

describe("phase transitions", () => {
  it("records TRIAGE phase", () => {
    auditLog(tmpDir, { agent: "ceo", phase: "TRIAGE", event: "triage_complete" });

    const [entry] = readLines(tmpDir);
    assert.strictEqual(entry.phase, "TRIAGE");
  });

  it("records GROUNDING phase", () => {
    auditLog(tmpDir, { agent: "ceo", phase: "GROUNDING", event: "search_used" });

    const [entry] = readLines(tmpDir);
    assert.strictEqual(entry.phase, "GROUNDING");
  });

  it("records READY phase", () => {
    auditLog(tmpDir, { agent: "ceo", phase: "READY", event: "delegation_unlocked" });

    const [entry] = readLines(tmpDir);
    assert.strictEqual(entry.phase, "READY");
  });

  it("full phase sequence TRIAGE → GROUNDING → READY", () => {
    auditLog(tmpDir, { agent: "ceo", phase: "TRIAGE", event: "triage_complete" });
    auditLog(tmpDir, { agent: "ceo", phase: "GROUNDING", event: "search_used" });
    auditLog(tmpDir, { agent: "ceo", phase: "READY", event: "delegation_unlocked" });

    const lines = readLines(tmpDir);
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(lines[0].phase, "TRIAGE");
    assert.strictEqual(lines[1].phase, "GROUNDING");
    assert.strictEqual(lines[2].phase, "READY");
  });
});

// ---------------------------------------------------------------------------
// 4. Data fields
// ---------------------------------------------------------------------------

describe("data fields", () => {
  it("includes extra data merged into log entry", () => {
    auditLog(tmpDir, {
      agent: "ceo",
      phase: "GROUNDING",
      event: "phase_blocked",
      tool: "web_search",
      blocked: true,
    });

    const [entry] = readLines(tmpDir);
    assert.strictEqual(entry.tool, "web_search");
    assert.strictEqual(entry.blocked, true);
  });

  it("ts is valid ISO 8601", () => {
    auditLog(tmpDir, { agent: "ceo", phase: "TRIAGE", event: "triage_complete" });

    const [entry] = readLines(tmpDir);
    const d = new Date(entry.ts);
    assert.ok(!isNaN(d.getTime()), `ts should parse as a valid date, got: ${entry.ts}`);
    // ISO 8601 format includes 'T' separator and 'Z' or offset
    assert.ok(entry.ts.includes("T"), "ts should contain T separator");
  });

  it("agent field matches what was passed", () => {
    auditLog(tmpDir, { agent: "ceo", phase: "TRIAGE", event: "triage_complete" });

    const [entry] = readLines(tmpDir);
    assert.strictEqual(entry.agent, "ceo");
  });
});

// ---------------------------------------------------------------------------
// 5. Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("handles missing data gracefully (no extra fields)", () => {
    // entry has only required structural fields, no extra data
    auditLog(tmpDir, { agent: "ceo", phase: "TRIAGE", event: "triage_complete" });

    const [entry] = readLines(tmpDir);
    assert.ok(entry, "entry should exist");
    assert.ok("ts" in entry, "ts should be present");
    assert.ok("agent" in entry, "agent should be present");
    assert.ok("event" in entry, "event should be present");
  });

  it("directory already exists on second call", () => {
    // First call creates the dir; second call must not throw
    auditLog(tmpDir, { agent: "ceo", phase: "TRIAGE", event: "first" });
    assert.doesNotThrow(
      () => auditLog(tmpDir, { agent: "ceo", phase: "GROUNDING", event: "second" })
    );

    const lines = readLines(tmpDir);
    assert.strictEqual(lines.length, 2);
  });

  it("concurrent writes — all 10 lines present", async () => {
    // Rapid synchronous calls (Node.js appendFileSync is atomic per call on
    // POSIX; on Windows it may interleave at OS level but sync calls are
    // serialised within a single process, so all 10 must appear)
    const count = 10;
    for (let i = 0; i < count; i++) {
      auditLog(tmpDir, { agent: "ceo", phase: "TRIAGE", event: "rapid", seq: i });
    }

    const lines = readLines(tmpDir);
    assert.strictEqual(lines.length, count, `expected ${count} lines, got ${lines.length}`);

    // Verify each seq value appears exactly once
    const seqs = lines.map(l => l.seq).sort((a, b) => a - b);
    for (let i = 0; i < count; i++) {
      assert.strictEqual(seqs[i], i, `seq ${i} missing from audit log`);
    }
  });
});
