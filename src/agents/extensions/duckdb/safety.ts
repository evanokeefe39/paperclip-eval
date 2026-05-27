import * as path from "node:path";

const ALLOWED_ROOTS = ["/workspace", "/tmp"];

const ROW_LIMIT_THRESHOLD = 100_000;

const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "INSERT", "UPDATE", "DELETE", "CREATE",
  "DROP", "ALTER", "JOIN", "GROUP", "ORDER", "HAVING", "UNION",
  "WITH", "LIMIT", "OFFSET", "ATTACH", "COPY", "LOAD", "SET",
  "DESCRIBE", "SHOW", "EXPLAIN", "PRAGMA", "INSTALL",
];

export function isNaturalLanguage(sql: string): boolean {
  const upper = sql.trim().toUpperCase();
  return !SQL_KEYWORDS.some((kw) => upper.startsWith(kw));
}

export function validatePath(filePath: string): { valid: boolean; error?: string } {
  if (/^(https?|s3|r2|gs):\/\//i.test(filePath)) {
    return { valid: true };
  }

  const resolved = path.resolve(filePath);
  const allowed = ALLOWED_ROOTS.some(
    (root) => resolved === root || resolved.startsWith(root + "/"),
  );

  if (!allowed) {
    return {
      valid: false,
      error: `Path "${resolved}" is outside allowed roots: ${ALLOWED_ROOTS.join(", ")}`,
    };
  }

  if (resolved.includes("/../") || resolved.endsWith("/..")) {
    return { valid: false, error: "Path traversal rejected" };
  }

  return { valid: true };
}

export function hasAggregationOrLimit(sql: string): boolean {
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

export async function estimateRowCount(
  conn: any,
  sql: string,
): Promise<number | null> {
  try {
    const result = await conn.run(`SELECT COUNT(*) AS cnt FROM (${sql}) _est LIMIT 1`);
    for await (const row of result.streamRows()) {
      return Number(row[0]);
    }
    return null;
  } catch {
    return null;
  }
}

export function checkQuerySafety(
  sql: string,
  estimatedRows: number | null,
): { safe: boolean; warning?: string } {
  if (hasAggregationOrLimit(sql)) {
    return { safe: true };
  }

  if (estimatedRows !== null && estimatedRows > ROW_LIMIT_THRESHOLD) {
    return {
      safe: false,
      warning:
        `Query would return ~${estimatedRows.toLocaleString()} rows. ` +
        `Add LIMIT, GROUP BY, or an aggregation function to bound the result set.`,
    };
  }

  return { safe: true };
}
