import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createLogger } from "./logger.mjs";

const SDK_PATH = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
} = await import(SDK_PATH);

const PORT = process.env.BRIDGE_PORT || 8080;
const PI_PROVIDER = process.env.PI_PROVIDER || "minimax";
const PI_MODEL = process.env.PI_MODEL || "MiniMax-M2.7";
const BRIDGE_TIMEOUT_MS = parseInt(process.env.BRIDGE_TIMEOUT_MS, 10) || 120000;
const VERSION = "3.0.0";
const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL || "";
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY || "";
const PAPERCLIP_AGENT_ID = process.env.PAPERCLIP_AGENT_ID || "";
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "";
const QUEUE_MAX_DEPTH = parseInt(process.env.QUEUE_MAX_DEPTH, 10) || 8;
const CWD = "/workspace/scratch";

const AGENT_NAME = process.env.AGENT_NAME || "";
const SERVICE_NAME = AGENT_NAME ? `${AGENT_NAME}-server` : "server";
const logger = createLogger({ service: SERVICE_NAME });

function log(level, event, data = {}) {
  logger[level]({ event, ...data }, event);
}

// --- Cost reporting ---

async function reportCostEvent(usage) {
  if (!PAPERCLIP_API_KEY || !PAPERCLIP_COMPANY_ID || !PAPERCLIP_AGENT_ID) return;
  if ((usage.inputTokens + usage.outputTokens) === 0) return;
  try {
    await fetch(`${PAPERCLIP_API_URL}/api/companies/${PAPERCLIP_COMPANY_ID}/cost-events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PAPERCLIP_API_KEY}`,
      },
      body: JSON.stringify({
        agentId: PAPERCLIP_AGENT_ID,
        provider: usage.provider,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
      }),
    });
    log("debug", "cost_reported", { input: usage.inputTokens, output: usage.outputTokens });
  } catch (err) {
    log("warn", "cost_report_failed", { error: err.message });
  }
}

// --- Metrics ---

const bootTime = Date.now();
const metrics = {
  requests_total: 0,
  requests_active: 0,
  requests_failed: 0,
  durations: [],
  last_request_at: null,
  cold_start_ms: null,
};

// --- Run tracking ---

const MAX_RUN_HISTORY = 100;
const runs = new Map();

function trackRun(runId, data) {
  runs.set(runId, { ...runs.get(runId), ...data });
  while (runs.size > MAX_RUN_HISTORY) {
    const oldest = runs.keys().next().value;
    runs.delete(oldest);
  }
}

// --- FIFO queue (Pi sessions are sequential — one prompt at a time) ---

const queue = [];
let processing = false;

function drainQueue() {
  if (processing || queue.length === 0) return;
  const next = queue.shift();
  next();
}

// --- Shared services (initialized once at boot) ---

let services = null;

async function initServices() {
  mkdirSync(CWD, { recursive: true });
  const t0 = Date.now();
  services = await createAgentSessionServices({ cwd: CWD });
  log("info", "services_init", {
    duration_ms: Date.now() - t0,
    extensions: services.resourceLoader.getExtensions().extensions.length,
  });
}

// --- Prompt extraction (same logic as bridge.mjs) ---

function extractPrompt(body) {
  const ctx = body.context || {};

  if (ctx.paperclipTaskMarkdown) return ctx.paperclipTaskMarkdown;

  if (ctx.paperclipWake) {
    const wake = ctx.paperclipWake;
    const parts = [];
    if (wake.issue) parts.push(`Issue: ${wake.issue.identifier || wake.issue.id} — ${wake.issue.title}\n${wake.issue.description || ""}`);
    if (wake.comments?.length) parts.push(`Latest comment:\n${wake.comments[wake.comments.length - 1].body}`);
    if (parts.length) return parts.join("\n\n");
  }

  if (ctx.paperclipIssue) {
    return `Issue: ${ctx.paperclipIssue.identifier || ctx.paperclipIssue.id} — ${ctx.paperclipIssue.title}\n${ctx.paperclipIssue.description || ""}`;
  }

  if (body.prompt || body.renderedPrompt) return body.prompt || body.renderedPrompt;

  const reason = ctx.wakeReason || "heartbeat";
  return `Wake reason: ${reason}. Check your inbox for assigned work.`;
}

// --- Process a single invocation ---

async function processInvocation(body, traceId, requestStart) {
  trackRun(traceId, { status: "running" });

  const ctx = body.context || {};
  const runId = body.runId || null;

  const wakeContext = {
    reason: ctx.wakeReason || "heartbeat",
    source: ctx.wakeSource || null,
    taskId: ctx.taskId || ctx.issueId || null,
    commentId: ctx.wakeCommentId || null,
    issueId: ctx.issueId || null,
    interactionId: ctx.interactionId || null,
    interactionKind: ctx.interactionKind || null,
    runId,
  };
  log("info", "wake_context", wakeContext);

  const prompt = extractPrompt(body);

  // Per-issue workspace
  const rawScope = wakeContext.issueId || runId || "scratch";
  const issueScope = rawScope.replace(/[^a-zA-Z0-9_-]/g, "-");
  const workDir = body.workspace || `/workspace/${issueScope}`;
  try { mkdirSync(workDir, { recursive: true }); } catch { /* non-fatal */ }

  // Fresh session per request — no session bleed
  let session;
  try {
    const result = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(),
    });
    session = result.session;
  } catch (err) {
    metrics.requests_active--;
    metrics.requests_failed++;
    log("error", "session_create_failed", { error: err.message, trace_id: traceId });
    trackRun(traceId, { status: "failed", completedAt: new Date().toISOString(), error: err.message });
    processing = false;
    drainQueue();
    return;
  }

  // Collect events
  const events = [];
  const usageByTurn = [];
  let output = "";

  session.subscribe((event) => {
    events.push(event);

    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (delta?.type === "text_delta") output += delta.delta;
    }

    if (event.type === "turn_end" && event.message?.usage) {
      usageByTurn.push({
        provider: event.message.provider || PI_PROVIDER,
        model: event.message.model || PI_MODEL,
        input: event.message.usage.input || 0,
        output: event.message.usage.output || 0,
        cacheRead: event.message.usage.cacheRead || 0,
      });
    }
  });

  // Send prompt with timeout
  log("info", "prompt_sent", { prompt_length: prompt.length, trace_id: traceId });

  try {
    await Promise.race([
      session.prompt(prompt),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), BRIDGE_TIMEOUT_MS)
      ),
    ]);
  } catch (err) {
    metrics.requests_active--;
    metrics.requests_failed++;
    const isTimeout = err.message === "timeout";
    log("error", "prompt_failed", { error: err.message, trace_id: traceId });
    trackRun(traceId, {
      status: isTimeout ? "timeout" : "failed",
      completedAt: new Date().toISOString(),
      error: err.message,
    });
    processing = false;
    drainQueue();
    return;
  }

  // Harvest results
  const totalDuration = Date.now() - requestStart;
  metrics.durations.push(totalDuration);
  metrics.requests_active--;
  if (metrics.cold_start_ms === null) metrics.cold_start_ms = totalDuration;

  const usage = {
    inputTokens: usageByTurn.reduce((s, u) => s + u.input, 0),
    outputTokens: usageByTurn.reduce((s, u) => s + u.output, 0),
    cachedInputTokens: usageByTurn.reduce((s, u) => s + u.cacheRead, 0),
    provider: usageByTurn[0]?.provider || PI_PROVIDER,
    model: usageByTurn[0]?.model || PI_MODEL,
    turns: usageByTurn.length,
  };

  log("info", "request_complete", {
    output_length: output.length,
    event_count: events.length,
    duration_ms: totalDuration,
    trace_id: traceId,
    usage,
  });

  reportCostEvent(usage).catch(() => {});

  trackRun(traceId, { status: "completed", completedAt: new Date().toISOString(), output, usage });

  processing = false;
  drainQueue();
}

// --- HTTP server ---

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      status: services ? "ok" : "starting",
      uptime_s: Math.floor((Date.now() - bootTime) / 1000),
      version: VERSION,
      config: { provider: PI_PROVIDER, model: PI_MODEL, port: Number(PORT) },
      busy: processing,
      queue_depth: queue.length,
      queue_max: QUEUE_MAX_DEPTH,
      runs_active: [...runs.values()].filter(r => r.status === "queued" || r.status === "running").length,
    }));
  }

  if (req.method === "GET" && req.url === "/metrics") {
    const totalDuration = metrics.durations.reduce((s, d) => s + d, 0);
    const avgDuration = metrics.durations.length > 0
      ? Math.round(totalDuration / metrics.durations.length)
      : 0;
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      requests_total: metrics.requests_total,
      requests_active: metrics.requests_active,
      requests_failed: metrics.requests_failed,
      avg_duration_ms: avgDuration,
      last_request_at: metrics.last_request_at,
      cold_start_ms: metrics.cold_start_ms,
      queue_depth: queue.length,
      runs_completed: [...runs.values()].filter(r => r.status === "completed").length,
      runs_active: [...runs.values()].filter(r => r.status === "queued" || r.status === "running").length,
    }));
  }

  if (req.method === "GET" && req.url.startsWith("/runs/")) {
    const runId = req.url.slice(6).split("?")[0];
    const run = runs.get(runId);
    if (!run) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "not_found" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ runId, ...run }));
  }

  if (req.method !== "POST" || req.url !== "/invoke") {
    res.writeHead(404);
    return res.end();
  }

  if (!services) {
    res.writeHead(503, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "starting", detail: "services not ready" }));
  }

  const requestStart = Date.now();
  const traceId = randomUUID().replace(/-/g, "");
  metrics.requests_total++;
  metrics.requests_active++;
  metrics.last_request_at = new Date().toISOString();

  log("info", "request_received", { method: req.method, url: req.url, trace_id: traceId });

  let body;
  try {
    const raw = await new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
    });
    if (!raw) throw new Error("empty body");
    body = JSON.parse(raw);
  } catch (err) {
    metrics.requests_active--;
    metrics.requests_failed++;
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "invalid_json", detail: err.message }));
  }

  // Check queue capacity before accepting
  if (processing && queue.length >= QUEUE_MAX_DEPTH) {
    metrics.requests_active--;
    metrics.requests_failed++;
    res.writeHead(429, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "queue_full", detail: `${queue.length}/${QUEUE_MAX_DEPTH}` }));
  }

  // Track run and respond 202 immediately
  trackRun(traceId, {
    status: "queued",
    startedAt: new Date().toISOString(),
    wakeReason: body.context?.wakeReason || "heartbeat",
    output: null,
    error: null,
    usage: null,
  });

  res.writeHead(202, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ runId: traceId, status: "accepted" }));

  if (processing) {
    log("info", "request_queued", { depth: queue.length + 1, trace_id: traceId });
    queue.push(() => {
      processing = true;
      processInvocation(body, traceId, requestStart);
    });
    return;
  }

  processing = true;
  processInvocation(body, traceId, requestStart);
});

// --- Startup ---

server.listen(PORT, async () => {
  log("info", "server_start", { port: Number(PORT), provider: PI_PROVIDER, model: PI_MODEL, version: VERSION });
  try {
    await initServices();

    if (!AGENT_NAME) {
      log("error", "missing_agent_name", { detail: "AGENT_NAME env var required — extensions will not load correctly" });
      process.exit(1);
    }

    const extCount = services.resourceLoader.getExtensions().extensions.length;
    if (extCount < 3) {
      log("error", "insufficient_extensions", { count: extCount, minimum: 3, detail: "Expected paperclip + artifacts + agent-specific extensions" });
      process.exit(1);
    }

    log("info", "ready", { startup_ms: Date.now() - bootTime, agent_name: AGENT_NAME, extensions: extCount });
  } catch (err) {
    log("error", "services_init_failed", { error: err.message });
    process.exit(1);
  }
});

// --- Graceful shutdown ---

function shutdown(reason) {
  log("info", "shutdown", { reason });
  for (const _ of queue.splice(0)) { /* drain — HTTP connections will timeout */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
