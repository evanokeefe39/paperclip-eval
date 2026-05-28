import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as client from "./artifact-client.js";
import { validateByStyle, type StyleProfiles } from "./workproduct-lib/validate.js";
import { ArtifactRef, ISODate } from "./workproduct-lib/schemas.js";

// ---------------------------------------------------------------------------
// Validation profiles — each "kind" of data work product is treated as a
// style so we can reuse validateByStyle. No source-level rules because data
// work products carry no sources array.
// ---------------------------------------------------------------------------
const KIND_PROFILES: StyleProfiles = {
  sourceRequired: { dataset_ref: [], query_result: [], metric: [], chart: [] },
  sourceEncouraged: { dataset_ref: [], query_result: [], metric: [], chart: [] },
  recordEncouraged: {
    dataset_ref: ["row_count_estimate", "caveats", "topic_tags"],
    query_result: ["duration_ms", "source_dataset_refs", "topic_tags"],
    metric: ["unit", "window", "confidence", "topic_tags"],
    chart: ["title", "dimensions", "measures", "caveats"],
  },
};

const DATA_KINDS = ["dataset_ref", "query_result", "metric", "chart"] as const;
type DataKind = (typeof DATA_KINDS)[number];

function getSessionId(): string {
  return process.env.PAPERCLIP_RUN_ID || process.env.SESSION_ID || "default";
}

function asText(text: string, details?: Record<string, unknown>) {
  return details
    ? { content: [{ type: "text" as const, text }], details }
    : { content: [{ type: "text" as const, text }] };
}

function asError(msg: string) {
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
}

// ---------------------------------------------------------------------------
// Extension entry point — self-gates to the data agent only.
// ---------------------------------------------------------------------------
export default function (pi: ExtensionAPI) {
  if (client.getAgentName() !== "data") {
    if (client.getAgentName()) {
      console.warn("[workproduct] data extension loaded in wrong agent:", client.getAgentName());
    }
    return;
  }

  // -------------------------------------------------------------------------
  // record_dataset_ref
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "record_dataset_ref",
    label: "Record Dataset Reference",
    description:
      "Register a reference to a dataset (table, file, API, etc.) the data agent has analyzed. Returns the artifact id.",
    parameters: Type.Object({
      source: Type.Union([
        Type.Literal("postgres"), Type.Literal("duckdb"), Type.Literal("parquet"),
        Type.Literal("csv"), Type.Literal("tinybird"), Type.Literal("s3"),
        Type.Literal("api"), Type.Literal("other"),
      ], { description: "Where the dataset lives" }),
      table: Type.Optional(Type.String({ description: "Required for postgres/duckdb/tinybird sources" })),
      path: Type.Optional(Type.String({ description: "Required for parquet/csv/s3 sources" })),
      filters: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Predicate/filter applied" })),
      columns: Type.Optional(Type.Array(Type.String(), { description: "Columns of interest" })),
      row_count_estimate: Type.Optional(Type.Integer({ description: "Approximate row count" })),
      schema_hash: Type.Optional(Type.String({ description: "Hash of the schema at time of access" })),
      as_of: ISODate,
      caveats: Type.Optional(Type.String({ description: "Caveats about freshness, completeness, etc." })),
      topic_tags: Type.Optional(Type.Array(Type.String())),
      related_artifacts: Type.Optional(Type.Array(ArtifactRef)),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        const { source, table, path } = params as { source: string; table?: string; path?: string };

        // Conditional requirements beyond validateByStyle.
        if (["postgres", "duckdb", "tinybird"].includes(source) && !table) {
          return asError(`source '${source}' requires 'table'`);
        }
        if (["parquet", "csv", "s3"].includes(source) && !path) {
          return asError(`source '${source}' requires 'path'`);
        }

        const { errors, warnings } = validateByStyle(
          KIND_PROFILES,
          "dataset_ref",
          [],
          params as Record<string, unknown>,
        );
        if (errors.length > 0) {
          return asError(errors.join("; "));
        }

        const manifest = JSON.stringify({
          source: params.source,
          table: params.table,
          path: params.path,
          filters: params.filters,
          columns: params.columns,
          row_count_estimate: params.row_count_estimate,
          as_of: params.as_of,
        });

        const result = await client.write({
          type: "dataset_ref",
          bucket: "artifacts",
          filename: "dataset_ref.json",
          mime: "application/json",
          content: manifest,
          metadata: {
            source: params.source,
            table: params.table,
            path: params.path,
            filters: params.filters,
            columns: params.columns,
            row_count_estimate: params.row_count_estimate,
            schema_hash: params.schema_hash,
            as_of: params.as_of,
            caveats: params.caveats,
            topic_tags: params.topic_tags,
            related_artifacts: params.related_artifacts,
            session_id: getSessionId(),
          },
          run_id: getSessionId(),
        });

        const lines = [`Dataset reference recorded.`, `ID: ${result.id}`, `Ref: ${result.ref}`];
        if (warnings.length > 0) {
          lines.push("Warnings:");
          for (const w of warnings) lines.push(`  - ${w}`);
        }
        return asText(lines.join("\n"), { id: result.id, warnings });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return asError(msg);
      }
    },
  });

  // -------------------------------------------------------------------------
  // record_query_result
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "record_query_result",
    label: "Record Query Result",
    description:
      "Persist the output of an analytical query, either inline (small) or by reference to an artifact (large). Returns artifact id.",
    parameters: Type.Object({
      sql: Type.String({ description: "Full SQL text (truncated to 8KB in metadata)" }),
      engine: Type.Union([
        Type.Literal("duckdb"), Type.Literal("postgres"),
        Type.Literal("tinybird"), Type.Literal("other"),
      ]),
      row_count: Type.Integer(),
      materialized_at: ISODate,
      columns: Type.Array(Type.Object({ name: Type.String(), type: Type.String() })),
      result_artifact_ref: Type.Optional(ArtifactRef),
      source_dataset_refs: Type.Optional(Type.Array(ArtifactRef)),
      duration_ms: Type.Optional(Type.Integer()),
      topic_tags: Type.Optional(Type.Array(Type.String())),
      rows_inline: Type.Optional(Type.Array(Type.Unknown(), {
        description: "Inline rows (max 100). For larger results, write to an artifact and pass result_artifact_ref instead.",
      })),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        const rows = params.rows_inline;
        if (Array.isArray(rows) && rows.length > 100) {
          return asError(
            "rows_inline exceeds 100 rows. Write the full result to an artifact via write_artifact and pass result_artifact_ref instead.",
          );
        }

        const { errors, warnings } = validateByStyle(
          KIND_PROFILES,
          "query_result",
          [],
          params as Record<string, unknown>,
        );
        if (errors.length > 0) {
          return asError(errors.join("; "));
        }

        const body = JSON.stringify({
          sql: params.sql,
          columns: params.columns,
          rows_inline: params.rows_inline ?? null,
          result_artifact_ref: params.result_artifact_ref ?? null,
        });

        if (Buffer.byteLength(body, "utf8") > 1_000_000) {
          return asError(
            "query_result content exceeds 1MB. Write the rows to an artifact via write_artifact and pass result_artifact_ref instead.",
          );
        }

        const sqlForMeta = params.sql.length > 8192 ? params.sql.slice(0, 8192) : params.sql;

        const result = await client.write({
          type: "query_result",
          bucket: "artifacts",
          filename: "query_result.json",
          mime: "application/json",
          content: body,
          metadata: {
            sql: sqlForMeta,
            engine: params.engine,
            row_count: params.row_count,
            materialized_at: params.materialized_at,
            columns: params.columns,
            result_artifact_ref: params.result_artifact_ref,
            source_dataset_refs: params.source_dataset_refs,
            duration_ms: params.duration_ms,
            topic_tags: params.topic_tags,
            inline_rows: Array.isArray(rows) ? rows.length : 0,
            session_id: getSessionId(),
          },
          run_id: getSessionId(),
        });

        const lines = [`Query result recorded.`, `ID: ${result.id}`, `Ref: ${result.ref}`, `Rows: ${params.row_count}`];
        if (warnings.length > 0) {
          lines.push("Warnings:");
          for (const w of warnings) lines.push(`  - ${w}`);
        }
        return asText(lines.join("\n"), { id: result.id, warnings });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return asError(msg);
      }
    },
  });

  // -------------------------------------------------------------------------
  // record_metric
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "record_metric",
    label: "Record Metric",
    description:
      "Record a single named metric derived from a query result. Use for KPIs, counts, ratios, etc.",
    parameters: Type.Object({
      name: Type.String(),
      value: Type.Union([Type.Number(), Type.String()]),
      unit: Type.Optional(Type.String()),
      dimensions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      window: Type.Optional(Type.Union([
        Type.Object({ start: Type.String(), end: Type.String() }),
        Type.String(),
      ])),
      source_query_ref: ArtifactRef,
      confidence: Type.Optional(Type.Union([
        Type.Literal("high"), Type.Literal("medium"), Type.Literal("low"),
      ])),
      topic_tags: Type.Optional(Type.Array(Type.String())),
      entities: Type.Optional(Type.Array(Type.String())),
      series: Type.Optional(Type.Array(Type.Object({
        t: Type.String(),
        v: Type.Union([Type.Number(), Type.String()]),
      }))),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        const { errors, warnings } = validateByStyle(
          KIND_PROFILES,
          "metric",
          [],
          params as Record<string, unknown>,
        );
        if (errors.length > 0) {
          return asError(errors.join("; "));
        }

        const body = JSON.stringify({
          value: params.value,
          series: params.series ?? null,
        });

        const result = await client.write({
          type: "metric",
          bucket: "artifacts",
          filename: `metric_${params.name}.json`,
          mime: "application/json",
          content: body,
          metadata: {
            name: params.name,
            value: params.value,
            unit: params.unit,
            dimensions: params.dimensions,
            window: params.window,
            source_query_ref: params.source_query_ref,
            confidence: params.confidence,
            topic_tags: params.topic_tags,
            entities: params.entities,
            session_id: getSessionId(),
          },
          run_id: getSessionId(),
        });

        const lines = [`Metric recorded.`, `ID: ${result.id}`, `Name: ${params.name}`, `Value: ${params.value}${params.unit ? " " + params.unit : ""}`];
        if (warnings.length > 0) {
          lines.push("Warnings:");
          for (const w of warnings) lines.push(`  - ${w}`);
        }
        return asText(lines.join("\n"), { id: result.id, warnings });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return asError(msg);
      }
    },
  });

  // -------------------------------------------------------------------------
  // record_chart
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "record_chart",
    label: "Record Chart",
    description:
      "Register a chart spec (e.g. Vega-Lite) plus a pointer to the data it visualizes. Returns artifact id.",
    parameters: Type.Object({
      chart_type: Type.Union([
        Type.Literal("line"), Type.Literal("bar"), Type.Literal("scatter"),
        Type.Literal("area"), Type.Literal("pie"), Type.Literal("table"),
        Type.Literal("other"),
      ]),
      data_ref: ArtifactRef,
      spec: Type.Record(Type.String(), Type.Unknown(), { description: "Chart spec (vega-lite, plotly, etc.)" }),
      dimensions: Type.Optional(Type.Array(Type.String())),
      measures: Type.Optional(Type.Array(Type.String())),
      rendered_artifact_ref: Type.Optional(ArtifactRef),
      title: Type.Optional(Type.String()),
      caveats: Type.Optional(Type.String()),
      topic_tags: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        const { errors, warnings } = validateByStyle(
          KIND_PROFILES,
          "chart",
          [],
          params as Record<string, unknown>,
        );
        if (errors.length > 0) {
          return asError(errors.join("; "));
        }

        const body = JSON.stringify(params.spec);

        const result = await client.write({
          type: "chart",
          bucket: "artifacts",
          filename: params.title ? `chart_${params.title.replace(/[^a-zA-Z0-9_-]/g, "_")}.json` : "chart.json",
          mime: "application/json",
          content: body,
          metadata: {
            chart_type: params.chart_type,
            data_ref: params.data_ref,
            dimensions: params.dimensions,
            measures: params.measures,
            rendered_artifact_ref: params.rendered_artifact_ref,
            title: params.title,
            caveats: params.caveats,
            topic_tags: params.topic_tags,
            session_id: getSessionId(),
          },
          run_id: getSessionId(),
        });

        const lines = [`Chart recorded.`, `ID: ${result.id}`, `Type: ${params.chart_type}`];
        if (params.title) lines.push(`Title: ${params.title}`);
        if (warnings.length > 0) {
          lines.push("Warnings:");
          for (const w of warnings) lines.push(`  - ${w}`);
        }
        return asText(lines.join("\n"), { id: result.id, warnings });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return asError(msg);
      }
    },
  });

  // -------------------------------------------------------------------------
  // query_data_products
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "query_data_products",
    label: "Query Data Products",
    description:
      "Search across recorded data work products (dataset refs, query results, metrics, charts) with optional filters.",
    parameters: Type.Object({
      kind: Type.Optional(Type.Union([
        Type.Literal("dataset_ref"), Type.Literal("query_result"),
        Type.Literal("metric"), Type.Literal("chart"),
      ], { description: "Restrict to one kind. Omit to search all four." })),
      agent: Type.Optional(Type.String({ description: "Defaults to own agent" })),
      session_id: Type.Optional(Type.String()),
      topic_tag: Type.Optional(Type.String({ description: "Substring match on topic_tags[]" })),
      entity: Type.Optional(Type.String({ description: "Substring match on metric entities[]" })),
      since: Type.Optional(Type.String({ description: "ISO 8601 timestamp" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        const agent = params.agent ?? client.getAgentName();
        const limit = params.limit ?? 50;
        const metaFilter: Record<string, unknown> | undefined = params.session_id
          ? { session_id: params.session_id }
          : undefined;

        const baseFilters = {
          agent,
          bucket: "artifacts",
          since: params.since,
          metadata: metaFilter,
        };

        let records: Awaited<ReturnType<typeof client.list>>;
        if (params.kind) {
          records = await client.list({ ...baseFilters, type: params.kind });
        } else {
          const lists = await Promise.all(
            DATA_KINDS.map((k) => client.list({ ...baseFilters, type: k })),
          );
          records = lists.flat();
        }

        // Post-filter on topic_tag / entity (metadata is JSON, not a flat scalar).
        let filtered = records;
        if (params.topic_tag) {
          const needle = params.topic_tag.toLowerCase();
          filtered = filtered.filter((r) => {
            const tags = (r.metadata?.topic_tags ?? []) as unknown;
            if (!Array.isArray(tags)) return false;
            return tags.some((t) => typeof t === "string" && t.toLowerCase().includes(needle));
          });
        }
        if (params.entity) {
          const needle = params.entity.toLowerCase();
          filtered = filtered.filter((r) => {
            const ents = (r.metadata?.entities ?? []) as unknown;
            if (!Array.isArray(ents)) return false;
            return ents.some((e) => typeof e === "string" && e.toLowerCase().includes(needle));
          });
        }

        filtered.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
        const sliced = filtered.slice(0, limit);

        if (sliced.length === 0) {
          return asText("No data products match the filters.", { count: 0 });
        }

        const lines: string[] = [`Found ${sliced.length} data product(s):`];
        for (const r of sliced) {
          const meta = r.metadata ?? {};
          const label =
            (meta as Record<string, unknown>).name as string ||
            (meta as Record<string, unknown>).title as string ||
            (meta as Record<string, unknown>).table as string ||
            (meta as Record<string, unknown>).path as string ||
            r.filename;
          lines.push(`[${r.id}] ${r.artifact_type} | ${label} | ${r.created_at}`);
        }

        return asText(lines.join("\n"), { count: sliced.length });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return asError(msg);
      }
    },
  });

  // -------------------------------------------------------------------------
  // get_data_product
  // -------------------------------------------------------------------------
  pi.registerTool({
    name: "get_data_product",
    label: "Get Data Product",
    description:
      "Fetch a single data work product (dataset_ref, query_result, metric, chart) by id. Returns metadata and parsed content.",
    parameters: Type.Object({
      id: Type.String({ description: "Artifact ULID" }),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        const result = await client.read(params.id);
        const allowed = new Set<string>(DATA_KINDS as unknown as string[]);
        if (!allowed.has(result.metadata.artifact_type)) {
          return asError(
            `artifact ${params.id} has type '${result.metadata.artifact_type}', not a data work product (expected one of ${[...allowed].join(", ")})`,
          );
        }

        const raw = result.content.toString("utf8");
        let parsed: unknown = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // leave as string
        }

        const dump = JSON.stringify(
          { record: result.metadata, content: parsed },
          null,
          2,
        );
        return asText(dump, { id: params.id });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return asError(msg);
      }
    },
  });
}
