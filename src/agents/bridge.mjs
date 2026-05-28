import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createLogger } from "./logger.mjs";


// --- Configuration ---

const PORT = process.env.BRIDGE_PORT || 8080;
const PI_PROVIDER = process.env.PI_PROVIDER || "minimax";
const PI_MODEL = process.env.PI_MODEL || "MiniMax-M2.7";
const BRIDGE_TIMEOUT_MS = parseInt(process.env.BRIDGE_TIMEOUT_MS, 10) || 120000;
const VERSION = "1.1.0";
const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL || "";
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_API_KEY || "";
const PAPERCLIP_AGENT_ID = process.env.PAPERCLIP_AGENT_ID || "";
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "";

// --- Pino logger ---

const AGENT_NAME = process.env.AGENT_NAME || "";
const SERVICE_NAME = AGENT_NAME ? `${AGENT_NAME}-bridge` : "bridge";
const logger = createLogger({ service: SERVICE_NAME });

function log(level, event, data = {}) {
  logger[level]({ event, ...data }, event);
}

// --- Cost reporting to Paperclip ---

async function reportCostEvent(usage) {
  if (!PAPERCLIP_API_KEY || !PAPERCLIP_COMPANY_ID || !PAPERCLIP_AGENT_ID) return;
  if ((usage.inputTokens + usage.outputTokens) === 0) return;
  try {
    await fetch(`${PAPERCLIP_API_URL}/api/companies/${PAPERCLIP_COMPANY_ID}/cost-events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${PAPERCLIP_API_KEY}`,
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

// Extensions discovered via Pi-native autodiscovery from ~/.pi/agent/extensions/
// No bridge-side discovery needed — Pi scans *.ts and */index.ts at startup

// --- Paperclip skill discovery ---

const SKILLS_DIR = "/app/skills/paperclip-skills";
const PAPERCLIP_SKILLS = (process.env.PAPERCLIP_SKILLS || "paperclip,paperclip-converting-plans-to-tasks,para-memory-files")
  .split(",").map(s => s.trim()).filter(Boolean);

// --- 1.3 In-memory metrics counters ---

const startTime = Date.now();
const metrics = {
  requests_total: 0,
  requests_active: 0,
  requests_failed: 0,
  durations: [],
  last_request_at: null,
};

// --- Server ---

const server = http.createServer(async (req, res) => {
  // --- 1.2 Health endpoint ---
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      status: "ok",
      uptime_s: Math.floor((Date.now() - startTime) / 1000),
      version: VERSION,
      config: {
        provider: PI_PROVIDER,
        model: PI_MODEL,
        port: Number(PORT),
      },
    }));
  }

  // --- 1.3 Metrics endpoint ---
  if (req.method === "GET" && req.url === "/metrics") {
    const totalDuration = metrics.durations.reduce((sum, d) => sum + d, 0);
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
    }));
  }

  // Only POST /invoke beyond this point — everything else is 404
  if (req.method !== "POST" || req.url !== "/invoke") {
    res.writeHead(404);
    return res.end();
  }

  const requestStart = Date.now();
  const traceId = randomUUID().replace(/-/g, "");
  const spanId = randomUUID().replace(/-/g, "").slice(0, 16);
  const traceparent = `00-${traceId}-${spanId}-01`;
  metrics.requests_total++;
  metrics.requests_active++;
  metrics.last_request_at = new Date().toISOString();

  log("info", "request_received", {
    method: req.method,
    url: req.url,
    trace_id: traceId,
  });

  // --- 1.4 Body parsing with error handling ---
  let body;
  try {
    const rawBody = await new Promise((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
    });

    log("info", "request_received", { payload_size: rawBody.length });

    if (!rawBody) {
      metrics.requests_active--;
      metrics.requests_failed++;
      log("error", "pi_error", { error: "empty body" });
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid_json", detail: "empty body" }));
    }

    body = JSON.parse(rawBody);
  } catch (err) {
    metrics.requests_active--;
    metrics.requests_failed++;
    log("error", "pi_error", { error: "invalid JSON", detail: err.message });
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "invalid_json", detail: err.message }));
  }

  // HTTP adapter sends { agentId, runId, context } — no prompt/systemPrompt/env
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

  // Build prompt from Paperclip's pre-rendered task markdown, fall back to wake payload
  let prompt;
  if (ctx.paperclipTaskMarkdown) {
    prompt = ctx.paperclipTaskMarkdown;
  } else if (ctx.paperclipWake) {
    const wake = ctx.paperclipWake;
    const parts = [];
    if (wake.issue) parts.push(`Issue: ${wake.issue.identifier || wake.issue.id} — ${wake.issue.title}\n${wake.issue.description || ""}`);
    if (wake.comments?.length) parts.push(`Latest comment:\n${wake.comments[wake.comments.length - 1].body}`);
    prompt = parts.join("\n\n") || `Wake reason: ${wakeContext.reason}. Check your inbox.`;
  } else if (ctx.paperclipIssue) {
    prompt = `Issue: ${ctx.paperclipIssue.identifier || ctx.paperclipIssue.id} — ${ctx.paperclipIssue.title}\n${ctx.paperclipIssue.description || ""}`;
  } else if (body.prompt || body.renderedPrompt) {
    // Backward compat: direct bridge testing with {prompt: "..."} payload
    prompt = body.prompt || body.renderedPrompt;
  } else {
    prompt = `Wake reason: ${wakeContext.reason}. Check your inbox for assigned work.`;
  }

  const systemPrompt = "";

  const skillArgs = PAPERCLIP_SKILLS.flatMap(name => ["--skill", `${SKILLS_DIR}/${name}`]);

  const spawnArgs = [
    "--mode", "rpc",
    "--no-session",
    "--provider", PI_PROVIDER,
    "--model", PI_MODEL,
    ...skillArgs,
    ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
  ];

  log("info", "pi_spawn", { args: spawnArgs });

  // --- 1.4 Spawn error handling ---
  let pi;
  try {
    pi = spawn("pi", spawnArgs, {
      cwd: body.workspace || "/workspace",
      env: { ...process.env, TRACEPARENT: traceparent, ...(runId ? { PAPERCLIP_RUN_ID: runId } : {}) },
    });
  } catch (err) {
    metrics.requests_active--;
    metrics.requests_failed++;
    log("error", "pi_error", { error: "spawn failed", detail: err.message });
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "pi_spawn_failed", detail: err.message }));
  }

  // Handle spawn errors that arrive asynchronously (e.g. ENOENT)
  let spawnError = null;
  pi.on("error", (err) => {
    spawnError = err;
  });

  const promptSentAt = Date.now();
  pi.stdin.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");
  log("info", "pi_prompt_sent", { prompt_length: prompt.length });

  const events = [];
  const usageByTurn = [];
  let output = "";
  let stderrOutput = "";

  pi.stderr.on("data", (chunk) => {
    stderrOutput += chunk.toString();
  });

  // Buffer partial JSONL lines across chunks — a single event can exceed 64KB
  // and arrive split across multiple TCP reads
  let stdoutBuf = "";
  pi.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    const parts = stdoutBuf.split("\n");
    // Last element is either "" (line ended with \n) or an incomplete line
    stdoutBuf = parts.pop() || "";

    for (const line of parts) {
      if (!line) continue;
      log("debug", "pi_raw_event", { raw: line.length > 500 ? line.slice(0, 500) + "…" : line });

      try {
        const event = JSON.parse(line);
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
      } catch (err) {
        log("warn", "pi_error", { error: "JSONL parse error", detail: err.message, raw: line.slice(0, 200) });
      }
    }
  });

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(check);
        reject(new Error("timeout waiting for pi agent_start"));
      }, BRIDGE_TIMEOUT_MS);

      const check = setInterval(() => {
        if (spawnError) {
          clearInterval(check);
          clearTimeout(timeout);
          reject(spawnError);
          return;
        }
        if (events.some((e) => e.type === "response" && e.success === false)) {
          clearInterval(check);
          clearTimeout(timeout);
          reject(new Error("pi rejected prompt"));
          return;
        }
        if (events.some((e) => e.type === "agent_start")) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);

      pi.on("close", () => {
        clearInterval(check);
        clearTimeout(timeout);
        if (!events.some((e) => e.type === "agent_start")) {
          reject(new Error("pi process exited before agent_start"));
        }
      });
    });
  } catch (err) {
    metrics.requests_active--;
    metrics.requests_failed++;
    const isTimeout = err.message.includes("timeout");
    const statusCode = isTimeout ? 504 : 500;
    const errorType = isTimeout ? "timeout" : "pi_spawn_failed";
    log("error", "pi_error", { error: err.message, stderr: stderrOutput });
    try { pi.kill(); } catch {}
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: errorType, detail: err.message }));
  }

  log("info", "pi_ready", { wait_ms: Date.now() - promptSentAt, prompt_acknowledged: true, extensions_active: events.some((e) => e.type === "extension_ui_request") });

  // --- Wait for agent_end or process exit, with timeout ---
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(check);
        reject(new Error("timeout waiting for agent_end"));
      }, BRIDGE_TIMEOUT_MS);

      const check = setInterval(() => {
        if (events.some((e) => e.type === "agent_end")) {
          clearInterval(check);
          clearTimeout(timeout);
          pi.stdin.end();
        }
      }, 100);

      pi.on("close", () => {
        clearInterval(check);
        clearTimeout(timeout);
        resolve();
      });
    });
  } catch (err) {
    metrics.requests_active--;
    metrics.requests_failed++;
    log("error", "pi_error", { error: err.message, stderr: stderrOutput });
    try { pi.kill(); } catch {}
    res.writeHead(504, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "timeout", detail: err.message }));
  }

  const totalDuration = Date.now() - requestStart;
  metrics.durations.push(totalDuration);
  metrics.requests_active--;

  const usage = {
    inputTokens: usageByTurn.reduce((s, u) => s + u.input, 0),
    outputTokens: usageByTurn.reduce((s, u) => s + u.output, 0),
    cachedInputTokens: usageByTurn.reduce((s, u) => s + u.cacheRead, 0),
    provider: usageByTurn[0]?.provider || PI_PROVIDER,
    model: usageByTurn[0]?.model || PI_MODEL,
    turns: usageByTurn.length,
  };

  log("info", "pi_response", {
    output_length: output.length,
    event_count: events.length,
    duration_ms: totalDuration,
    trace_id: traceId,
    usage,
  });

  if (stderrOutput) {
    log("warn", "pi_error", { error: "stderr output", stderr: stderrOutput });
  }

  reportCostEvent(usage).catch(() => {});

  const statusCode = 200;
  log("info", "request_complete", { status: statusCode, duration_ms: totalDuration, trace_id: traceId });

  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    output,
    events,
    exitCode: pi.exitCode,
    trace_id: traceId,
    usage,
  }));
});

server.listen(PORT, () => {
  log("info", "server_start", { port: Number(PORT), provider: PI_PROVIDER, model: PI_MODEL });
});
