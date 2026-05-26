import type { LogEntry } from "./types.js";

type PiLike = { events?: { emit?: (event: string, data: unknown) => void } };

const SEVERITY_MAP: Record<string, string> = {
  debug: "DEBUG",
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
};

export class OtelEmitter {
  private emit: ((event: string, data: unknown) => void) | null = null;

  constructor(pi: unknown) {
    const piAny = pi as PiLike;
    if (piAny?.events?.emit) {
      this.emit = piAny.events.emit.bind(piAny.events);
    }
  }

  send(entry: LogEntry): void {
    if (!this.emit) return;
    try {
      this.emit("pi-otel:log", {
        severityText: SEVERITY_MAP[entry.level] || "INFO",
        body: `[${entry.event}] ${entry.message}`,
        attributes: {
          "log.agent": entry.agent,
          "log.event": entry.event,
          "log.level": entry.level,
          "log.trace_id": entry.trace_id,
          ...flattenMeta(entry.meta),
        },
      });
    } catch {
      // pi-otel not active — silent
    }
  }

  isAvailable(): boolean {
    return this.emit !== null;
  }
}

function flattenMeta(meta: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    out[`log.meta.${k}`] = s.length > 4096 ? s.slice(0, 4093) + "..." : s;
  }
  return out;
}
