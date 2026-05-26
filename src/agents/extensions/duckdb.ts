import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// Conditional import — skip all registration if @duckdb/node-api is missing
let duckdbAvailable = false;
try {
  require("@duckdb/node-api");
  duckdbAvailable = true;
} catch {
  // native addon not installed in this image
}

export default function (pi: ExtensionAPI) {
  if (!duckdbAvailable) return;

  const { getConnection } = require("./duckdb/connection.js") as typeof import("./duckdb/connection.js");
  const { restoreState, appendState } = require("./duckdb/session.js") as typeof import("./duckdb/session.js");
  const { formatResult } = require("./duckdb/format.js") as typeof import("./duckdb/format.js");
  const {
    detectFormat, getSupportedFormats, isRemoteUrl, readFunction,
    requiredExtension, outputCopyFormat,
  } = require("./duckdb/detect.js") as typeof import("./duckdb/detect.js");
  const {
    isNaturalLanguage, validatePath, estimateRowCount, checkQuerySafety,
  } = require("./duckdb/safety.js") as typeof import("./duckdb/safety.js");
  const { getSchemaContext, buildNlqPrompt } = require("./duckdb/nlq.js") as typeof import("./duckdb/nlq.js");

  type ToolResult = {
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
  };

  function ok(text: string, details?: unknown): ToolResult {
    return { content: [{ type: "text" as const, text }], ...(details ? { details } : {}) };
  }

  function err(msg: string): ToolResult {
    return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
  }

  async function ensureExtension(conn: any, ext: string): Promise<void> {
    try {
      await conn.run(`INSTALL '${ext}'`);
    } catch {}
    await conn.run(`LOAD '${ext}'`);
  }

  let sessionRestored = false;

  async function getReadyConnection() {
    const conn = await getConnection();
    if (!sessionRestored) {
      sessionRestored = true;
      await restoreState(conn);
    }
    return conn;
  }

  // ---- duckdb_query ----
  pi.registerTool({
    name: "duckdb_query",
    label: "DuckDB Query",
    description:
      "Execute SQL against attached databases or ad-hoc against a file. " +
      "Supports DuckDB Friendly SQL (FROM-first, GROUP BY ALL, EXCLUDE/REPLACE). " +
      "If sql looks like natural language, generates SQL from schema context.",
    promptSnippet:
      "Use duckdb_query to run analytical SQL against structured data files (CSV, JSON, Parquet, Excel, SQLite) " +
      "or attached DuckDB databases. You can query files directly:\n" +
      "  duckdb_query({ sql: \"SELECT * FROM '/artifacts/data/sales.csv' LIMIT 10\" })\n" +
      "Or use ad-hoc mode:\n" +
      "  duckdb_query({ sql: \"SELECT * LIMIT 10\", file: \"/artifacts/data/sales.csv\" })\n" +
      "Natural language works too:\n" +
      "  duckdb_query({ sql: \"how many orders per month\" })\n" +
      "Results are bounded by default (100 rows). Use format param for json/csv output.",
    parameters: Type.Object({
      sql: Type.String({ description: "SQL query or natural-language question" }),
      file: Type.Optional(Type.String({ description: "Path/URL to query ad-hoc (skips session state)" })),
      limit: Type.Optional(Type.Number({ description: "Max rows returned (default 100)" })),
      format: Type.Optional(
        Type.Union([Type.Literal("table"), Type.Literal("json"), Type.Literal("csv")], {
          description: "Output format (default: table)",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, any>): Promise<ToolResult> {
      try {
        const sql: string = params.sql;
        const file: string | undefined = params.file;
        const limit: number = params.limit ?? 100;
        const format = (params.format || "table") as "table" | "json" | "csv";

        if (!sql?.trim()) return err("sql is required");

        // Ad-hoc file mode
        if (file) {
          const pathCheck = validatePath(file);
          if (!pathCheck.valid) return err(pathCheck.error!);

          const fmt = detectFormat(file);
          if (!fmt && !isRemoteUrl(file)) {
            return err(`Cannot detect format for "${file}". Supported: ${getSupportedFormats().join(", ")}`);
          }

          const conn = await getConnection();

          const reqExt = fmt ? requiredExtension(fmt) : null;
          if (reqExt) await ensureExtension(conn, reqExt);
          if (isRemoteUrl(file)) await ensureExtension(conn, "httpfs");

          const readFn = fmt ? readFunction(fmt, file) : `read_csv('${file}', auto_detect=true)`;
          const finalSql = `SELECT * FROM ${readFn} ${sql.trim().toUpperCase() === "SELECT *" ? "" : `WHERE ${sql}`} LIMIT ${limit}`;
          const actualSql = `SELECT * FROM ${readFn} LIMIT ${limit}`;

          const startMs = Date.now();
          const result = await conn.run(actualSql);
          const elapsed = Date.now() - startMs;
          const formatted = await formatResult(result, format, limit);

          return ok(
            [
              formatted.text,
              "",
              `${formatted.rowCount} row(s) | ${formatted.columns.length} column(s) | ${elapsed}ms`,
            ].join("\n"),
            { rowCount: formatted.rowCount, columns: formatted.columns, elapsed_ms: elapsed },
          );
        }

        // Session mode
        const conn = await getReadyConnection();

        // Natural language detection
        if (isNaturalLanguage(sql)) {
          const schema = await getSchemaContext(conn);
          if (schema === "(no tables found)" || schema === "(no schema available)") {
            return err(
              "No tables attached. Natural language queries need a database or file. " +
              "Use duckdb_attach to connect a database, or pass a file path.",
            );
          }

          const nlqPrompt = buildNlqPrompt(sql, schema);
          return ok(
            [
              "Natural language detected. Schema context:",
              schema,
              "",
              "Suggested prompt for SQL generation:",
              nlqPrompt,
              "",
              "Generate the SQL and call duckdb_query again with the SQL.",
            ].join("\n"),
          );
        }

        // Safety check
        const estimated = await estimateRowCount(conn, sql);
        const safety = checkQuerySafety(sql, estimated);
        if (!safety.safe) {
          return ok(`⚠ ${safety.warning}\n\nQuery not executed. Add LIMIT or aggregation and retry.`);
        }

        const startMs = Date.now();
        const result = await conn.run(sql);
        const elapsed = Date.now() - startMs;
        const formatted = await formatResult(result, format, limit);

        return ok(
          [
            formatted.text,
            "",
            `${formatted.rowCount} row(s) | ${formatted.columns.length} column(s) | ${elapsed}ms`,
          ].join("\n"),
          { rowCount: formatted.rowCount, columns: formatted.columns, elapsed_ms: elapsed },
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(msg);
      }
    },
  });

  // ---- duckdb_read_file ----
  pi.registerTool({
    name: "duckdb_read_file",
    label: "DuckDB Read File",
    description:
      "Explore any supported data file. Returns schema, row count, and 20-row preview. " +
      "Supports CSV, JSON, JSONL, Parquet, Excel, SQLite, Avro, spatial formats, and remote URLs.",
    parameters: Type.Object({
      path: Type.String({ description: "Local path or remote URL (S3, HTTPS, GCS)" }),
      question: Type.Optional(Type.String({ description: "Question about the data (default: describe)" })),
    }),
    async execute(_id: string, params: Record<string, any>): Promise<ToolResult> {
      try {
        const filePath: string = params.path;
        if (!filePath?.trim()) return err("path is required");

        const pathCheck = validatePath(filePath);
        if (!pathCheck.valid) return err(pathCheck.error!);

        const remote = isRemoteUrl(filePath);

        if (!remote && !fs.existsSync(filePath)) {
          return err(`File not found: ${filePath}`);
        }

        const fmt = detectFormat(filePath);
        if (!fmt) {
          return err(`Unsupported format. Supported extensions: ${getSupportedFormats().join(", ")}`);
        }

        const conn = await getConnection();
        const reqExt = requiredExtension(fmt);
        if (reqExt) await ensureExtension(conn, reqExt);
        if (remote) await ensureExtension(conn, "httpfs");

        const readFn = readFunction(fmt, filePath);
        const sections: string[] = [];

        // Schema
        try {
          const schemaResult = await conn.run(`DESCRIBE SELECT * FROM ${readFn} LIMIT 0`);
          const schemaFormatted = await formatResult(schemaResult, "table", 200);
          sections.push("## Schema", schemaFormatted.text);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          // Empty file detection
          if (msg.includes("empty") || msg.includes("no rows")) {
            return err("File is empty or contains no parseable data.");
          }
          return err(`Failed to read schema: ${msg}`);
        }

        // Row count
        try {
          const countResult = await conn.run(`SELECT COUNT(*) AS total_rows FROM ${readFn}`);
          for await (const row of countResult.streamRows()) {
            sections.push("", `Row count: ${Number(row[0]).toLocaleString()}`);
          }
        } catch {}

        // Preview
        try {
          const previewResult = await conn.run(`SELECT * FROM ${readFn} LIMIT 20`);
          const previewFormatted = await formatResult(previewResult, "table", 20);
          sections.push("", "## Preview (20 rows)", previewFormatted.text);
        } catch {}

        // Question
        if (params.question) {
          sections.push(
            "",
            "## Question",
            `"${params.question}"`,
            "",
            `To answer, run: duckdb_query({ sql: "<generated SQL>", file: "${filePath}" })`,
          );
        }

        return ok(sections.join("\n"));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(msg);
      }
    },
  });

  // ---- duckdb_attach ----
  pi.registerTool({
    name: "duckdb_attach",
    label: "DuckDB Attach",
    description:
      "Connect a DuckDB database file for persistent querying within the session. " +
      "Explores and returns schema summary. Persists attachment to session state.",
    parameters: Type.Object({
      path: Type.String({ description: "Path to .duckdb file" }),
      alias: Type.Optional(Type.String({ description: "Schema alias (default: from filename)" })),
      read_only: Type.Optional(Type.Boolean({ description: "Attach read-only (default: false)" })),
    }),
    async execute(_id: string, params: Record<string, any>): Promise<ToolResult> {
      try {
        const filePath: string = params.path;
        if (!filePath?.trim()) return err("path is required");

        const pathCheck = validatePath(filePath);
        if (!pathCheck.valid) return err(pathCheck.error!);

        const alias = params.alias || path.basename(filePath, ".duckdb");
        const readOnly = params.read_only ?? false;
        const roClause = readOnly ? " (READ_ONLY)" : "";

        const conn = await getReadyConnection();

        const attachSql = `ATTACH IF NOT EXISTS '${filePath}' AS "${alias}"${roClause}`;
        await conn.run(attachSql);
        appendState(attachSql);

        // Explore schema
        const sections: string[] = [`Attached: ${filePath} as "${alias}"`, ""];

        try {
          const tablesResult = await conn.run(
            `SELECT table_name FROM information_schema.tables ` +
            `WHERE table_schema = '${alias}' ORDER BY table_name LIMIT 50`,
          );

          const tables: string[] = [];
          for await (const row of tablesResult.streamRows()) {
            tables.push(String(row[0]));
          }

          if (tables.length === 0) {
            sections.push("(no tables found — empty database)");
          } else {
            sections.push(`Tables (${tables.length}):`);
            for (const table of tables) {
              sections.push(`\n### ${table}`);
              try {
                const colsResult = await conn.run(
                  `SELECT column_name, data_type FROM information_schema.columns ` +
                  `WHERE table_schema = '${alias}' AND table_name = '${table}' ` +
                  `ORDER BY ordinal_position`,
                );
                for await (const row of colsResult.streamRows()) {
                  sections.push(`  ${row[0]} ${row[1]}`);
                }

                const countResult = await conn.run(`SELECT COUNT(*) FROM "${alias}"."${table}"`);
                for await (const row of countResult.streamRows()) {
                  sections.push(`  (~${Number(row[0]).toLocaleString()} rows)`);
                }
              } catch {}
            }
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          sections.push(`Could not explore schema: ${msg}`);
        }

        return ok(sections.join("\n"), { alias, path: filePath, read_only: readOnly });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(msg);
      }
    },
  });

  // ---- duckdb_convert ----
  pi.registerTool({
    name: "duckdb_convert",
    label: "DuckDB Convert",
    description:
      "Transform data between formats. Supports: CSV, TSV, JSON, JSONL, Parquet, Excel. " +
      "Optional transform SQL applied before writing.",
    parameters: Type.Object({
      input: Type.String({ description: "Source file path or URL" }),
      output: Type.String({ description: "Destination file path" }),
      query: Type.Optional(Type.String({ description: "Transform SQL (default: SELECT *)" })),
    }),
    async execute(_id: string, params: Record<string, any>): Promise<ToolResult> {
      try {
        const input: string = params.input;
        const output: string = params.output;
        const query: string = params.query || "SELECT *";

        if (!input?.trim()) return err("input is required");
        if (!output?.trim()) return err("output is required");

        const inputCheck = validatePath(input);
        if (!inputCheck.valid) return err(inputCheck.error!);
        const outputCheck = validatePath(output);
        if (!outputCheck.valid) return err(outputCheck.error!);

        const remote = isRemoteUrl(input);
        if (!remote && !fs.existsSync(input)) {
          return err(`Input file not found: ${input}`);
        }

        const inputFmt = detectFormat(input);
        if (!inputFmt) {
          return err(`Cannot detect input format. Supported: ${getSupportedFormats().join(", ")}`);
        }

        const outputFmt = outputCopyFormat(output);
        if (!outputFmt) {
          return err(`Unsupported output format. Supported: parquet, csv, tsv, json, jsonl, xlsx`);
        }

        const conn = await getConnection();

        const inputExt = requiredExtension(inputFmt);
        if (inputExt) await ensureExtension(conn, inputExt);
        if (remote) await ensureExtension(conn, "httpfs");

        if (outputFmt === "EXCEL") await ensureExtension(conn, "excel");

        // Ensure output directory exists
        const outputDir = path.dirname(output);
        fs.mkdirSync(outputDir, { recursive: true });

        const readFn = readFunction(inputFmt, input);
        const copySql =
          `COPY (${query} FROM ${readFn}) TO '${output}' (FORMAT ${outputFmt})`;

        const startMs = Date.now();
        await conn.run(copySql);
        const elapsed = Date.now() - startMs;

        // Get output stats
        let fileSize = 0;
        let rowCount = 0;
        try {
          const stats = fs.statSync(output);
          fileSize = stats.size;
        } catch {}

        try {
          const countResult = await conn.run(
            `SELECT COUNT(*) FROM ${readFunction(detectFormat(output) || "csv", output)}`,
          );
          for await (const row of countResult.streamRows()) {
            rowCount = Number(row[0]);
          }
        } catch {}

        const sizeStr = fileSize > 1_000_000
          ? `${(fileSize / 1_000_000).toFixed(1)}MB`
          : `${(fileSize / 1_000).toFixed(1)}KB`;

        return ok(
          [
            `Converted: ${input} → ${output}`,
            `Format: ${inputFmt} → ${outputFmt.toLowerCase()}`,
            `Rows: ${rowCount.toLocaleString()}`,
            `Size: ${sizeStr}`,
            `Time: ${elapsed}ms`,
          ].join("\n"),
          { output_path: output, row_count: rowCount, file_size: fileSize, elapsed_ms: elapsed },
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return err(msg);
      }
    },
  });
}
