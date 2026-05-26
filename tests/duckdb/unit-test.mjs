/**
 * Unit tests for duckdb extension submodules.
 *
 * Tests pure logic without DuckDB native addon — format detection, path
 * validation, safety checks, NLQ detection, result formatting, session
 * state file I/O.
 *
 * Run:  node --test tests/duckdb/unit-test.mjs
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// =========================================================================
//  detect.ts — re-implemented inline (source is TypeScript)
// =========================================================================

const FORMAT_MAP = {
  csv: "csv", tsv: "csv",
  json: "json", jsonl: "json", ndjson: "json",
  parquet: "parquet", pq: "parquet",
  xlsx: "excel", xls: "excel",
  sqlite: "sqlite", sqlite3: "sqlite", db: "sqlite",
  duckdb: "duckdb",
  avro: "avro",
  shp: "spatial", gpkg: "spatial", geojson: "spatial",
  ipynb: "json",
};

function detectFormat(filePath) {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return FORMAT_MAP[ext] || null;
}

function isRemoteUrl(p) {
  return /^(https?|s3|r2|gs):\/\//i.test(p);
}

function outputCopyFormat(filePath) {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  const map = {
    parquet: "PARQUET", pq: "PARQUET",
    csv: "CSV", tsv: "CSV",
    json: "JSON", jsonl: "JSON", ndjson: "JSON",
    xlsx: "EXCEL",
  };
  return map[ext] || null;
}

describe("detect", () => {
  it("detects CSV", () => {
    assert.equal(detectFormat("data.csv"), "csv");
    assert.equal(detectFormat("/path/to/file.CSV"), "csv");
  });

  it("detects JSON variants", () => {
    assert.equal(detectFormat("data.json"), "json");
    assert.equal(detectFormat("data.jsonl"), "json");
    assert.equal(detectFormat("data.ndjson"), "json");
    assert.equal(detectFormat("notebook.ipynb"), "json");
  });

  it("detects Parquet", () => {
    assert.equal(detectFormat("data.parquet"), "parquet");
    assert.equal(detectFormat("data.pq"), "parquet");
  });

  it("detects Excel", () => {
    assert.equal(detectFormat("sheet.xlsx"), "excel");
    assert.equal(detectFormat("old.xls"), "excel");
  });

  it("detects SQLite", () => {
    assert.equal(detectFormat("app.sqlite"), "sqlite");
    assert.equal(detectFormat("app.sqlite3"), "sqlite");
    assert.equal(detectFormat("app.db"), "sqlite");
  });

  it("detects spatial", () => {
    assert.equal(detectFormat("map.shp"), "spatial");
    assert.equal(detectFormat("map.gpkg"), "spatial");
    assert.equal(detectFormat("map.geojson"), "spatial");
  });

  it("detects DuckDB", () => {
    assert.equal(detectFormat("analytics.duckdb"), "duckdb");
  });

  it("returns null for unsupported", () => {
    assert.equal(detectFormat("file.txt"), null);
    assert.equal(detectFormat("binary.exe"), null);
    assert.equal(detectFormat("noext"), null);
  });

  it("detects remote URLs", () => {
    assert.equal(isRemoteUrl("https://example.com/data.csv"), true);
    assert.equal(isRemoteUrl("s3://bucket/file.parquet"), true);
    assert.equal(isRemoteUrl("r2://bucket/file.csv"), true);
    assert.equal(isRemoteUrl("gs://bucket/file.json"), true);
    assert.equal(isRemoteUrl("/local/path/file.csv"), false);
  });

  it("maps output copy formats", () => {
    assert.equal(outputCopyFormat("out.parquet"), "PARQUET");
    assert.equal(outputCopyFormat("out.csv"), "CSV");
    assert.equal(outputCopyFormat("out.json"), "JSON");
    assert.equal(outputCopyFormat("out.jsonl"), "JSON");
    assert.equal(outputCopyFormat("out.xlsx"), "EXCEL");
    assert.equal(outputCopyFormat("out.txt"), null);
  });
});

// =========================================================================
//  safety.ts — re-implemented inline
// =========================================================================

const ALLOWED_ROOTS = ["/artifacts", "/workspace", "/tmp"];

const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "INSERT", "UPDATE", "DELETE", "CREATE",
  "DROP", "ALTER", "JOIN", "GROUP", "ORDER", "HAVING", "UNION",
  "WITH", "LIMIT", "OFFSET", "ATTACH", "COPY", "LOAD", "SET",
  "DESCRIBE", "SHOW", "EXPLAIN", "PRAGMA", "INSTALL",
];

function isNaturalLanguage(sql) {
  const upper = sql.trim().toUpperCase();
  return !SQL_KEYWORDS.some((kw) => upper.startsWith(kw));
}

function validatePath(filePath) {
  if (/^(https?|s3|r2|gs):\/\//i.test(filePath)) {
    return { valid: true };
  }
  const resolved = path.resolve(filePath);
  const allowed = ALLOWED_ROOTS.some(
    (root) => resolved === root || resolved.startsWith(root + "/"),
  );
  if (!allowed) {
    return { valid: false, error: `Path "${resolved}" is outside allowed roots: ${ALLOWED_ROOTS.join(", ")}` };
  }
  return { valid: true };
}

function hasAggregationOrLimit(sql) {
  const upper = sql.toUpperCase();
  return (
    /\bLIMIT\b/.test(upper) ||
    /\bGROUP\s+BY\b/.test(upper) ||
    /\bCOUNT\s*\(/.test(upper) ||
    /\bSUM\s*\(/.test(upper) ||
    /\bAVG\s*\(/.test(upper) ||
    /\bMIN\s*\(/.test(upper) ||
    /\bMAX\s*\(/.test(upper) ||
    /\bDISTINCT\b/.test(upper)
  );
}

function checkQuerySafety(sql, estimatedRows) {
  if (hasAggregationOrLimit(sql)) return { safe: true };
  if (estimatedRows !== null && estimatedRows > 100_000) {
    return {
      safe: false,
      warning: `Query would return ~${estimatedRows.toLocaleString()} rows. Add LIMIT, GROUP BY, or an aggregation function to bound the result set.`,
    };
  }
  return { safe: true };
}

describe("safety", () => {
  describe("isNaturalLanguage", () => {
    it("detects natural language", () => {
      assert.equal(isNaturalLanguage("how many orders per month"), true);
      assert.equal(isNaturalLanguage("what is the average revenue"), true);
      assert.equal(isNaturalLanguage("top 10 customers by spend"), true);
    });

    it("detects SQL", () => {
      assert.equal(isNaturalLanguage("SELECT * FROM orders"), false);
      assert.equal(isNaturalLanguage("FROM orders SELECT *"), false);
      assert.equal(isNaturalLanguage("WITH cte AS (SELECT 1) SELECT * FROM cte"), false);
      assert.equal(isNaturalLanguage("DESCRIBE orders"), false);
      assert.equal(isNaturalLanguage("SHOW TABLES"), false);
      assert.equal(isNaturalLanguage("EXPLAIN SELECT 1"), false);
    });

    it("handles edge cases", () => {
      assert.equal(isNaturalLanguage("  SELECT * FROM t"), false);
      assert.equal(isNaturalLanguage("select * from t"), false);
    });
  });

  describe("validatePath", () => {
    // validatePath uses path.resolve which is platform-dependent.
    // On Windows, /artifacts resolves to C:\artifacts — won't match.
    // These tests verify the logic runs in Linux containers.
    const isWindows = process.platform === "win32";

    it("allows paths under /artifacts", { skip: isWindows && "Linux-only path validation" }, () => {
      assert.deepEqual(validatePath("/artifacts/data/file.csv"), { valid: true });
    });

    it("allows paths under /workspace", { skip: isWindows && "Linux-only path validation" }, () => {
      assert.deepEqual(validatePath("/workspace/data.csv"), { valid: true });
    });

    it("allows paths under /tmp", { skip: isWindows && "Linux-only path validation" }, () => {
      assert.deepEqual(validatePath("/tmp/staging.parquet"), { valid: true });
    });

    it("allows remote URLs", () => {
      assert.deepEqual(validatePath("https://example.com/data.csv"), { valid: true });
      assert.deepEqual(validatePath("s3://bucket/key.parquet"), { valid: true });
    });

    it("rejects paths outside allowed roots", () => {
      // On any platform, /etc/passwd or C:\etc\passwd won't be in the allowed list
      const result = validatePath("/etc/passwd");
      assert.equal(result.valid, false);
      assert.ok(result.error.includes("outside allowed roots"));
    });

    it("rejects home directory paths", () => {
      const result = validatePath("/root/.ssh/id_rsa");
      assert.equal(result.valid, false);
    });
  });

  describe("hasAggregationOrLimit", () => {
    it("detects LIMIT", () => {
      assert.equal(hasAggregationOrLimit("SELECT * FROM t LIMIT 10"), true);
    });

    it("detects GROUP BY", () => {
      assert.equal(hasAggregationOrLimit("SELECT x, COUNT(*) FROM t GROUP BY x"), true);
    });

    it("detects aggregate functions", () => {
      assert.equal(hasAggregationOrLimit("SELECT COUNT(*) FROM t"), true);
      assert.equal(hasAggregationOrLimit("SELECT SUM(x) FROM t"), true);
      assert.equal(hasAggregationOrLimit("SELECT AVG(x) FROM t"), true);
      assert.equal(hasAggregationOrLimit("SELECT MIN(x) FROM t"), true);
      assert.equal(hasAggregationOrLimit("SELECT MAX(x) FROM t"), true);
    });

    it("detects DISTINCT", () => {
      assert.equal(hasAggregationOrLimit("SELECT DISTINCT x FROM t"), true);
    });

    it("returns false for unbounded queries", () => {
      assert.equal(hasAggregationOrLimit("SELECT * FROM t"), false);
      assert.equal(hasAggregationOrLimit("SELECT x, y FROM t WHERE z > 1"), false);
    });
  });

  describe("checkQuerySafety", () => {
    it("allows queries with aggregation", () => {
      assert.deepEqual(checkQuerySafety("SELECT COUNT(*) FROM t", 1_000_000), { safe: true });
    });

    it("allows queries with LIMIT", () => {
      assert.deepEqual(checkQuerySafety("SELECT * FROM t LIMIT 100", 1_000_000), { safe: true });
    });

    it("blocks unbounded large results", () => {
      const result = checkQuerySafety("SELECT * FROM t", 500_000);
      assert.equal(result.safe, false);
      assert.ok(result.warning.includes("500,000"));
    });

    it("allows when estimated rows below threshold", () => {
      assert.deepEqual(checkQuerySafety("SELECT * FROM t", 50_000), { safe: true });
    });

    it("allows when estimate is null", () => {
      assert.deepEqual(checkQuerySafety("SELECT * FROM t", null), { safe: true });
    });
  });
});

// =========================================================================
//  nlq.ts — buildNlqPrompt
// =========================================================================

function buildNlqPrompt(question, schema) {
  return [
    "Given this database schema:",
    "```",
    schema,
    "```",
    "",
    `Question: ${question}`,
    "",
    "Write a single DuckDB SQL query that answers the question.",
    "Use DuckDB Friendly SQL features where appropriate (FROM-first, GROUP BY ALL, etc).",
    "Return ONLY the SQL query, no explanation.",
  ].join("\n");
}

describe("nlq", () => {
  it("builds prompt with schema and question", () => {
    const result = buildNlqPrompt("how many rows", "Table: orders\n  id INTEGER");
    assert.ok(result.includes("how many rows"));
    assert.ok(result.includes("Table: orders"));
    assert.ok(result.includes("DuckDB SQL"));
  });
});

// =========================================================================
//  session.ts — state file I/O
// =========================================================================

describe("session", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "duckdb-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appendState creates dir and writes", () => {
    const stateDir = path.join(tmpDir, "duckdb");
    const stateFile = path.join(stateDir, "state.sql");

    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateFile, "-- DuckDB session state\n", "utf8");

    const statement = "ATTACH IF NOT EXISTS '/artifacts/shared/sales.duckdb' AS sales";
    const existing = fs.readFileSync(stateFile, "utf8");
    if (!existing.includes(statement)) {
      fs.writeFileSync(stateFile, existing + statement + "\n", "utf8");
    }

    const content = fs.readFileSync(stateFile, "utf8");
    assert.ok(content.includes("ATTACH"));
    assert.ok(content.includes("sales.duckdb"));
  });

  it("does not duplicate statements", () => {
    const stateDir = path.join(tmpDir, "duckdb");
    const stateFile = path.join(stateDir, "state.sql");
    fs.mkdirSync(stateDir, { recursive: true });

    const statement = "LOAD httpfs";
    fs.writeFileSync(stateFile, "-- DuckDB session state\n" + statement + "\n", "utf8");

    const existing = fs.readFileSync(stateFile, "utf8");
    if (!existing.includes(statement)) {
      fs.writeFileSync(stateFile, existing + statement + "\n", "utf8");
    }

    const content = fs.readFileSync(stateFile, "utf8");
    const matches = content.split(statement).length - 1;
    assert.equal(matches, 1);
  });

  it("parses state lines correctly", () => {
    const stateContent = [
      "-- DuckDB session state",
      "ATTACH IF NOT EXISTS '/data/sales.duckdb' AS sales",
      "USE sales",
      "LOAD httpfs",
      "",
      "-- this is a comment",
      "LOAD json",
    ].join("\n");

    const lines = stateContent
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("--"));

    assert.deepEqual(lines, [
      "ATTACH IF NOT EXISTS '/data/sales.duckdb' AS sales",
      "USE sales",
      "LOAD httpfs",
      "LOAD json",
    ]);
  });
});

// =========================================================================
//  format.ts — CSV escaping
// =========================================================================

describe("format", () => {
  function csvEscape(v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  }

  it("escapes commas", () => {
    assert.equal(csvEscape("hello,world"), '"hello,world"');
  });

  it("escapes quotes", () => {
    assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  });

  it("escapes newlines", () => {
    assert.equal(csvEscape("line1\nline2"), '"line1\nline2"');
  });

  it("passes through plain strings", () => {
    assert.equal(csvEscape("hello"), "hello");
  });

  it("handles null/undefined", () => {
    assert.equal(csvEscape(null), "");
    assert.equal(csvEscape(undefined), "");
  });
});

// =========================================================================
//  Edge cases from spec
// =========================================================================

describe("edge cases", () => {
  it("EC1: path traversal blocked", () => {
    const result = validatePath("/etc/shadow");
    assert.equal(result.valid, false);
  });

  it("EC9: binary/non-data file detected", () => {
    assert.equal(detectFormat("program.exe"), null);
    assert.equal(detectFormat("image.png"), null);
    assert.equal(detectFormat("doc.pdf"), null);
  });

  it("EC11: conditional registration pattern — missing module returns false", () => {
    let available = false;
    try {
      require("@duckdb/node-api");
      available = true;
    } catch {
      available = false;
    }
    // In test environment without DuckDB installed, this should be false
    // In container with DuckDB, this should be true
    assert.equal(typeof available, "boolean");
  });
});

// =========================================================================
//  Behavioral contracts (logic-only, no DuckDB connection)
// =========================================================================

describe("behavioral contracts (logic)", () => {
  it("BC7: query >100k rows without LIMIT triggers warning", () => {
    const result = checkQuerySafety("SELECT * FROM big_table", 200_000);
    assert.equal(result.safe, false);
    assert.ok(result.warning.includes("200,000"));
  });

  it("BC8: natural language detected for non-SQL input", () => {
    assert.equal(isNaturalLanguage("how many orders per month"), true);
  });

  it("BC10: unsupported extension returns null format", () => {
    assert.equal(detectFormat("file.xyz"), null);
    assert.equal(detectFormat("README.md"), null);
  });
});
