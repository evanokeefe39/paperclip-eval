import { describe, it } from "node:test";
import assert from "node:assert/strict";

// We can't import TypeScript directly, so we replicate the validation logic
// from src/agents/data/.pi/agent/extensions/workproduct.ts inline. This mirrors
// the approach used in tests/findings/unit-test.mjs.

// ---------------------------------------------------------------------------
// Replicated KIND_PROFILES (must stay in sync with workproduct.ts)
// ---------------------------------------------------------------------------
const KIND_PROFILES = {
  sourceRequired: { dataset_ref: [], query_result: [], metric: [], chart: [] },
  sourceEncouraged: { dataset_ref: [], query_result: [], metric: [], chart: [] },
  recordEncouraged: {
    dataset_ref: ["row_count_estimate", "caveats", "topic_tags"],
    query_result: ["duration_ms", "source_dataset_refs", "topic_tags"],
    metric: ["unit", "window", "confidence", "topic_tags"],
    chart: ["title", "dimensions", "measures", "caveats"],
  },
};

const DATA_KINDS = ["dataset_ref", "query_result", "metric", "chart"];

function validateByStyle(profiles, style, sources, record) {
  const errors = [];
  const warnings = [];
  const srcRequired = profiles.sourceRequired[style] || [];
  const srcEncouraged = profiles.sourceEncouraged[style] || [];
  const recEncouraged = profiles.recordEncouraged[style] || [];

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    for (const field of srcRequired) {
      const val = src[field];
      if (val === undefined || val === null || val === "") {
        errors.push(`sources[${i}].${field} is required for style '${style}'`);
      }
    }
    for (const field of srcEncouraged) {
      const val = src[field];
      if (val === undefined || val === null || val === "") {
        warnings.push(`sources[${i}].${field} is recommended for style '${style}'`);
      }
    }
  }

  for (const field of recEncouraged) {
    const val = record[field];
    if (val === undefined || val === null || val === "") {
      warnings.push(`${field} is recommended for style '${style}'`);
    }
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Replicated conditional rules from record_dataset_ref
// ---------------------------------------------------------------------------
function validateDatasetRef(params) {
  const errors = [];
  const { source, table, path, as_of } = params;
  if (!source) errors.push("source is required");
  if (!as_of) errors.push("as_of is required");
  if (["postgres", "duckdb", "tinybird"].includes(source) && !table) {
    errors.push(`source '${source}' requires 'table'`);
  }
  if (["parquet", "csv", "s3"].includes(source) && !path) {
    errors.push(`source '${source}' requires 'path'`);
  }
  const { warnings } = validateByStyle(KIND_PROFILES, "dataset_ref", [], params);
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Replicated rules from record_query_result
// ---------------------------------------------------------------------------
function validateQueryResult(params) {
  const errors = [];
  const required = ["sql", "engine", "row_count", "materialized_at", "columns"];
  for (const f of required) {
    const v = params[f];
    if (v === undefined || v === null || v === "") errors.push(`${f} is required`);
  }
  if (Array.isArray(params.rows_inline) && params.rows_inline.length > 100) {
    errors.push("rows_inline exceeds 100 rows — write to artifact and pass result_artifact_ref");
  }
  const body = JSON.stringify({
    sql: params.sql,
    columns: params.columns,
    rows_inline: params.rows_inline ?? null,
    result_artifact_ref: params.result_artifact_ref ?? null,
  });
  if (Buffer.byteLength(body, "utf8") > 1_000_000) {
    errors.push("query_result content exceeds 1MB");
  }
  const { warnings } = validateByStyle(KIND_PROFILES, "query_result", [], params);
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Replicated rules from record_metric
// ---------------------------------------------------------------------------
function validateMetric(params) {
  const errors = [];
  const required = ["name", "value", "source_query_ref"];
  for (const f of required) {
    const v = params[f];
    if (v === undefined || v === null || v === "") errors.push(`${f} is required`);
  }
  const { warnings } = validateByStyle(KIND_PROFILES, "metric", [], params);
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Replicated rules from record_chart
// ---------------------------------------------------------------------------
function validateChart(params) {
  const errors = [];
  const required = ["chart_type", "data_ref", "spec"];
  for (const f of required) {
    const v = params[f];
    if (v === undefined || v === null || v === "") errors.push(`${f} is required`);
  }
  const { warnings } = validateByStyle(KIND_PROFILES, "chart", [], params);
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Mock client.list + query_data_products kind dispatch
// ---------------------------------------------------------------------------
function makeMockClient(records) {
  const calls = [];
  return {
    calls,
    async list(filters) {
      calls.push(filters);
      return records.filter((r) => {
        if (filters.type && r.artifact_type !== filters.type) return false;
        if (filters.agent && r.agent_name !== filters.agent) return false;
        if (filters.bucket && r.bucket !== filters.bucket) return false;
        return true;
      });
    },
  };
}

async function queryDataProducts(client, params) {
  const agent = params.agent ?? "data";
  const limit = params.limit ?? 50;
  const baseFilters = { agent, bucket: "artifacts", since: params.since };

  let records;
  if (params.kind) {
    records = await client.list({ ...baseFilters, type: params.kind });
  } else {
    const lists = await Promise.all(
      DATA_KINDS.map((k) => client.list({ ...baseFilters, type: k })),
    );
    records = lists.flat();
  }

  let filtered = records;
  if (params.topic_tag) {
    const needle = params.topic_tag.toLowerCase();
    filtered = filtered.filter((r) => {
      const tags = (r.metadata?.topic_tags ?? []);
      return Array.isArray(tags) && tags.some((t) => typeof t === "string" && t.toLowerCase().includes(needle));
    });
  }
  if (params.entity) {
    const needle = params.entity.toLowerCase();
    filtered = filtered.filter((r) => {
      const ents = (r.metadata?.entities ?? []);
      return Array.isArray(ents) && ents.some((e) => typeof e === "string" && e.toLowerCase().includes(needle));
    });
  }

  filtered.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return filtered.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("record_dataset_ref", () => {
  it("requires source and as_of", () => {
    const { errors } = validateDatasetRef({});
    assert.ok(errors.some((e) => e.includes("source")));
    assert.ok(errors.some((e) => e.includes("as_of")));
  });

  it("requires table for postgres source", () => {
    const { errors } = validateDatasetRef({ source: "postgres", as_of: "2026-05-28T00:00:00Z" });
    assert.ok(errors.some((e) => e.includes("requires 'table'")));
  });

  it("requires table for duckdb source", () => {
    const { errors } = validateDatasetRef({ source: "duckdb", as_of: "2026-05-28T00:00:00Z" });
    assert.ok(errors.some((e) => e.includes("requires 'table'")));
  });

  it("requires table for tinybird source", () => {
    const { errors } = validateDatasetRef({ source: "tinybird", as_of: "2026-05-28T00:00:00Z" });
    assert.ok(errors.some((e) => e.includes("requires 'table'")));
  });

  it("requires path for parquet source", () => {
    const { errors } = validateDatasetRef({ source: "parquet", as_of: "2026-05-28T00:00:00Z" });
    assert.ok(errors.some((e) => e.includes("requires 'path'")));
  });

  it("requires path for csv source", () => {
    const { errors } = validateDatasetRef({ source: "csv", as_of: "2026-05-28T00:00:00Z" });
    assert.ok(errors.some((e) => e.includes("requires 'path'")));
  });

  it("requires path for s3 source", () => {
    const { errors } = validateDatasetRef({ source: "s3", as_of: "2026-05-28T00:00:00Z" });
    assert.ok(errors.some((e) => e.includes("requires 'path'")));
  });

  it("api source does not require table or path", () => {
    const { errors } = validateDatasetRef({ source: "api", as_of: "2026-05-28T00:00:00Z" });
    assert.equal(errors.length, 0, `unexpected errors: ${errors.join(", ")}`);
  });

  it("postgres with table passes hard validation", () => {
    const { errors } = validateDatasetRef({
      source: "postgres",
      table: "public.orders",
      as_of: "2026-05-28T00:00:00Z",
    });
    assert.equal(errors.length, 0);
  });

  it("warns on missing encouraged fields", () => {
    const { errors, warnings } = validateDatasetRef({
      source: "postgres",
      table: "public.orders",
      as_of: "2026-05-28T00:00:00Z",
    });
    assert.equal(errors.length, 0);
    assert.ok(warnings.some((w) => w.includes("row_count_estimate")));
    assert.ok(warnings.some((w) => w.includes("caveats")));
    assert.ok(warnings.some((w) => w.includes("topic_tags")));
  });
});

describe("record_query_result", () => {
  const validBase = {
    sql: "SELECT 1",
    engine: "duckdb",
    row_count: 1,
    materialized_at: "2026-05-28T00:00:00Z",
    columns: [{ name: "x", type: "INTEGER" }],
  };

  it("rejects rows_inline.length > 100", () => {
    const rows = Array.from({ length: 101 }, (_, i) => ({ x: i }));
    const { errors } = validateQueryResult({ ...validBase, row_count: 101, rows_inline: rows });
    assert.ok(errors.some((e) => e.includes("exceeds 100 rows")));
  });

  it("accepts rows_inline.length == 100", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ x: i }));
    const { errors } = validateQueryResult({ ...validBase, row_count: 100, rows_inline: rows });
    assert.equal(errors.length, 0);
  });

  it("requires sql, engine, row_count, materialized_at, columns", () => {
    const { errors } = validateQueryResult({});
    assert.ok(errors.some((e) => e.includes("sql")));
    assert.ok(errors.some((e) => e.includes("engine")));
    assert.ok(errors.some((e) => e.includes("materialized_at")));
    assert.ok(errors.some((e) => e.includes("columns")));
  });

  it("warns on missing encouraged fields", () => {
    const { warnings } = validateQueryResult(validBase);
    assert.ok(warnings.some((w) => w.includes("duration_ms")));
    assert.ok(warnings.some((w) => w.includes("source_dataset_refs")));
    assert.ok(warnings.some((w) => w.includes("topic_tags")));
  });
});

describe("record_metric", () => {
  it("requires source_query_ref", () => {
    const { errors } = validateMetric({ name: "active_users", value: 1234 });
    assert.ok(errors.some((e) => e.includes("source_query_ref")));
  });

  it("requires name and value", () => {
    const { errors } = validateMetric({ source_query_ref: "01JABC" });
    assert.ok(errors.some((e) => e.includes("name")));
    assert.ok(errors.some((e) => e.includes("value")));
  });

  it("accepts numeric value", () => {
    const { errors } = validateMetric({
      name: "active_users",
      value: 1234,
      source_query_ref: "01JABC",
    });
    assert.equal(errors.length, 0);
  });

  it("accepts string value", () => {
    const { errors } = validateMetric({
      name: "status",
      value: "green",
      source_query_ref: "01JABC",
    });
    assert.equal(errors.length, 0);
  });

  it("warns on missing encouraged fields", () => {
    const { warnings } = validateMetric({
      name: "x",
      value: 1,
      source_query_ref: "01JABC",
    });
    assert.ok(warnings.some((w) => w.includes("unit")));
    assert.ok(warnings.some((w) => w.includes("window")));
    assert.ok(warnings.some((w) => w.includes("confidence")));
  });
});

describe("record_chart", () => {
  it("requires chart_type, data_ref, spec", () => {
    const { errors } = validateChart({});
    assert.ok(errors.some((e) => e.includes("chart_type")));
    assert.ok(errors.some((e) => e.includes("data_ref")));
    assert.ok(errors.some((e) => e.includes("spec")));
  });

  it("accepts minimal valid chart", () => {
    const { errors } = validateChart({
      chart_type: "line",
      data_ref: "01JABC",
      spec: { mark: "line" },
    });
    assert.equal(errors.length, 0);
  });

  it("warns on missing encouraged fields", () => {
    const { warnings } = validateChart({
      chart_type: "bar",
      data_ref: "01JABC",
      spec: {},
    });
    assert.ok(warnings.some((w) => w.includes("title")));
    assert.ok(warnings.some((w) => w.includes("dimensions")));
    assert.ok(warnings.some((w) => w.includes("measures")));
    assert.ok(warnings.some((w) => w.includes("caveats")));
  });
});

describe("query_data_products kind filter", () => {
  const sampleRecords = [
    {
      id: "01METRIC1", artifact_type: "metric", agent_name: "data", bucket: "artifacts",
      filename: "metric_x.json", created_at: "2026-05-28T10:00:00Z",
      metadata: { name: "x", topic_tags: ["revenue"], entities: ["acme"] },
    },
    {
      id: "01QUERY1", artifact_type: "query_result", agent_name: "data", bucket: "artifacts",
      filename: "query_result.json", created_at: "2026-05-28T11:00:00Z",
      metadata: { topic_tags: ["churn"] },
    },
    {
      id: "01DATASET1", artifact_type: "dataset_ref", agent_name: "data", bucket: "artifacts",
      filename: "dataset_ref.json", created_at: "2026-05-28T09:00:00Z",
      metadata: { table: "public.orders", topic_tags: ["revenue"] },
    },
    {
      id: "01CHART1", artifact_type: "chart", agent_name: "data", bucket: "artifacts",
      filename: "chart.json", created_at: "2026-05-28T12:00:00Z",
      metadata: { title: "Revenue", topic_tags: ["revenue"] },
    },
  ];

  it("issues a single list call when kind is specified", async () => {
    const mock = makeMockClient(sampleRecords);
    const out = await queryDataProducts(mock, { kind: "metric" });
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].type, "metric");
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "01METRIC1");
  });

  it("issues four parallel list calls when kind is omitted", async () => {
    const mock = makeMockClient(sampleRecords);
    const out = await queryDataProducts(mock, {});
    assert.equal(mock.calls.length, 4);
    const types = mock.calls.map((c) => c.type).sort();
    assert.deepEqual(types, ["chart", "dataset_ref", "metric", "query_result"]);
    assert.equal(out.length, 4);
  });

  it("sorts results by created_at descending", async () => {
    const mock = makeMockClient(sampleRecords);
    const out = await queryDataProducts(mock, {});
    assert.equal(out[0].id, "01CHART1");
    assert.equal(out[out.length - 1].id, "01DATASET1");
  });

  it("applies topic_tag substring filter post-list", async () => {
    const mock = makeMockClient(sampleRecords);
    const out = await queryDataProducts(mock, { topic_tag: "revenue" });
    const ids = out.map((r) => r.id).sort();
    assert.deepEqual(ids, ["01CHART1", "01DATASET1", "01METRIC1"]);
  });

  it("applies entity substring filter post-list", async () => {
    const mock = makeMockClient(sampleRecords);
    const out = await queryDataProducts(mock, { entity: "acme" });
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "01METRIC1");
  });

  it("respects limit", async () => {
    const mock = makeMockClient(sampleRecords);
    const out = await queryDataProducts(mock, { limit: 2 });
    assert.equal(out.length, 2);
  });

  it("returns empty array when no records match", async () => {
    const mock = makeMockClient([]);
    const out = await queryDataProducts(mock, { kind: "metric" });
    assert.equal(out.length, 0);
  });
});

describe("validateByStyle warning population", () => {
  it("populates warnings for all dataset_ref encouraged fields when absent", () => {
    const { warnings } = validateByStyle(KIND_PROFILES, "dataset_ref", [], {});
    assert.equal(warnings.length, 3);
  });

  it("populates warnings for all query_result encouraged fields when absent", () => {
    const { warnings } = validateByStyle(KIND_PROFILES, "query_result", [], {});
    assert.equal(warnings.length, 3);
  });

  it("populates warnings for all metric encouraged fields when absent", () => {
    const { warnings } = validateByStyle(KIND_PROFILES, "metric", [], {});
    assert.equal(warnings.length, 4);
  });

  it("populates warnings for all chart encouraged fields when absent", () => {
    const { warnings } = validateByStyle(KIND_PROFILES, "chart", [], {});
    assert.equal(warnings.length, 4);
  });

  it("does not warn when encouraged fields are present", () => {
    const { warnings } = validateByStyle(KIND_PROFILES, "metric", [], {
      unit: "users",
      window: "2026-05",
      confidence: "high",
      topic_tags: ["x"],
    });
    assert.equal(warnings.length, 0);
  });

  it("produces no source-level errors (data work products carry no sources)", () => {
    const { errors } = validateByStyle(KIND_PROFILES, "dataset_ref", [{}], {});
    assert.equal(errors.length, 0);
  });
});
