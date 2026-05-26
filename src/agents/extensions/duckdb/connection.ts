import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";

const MEMORY_LIMIT = process.env.DUCKDB_MEMORY_LIMIT || "512MB";
const THREADS = process.env.DUCKDB_THREADS || "2";

let instance: DuckDBInstance | null = null;
let conn: DuckDBConnection | null = null;

export async function getConnection(): Promise<DuckDBConnection> {
  if (conn) return conn;
  instance = await DuckDBInstance.create();
  conn = await instance.connect();
  await conn.run(`SET memory_limit = '${MEMORY_LIMIT}'`);
  await conn.run(`SET threads = ${THREADS}`);
  return conn;
}

export async function closeConnection(): Promise<void> {
  if (conn) {
    await conn.close();
    conn = null;
  }
  if (instance) {
    await instance.close();
    instance = null;
  }
}

export function isConnected(): boolean {
  return conn !== null;
}
