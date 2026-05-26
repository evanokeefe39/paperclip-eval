import type { LogEntry, LogLevel } from "./types.js";

export class RingBuffer {
  private items: LogEntry[];
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.items = new Array(capacity);
  }

  push(entry: LogEntry): void {
    this.items[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  query(filters: { level?: LogLevel; event?: string; since?: string; limit?: number }): LogEntry[] {
    const limit = filters.limit ?? 50;
    const results: LogEntry[] = [];

    let idx = (this.head - 1 + this.capacity) % this.capacity;
    for (let i = 0; i < this.count && results.length < limit; i++) {
      const entry = this.items[idx];
      idx = (idx - 1 + this.capacity) % this.capacity;

      if (filters.level && entry.level !== filters.level) continue;
      if (filters.event && entry.event !== filters.event) continue;
      if (filters.since && entry.ts < filters.since) continue;

      results.push(entry);
    }

    return results;
  }

  size(): number {
    return this.count;
  }
}
