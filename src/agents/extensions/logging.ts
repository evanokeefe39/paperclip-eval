import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type { LogLevel, LogEntry } from "./logging/types.js";
import { LOG_LEVELS } from "./logging/types.js";
import { RingBuffer } from "./logging/buffer.js";
import { JsonlWriter } from "./logging/jsonl.js";
import { OtelEmitter } from "./logging/otel.js";

const AGENT_NAME = process.env.AGENT_NAME || "";
const TRACE_ID = process.env.TRACEPARENT?.split("-")[1] || randomUUID().replace(/-/g, "");
const BUFFER_SIZE = parseInt(process.env.LOG_BUFFER_SIZE || "1000", 10);
const JSONL_ENABLED = process.env.LOG_JSONL_ENABLED !== "false";

export default function (pi: ExtensionAPI) {
  const buffer = new RingBuffer(BUFFER_SIZE);
  const writer = new JsonlWriter(AGENT_NAME, JSONL_ENABLED);
  const otel = new OtelEmitter(pi);

  function createEntry(level: LogLevel, event: string, message: string, meta: Record<string, unknown> = {}): LogEntry {
    return {
      ts: new Date().toISOString(),
      agent: AGENT_NAME,
      level,
      event,
      message,
      trace_id: TRACE_ID,
      meta,
    };
  }

  pi.registerTool({
    name: "log_event",
    label: "Log Event",
    description:
      "Log a structured event. Use for decisions, progress updates, warnings, and errors. Entries go to JSONL file, in-memory buffer, and OTel dashboard.",
    promptSnippet:
      "Log important decisions, progress milestones, and errors using log_event. " +
      "Use get_log to review recent activity. Use get_trace_id for cross-agent correlation.",
    parameters: Type.Object({
      level: Type.Union([
        Type.Literal("debug"),
        Type.Literal("info"),
        Type.Literal("warn"),
        Type.Literal("error"),
      ], { description: "Log level" }),
      event: Type.String({ description: "Event type (e.g. decision, progress, rate_limit, error)" }),
      message: Type.String({ description: "Human-readable description" }),
      metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
        description: "Structured data (tool params, timing, counts)",
      })),
    }),
    async execute(_toolCallId: string, params: Record<string, any>, _signal?: AbortSignal) {
      const entry = createEntry(
        params.level as LogLevel,
        params.event,
        params.message,
        params.metadata || {},
      );

      buffer.push(entry);
      writer.append(entry);
      otel.send(entry);

      return {
        content: [{
          type: "text" as const,
          text: `Logged [${entry.level}] ${entry.event}: ${entry.message}`,
        }],
        details: { trace_id: TRACE_ID, ts: entry.ts },
      };
    },
  });

  pi.registerTool({
    name: "get_log",
    label: "Get Log",
    description:
      "Query recent log entries from this run. Filter by level, event type, or time. Returns most recent first.",
    parameters: Type.Object({
      level: Type.Optional(Type.Union([
        Type.Literal("debug"),
        Type.Literal("info"),
        Type.Literal("warn"),
        Type.Literal("error"),
      ], { description: "Filter by level" })),
      event: Type.Optional(Type.String({ description: "Filter by event type" })),
      since: Type.Optional(Type.String({ description: "ISO 8601 — only entries after this time" })),
      limit: Type.Optional(Type.Number({ description: "Max entries to return (default 50)" })),
    }),
    async execute(_toolCallId: string, params: Record<string, any>, _signal?: AbortSignal) {
      const entries = buffer.query({
        level: params.level as LogLevel | undefined,
        event: params.event,
        since: params.since,
        limit: params.limit,
      });

      if (entries.length === 0) {
        return { content: [{ type: "text" as const, text: "No log entries match filters." }] };
      }

      const lines = [`${entries.length} entries (most recent first):\n`];
      for (const e of entries) {
        lines.push(`[${e.ts}] [${e.level}] ${e.event}: ${e.message}`);
        if (Object.keys(e.meta).length > 0) {
          lines.push(`  meta: ${JSON.stringify(e.meta)}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { count: entries.length, buffer_size: buffer.size() },
      };
    },
  });

  pi.registerTool({
    name: "get_trace_id",
    label: "Get Trace ID",
    description:
      "Return the trace ID for this agent run. Use in artifact metadata or Paperclip issue comments for cross-agent correlation.",
    parameters: Type.Object({}),
    async execute(_toolCallId: string, _params: Record<string, any>, _signal?: AbortSignal) {
      const jsonlPath = writer.getPath();
      return {
        content: [{
          type: "text" as const,
          text: [
            `Trace ID: ${TRACE_ID}`,
            `Agent: ${AGENT_NAME}`,
            `JSONL: ${jsonlPath || "(disabled)"}`,
            `OTel: ${otel.isAvailable() ? "active" : "unavailable"}`,
            `Buffer: ${buffer.size()} entries`,
          ].join("\n"),
        }],
        details: { trace_id: TRACE_ID, agent: AGENT_NAME },
      };
    },
  });
}
