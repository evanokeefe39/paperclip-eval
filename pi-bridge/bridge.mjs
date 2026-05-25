import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const PORT = process.env.BRIDGE_PORT || 8080;
const PI_PROVIDER = process.env.PI_PROVIDER || "anthropic";
const PI_MODEL = process.env.PI_MODEL || "claude-sonnet-4-20250514";

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/invoke") {
    res.writeHead(404);
    return res.end();
  }

  const body = await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(JSON.parse(data)));
  });

  const systemPrompt = body.systemPrompt || "";
  const prompt = body.prompt || body.renderedPrompt || "Continue your work.";

  const pi = spawn("pi", [
    "--mode", "rpc",
    "--no-session",
    "--provider", PI_PROVIDER,
    "--model", PI_MODEL,
    ...(systemPrompt ? ["--append-system-prompt", systemPrompt] : []),
  ], {
    cwd: body.workspace || "/workspace",
    env: { ...process.env, ...body.env },
  });

  const events = [];
  let output = "";

  pi.stdout.on("data", (chunk) => {
    const lines = chunk.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        events.push(event);
        if (event.type === "message_update") {
          const delta = event.assistantMessageEvent;
          if (delta?.type === "text_delta") output += delta.delta;
        }
      } catch {}
    }
  });

  // Wait for ready, then send prompt
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (events.some((e) => e.type === "ready")) {
        clearInterval(check);
        resolve();
      }
    }, 50);
  });

  pi.stdin.write(JSON.stringify({ type: "prompt", message: prompt }) + "\n");

  // Wait for agent_end or process exit
  await new Promise((resolve) => {
    pi.on("close", resolve);
    const check = setInterval(() => {
      if (events.some((e) => e.type === "agent_end")) {
        clearInterval(check);
        pi.stdin.end();
      }
    }, 100);
  });

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    output,
    events,
    exitCode: pi.exitCode,
  }));
});

server.listen(PORT, () => console.log(`Bridge listening on :${PORT}`));
