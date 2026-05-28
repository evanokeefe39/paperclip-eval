import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createLogger } from "./logger.mjs";


// --- Configuration ---

const PORT = process.env.BRIDGE_PORT || 8080;
const PI_PROVIDER = process.env.PI_PROVIDER || "minimax";
const PI_MODEL = process.env.PI_MODEL || "MiniMax-M2.7";
const BRIDGE_TIMEOUT_MS = parseInt(process.env.BRIDGE_TIMEOUT_MS, 10) || 120000;
const VERSION = "2.0.0";
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

// --- In-memory metrics counters ---

const startTime = Date.now();
const metrics = {
  requests_total: 0,
  requests_active: 0,
  requests_failed: 0,
  durations: [],
  last_request_at: null,
  cold_start_ms: null,
};

// --- FIFO request queue ---

const QUEUE_MAX_DEPTH = parseInt(process.env.QUEUE_MAX_DEPTH, 10) || 8;
const queue = [];
let processing = false;

function drainQueue() {
  if (processing) return;
  if (queue.length === 0) return;
  const next = queue.shift();
  next();
}

// --- Persistent Pi process lifecycle ---

const PI_MAX_RESPAWN_ATTEMPTS = 3;
const PI_RESPAWN_DELAYS = [1000, 2000, 4000]; // exponential backoff
const NEW_SESSION_TIMEOUT_MS = 5000;

const piState = {
  process: null,
  ready: false,
  startedAt: null,
  restarts: 0,
  lastCrashAt: null,
  readyPromise: null,
  stderrBuf: "",
};

/** Current request's event collector — only one active at a time (serialized by queue) */
let activeCollector = null;

/** Partial JSONL line buffer for the persistent stdout stream */
let stdoutBuf = "";

/** Whether a graceful shutdown is in progress */
let shuttingDown = false;

/**
 * Build the args array for spawning Pi in persistent RPC mode.
 * Extracted so both spawnPi and tests can inspect the arg list.
 */
function buildSpawnArgs() {
  const skillArgs = PAPERCLIP_SKILLS.flatMap(name => ["--skill", `${SKILLS_DIR}/${name}`]);
  return [
    "--mode", "rpc",
    "--no-session",
    "--provider", PI_PROVIDER,
    "--model", PI_MODEL,
    ...skillArgs,
  ];
}

/**
 * Spawn Pi as a persistent process. Sets up the single stdout JSONL parser
 * that routes events to the activeCollector (if one exists) or logs them
 * as background events.
 *
 * Returns a promise that resolves when Pi signals readiness (agent_start or
 * extension_ui_request on stdout).
 */
function spawnPi() {
  if (piState.readyPromise) return piState.readyPromise;

  piState.readyPromise = new Promise((resolve, reject) => {
    const args = buildSpawnArgs();
    log("info", "pi_spawn", { args, attempt: piState.restarts + 1 });

    let pi;
    try {
      fs.mkdirSync("/workspace/scratch", { recursive: true });
      pi = spawn("pi", args, {
        cwd: "/workspace/scratch",
        env: { ...process.env },
      });
    } catch (err) {
      piState.readyPromise = null;
      reject(err);
      return;
    }

    piState.process = pi;
    piState.startedAt = Date.now();
    piState.ready = false;
    piState.stderrBuf = "";
    stdoutBuf = "";

    let readyResolved = false;

    // Handle spawn errors (e.g. ENOENT)
    pi.on("error", (err) => {
      log("error", "pi_error", { error: "spawn error", detail: err.message });
      if (!readyResolved) {
        readyResolved = true;
        piState.readyPromise = null;
        piState.process = null;
        piState.ready = false;
        reject(err);
      }
    });

    // Collect stderr
    pi.stderr.on("data", (chunk) => {
      piState.stderrBuf += chunk.toString();
    });

    // Single persistent stdout JSONL parser
    pi.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      const parts = stdoutBuf.split("\n");
      // Last element is either "" (line ended with \n) or an incomplete line
      stdoutBuf = parts.pop() || "";

      for (const line of parts) {
        if (!line) continue;
        log("debug", "pi_raw_event", { raw: line.length > 500 ? line.slice(0, 500) + "…" : line });

        let event;
        try {
          event = JSON.parse(line);
        } catch (err) {
          log("warn", "pi_error", { error: "JSONL parse error", detail: err.message, raw: line.slice(0, 200) });
          continue;
        }

        // During startup: look for readiness signal
        if (!readyResolved) {
          if (event.type === "agent_start" || event.type === "extension_ui_request") {
            readyResolved = true;
            piState.ready = true;
            piState.readyPromise = null;
            resolve();
            // Don't push startup events to collector — there isn't one yet
            continue;
          }
        }

        // Route to active collector if one exists
        if (activeCollector) {
          activeCollector.events.push(event);

          if (event.type === "message_update") {
            const delta = event.assistantMessageEvent;
            if (delta?.type === "text_delta") activeCollector.output += delta.delta;
          }

          if (event.type === "turn_end" && event.message?.usage) {
            activeCollector.usageByTurn.push({
              provider: event.message.provider || PI_PROVIDER,
              model: event.message.model || PI_MODEL,
              input: event.message.usage.input || 0,
              output: event.message.usage.output || 0,
              cacheRead: event.message.usage.cacheRead || 0,
            });
          }

          if (event.type === "agent_end") {
            activeCollector.resolve();
          }

          // Also handle RPC responses (new_session ack) — routed to collector
          // for sendNewSession to inspect
          if (event.type === "response" && event.success === false && activeCollector) {
            activeCollector.reject(new Error(`pi rejected command: ${JSON.stringify(event)}`));
          }
        } else {
          // No active collector — background event (extension updates, etc.)
          log("debug", "pi_background_event", { type: event.type });

          // Handle new_session response outside of a collector context
          if (event.type === "response" && event.command === "new_session") {
            if (pendingNewSession) {
              if (event.success) {
                pendingNewSession.resolve();
              } else {
                pendingNewSession.reject(new Error("new_session failed"));
              }
              pendingNewSession = null;
            }
          }
        }
      }
    });

    // Handle unexpected process exit
    pi.on("close", (code, signal) => {
      const wasReady = piState.ready;
      piState.process = null;
      piState.ready = false;
      piState.readyPromise = null;
      piState.lastCrashAt = Date.now();

      log("warn", "pi_crash", { code, signal, was_ready: wasReady, restarts: piState.restarts });

      // If startup hadn't completed, reject the ready promise
      if (!readyResolved) {
        readyResolved = true;
        reject(new Error(`pi process exited before ready (code=${code}, signal=${signal})`));
        return;
      }

      // If an active collector is waiting, reject it
      if (activeCollector) {
        activeCollector.reject(new Error(`pi process crashed during request (code=${code})`));
        activeCollector = null;
      }

      // If a new_session response was pending, reject it
      if (pendingNewSession) {
        pendingNewSession.reject(new Error("pi process crashed during new_session"));
        pendingNewSession = null;
      }

      // Auto-respawn unless shutting down or too many attempts
      if (!shuttingDown && piState.restarts < PI_MAX_RESPAWN_ATTEMPTS) {
        const delay = PI_RESPAWN_DELAYS[piState.restarts] || PI_RESPAWN_DELAYS[PI_RESPAWN_DELAYS.length - 1];
        piState.restarts++;
        log("info", "pi_respawn_scheduled", { delay_ms: delay, attempt: piState.restarts });
        setTimeout(() => {
          spawnPi().then(() => {
            log("info", "pi_respawn_success", { restarts: piState.restarts });
            // Reset backoff counter on successful respawn
            piState.restarts = 0;
          }).catch((err) => {
            log("error", "pi_respawn_failed", { error: err.message, attempt: piState.restarts });
          });
        }, delay);
      } else if (!shuttingDown) {
        log("error", "pi_respawn_exhausted", { restarts: piState.restarts, max: PI_MAX_RESPAWN_ATTEMPTS });
      }
    });

    // Timeout waiting for readiness
    const readyTimeout = setTimeout(() => {
      if (!readyResolved) {
        readyResolved = true;
        piState.readyPromise = null;
        log("error", "pi_ready_timeout", { timeout_ms: BRIDGE_TIMEOUT_MS });
        try { pi.kill(); } catch { /* ignore */ }
        reject(new Error("timeout waiting for Pi readiness"));
      }
    }, BRIDGE_TIMEOUT_MS);

    // Clean up timeout if we resolve/reject before it fires
    const origResolve = resolve;
    const origReject = reject;
    resolve = (val) => { clearTimeout(readyTimeout); origResolve(val); };
    reject = (err) => { clearTimeout(readyTimeout); origReject(err); };
  });

  return piState.readyPromise;
}

/**
 * Ensure Pi is running and ready. If not spawned or not ready, wait for it.
 */
async function ensurePi() {
  if (piState.process && piState.ready) return;
  if (piState.readyPromise) {
    await piState.readyPromise;
    return;
  }
  await spawnPi();
}

/**
 * Pending new_session RPC response handler.
 * Set before writing the new_session command, resolved/rejected by the stdout parser.
 */
let pendingNewSession = null;

/**
 * Send a new_session command to reset Pi's conversation context between requests.
 * Waits for the RPC acknowledgement with a timeout.
 */
async function sendNewSession() {
  if (!piState.process || !piState.ready) {
    throw new Error("Pi not ready for new_session");
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingNewSession = null;
      reject(new Error("new_session timeout"));
    }, NEW_SESSION_TIMEOUT_MS);

    pendingNewSession = {
      resolve: () => { clearTimeout(timeout); resolve(); },
      reject: (err) => { clearTimeout(timeout); reject(err); },
    };

    piState.process.stdin.write(JSON.stringify({ type: "new_session" }) + "\n");
    log("debug", "new_session_sent", {});
  });
}

/**
 * Kill Pi and reset state. Used on error paths — next ensurePi() will respawn.
 */
function killPi(reason) {
  log("warn", "pi_kill", { reason });
  if (piState.process) {
    try { piState.process.kill(); } catch { /* ignore */ }
  }
  piState.process = null;
  piState.ready = false;
  piState.readyPromise = null;
  activeCollector = null;
  pendingNewSession = null;
}

// --- Process invocation (handles a single queued request) ---

async function processInvocation(body, traceId, spanId, traceparent, requestStart, res) {
  // --- Prompt construction (unchanged) ---
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

  // --- Ensure Pi is alive ---
  try {
    await ensurePi();
  } catch (err) {
    metrics.requests_active--;
    metrics.requests_failed++;
    log("error", "pi_error", { error: "ensurePi failed", detail: err.message });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "pi_spawn_failed", detail: err.message }));
    processing = false;
    drainQueue();
    return;
  }

  // --- Reset session context ---
  try {
    await sendNewSession();
    log("debug", "new_session_ack", {});
  } catch (err) {
    log("warn", "new_session_failed", { error: err.message });
    // Kill and respawn — the session state may be corrupt
    killPi("new_session failed");
    try {
      await ensurePi();
      await sendNewSession();
    } catch (retryErr) {
      metrics.requests_active--;
      metrics.requests_failed++;
      log("error", "pi_error", { error: "new_session retry failed", detail: retryErr.message });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "pi_session_reset_failed", detail: retryErr.message }));
      processing = false;
      drainQueue();
      return;
    }
  }

  // --- Set per-request env on Pi process (traceparent, run ID) ---
  // Note: Pi inherits env at spawn time. TRACEPARENT and PAPERCLIP_RUN_ID
  // are per-request, but in persistent mode we cannot change the process env.
  // These are included in the prompt context instead for traceability.

  // --- Ensure workspace directory exists ---
  const rawScope = wakeContext.issueId || runId || "scratch";
  const issueScope = rawScope.replace(/[^a-zA-Z0-9_-]/g, "-");
  const workDir = body.workspace || `/workspace/${issueScope}`;
  try {
    fs.mkdirSync(workDir, { recursive: true });
  } catch { /* non-fatal — Pi will use its cwd */ }

  // --- Set up per-request event collector ---
  const collectorPromise = new Promise((resolve, reject) => {
    activeCollector = {
      events: [],
      usageByTurn: [],
      output: "",
      resolve,
      reject,
    };
  });

  // --- Send prompt ---
  const promptSentAt = Date.now();
  piState.process.stdin.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");
  log("info", "pi_prompt_sent", { prompt_length: prompt.length, trace_id: traceId });

  // --- Wait for agent_start ---
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        clearInterval(check);
        reject(new Error("timeout waiting for pi agent_start"));
      }, BRIDGE_TIMEOUT_MS);

      const check = setInterval(() => {
        if (!activeCollector) {
          // Collector was rejected (pi crash)
          clearInterval(check);
          clearTimeout(timeout);
          reject(new Error("collector terminated before agent_start"));
          return;
        }
        if (activeCollector.events.some((e) => e.type === "response" && e.success === false)) {
          clearInterval(check);
          clearTimeout(timeout);
          reject(new Error("pi rejected prompt"));
          return;
        }
        if (activeCollector.events.some((e) => e.type === "agent_start")) {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 50);

      // If the collector promise rejects (pi crash), also reject the agent_start wait
      collectorPromise.catch((err) => {
        clearInterval(check);
        clearTimeout(timeout);
        reject(err);
      });
    });
  } catch (err) {
    metrics.requests_active--;
    metrics.requests_failed++;
    const isTimeout = err.message.includes("timeout");
    const statusCode = isTimeout ? 504 : 500;
    const errorType = isTimeout ? "timeout" : "pi_spawn_failed";
    log("error", "pi_error", { error: err.message, stderr: piState.stderrBuf });

    // Kill Pi on error — next request triggers respawn
    killPi("agent_start failed: " + err.message);

    activeCollector = null;
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: errorType, detail: err.message }));
    processing = false;
    drainQueue();
    return;
  }

  log("info", "pi_ready", {
    wait_ms: Date.now() - promptSentAt,
    prompt_acknowledged: true,
    extensions_active: activeCollector.events.some((e) => e.type === "extension_ui_request"),
  });

  // --- Wait for agent_end, with timeout ---
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("timeout waiting for agent_end"));
      }, BRIDGE_TIMEOUT_MS);

      // collectorPromise resolves on agent_end
      collectorPromise.then(() => {
        clearTimeout(timeout);
        resolve();
      }).catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  } catch (err) {
    metrics.requests_active--;
    metrics.requests_failed++;
    log("error", "pi_error", { error: err.message, stderr: piState.stderrBuf });

    // Kill Pi on timeout — next request triggers respawn
    killPi("agent_end failed: " + err.message);

    const collectedEvents = activeCollector ? activeCollector.events : [];
    activeCollector = null;
    res.writeHead(504, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "timeout", detail: err.message }));
    processing = false;
    drainQueue();
    return;
  }

  // --- Harvest results from collector ---
  const events = activeCollector.events;
  const usageByTurn = activeCollector.usageByTurn;
  const output = activeCollector.output;
  activeCollector = null;

  const totalDuration = Date.now() - requestStart;
  metrics.durations.push(totalDuration);
  metrics.requests_active--;

  // Record cold start baseline (first successful request)
  if (metrics.cold_start_ms === null) {
    metrics.cold_start_ms = totalDuration;
  }

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

  if (piState.stderrBuf) {
    log("warn", "pi_error", { error: "stderr output", stderr: piState.stderrBuf });
    piState.stderrBuf = "";
  }

  reportCostEvent(usage).catch(() => {});

  const statusCode = 200;
  log("info", "request_complete", { status: statusCode, duration_ms: totalDuration, trace_id: traceId });

  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    output,
    events,
    exitCode: null, // persistent process — no exit code per request
    trace_id: traceId,
    usage,
  }));

  processing = false;
  drainQueue();
}


// --- Server ---

const server = http.createServer(async (req, res) => {
  // --- Health endpoint ---
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
      busy: processing,
      queue_depth: queue.length,
      queue_max: QUEUE_MAX_DEPTH,
      pi_status: piState.ready ? "ready" : (piState.process ? "starting" : "stopped"),
      pi_uptime_s: piState.startedAt ? Math.floor((Date.now() - piState.startedAt) / 1000) : 0,
      pi_restarts: piState.restarts,
    }));
  }

  // --- Metrics endpoint ---
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
      cold_start_ms: metrics.cold_start_ms,
      queue_depth: queue.length,
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

  // --- Body parsing with error handling ---
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

  // --- Queue serialization ---
  // Only one request processes at a time (Pi handles one prompt at a time).
  // If already processing, enqueue. If queue is full, reject with 429.
  if (processing) {
    if (queue.length >= QUEUE_MAX_DEPTH) {
      metrics.requests_active--;
      metrics.requests_failed++;
      log("warn", "queue_full", { depth: queue.length, max: QUEUE_MAX_DEPTH });
      res.writeHead(429, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "queue_full", detail: `${queue.length} requests queued, max ${QUEUE_MAX_DEPTH}` }));
    }
    log("info", "request_queued", { depth: queue.length + 1, trace_id: traceId });
    queue.push(() => {
      processing = true;
      processInvocation(body, traceId, spanId, traceparent, requestStart, res);
    });
    return;
  }

  processing = true;
  processInvocation(body, traceId, spanId, traceparent, requestStart, res);
});

// --- Startup ---

server.listen(PORT, () => {
  log("info", "server_start", { port: Number(PORT), provider: PI_PROVIDER, model: PI_MODEL });
  spawnPi().then(() => {
    log("info", "pi_persistent_ready", { startup_ms: Date.now() - piState.startedAt, restarts: 0 });
  }).catch((err) => {
    log("error", "pi_startup_failed", { error: err.message });
    process.exit(1);
  });
});

// --- Graceful shutdown ---

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "shutdown", { reason });

  // Reject queued requests
  for (const queued of queue.splice(0)) {
    // Can't call queued() — it would start processing.
    // The HTTP connections will time out on their own.
  }

  if (piState.process) {
    piState.process.stdin.end();
    piState.process.on("close", () => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  } else {
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
