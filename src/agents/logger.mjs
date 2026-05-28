import pino from "pino";
import { Writable } from "node:stream";

const SEVERITY_NUMBER = { trace: 1, debug: 5, info: 9, warn: 13, error: 17, fatal: 21 };

const FLUSH_INTERVAL_MS = 2000;
const FLUSH_BATCH_SIZE = 50;

class OtlpLogStream extends Writable {
  #buffer = [];
  #timer = null;
  #endpoint;
  #serviceName;

  constructor(endpoint, serviceName) {
    super();
    this.#endpoint = endpoint;
    this.#serviceName = serviceName;
  }

  _write(chunk, _enc, cb) {
    if (!this.#endpoint) { cb(); return; }
    try {
      const obj = JSON.parse(chunk.toString());
      this.#buffer.push(this.#toLogRecord(obj));
      if (this.#buffer.length >= FLUSH_BATCH_SIZE) {
        this.#flush();
      } else if (!this.#timer) {
        this.#timer = setTimeout(() => this.#flush(), FLUSH_INTERVAL_MS);
      }
    } catch {
      // malformed log line — skip
    }
    cb();
  }

  _final(cb) {
    this.#flush();
    cb();
  }

  #toLogRecord(obj) {
    const timeMs = obj.ts ? new Date(obj.ts).getTime() : Date.now();
    const level = obj.level || "info";
    const attrs = [];
    for (const [k, v] of Object.entries(obj)) {
      if (["level", "ts", "msg", "pid", "hostname", "service", "trace_id", "span_id"].includes(k)) continue;
      const sv = typeof v === "string" ? v : JSON.stringify(v);
      attrs.push({ key: k, value: { stringValue: sv.length > 4096 ? sv.slice(0, 4093) + "..." : sv } });
    }
    return {
      timeUnixNano: String(BigInt(timeMs) * 1000000n),
      severityNumber: SEVERITY_NUMBER[level] || 9,
      severityText: level.toUpperCase(),
      body: { stringValue: obj.msg || "" },
      attributes: attrs,
      traceId: obj.trace_id || "",
      spanId: obj.span_id || "",
    };
  }

  #flush() {
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    if (this.#buffer.length === 0) return;
    const records = this.#buffer.splice(0);
    const payload = {
      resourceLogs: [{
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: this.#serviceName } },
          ],
        },
        scopeLogs: [{
          scope: { name: "pino", version: "1.0.0" },
          logRecords: records,
        }],
      }],
    };
    fetch(`${this.#endpoint}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }
}

/**
 * Create a Pino logger that writes JSON to stdout and optionally sends
 * OTLP HTTP log records to an OpenTelemetry collector (e.g. Aspire Dashboard).
 *
 * @param {{ service?: string, otlpEndpoint?: string }} opts
 */
export function createLogger(opts = {}) {
  const service = opts.service || process.env.OTEL_SERVICE_NAME || "unknown";
  const otlpEndpoint = opts.otlpEndpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "";

  const streams = [{ stream: process.stdout }];
  if (otlpEndpoint) {
    streams.push({
      stream: new OtlpLogStream(otlpEndpoint, service),
      level: process.env.OTEL_LOG_LEVEL || "info",
    });
  }

  return pino(
    {
      level: process.env.LOG_LEVEL || "info",
      formatters: {
        level(label) { return { level: label }; },
      },
      base: { service, pid: process.pid },
      timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    },
    pino.multistream(streams),
  );
}
