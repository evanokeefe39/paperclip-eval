import type { DuckDBConnection } from "@duckdb/node-api";

export async function getSchemaContext(conn: DuckDBConnection): Promise<string> {
  const lines: string[] = [];

  try {
    const tablesResult = await conn.run(
      "SELECT table_schema, table_name FROM information_schema.tables " +
      "WHERE table_schema NOT IN ('information_schema', 'pg_catalog') " +
      "ORDER BY table_schema, table_name LIMIT 50",
    );

    const tables: Array<{ schema: string; name: string }> = [];
    for await (const row of tablesResult.streamRows()) {
      tables.push({ schema: String(row[0]), name: String(row[1]) });
    }

    for (const table of tables) {
      const qualified = table.schema === "main"
        ? table.name
        : `${table.schema}.${table.name}`;

      lines.push(`\nTable: ${qualified}`);

      try {
        const colsResult = await conn.run(
          `SELECT column_name, data_type FROM information_schema.columns ` +
          `WHERE table_schema = '${table.schema}' AND table_name = '${table.name}' ` +
          `ORDER BY ordinal_position`,
        );

        for await (const row of colsResult.streamRows()) {
          lines.push(`  ${row[0]} ${row[1]}`);
        }

        const countResult = await conn.run(
          `SELECT COUNT(*) FROM "${table.schema}"."${table.name}"`,
        );
        for await (const row of countResult.streamRows()) {
          lines.push(`  (~${Number(row[0]).toLocaleString()} rows)`);
        }
      } catch {
        lines.push("  (could not read columns)");
      }
    }
  } catch {
    return "(no schema available)";
  }

  return lines.join("\n") || "(no tables found)";
}

export function buildNlqPrompt(question: string, schema: string): string {
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
