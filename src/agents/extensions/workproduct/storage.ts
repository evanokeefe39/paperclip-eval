import * as fs from "node:fs";
import * as path from "node:path";

export const ARTIFACTS_ROOT = "/artifacts";

export function getAgentName(): string {
  return process.env.AGENT_NAME || "";
}

export function getSessionId(): string {
  return process.env.PAPERCLIP_RUN_ID || process.env.SESSION_ID || "default";
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function workProductDir(agentName: string, subdir: string): string {
  return path.join(ARTIFACTS_ROOT, agentName, subdir);
}

export function sessionFilePath(agentName: string, subdir: string, sessionId: string): string {
  return path.join(workProductDir(agentName, subdir), `${sessionId}.jsonl`);
}

export function appendRecord<T>(record: T, filePath: string): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
}

export function readRecords<T>(dir: string, sessionId?: string): T[] {
  if (!fs.existsSync(dir)) return [];

  const files = sessionId
    ? [path.join(dir, `${sessionId}.jsonl`)]
    : fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")).map(f => path.join(dir, f));

  const records: T[] = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
  }
  return records;
}

export function findRecordById<T extends { id: string }>(dir: string, id: string): T | null {
  const all = readRecords<T>(dir);
  return all.find(r => r.id === id) || null;
}

export function updateRecord<T extends { id: string; session_id: string }>(
  record: T,
  dir: string,
): void {
  const file = path.join(dir, `${record.session_id}.jsonl`);
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const updated = lines.map(line => {
    try {
      const r = JSON.parse(line);
      if (r.id === record.id) return JSON.stringify(record);
      return line;
    } catch {
      return line;
    }
  });
  fs.writeFileSync(file, updated.join("\n") + "\n", "utf8");
}

export function scanAllAgents<T>(subdir: string, predicate: (record: T) => boolean): T | null {
  if (!fs.existsSync(ARTIFACTS_ROOT)) return null;
  const agentDirs = fs.readdirSync(ARTIFACTS_ROOT, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const agent of agentDirs) {
    const dir = path.join(ARTIFACTS_ROOT, agent, subdir);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl"));
    for (const file of files) {
      const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const record: T = JSON.parse(line);
          if (predicate(record)) return record;
        } catch { /* skip */ }
      }
    }
  }
  return null;
}
