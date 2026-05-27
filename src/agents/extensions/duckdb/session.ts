import type { DuckDBConnection } from "@duckdb/node-api";
import * as client from "../artifact-client.js";

const AGENT_NAME = process.env.AGENT_NAME || "unknown";

/**
 * Restore DuckDB session state from the artifact service.
 *
 * Fetches the most recent state artifact (type: "state", bucket: "state"),
 * splits it into SQL statements, and executes each against the provided
 * connection. Statements that fail are silently skipped, and the persisted
 * state is rewritten to contain only the statements that succeeded.
 *
 * @returns The list of SQL statements that were successfully executed.
 */
export async function restoreState(conn: DuckDBConnection): Promise<string[]> {
  let records;
  try {
    records = await client.list({ type: "state", bucket: "state", agent: AGENT_NAME });
  } catch {
    return [];
  }

  if (records.length === 0) return [];

  // list returns sorted by created_at DESC — first element is the latest
  const latest = records[0];
  let content: string;
  try {
    const result = await client.read(latest.id);
    content = result.content.toString("utf8");
  } catch {
    return [];
  }

  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("--"));

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
      await writeState(restored);
    } catch {
      // best-effort rewrite; failure here is non-fatal
    }
  }

  return restored;
}

/**
 * Append a SQL statement to the persisted session state.
 *
 * Reads the current state artifact (if any), appends the statement if it
 * is not already present, and writes the updated content back to the
 * artifact service.
 *
 * BREAKING CHANGE: this function is now async (was sync when backed by
 * node:fs). Callers must await the returned promise.
 */
export async function appendState(statement: string): Promise<void> {
  let currentContent = "-- DuckDB session state\n";
  try {
    const records = await client.list({ type: "state", bucket: "state", agent: AGENT_NAME });
    if (records.length > 0) {
      const result = await client.read(records[0].id);
      currentContent = result.content.toString("utf8");
    }
  } catch {
    // no existing state — start fresh
  }

  // Idempotency: skip if the statement is already persisted
  if (currentContent.includes(statement)) return;

  const newContent = currentContent + statement + "\n";
  await client.write({
    filename: "duckdb-state.sql",
    content: newContent,
    type: "state",
    bucket: "state",
    mime: "text/x-sql",
    metadata: { agent: AGENT_NAME },
  });
}

/**
 * Internal helper — overwrites the full state artifact with the given lines.
 */
async function writeState(lines: string[]): Promise<void> {
  const content = "-- DuckDB session state\n" + lines.join("\n") + "\n";
  await client.write({
    filename: "duckdb-state.sql",
    content,
    type: "state",
    bucket: "state",
    mime: "text/x-sql",
    metadata: { agent: AGENT_NAME },
  });
}
