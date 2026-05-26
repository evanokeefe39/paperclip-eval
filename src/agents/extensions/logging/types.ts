export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogEntry {
  ts: string;
  agent: string;
  level: LogLevel;
  event: string;
  message: string;
  trace_id: string;
  meta: Record<string, unknown>;
}
