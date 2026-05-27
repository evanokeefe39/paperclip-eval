import { loadRules } from "./rbac";
import {
  handleWrite,
  handleRead,
  handleList,
  handleUpdate,
  handleHealth,
} from "./routes";

loadRules();

const PORT = parseInt(process.env.PORT || "8090", 10);

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const agentName = req.headers.get("x-agent-name") || "unknown";

    try {
      if (url.pathname === "/health") {
        return handleHealth(req, agentName);
      }
      if (url.pathname === "/artifacts" && req.method === "POST") {
        return handleWrite(req, agentName);
      }
      if (url.pathname.startsWith("/artifacts/") && req.method === "GET") {
        return handleRead(req, agentName);
      }
      if (url.pathname === "/artifacts" && req.method === "GET") {
        return handleList(req, agentName);
      }
      if (url.pathname.startsWith("/artifacts/") && req.method === "PATCH") {
        return handleUpdate(req, agentName);
      }
      return Response.json({ error: "not found", status: 404 }, { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      return Response.json({ error: message, status: 500 }, { status: 500 });
    }
  },
});

console.log(`artifact-service listening on :${PORT}`);
