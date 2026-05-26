import * as fs from "node:fs";
import * as path from "node:path";
import type { DuckDBConnection } from "@duckdb/node-api";

const AGENT_NAME = process.env.AGENT_NAME || "unknown";
const STATE_DIR = process.env.DUCKDB_STATE_DIR || `/artifacts/${AGENT_NAME}/duckdb`;
const STATE_FILE = path.join(STATE_DIR, "state.sql");

export function getStateDir(): string {
  return STATE_DIR;
}

export function getStatePath(): string {
  return STATE_FILE;
}

export async function restoreState(conn: DuckDBConnection): Promise<string[]> {
  if (!fs.existsSync(STATE_FILE)) return [];

  let sql: string;
  try {
    sql = fs.readFileSync(STATE_FILE, "utf8");
  } catch {
    return [];
  }

  const lines = sql
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("--"));

  const restored: string[] = [];
  const failed: string[] = [];

  for (const line of lines) {
    try {
      await conn.run(line);
      restored.push(line);
    } catch (err) {
      failed.push(`${line} -- ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failed.length > 0) {
    const backupPath = STATE_FILE + ".bak";
    try {
      fs.copyFileSync(STATE_FILE, backupPath);
    } catch {}
    writeState(restored);
  }

  return restored;
}

export function appendState(statement: string): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const existing = fs.existsSync(STATE_FILE)
    ? fs.readFileSync(STATE_FILE, "utf8")
    : "-- DuckDB session state\n";

  if (!existing.includes(statement)) {
    fs.writeFileSync(STATE_FILE, existing + statement + "\n", "utf8");
  }
}

function writeState(lines: string[]): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const content = "-- DuckDB session state\n" + lines.join("\n") + "\n";
  fs.writeFileSync(STATE_FILE, content, "utf8");
}
