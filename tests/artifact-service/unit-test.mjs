// Run: node --test tests/artifact-service/unit-test.mjs

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// We can't import TypeScript directly, so we re-implement the pure logic from
// uri.ts, rbac.ts, and route validation inline. This verifies the algorithms
// and schema contracts without needing a TypeScript runtime.

// ===========================================================================
// URI functions — re-implemented from src/artifact-service/uri.ts
// ===========================================================================

function buildUri(record) {
  const runSegment = record.run_id ?? "no-run";
  return `artifact://${record.company_id}/${record.project_id}/${runSegment}/${record.agent_name}/${record.artifact_type}/${record.id}_${record.filename}`;
}

function parseUri(uri) {
  const PREFIX = "artifact://";
  if (!uri.startsWith(PREFIX)) {
    throw new Error(
      `Malformed artifact URI: missing "artifact://" prefix — got "${uri}"`,
    );
  }

  const body = uri.slice(PREFIX.length);
  const parts = body.split("/");

  if (parts.length !== 6) {
    throw new Error(
      `Malformed artifact URI: expected 6 path segments, got ${parts.length} — "${uri}"`,
    );
  }

  const [company_id, project_id, runSegment, agent_name, artifact_type, idFilename] = parts;

  const underscoreIdx = idFilename.indexOf("_");
  if (underscoreIdx === -1) {
    throw new Error(
      `Malformed artifact URI: final segment must be "{id}_{filename}" — got "${idFilename}"`,
    );
  }

  const id = idFilename.slice(0, underscoreIdx);
  const filename = idFilename.slice(underscoreIdx + 1);

  if (!id || !filename) {
    throw new Error(
      `Malformed artifact URI: id and filename must be non-empty — got "${idFilename}"`,
    );
  }

  return {
    company_id,
    project_id,
    run_id: runSegment === "no-run" ? null : runSegment,
    agent_name,
    artifact_type,
    id,
    filename,
  };
}

// ===========================================================================
// RBAC functions — re-implemented from src/artifact-service/rbac.ts
// ===========================================================================

function globMatch(pattern, value) {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i += 2;
      // skip trailing slash after ** if present
      if (pattern[i] === "/") i++;
    } else if (ch === "*") {
      re += "[^/]*";
      i++;
    } else if (ch === "?") {
      re += ".";
      i++;
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      re += `\\${ch}`;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return new RegExp(`^${re}$`).test(value);
}

function matchAny(rules, agentName, action, s3Key) {
  const agent = rules.agents[agentName];
  if (!agent) return false;

  const patterns = agent[action];
  if (!patterns || patterns.length === 0) return false;

  return patterns.some((pattern) => globMatch(pattern, s3Key));
}

function canRead(rules, agentName, s3Key) {
  return matchAny(rules, agentName, "read", s3Key);
}

function canWrite(rules, agentName, s3Key) {
  return matchAny(rules, agentName, "write", s3Key);
}

// ===========================================================================
// Route validation — re-implemented from src/artifact-service/routes.ts
// ===========================================================================

function validateWriteBody(body) {
  const errors = [];
  if (!body.filename) errors.push("filename");
  if (!body.content) errors.push("content");
  if (!body.type) errors.push("type");
  if (errors.length > 0) {
    return { valid: false, error: `missing required fields: ${errors.join(", ")}` };
  }
  return { valid: true, error: null };
}

function validateUpdateBody(body) {
  if (!body.metadata || typeof body.metadata !== "object") {
    return { valid: false, error: "body must contain a metadata object" };
  }
  return { valid: true, error: null };
}

function parseMetadataParam(raw) {
  try {
    return { parsed: JSON.parse(raw), error: null };
  } catch {
    return { parsed: null, error: "metadata param must be valid JSON" };
  }
}

function extractIdFromPath(pathname) {
  const segments = pathname.split("/").filter(Boolean);
  return segments[segments.length - 1] || null;
}

// ===========================================================================
// Test data helpers
// ===========================================================================

function makeRecord(overrides = {}) {
  return {
    id: "01HXYZ1234ABCDEF56789012",
    filename: "report.pdf",
    artifact_type: "report",
    agent_name: "researcher",
    run_id: "run-42",
    company_id: "acme",
    project_id: "proj-1",
    bucket: "artifacts",
    s3_key: "acme/proj-1/run-42/researcher/report/01HXYZ1234ABCDEF56789012_report.pdf",
    content_hash: "abc123",
    size_bytes: 1024,
    metadata: {},
    created_at: new Date(),
    mime_type: "application/pdf",
    ...overrides,
  };
}

// ===========================================================================
// URI — buildUri
// ===========================================================================

describe("URI — buildUri", () => {
  it("builds correct URI with all fields", () => {
    const record = makeRecord();
    const uri = buildUri(record);
    assert.equal(
      uri,
      "artifact://acme/proj-1/run-42/researcher/report/01HXYZ1234ABCDEF56789012_report.pdf",
    );
  });

  it("uses 'no-run' when run_id is null", () => {
    const record = makeRecord({ run_id: null });
    const uri = buildUri(record);
    assert.match(uri, /\/no-run\//);
    assert.equal(
      uri,
      "artifact://acme/proj-1/no-run/researcher/report/01HXYZ1234ABCDEF56789012_report.pdf",
    );
  });

  it("uses 'no-run' when run_id is undefined", () => {
    const record = makeRecord({ run_id: undefined });
    const uri = buildUri(record);
    assert.match(uri, /\/no-run\//);
  });

  it("handles special characters in filename", () => {
    const record = makeRecord({ filename: "my report (final).pdf" });
    const uri = buildUri(record);
    assert.ok(uri.endsWith("01HXYZ1234ABCDEF56789012_my report (final).pdf"));
  });
});

// ===========================================================================
// URI — parseUri
// ===========================================================================

describe("URI — parseUri", () => {
  it("parses well-formed URI into components", () => {
    const uri = "artifact://acme/proj-1/run-42/researcher/report/01HX_report.pdf";
    const parsed = parseUri(uri);
    assert.equal(parsed.company_id, "acme");
    assert.equal(parsed.project_id, "proj-1");
    assert.equal(parsed.run_id, "run-42");
    assert.equal(parsed.agent_name, "researcher");
    assert.equal(parsed.artifact_type, "report");
    assert.equal(parsed.id, "01HX");
    assert.equal(parsed.filename, "report.pdf");
  });

  it("returns null run_id when segment is 'no-run'", () => {
    const uri = "artifact://acme/proj-1/no-run/researcher/report/01HX_report.pdf";
    const parsed = parseUri(uri);
    assert.equal(parsed.run_id, null);
  });

  it("round-trips with buildUri", () => {
    const record = makeRecord();
    const uri = buildUri(record);
    const parsed = parseUri(uri);
    assert.equal(parsed.company_id, record.company_id);
    assert.equal(parsed.project_id, record.project_id);
    assert.equal(parsed.run_id, record.run_id);
    assert.equal(parsed.agent_name, record.agent_name);
    assert.equal(parsed.artifact_type, record.artifact_type);
    assert.equal(parsed.id, record.id);
    assert.equal(parsed.filename, record.filename);
  });

  it("throws on missing artifact:// prefix", () => {
    assert.throws(
      () => parseUri("http://acme/proj/run/agent/type/id_file"),
      /missing "artifact:\/\/" prefix/,
    );
  });

  it("throws on wrong number of segments", () => {
    assert.throws(
      () => parseUri("artifact://acme/proj/run/agent/type"),
      /expected 6 path segments/,
    );
    assert.throws(
      () => parseUri("artifact://acme/proj/run/agent/type/id_file/extra"),
      /expected 6 path segments/,
    );
  });

  it("throws on missing underscore in id_filename", () => {
    assert.throws(
      () => parseUri("artifact://acme/proj/run/agent/type/nounderscorehere"),
      /final segment must be/,
    );
  });

  it("throws on empty id", () => {
    assert.throws(
      () => parseUri("artifact://acme/proj/run/agent/type/_filename.txt"),
      /id and filename must be non-empty/,
    );
  });

  it("throws on empty filename", () => {
    assert.throws(
      () => parseUri("artifact://acme/proj/run/agent/type/someid_"),
      /id and filename must be non-empty/,
    );
  });
});

// ===========================================================================
// RBAC — globMatch
// ===========================================================================

describe("RBAC — globMatch", () => {
  it("matches ** against any path", () => {
    assert.ok(globMatch("**", "a/b/c/d/e"));
    assert.ok(globMatch("**", ""));
    assert.ok(globMatch("**", "single"));
  });

  it("matches * within single segment only", () => {
    assert.ok(globMatch("*", "anything"));
    assert.ok(globMatch("a/*/c", "a/b/c"));
    assert.ok(globMatch("a/*/c", "a/xyz/c"));
  });

  it("does not match * across path separator", () => {
    assert.ok(!globMatch("*", "a/b"));
    assert.ok(!globMatch("a/*/c", "a/b/d/c"));
  });

  it("matches exact path", () => {
    assert.ok(globMatch("a/b/c", "a/b/c"));
    assert.ok(!globMatch("a/b/c", "a/b/d"));
  });

  it("matches pattern with multiple wildcards", () => {
    assert.ok(globMatch("*/*/*/*/*/**", "acme/proj/run/agent/type/file.txt"));
    assert.ok(globMatch("*/*/no-run/*/*/**", "acme/proj/no-run/ceo/report/id_f.pdf"));
  });

  it("rejects non-matching pattern", () => {
    assert.ok(!globMatch("a/b/c", "x/y/z"));
    assert.ok(!globMatch("acme/*", "other/proj"));
  });

  it("handles trailing ** after slash", () => {
    assert.ok(globMatch("a/b/**", "a/b/c/d/e"));
    assert.ok(globMatch("a/b/**", "a/b/c"));
    assert.ok(globMatch("a/b/**", "a/b/"));
  });

  it("matches ? as single character", () => {
    assert.ok(globMatch("a?c", "abc"));
    assert.ok(!globMatch("a?c", "abbc"));
  });

  it("escapes regex special characters", () => {
    assert.ok(globMatch("file.txt", "file.txt"));
    assert.ok(!globMatch("file.txt", "filextxt"));
  });
});

// ===========================================================================
// RBAC — canRead / canWrite
// ===========================================================================

describe("RBAC — canRead/canWrite", () => {
  // Key structure: company/project/run/agent/type/id_filename
  // Pattern wildcards: */*/*/agent/** matches 3 segments before agent name
  const rules = {
    agents: {
      ceo: {
        read: ["**"],
        write: ["*/*/*/ceo/**"],
      },
      researcher: {
        read: ["*/*/*/researcher/**", "*/*/*/data/**"],
        write: ["*/*/*/researcher/**"],
      },
      data: {
        read: ["*/*/*/data/**", "*/*/*/researcher/**"],
        write: ["*/*/*/data/**"],
      },
      writer: {
        read: ["*/*/*/writer/**", "*/*/*/researcher/**", "*/*/*/data/**"],
        write: ["*/*/*/writer/**"],
      },
    },
  };

  const researcherKey = "acme/proj/run-1/researcher/report/01HX_report.pdf";
  const dataKey = "acme/proj/run-1/data/dataset/01HY_data.csv";
  const ceoKey = "acme/proj/run-1/ceo/memo/01HZ_memo.md";
  const writerKey = "acme/proj/run-1/writer/draft/01HW_draft.md";

  it("ceo can read any path", () => {
    assert.ok(canRead(rules, "ceo", researcherKey));
    assert.ok(canRead(rules, "ceo", dataKey));
    assert.ok(canRead(rules, "ceo", ceoKey));
    assert.ok(canRead(rules, "ceo", writerKey));
  });

  it("ceo can only write to own namespace", () => {
    assert.ok(canWrite(rules, "ceo", ceoKey));
  });

  it("ceo cannot write to researcher namespace", () => {
    assert.ok(!canWrite(rules, "ceo", researcherKey));
  });

  it("researcher can read own artifacts", () => {
    assert.ok(canRead(rules, "researcher", researcherKey));
  });

  it("researcher can read data artifacts", () => {
    assert.ok(canRead(rules, "researcher", dataKey));
  });

  it("researcher cannot read writer artifacts", () => {
    assert.ok(!canRead(rules, "researcher", writerKey));
  });

  it("researcher can write to own namespace", () => {
    assert.ok(canWrite(rules, "researcher", researcherKey));
  });

  it("researcher cannot write to data namespace", () => {
    assert.ok(!canWrite(rules, "researcher", dataKey));
  });

  it("writer can read researcher and data but not ceo", () => {
    assert.ok(canRead(rules, "writer", researcherKey));
    assert.ok(canRead(rules, "writer", dataKey));
    assert.ok(!canRead(rules, "writer", ceoKey));
  });

  it("unknown agent is denied by default", () => {
    assert.ok(!canRead(rules, "phantom", researcherKey));
    assert.ok(!canWrite(rules, "phantom", researcherKey));
  });
});

// ===========================================================================
// Route validation
// ===========================================================================

describe("Route validation", () => {
  it("write rejects missing filename", () => {
    const result = validateWriteBody({ content: "abc", type: "report" });
    assert.equal(result.valid, false);
    assert.match(result.error, /filename/);
  });

  it("write rejects missing content", () => {
    const result = validateWriteBody({ filename: "f.txt", type: "report" });
    assert.equal(result.valid, false);
    assert.match(result.error, /content/);
  });

  it("write rejects missing type", () => {
    const result = validateWriteBody({ filename: "f.txt", content: "abc" });
    assert.equal(result.valid, false);
    assert.match(result.error, /type/);
  });

  it("write accepts valid request with all required fields", () => {
    const result = validateWriteBody({
      filename: "f.txt",
      content: "abc",
      type: "report",
    });
    assert.equal(result.valid, true);
    assert.equal(result.error, null);
  });

  it("write rejects empty body", () => {
    const result = validateWriteBody({});
    assert.equal(result.valid, false);
    assert.match(result.error, /filename/);
    assert.match(result.error, /content/);
    assert.match(result.error, /type/);
  });

  it("update rejects missing metadata", () => {
    const result = validateUpdateBody({});
    assert.equal(result.valid, false);
    assert.match(result.error, /metadata/);
  });

  it("update rejects non-object metadata", () => {
    const result = validateUpdateBody({ metadata: "not-an-object" });
    assert.equal(result.valid, false);
    assert.match(result.error, /metadata/);
  });

  it("update accepts valid metadata object", () => {
    const result = validateUpdateBody({ metadata: { tag: "final" } });
    assert.equal(result.valid, true);
  });

  it("list parses metadata query param as JSON", () => {
    const input = '{"status":"reviewed"}';
    const { parsed, error } = parseMetadataParam(input);
    assert.equal(error, null);
    assert.deepEqual(parsed, { status: "reviewed" });
  });

  it("list rejects invalid metadata JSON", () => {
    const { parsed, error } = parseMetadataParam("{bad json");
    assert.equal(parsed, null);
    assert.match(error, /valid JSON/);
  });

  it("extractIdFromPath returns last segment", () => {
    assert.equal(extractIdFromPath("/artifacts/01HXYZ"), "01HXYZ");
    assert.equal(extractIdFromPath("/api/v1/artifacts/01HXYZ"), "01HXYZ");
  });

  it("extractIdFromPath returns null for empty path", () => {
    assert.equal(extractIdFromPath("/"), null);
  });
});
