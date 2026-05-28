import { loadRules } from "./rbac";
import {
  handleWrite,
  handleRead,
  handleList,
  handleUpdate,
  handleHealth,
} from "./routes";
import { log } from "./logger";

loadRules();

const PORT = parseInt(process.env.PORT || "8090", 10);

Bun.serve({
  port: PORT,
  async fetch(req) {
    const start = Date.now();
    const url = new URL(req.url);
    const agentName = req.headers.get("x-agent-name") || "unknown";

    let res: Response;
    try {
      if (url.pathname === "/health") {
        res = await handleHealth(req, agentName);
      } else if (url.pathname === "/artifacts" && req.method === "POST") {
        res = await handleWrite(req, agentName);
      } else if (url.pathname.startsWith("/artifacts/") && req.method === "GET") {
        res = await handleRead(req, agentName);
      } else if (url.pathname === "/artifacts" && req.method === "GET") {
        res = await handleList(req, agentName);
      } else if (url.pathname.startsWith("/artifacts/") && req.method === "PATCH") {
        res = await handleUpdate(req, agentName);
      } else {
        res = Response.json({ error: "not found", status: 404 }, { status: 404 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      log.error({ event: "request_error", method: req.method, path: url.pathname, agent: agentName, error: message }, "request_error");
      res = Response.json({ error: message, status: 500 }, { status: 500 });
    }

    const duration = Date.now() - start;
    if (url.pathname !== "/health") {
      log.info({ event: "request", method: req.method, path: url.pathname, status: res.status, agent: agentName, duration_ms: duration }, "request");
    }
    return res;
  },
});

log.info({ event: "server_start", port: PORT }, "server_start");
