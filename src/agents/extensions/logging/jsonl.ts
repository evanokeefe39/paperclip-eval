import * as fs from "node:fs";
import * as path from "node:path";
import type { LogEntry } from "./types.js";

const ARTIFACTS_ROOT = "/artifacts";

export class JsonlWriter {
  private filePath: string | null = null;
  private enabled: boolean;

  constructor(agentName: string, enabled: boolean) {
    this.enabled = enabled;
    if (!agentName || !enabled) return;

    const dir = path.join(ARTIFACTS_ROOT, agentName);
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.filePath = path.join(dir, "run.log.jsonl");
    } catch {
      this.filePath = null;
    }
  }

  append(entry: LogEntry): void {
    if (!this.filePath) return;
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf8");
    } catch {
      // Volume not mounted or write error — silent
    }
  }

  getPath(): string | null {
    return this.filePath;
  }
}
