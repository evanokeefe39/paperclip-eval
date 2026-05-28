/**
 * Unit tests for local-first filesystem storage pattern.
 *
 * Tests the storage helpers (writeLocal, readLocal, listLocal) that replaced
 * artifact-client in workproduct, deep-research, and duckdb extensions.
 *
 * Run:  node --test tests/local-first/unit-test.mjs
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// ULID generator (re-implemented from workproduct-lib/ulid.ts)
// ---------------------------------------------------------------------------

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
let lastTime = 0;
let lastRandom = 0;

function ulid() {
  let now = Date.now();
  if (now === lastTime) {
    lastRandom++;
  } else {
    lastTime = now;
    lastRandom = Math.floor(Math.random() * 0xffffffffffff);
  }
  let id = "";
  for (let i = 9; i >= 0; i--) {
    id = CROCKFORD[now & 0x1f] + id;
    now = Math.floor(now / 32);
  }
  let r = lastRandom;
  for (let i = 15; i >= 0; i--) {
    id += CROCKFORD[r & 0x1f];
    r = Math.floor(r / 32);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Workproduct storage helpers (re-implemented from agent workproduct.ts files)
// The real data agent uses subdir="data"; researcher uses subdir="findings".
// Tests use a configurable baseDir so we can point at a temp directory.
// ---------------------------------------------------------------------------

function writeLocal(baseDir, subdir, type, content, metadata) {
  const dir = path.join(baseDir, "workproduct", subdir);
  fs.mkdirSync(dir, { recursive: true });
  const id = ulid();
  const record = {
    id,
    agent: "test-agent",
    type,
    timestamp: new Date().toISOString(),
    content,
    metadata,
  };
  fs.writeFileSync(path.join(dir, `${id}-${type}.json`), JSON.stringify(record, null, 2));
  return { id };
}

function readLocal(baseDir, subdir, id) {
  const dir = path.join(baseDir, "workproduct", subdir);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir);
  const match = files.find(f => f.startsWith(id));
  if (!match) return null;
  return JSON.parse(fs.readFileSync(path.join(dir, match), "utf8"));
}

function listLocal(baseDir, subdir, filters) {
  const dir = path.join(baseDir, "workproduct", subdir);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  const records = [];
  for (const f of files) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (filters?.type && rec.type !== filters.type) continue;
      if (filters?.session_id && rec.metadata.session_id !== filters.session_id) continue;
      records.push(rec);
    } catch { /* skip */ }
  }
  return records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

// ---------------------------------------------------------------------------
// Deep-research store helpers (re-implemented from deep-research/store.ts)
// The real implementation uses process.cwd() as base; tests inject baseDir.
// ---------------------------------------------------------------------------

async function initSession(baseDir, sessionId) {
  const base = path.join(baseDir, "deep-research", sessionId);
  fs.mkdirSync(path.join(base, "findings"), { recursive: true });
  fs.mkdirSync(path.join(base, "pages"), { recursive: true });
}

async function streamFinding(baseDir, finding, sessionId) {
  const dir = path.join(baseDir, "deep-research", sessionId, "findings");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `finding-${finding.id}.json`),
    JSON.stringify(finding, null, 2)
  );
}

async function storePage(baseDir, sessionId, url, content) {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const dir = path.join(baseDir, "deep-research", sessionId, "pages");
  fs.mkdirSync(dir, { recursive: true });
  const filename = `page-${hash}.md`;
  fs.writeFileSync(
    path.join(dir, filename),
    `<!-- Source: ${url} -->\n<!-- Captured: ${new Date().toISOString()} -->\n\n${content}`
  );
  return filename;
}

async function writeSessionMeta(baseDir, sessionId, query, meta) {
  const base = path.join(baseDir, "deep-research", sessionId);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "session-meta.json"), JSON.stringify(meta, null, 2));
}

// ---------------------------------------------------------------------------
// DuckDB session helpers (re-implemented from duckdb/session.ts)
// The real implementation uses process.cwd() as base; tests inject baseDir.
// ---------------------------------------------------------------------------

async function appendState(baseDir, statement) {
  const dir = path.join(baseDir, "duckdb");
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, "state.sql");

  let currentContent = "-- DuckDB session state\n";
  try {
    currentContent = fs.readFileSync(statePath, "utf8");
  } catch { /* no existing state — start fresh */ }

  // Idempotency: skip if the statement is already persisted
  if (currentContent.includes(statement)) return;

  fs.writeFileSync(statePath, currentContent + statement + "\n");
}

function parseStateFile(baseDir) {
  const statePath = path.join(baseDir, "duckdb", "state.sql");
  let content;
  try {
    content = fs.readFileSync(statePath, "utf8");
  } catch {
    return [];
  }
  return content.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("--"));
}

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

let tmpDir;

function makeTmp() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-first-test-"));
}

function cleanTmp() {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  tmpDir = undefined;
}

// ---------------------------------------------------------------------------
// 1. ULID generator
// ---------------------------------------------------------------------------

describe("ULID generator", () => {
  it("generates 26-character strings", () => {
    const id = ulid();
    assert.equal(id.length, 26);
  });

  it("uses only Crockford Base32 characters", () => {
    const crockford = new Set(CROCKFORD);
    for (let i = 0; i < 50; i++) {
      const id = ulid();
      for (const ch of id) {
        assert.ok(crockford.has(ch), `unexpected character '${ch}' in ulid '${id}'`);
      }
    }
  });

  it("produces monotonically increasing values within the same millisecond", () => {
    // Generate IDs until we get a run of at least 5 sharing the same 10-character
    // time prefix. Within that run, each ID must sort strictly higher than the
    // previous one — guaranteed by the incrementing random counter.
    const batch = [];
    let attempts = 0;
    while (batch.length < 5 && attempts < 500) {
      attempts++;
      const id = ulid();
      const prefix = id.slice(0, 10);
      if (batch.length === 0 || batch[batch.length - 1].slice(0, 10) === prefix) {
        batch.push(id);
      } else {
        // Millisecond boundary crossed — restart the batch.
        batch.length = 0;
        batch.push(id);
      }
    }
    assert.ok(batch.length >= 2, "could not collect 2 same-ms IDs within 500 attempts");
    for (let i = 1; i < batch.length; i++) {
      assert.ok(
        batch[i] > batch[i - 1],
        `ulid[${i}] '${batch[i]}' not greater than ulid[${i - 1}] '${batch[i - 1]}'`
      );
    }
  });

  it("produces no duplicate IDs in 100 rapid generations", () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(ulid());
    }
    assert.equal(ids.size, 100);
  });
});

// ---------------------------------------------------------------------------
// 2. Workproduct storage helpers
// ---------------------------------------------------------------------------

describe("writeLocal", () => {
  beforeEach(makeTmp);
  afterEach(cleanTmp);

  it("creates directory and file on first write", () => {
    const { id } = writeLocal(tmpDir, "data", "metric", '{"value":42}', { session_id: "s1" });
    const dir = path.join(tmpDir, "workproduct", "data");
    assert.ok(fs.existsSync(dir), "directory not created");
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.ok(files[0].startsWith(id), `file '${files[0]}' does not start with id '${id}'`);
  });

  it("writes valid JSON with correct top-level fields", () => {
    const { id } = writeLocal(tmpDir, "data", "metric", '{"value":42}', { session_id: "s1" });
    const dir = path.join(tmpDir, "workproduct", "data");
    const files = fs.readdirSync(dir);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf8"));
    assert.equal(rec.id, id);
    assert.equal(rec.agent, "test-agent");
    assert.equal(rec.type, "metric");
    assert.equal(rec.content, '{"value":42}');
    assert.deepEqual(rec.metadata, { session_id: "s1" });
    assert.ok(typeof rec.timestamp === "string", "timestamp missing");
  });

  it("generates unique IDs across 50 rapid writes", () => {
    const ids = new Set();
    for (let i = 0; i < 50; i++) {
      const { id } = writeLocal(tmpDir, "data", "metric", `${i}`, { session_id: "s1" });
      ids.add(id);
    }
    assert.equal(ids.size, 50);
  });

  it("preserves complex metadata through JSON roundtrip", () => {
    const complexMeta = {
      session_id: "s1",
      tags: ["finance", "q3"],
      nested: { key: "val", count: 7 },
      nullish: null,
    };
    const { id } = writeLocal(tmpDir, "data", "dataset_ref", '{}', complexMeta);
    const rec = readLocal(tmpDir, "data", id);
    assert.deepEqual(rec.metadata, complexMeta);
  });
});

describe("readLocal", () => {
  beforeEach(makeTmp);
  afterEach(cleanTmp);

  it("returns null for a non-existent directory", () => {
    const result = readLocal(tmpDir, "data", "01AAAAAAAAAAAAAAAAAAAAAAAAA");
    assert.equal(result, null);
  });

  it("returns null for an ID not in the directory", () => {
    writeLocal(tmpDir, "data", "metric", '{}', {});
    const result = readLocal(tmpDir, "data", "NOTAREALID");
    assert.equal(result, null);
  });

  it("returns the correct record when ID matches", () => {
    const { id } = writeLocal(tmpDir, "data", "query_result", '{"sql":"SELECT 1"}', { session_id: "run42" });
    const rec = readLocal(tmpDir, "data", id);
    assert.ok(rec !== null, "record not found");
    assert.equal(rec.id, id);
    assert.equal(rec.type, "query_result");
    assert.equal(rec.content, '{"sql":"SELECT 1"}');
    assert.equal(rec.metadata.session_id, "run42");
  });
});

describe("listLocal", () => {
  beforeEach(makeTmp);
  afterEach(cleanTmp);

  it("returns empty array when directory does not exist", () => {
    const result = listLocal(tmpDir, "data");
    assert.deepEqual(result, []);
  });

  it("returns all records sorted by timestamp descending", async () => {
    // Write records with forced ordering by manipulating timestamps after write.
    // We produce 3 records; the last written should sort first (most recent).
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const { id } = writeLocal(tmpDir, "data", "metric", `${i}`, { session_id: "s1" });
      ids.push(id);
      // Patch the file timestamp so they are strictly ordered even within the same ms.
      const dir = path.join(tmpDir, "workproduct", "data");
      const files = fs.readdirSync(dir);
      const file = files.find(f => f.startsWith(id));
      const rec = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      rec.timestamp = new Date(Date.now() + i * 1000).toISOString();
      fs.writeFileSync(path.join(dir, file), JSON.stringify(rec, null, 2));
    }

    const results = listLocal(tmpDir, "data");
    assert.equal(results.length, 3);
    // Verify descending order: each timestamp >= the next.
    for (let i = 0; i < results.length - 1; i++) {
      assert.ok(
        results[i].timestamp >= results[i + 1].timestamp,
        `results not sorted: [${i}]=${results[i].timestamp} < [${i + 1}]=${results[i + 1].timestamp}`
      );
    }
    // The last-written record (highest i, highest timestamp) should be first.
    assert.equal(results[0].id, ids[2]);
  });

  it("filters by type", () => {
    writeLocal(tmpDir, "data", "metric", '{}', { session_id: "s1" });
    writeLocal(tmpDir, "data", "chart", '{}', { session_id: "s1" });
    writeLocal(tmpDir, "data", "metric", '{}', { session_id: "s1" });

    const metrics = listLocal(tmpDir, "data", { type: "metric" });
    assert.equal(metrics.length, 2);
    for (const r of metrics) assert.equal(r.type, "metric");

    const charts = listLocal(tmpDir, "data", { type: "chart" });
    assert.equal(charts.length, 1);
  });

  it("filters by session_id", () => {
    writeLocal(tmpDir, "data", "metric", '{}', { session_id: "session-A" });
    writeLocal(tmpDir, "data", "metric", '{}', { session_id: "session-B" });
    writeLocal(tmpDir, "data", "metric", '{}', { session_id: "session-A" });

    const sessionA = listLocal(tmpDir, "data", { session_id: "session-A" });
    assert.equal(sessionA.length, 2);
    for (const r of sessionA) assert.equal(r.metadata.session_id, "session-A");

    const sessionB = listLocal(tmpDir, "data", { session_id: "session-B" });
    assert.equal(sessionB.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 3. Deep-research store helpers
// ---------------------------------------------------------------------------

describe("deep-research store: initSession", () => {
  beforeEach(makeTmp);
  afterEach(cleanTmp);

  it("creates findings/ and pages/ subdirectories", async () => {
    await initSession(tmpDir, "sess-001");
    assert.ok(fs.existsSync(path.join(tmpDir, "deep-research", "sess-001", "findings")), "findings/ missing");
    assert.ok(fs.existsSync(path.join(tmpDir, "deep-research", "sess-001", "pages")), "pages/ missing");
  });

  it("is idempotent — calling twice does not throw", async () => {
    await initSession(tmpDir, "sess-002");
    await assert.doesNotReject(() => initSession(tmpDir, "sess-002"));
  });
});

describe("deep-research store: streamFinding", () => {
  beforeEach(makeTmp);
  afterEach(cleanTmp);

  it("writes finding JSON at the expected path", async () => {
    const finding = { id: "find-1", claim_preview: "test claim", confidence: 0.9, source_url: "https://example.com", entities: [] };
    await streamFinding(tmpDir, finding, "sess-003");
    const filePath = path.join(tmpDir, "deep-research", "sess-003", "findings", "finding-find-1.json");
    assert.ok(fs.existsSync(filePath), `finding file not found at ${filePath}`);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(parsed.id, "find-1");
    assert.equal(parsed.claim_preview, "test claim");
    assert.equal(parsed.confidence, 0.9);
  });

  it("creates the findings directory if it does not exist", async () => {
    const finding = { id: "find-2", claim_preview: "x", confidence: 0.5, source_url: "https://a.com", entities: [] };
    // No initSession called — streamFinding must create the dir itself.
    await streamFinding(tmpDir, finding, "sess-004");
    assert.ok(fs.existsSync(path.join(tmpDir, "deep-research", "sess-004", "findings")));
  });
});

describe("deep-research store: storePage", () => {
  beforeEach(makeTmp);
  afterEach(cleanTmp);

  it("returns a filename and writes the file with a URL header", async () => {
    const url = "https://example.com/article";
    const filename = await storePage(tmpDir, "sess-005", url, "body content here");
    assert.ok(typeof filename === "string", "filename not returned");
    assert.ok(filename.startsWith("page-"), `unexpected filename prefix: ${filename}`);
    const filePath = path.join(tmpDir, "deep-research", "sess-005", "pages", filename);
    assert.ok(fs.existsSync(filePath), "page file not created");
    const content = fs.readFileSync(filePath, "utf8");
    assert.ok(content.includes(`<!-- Source: ${url} -->`), "URL header missing");
    assert.ok(content.includes("body content here"), "body content missing");
  });

  it("produces the same filename for the same URL (deterministic hash)", async () => {
    const url = "https://example.com/stable";
    const f1 = await storePage(tmpDir, "sess-006", url, "first");
    const f2 = await storePage(tmpDir, "sess-006", url, "second");
    assert.equal(f1, f2);
  });

  it("produces different filenames for different URLs", async () => {
    const f1 = await storePage(tmpDir, "sess-007", "https://a.com", "a");
    const f2 = await storePage(tmpDir, "sess-007", "https://b.com", "b");
    assert.notEqual(f1, f2);
  });
});

describe("deep-research store: writeSessionMeta", () => {
  beforeEach(makeTmp);
  afterEach(cleanTmp);

  it("writes session-meta.json with the provided fields", async () => {
    const meta = {
      session_id: "sess-008",
      query: "test query",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      total_findings: 3,
      total_sources: 2,
      iterations: 1,
      config: { max_iterations: 5, max_sub_queries: 3 },
    };
    await writeSessionMeta(tmpDir, "sess-008", "test query", meta);
    const filePath = path.join(tmpDir, "deep-research", "sess-008", "session-meta.json");
    assert.ok(fs.existsSync(filePath), "session-meta.json not created");
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(parsed.session_id, "sess-008");
    assert.equal(parsed.total_findings, 3);
    assert.equal(parsed.iterations, 1);
  });
});

// ---------------------------------------------------------------------------
// 4. DuckDB session state helpers
// ---------------------------------------------------------------------------

describe("duckdb session: appendState", () => {
  beforeEach(makeTmp);
  afterEach(cleanTmp);

  it("creates the state file from scratch with a header and the statement", async () => {
    await appendState(tmpDir, "ATTACH 'db.ddb' AS mydb;");
    const statePath = path.join(tmpDir, "duckdb", "state.sql");
    assert.ok(fs.existsSync(statePath), "state.sql not created");
    const content = fs.readFileSync(statePath, "utf8");
    assert.ok(content.includes("-- DuckDB session state"), "header missing");
    assert.ok(content.includes("ATTACH 'db.ddb' AS mydb;"), "statement missing");
  });

  it("is idempotent — appending the same statement twice stores it only once", async () => {
    await appendState(tmpDir, "ATTACH 'db.ddb' AS mydb;");
    await appendState(tmpDir, "ATTACH 'db.ddb' AS mydb;");
    const content = fs.readFileSync(path.join(tmpDir, "duckdb", "state.sql"), "utf8");
    const occurrences = content.split("ATTACH 'db.ddb' AS mydb;").length - 1;
    assert.equal(occurrences, 1, `statement appears ${occurrences} times, expected 1`);
  });

  it("appends distinct statements sequentially", async () => {
    await appendState(tmpDir, "ATTACH 'a.ddb' AS a;");
    await appendState(tmpDir, "ATTACH 'b.ddb' AS b;");
    const content = fs.readFileSync(path.join(tmpDir, "duckdb", "state.sql"), "utf8");
    assert.ok(content.includes("ATTACH 'a.ddb' AS a;"), "first statement missing");
    assert.ok(content.includes("ATTACH 'b.ddb' AS b;"), "second statement missing");
  });
});

describe("duckdb session: parseStateFile", () => {
  beforeEach(makeTmp);
  afterEach(cleanTmp);

  it("returns empty array when the state file does not exist", () => {
    const lines = parseStateFile(tmpDir);
    assert.deepEqual(lines, []);
  });

  it("skips comment lines and blank lines, returns only SQL statements", async () => {
    const dir = path.join(tmpDir, "duckdb");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "state.sql"),
      "-- DuckDB session state\n\nATTACH 'a.ddb' AS a;\n\n-- another comment\nATTACH 'b.ddb' AS b;\n"
    );
    const lines = parseStateFile(tmpDir);
    assert.deepEqual(lines, ["ATTACH 'a.ddb' AS a;", "ATTACH 'b.ddb' AS b;"]);
  });
});

// ---------------------------------------------------------------------------
// 5. Issue-scoped workspace isolation
// ---------------------------------------------------------------------------

describe("issue-scoped workspace isolation", () => {
  beforeEach(makeTmp);
  afterEach(cleanTmp);

  it("different issue IDs produce different directories with no file collision", () => {
    const { id: idA } = writeLocal(tmpDir, "issue-AAA", "metric", '{"v":1}', { session_id: "AAA" });
    const { id: idB } = writeLocal(tmpDir, "issue-BBB", "metric", '{"v":2}', { session_id: "BBB" });

    // Each record is only visible in its own subdir.
    assert.ok(readLocal(tmpDir, "issue-AAA", idA) !== null, "record A not found in issue-AAA");
    assert.ok(readLocal(tmpDir, "issue-BBB", idB) !== null, "record B not found in issue-BBB");
    assert.equal(readLocal(tmpDir, "issue-AAA", idB), null, "record B leaked into issue-AAA");
    assert.equal(readLocal(tmpDir, "issue-BBB", idA), null, "record A leaked into issue-BBB");
  });

  it("same issue ID accumulates files across multiple invocations", () => {
    const { id: id1 } = writeLocal(tmpDir, "issue-CCC", "metric", '{"v":1}', {});
    const { id: id2 } = writeLocal(tmpDir, "issue-CCC", "metric", '{"v":2}', {});

    const all = listLocal(tmpDir, "issue-CCC");
    assert.equal(all.length, 2);
    const ids = all.map(r => r.id);
    assert.ok(ids.includes(id1), "first record missing from accumulated list");
    assert.ok(ids.includes(id2), "second record missing from accumulated list");
  });
});
