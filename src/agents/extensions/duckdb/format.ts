import type { DuckDBResult } from "@duckdb/node-api";

export type OutputFormat = "table" | "json" | "csv";

export async function formatResult(
  result: DuckDBResult,
  format: OutputFormat,
  limit: number,
): Promise<{ text: string; rowCount: number; columns: string[] }> {
  const columns = result.columnNames();
  const types = result.columnTypes();
  const rows: any[][] = [];

  for await (const chunk of result.streamRows()) {
    rows.push(chunk as any[]);
    if (rows.length >= limit) break;
  }

  const rowCount = rows.length;

  switch (format) {
    case "json":
      return {
        text: JSON.stringify(
          rows.map((row) => {
            const obj: Record<string, any> = {};
            columns.forEach((col, i) => (obj[col] = row[i]));
            return obj;
          }),
          null,
          2,
        ),
        rowCount,
        columns,
      };

    case "csv": {
      const header = columns.join(",");
      const body = rows.map((row) =>
        row.map((v: any) => {
          if (v === null || v === undefined) return "";
          const s = String(v);
          return s.includes(",") || s.includes('"') || s.includes("\n")
            ? `"${s.replace(/"/g, '""')}"`
            : s;
        }).join(","),
      ).join("\n");
      return { text: header + "\n" + body, rowCount, columns };
    }

    case "table":
    default: {
      const widths = columns.map((col, i) => {
        const typeStr = types[i]?.toString() || "";
        const headerWidth = Math.max(col.length, typeStr.length);
        const dataWidth = rows.reduce(
          (max, row) => Math.max(max, String(row[i] ?? "NULL").length),
          0,
        );
        return Math.min(Math.max(headerWidth, dataWidth), 40);
      });

      const pad = (s: string, w: number) =>
        s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w);

      const headerLine = columns.map((c, i) => pad(c, widths[i])).join(" | ");
      const typeLine = types
        .map((t, i) => pad(t?.toString() || "", widths[i]))
        .join(" | ");
      const sep = widths.map((w) => "-".repeat(w)).join("-+-");
      const dataLines = rows.map((row) =>
        row
          .map((v: any, i: number) => pad(String(v ?? "NULL"), widths[i]))
          .join(" | "),
      );

      const lines = [headerLine, typeLine, sep, ...dataLines];
      return { text: lines.join("\n"), rowCount, columns };
    }
  }
}
