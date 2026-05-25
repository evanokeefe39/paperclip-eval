import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// --- Configuration ---

const PORT = process.env.BRIDGE_PORT || 8080;
const PI_PROVIDER = process.env.PI_PROVIDER || "minimax";
const PI_MODEL = process.env.PI_MODEL || "MiniMax-M2.7";
const BRIDGE_TIMEOUT_MS = parseInt(process.env.BRIDGE_TIMEOUT_MS, 10) || 120000;
const VERSION = "1.0.0";

// --- 1.1 Hand-rolled JSON logger ---

const LOG_LEVEL = process.env.LOG_LEVEL || "info";
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level, event, data = {}) {
  if (LEVELS[level] < LEVELS[LOG_LEVEL]) return;
  const entry = { ts: new Date().toISOString(), level, event, pid: process.pid, ...data };
  process.stdout.write(JSON.stringify(entry) + "\n");
}

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
  metrics.requests_total++;
  metrics.requests_active++;
  metrics.last_request_at = new Date().toISOString();

  log("info", "request_received", {
    method: req.method,
    url: req.url,
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

  const systemPrompt = body.systemPrompt || "";
  const prompt = body.prompt || body.renderedPrompt || "Continue your work.";

  const spawnArgs = [
    "--mode", "rpc",
    "--no-session",
    "--provider", PI_PROVIDER,
    "--model", PI_MODEL,
    ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
  ];

  log("info", "pi_spawn", { args: spawnArgs });

  // --- 1.4 Spawn error handling ---
  let pi;
  try {
    pi = spawn("pi", spawnArgs, {
      cwd: body.workspace || "/workspace",
      env: { ...process.env, ...body.env },
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
  let output = "";
  let stderrOutput = "";

  pi.stderr.on("data", (chunk) => {
    stderrOutput += chunk.toString();
  });

  pi.stdout.on("data", (chunk) => {
    const lines = chunk.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      // --- 1.6 Protocol capture mode ---
      log("debug", "pi_raw_event", { raw: line });

      try {
        const event = JSON.parse(line);
        events.push(event);
        if (event.type === "message_update") {
          const delta = event.assistantMessageEvent;
          if (delta?.type === "text_delta") output += delta.delta;
        }
      } catch (err) {
        log("warn", "pi_error", { error: "JSONL parse error", detail: err.message, raw: line });
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

  log("info", "pi_response", {
    output_length: output.length,
    event_count: events.length,
    duration_ms: totalDuration,
  });

  if (stderrOutput) {
    log("warn", "pi_error", { error: "stderr output", stderr: stderrOutput });
  }

  const statusCode = 200;
  log("info", "request_complete", { status: statusCode, duration_ms: totalDuration });

  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    output,
    events,
    exitCode: pi.exitCode,
  }));
});

server.listen(PORT, () => {
  log("info", "server_start", { port: Number(PORT), provider: PI_PROVIDER, model: PI_MODEL });
});
