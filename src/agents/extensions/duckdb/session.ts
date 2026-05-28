import type { DuckDBConnection } from "@duckdb/node-api";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Restore DuckDB session state from the local filesystem.
 *
 * Reads the state file at ${process.cwd()}/duckdb/state.sql, splits it into
 * SQL statements, and executes each against the provided connection. Statements
 * that fail are silently skipped, and the persisted state is rewritten to
 * contain only the statements that succeeded.
 *
 * @returns The list of SQL statements that were successfully executed.
 */
export async function restoreState(conn: DuckDBConnection): Promise<string[]> {
  const statePath = path.join(process.cwd(), "duckdb", "state.sql");
  let content: string;
  try {
    content = fs.readFileSync(statePath, "utf8");
  } catch {
    return [];
  }

  const lines = content.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("--"));
  const restored: string[] = [];

  for (const line of lines) {
    try {
      await conn.run(line);
      restored.push(line);
    } catch {
      // skip failed statements — they may reference resources
      // that no longer exist (detached DBs, dropped tables, etc.)
    }
  }

  // If some statements failed, persist only the valid subset
  if (restored.length < lines.length && restored.length > 0) {
    try {
      writeState(restored);
    } catch { /* best-effort rewrite; failure here is non-fatal */ }
  }

  return restored;
}

/**
 * Append a SQL statement to the persisted session state.
 *
 * Reads the current state file (if any), appends the statement if it is not
 * already present, and writes the updated content back to disk.
 */
export async function appendState(statement: string): Promise<void> {
  const dir = path.join(process.cwd(), "duckdb");
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

/**
 * Internal helper — overwrites the full state file with the given lines.
 */
function writeState(lines: string[]): void {
  const dir = path.join(process.cwd(), "duckdb");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "state.sql"),
    "-- DuckDB session state\n" + lines.join("\n") + "\n"
  );
}
