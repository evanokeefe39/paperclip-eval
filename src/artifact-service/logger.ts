import pino from "pino";
import { Writable } from "node:stream";

const SEVERITY_NUMBER: Record<string, number> = {
  trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21,
};

const FLUSH_INTERVAL_MS = 2000;
const FLUSH_BATCH_SIZE = 50;

interface OtlpAttribute {
  key: string;
  value: { stringValue: string };
}

interface OtlpLogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: OtlpAttribute[];
  traceId: string;
  spanId: string;
}

class OtlpLogStream extends Writable {
  private buffer: OtlpLogRecord[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private endpoint: string;
  private serviceName: string;

  constructor(endpoint: string, serviceName: string) {
    super();
    this.endpoint = endpoint;
    this.serviceName = serviceName;
  }

  override _write(chunk: Buffer, _enc: string, cb: () => void): void {
    if (!this.endpoint) { cb(); return; }
    try {
      const obj = JSON.parse(chunk.toString());
      this.buffer.push(this.toLogRecord(obj));
      if (this.buffer.length >= FLUSH_BATCH_SIZE) {
        this.flush();
      } else if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
      }
    } catch {
      // skip malformed
    }
    cb();
  }

  override _final(cb: () => void): void {
    this.flush();
    cb();
  }

  private toLogRecord(obj: Record<string, unknown>): OtlpLogRecord {
    const ts = obj.ts as string | undefined;
    const timeMs = ts ? new Date(ts).getTime() : Date.now();
    const level = (obj.level as string) || "info";
    const attrs: OtlpAttribute[] = [];
    const skip = new Set(["level", "ts", "msg", "pid", "hostname", "service", "trace_id", "span_id"]);
    for (const [k, v] of Object.entries(obj)) {
      if (skip.has(k)) continue;
      const sv = typeof v === "string" ? v : JSON.stringify(v);
      attrs.push({ key: k, value: { stringValue: sv.length > 4096 ? sv.slice(0, 4093) + "..." : sv } });
    }
    return {
      timeUnixNano: String(BigInt(timeMs) * 1000000n),
      severityNumber: SEVERITY_NUMBER[level] || 9,
      severityText: level.toUpperCase(),
      body: { stringValue: (obj.msg as string) || "" },
      attributes: attrs,
      traceId: (obj.trace_id as string) || "",
      spanId: (obj.span_id as string) || "",
    };
  }

  private flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.buffer.length === 0) return;
    const records = this.buffer.splice(0);
    const payload = {
      resourceLogs: [{
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: this.serviceName } },
          ],
        },
        scopeLogs: [{
          scope: { name: "pino", version: "1.0.0" },
          logRecords: records,
        }],
      }],
    };
    fetch(`${this.endpoint}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }
}

function createLogger(service: string): pino.Logger {
  const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "";

  const streams: pino.StreamEntry[] = [{ stream: process.stdout }];
  if (otlpEndpoint) {
    streams.push({
      stream: new OtlpLogStream(otlpEndpoint, service) as unknown as pino.DestinationStream,
      level: (process.env.OTEL_LOG_LEVEL || "info") as pino.Level,
    });
  }

  return pino(
    {
      level: process.env.LOG_LEVEL || "info",
      formatters: {
        level(label: string) { return { level: label }; },
      },
      base: { service, pid: process.pid },
      timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    },
    pino.multistream(streams),
  );
}

export const log = createLogger("artifact-service");
