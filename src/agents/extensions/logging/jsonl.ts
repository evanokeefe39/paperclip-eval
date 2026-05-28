import * as client from "../lib/artifact-client.js";

export class JsonlWriter {
  private agentName: string;
  private enabled: boolean;

  constructor(agentName: string, enabled: boolean) {
    this.agentName = agentName;
    this.enabled = enabled;
  }

  append(entry: Record<string, unknown>): void {
    if (!this.enabled || !this.agentName) return;
    client.append({
      filename: "run.log.jsonl",
      line: JSON.stringify(entry),
      type: "log",
      bucket: "logs",
    }).catch(() => {});
  }

  getPath(): string | null {
    if (!this.enabled || !this.agentName) return null;
    return `logs/${this.agentName}/run.log.jsonl`;
  }
}
