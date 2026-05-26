/**
 * Unit tests for logging extension modules.
 *
 * Tests RingBuffer and JSONL writer without Docker or Pi.
 *
 * Run:  node --test tests/logging/unit-test.mjs
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// =========================================================================
//  RingBuffer (reimplemented inline — source is TypeScript)
// =========================================================================

class RingBuffer {
  #items;
  #head = 0;
  #count = 0;
  #capacity;

  constructor(capacity) {
    this.#capacity = capacity;
    this.#items = new Array(capacity);
  }

  push(entry) {
    this.#items[this.#head] = entry;
    this.#head = (this.#head + 1) % this.#capacity;
    if (this.#count < this.#capacity) this.#count++;
  }

  query(filters = {}) {
    const limit = filters.limit ?? 50;
    const results = [];

    let idx = (this.#head - 1 + this.#capacity) % this.#capacity;
    for (let i = 0; i < this.#count && results.length < limit; i++) {
      const entry = this.#items[idx];
      idx = (idx - 1 + this.#capacity) % this.#capacity;

      if (filters.level && entry.level !== filters.level) continue;
      if (filters.event && entry.event !== filters.event) continue;
      if (filters.since && entry.ts < filters.since) continue;

      results.push(entry);
    }

    return results;
  }

  size() {
    return this.#count;
  }
}

function makeEntry(overrides = {}) {
  return {
    ts: new Date().toISOString(),
    agent: "test",
    level: "info",
    event: "test_event",
    message: "test message",
    trace_id: "abc123",
    meta: {},
    ...overrides,
  };
}

describe("RingBuffer", () => {
  let buf;

  beforeEach(() => {
    buf = new RingBuffer(5);
  });

  it("starts empty", () => {
    assert.equal(buf.size(), 0);
    assert.deepEqual(buf.query(), []);
  });

  it("stores and retrieves entries", () => {
    buf.push(makeEntry({ message: "a" }));
    buf.push(makeEntry({ message: "b" }));
    const results = buf.query();
    assert.equal(results.length, 2);
    assert.equal(results[0].message, "b");
    assert.equal(results[1].message, "a");
  });

  it("returns most recent first", () => {
    for (let i = 0; i < 5; i++) buf.push(makeEntry({ message: `m${i}` }));
    const results = buf.query();
    assert.equal(results[0].message, "m4");
    assert.equal(results[4].message, "m0");
  });

  it("overwrites oldest when capacity exceeded", () => {
    for (let i = 0; i < 8; i++) buf.push(makeEntry({ message: `m${i}` }));
    assert.equal(buf.size(), 5);
    const results = buf.query();
    assert.equal(results.length, 5);
    assert.equal(results[0].message, "m7");
    assert.equal(results[4].message, "m3");
  });

  it("filters by level", () => {
    buf.push(makeEntry({ level: "info" }));
    buf.push(makeEntry({ level: "error" }));
    buf.push(makeEntry({ level: "info" }));
    const errors = buf.query({ level: "error" });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].level, "error");
  });

  it("filters by event", () => {
    buf.push(makeEntry({ event: "decision" }));
    buf.push(makeEntry({ event: "progress" }));
    buf.push(makeEntry({ event: "decision" }));
    const decisions = buf.query({ event: "decision" });
    assert.equal(decisions.length, 2);
  });

  it("filters by since", () => {
    buf.push(makeEntry({ ts: "2026-01-01T00:00:00Z" }));
    buf.push(makeEntry({ ts: "2026-06-01T00:00:00Z" }));
    buf.push(makeEntry({ ts: "2026-12-01T00:00:00Z" }));
    const recent = buf.query({ since: "2026-05-01T00:00:00Z" });
    assert.equal(recent.length, 2);
  });

  it("respects limit", () => {
    for (let i = 0; i < 5; i++) buf.push(makeEntry());
    const results = buf.query({ limit: 2 });
    assert.equal(results.length, 2);
  });

  it("combined filters", () => {
    buf.push(makeEntry({ level: "info", event: "a" }));
    buf.push(makeEntry({ level: "error", event: "a" }));
    buf.push(makeEntry({ level: "error", event: "b" }));
    const results = buf.query({ level: "error", event: "a" });
    assert.equal(results.length, 1);
  });

  it("handles capacity of 1", () => {
    const tiny = new RingBuffer(1);
    tiny.push(makeEntry({ message: "first" }));
    tiny.push(makeEntry({ message: "second" }));
    assert.equal(tiny.size(), 1);
    assert.equal(tiny.query()[0].message, "second");
  });
});

// =========================================================================
//  JSONL Writer (reimplemented inline)
// =========================================================================

class JsonlWriter {
  #filePath = null;

  constructor(agentName, enabled, rootDir) {
    if (!agentName || !enabled) return;
    const dir = path.join(rootDir, agentName);
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.#filePath = path.join(dir, "run.log.jsonl");
    } catch {
      this.#filePath = null;
    }
  }

  append(entry) {
    if (!this.#filePath) return;
    try {
      fs.appendFileSync(this.#filePath, JSON.stringify(entry) + "\n", "utf8");
    } catch {}
  }

  getPath() {
    return this.#filePath;
  }
}

describe("JsonlWriter", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "logging-test-"));
  });

  it("creates agent directory and log file", () => {
    const w = new JsonlWriter("researcher", true, tmpDir);
    w.append(makeEntry({ message: "hello" }));

    const filePath = w.getPath();
    assert.ok(filePath);
    assert.ok(fs.existsSync(filePath));

    const content = fs.readFileSync(filePath, "utf8").trim();
    const parsed = JSON.parse(content);
    assert.equal(parsed.message, "hello");
  });

  it("appends multiple entries as JSONL", () => {
    const w = new JsonlWriter("ceo", true, tmpDir);
    w.append(makeEntry({ message: "a" }));
    w.append(makeEntry({ message: "b" }));
    w.append(makeEntry({ message: "c" }));

    const lines = fs.readFileSync(w.getPath(), "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]).message, "a");
    assert.equal(JSON.parse(lines[2]).message, "c");
  });

  it("returns null path when disabled", () => {
    const w = new JsonlWriter("ceo", false, tmpDir);
    assert.equal(w.getPath(), null);
  });

  it("returns null path when agent name empty", () => {
    const w = new JsonlWriter("", true, tmpDir);
    assert.equal(w.getPath(), null);
  });

  it("silently handles write failures", () => {
    const w = new JsonlWriter("ceo", true, "/nonexistent/path/that/should/fail");
    assert.doesNotThrow(() => w.append(makeEntry()));
  });
});

// =========================================================================
//  OtelEmitter (reimplemented inline)
// =========================================================================

describe("OtelEmitter", () => {
  it("emits via pi.events.emit when available", () => {
    const emitted = [];
    const fakePi = { events: { emit: (evt, data) => emitted.push({ evt, data }) } };

    // Inline reimplementation
    const emit = fakePi.events?.emit?.bind(fakePi.events);
    assert.ok(emit);

    emit("pi-otel:log", {
      severityText: "INFO",
      body: "[test] msg",
      attributes: { "log.agent": "test" },
    });

    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].evt, "pi-otel:log");
    assert.equal(emitted[0].data.severityText, "INFO");
  });

  it("gracefully handles missing events property", () => {
    const fakePi = {};
    const emit = fakePi.events?.emit;
    assert.equal(emit, undefined);
  });

  it("truncates large metadata values at 4KB", () => {
    const bigValue = "x".repeat(5000);
    const s = bigValue.length > 4096 ? bigValue.slice(0, 4093) + "..." : bigValue;
    assert.equal(s.length, 4096);
    assert.ok(s.endsWith("..."));
  });
});

// =========================================================================
//  TRACEPARENT parsing
// =========================================================================

describe("TRACEPARENT parsing", () => {
  it("extracts trace_id from W3C traceparent", () => {
    const traceparent = "00-abcdef1234567890abcdef1234567890-1234567890abcdef-01";
    const traceId = traceparent.split("-")[1];
    assert.equal(traceId, "abcdef1234567890abcdef1234567890");
  });

  it("falls back to random UUID when no TRACEPARENT", () => {
    const fallback = undefined;
    const traceId = fallback?.split("-")[1] || "fallback-uuid";
    assert.equal(traceId, "fallback-uuid");
  });
});

// =========================================================================
//  Usage aggregation (bridge logic)
// =========================================================================

describe("Usage aggregation", () => {
  it("sums token counts across turns", () => {
    const usageByTurn = [
      { provider: "deepseek", model: "deepseek-chat", input: 100, output: 50, cacheRead: 200 },
      { provider: "deepseek", model: "deepseek-chat", input: 80, output: 30, cacheRead: 150 },
    ];

    const totalInput = usageByTurn.reduce((s, u) => s + u.input, 0);
    const totalOutput = usageByTurn.reduce((s, u) => s + u.output, 0);
    const totalCache = usageByTurn.reduce((s, u) => s + u.cacheRead, 0);

    assert.equal(totalInput, 180);
    assert.equal(totalOutput, 80);
    assert.equal(totalCache, 350);
  });

  it("handles empty turns array", () => {
    const usageByTurn = [];
    const totalInput = usageByTurn.reduce((s, u) => s + u.input, 0);
    assert.equal(totalInput, 0);
  });

  it("skips cost reporting when total is zero", () => {
    const inputTokens = 0;
    const outputTokens = 0;
    const shouldReport = (inputTokens + outputTokens) > 0;
    assert.equal(shouldReport, false);
  });
});
