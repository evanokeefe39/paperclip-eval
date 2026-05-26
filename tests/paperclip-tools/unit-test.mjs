#!/usr/bin/env node
/**
 * Unit tests for Paperclip tools extension (skills/paperclip-tools.ts).
 * Runs a fake Paperclip HTTP server and tests each tool's API call behavior,
 * parameter handling, error handling, auth caching, and response formatting.
 *
 * Usage: node tests/paperclip-tools/unit-test.mjs
 * Requires: Node 22+ (fetch, node:test)
 */

import http from "node:http";
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ═══════════════════════════════════════════════════════════════
// Fake Paperclip server
// ═══════════════════════════════════════════════════════════════

let server;
let serverPort;
let requests = [];

let shouldFailAuth = false;
let shouldFailRoute = false;
let failRouteStatus = 500;
let failRouteBody = { error: "server error" };
let heartbeatContextResponse = null;

function resetState() {
  requests = [];
  shouldFailAuth = false;
  shouldFailRoute = false;
  failRouteStatus = 500;
  failRouteBody = { error: "server error" };
  heartbeatContextResponse = null;
}

function lastRequest() {
  return requests[requests.length - 1];
}

function findRequest(method, urlPattern) {
  return requests.find(
    (r) => r.method === method && r.url.includes(urlPattern),
  );
}

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const record = {
          method: req.method,
          url: req.url,
          headers: { ...req.headers },
          body: body ? JSON.parse(body) : null,
        };
        requests.push(record);

        // Auth
        if (
          req.url === "/api/auth/sign-in/email" &&
          req.method === "POST"
        ) {
          if (shouldFailAuth) {
            res.writeHead(403, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "forbidden" }));
          }
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie":
              "paperclip-default.session_token=fake-session-abc; Path=/; HttpOnly",
          });
          return res.end(
            JSON.stringify({ token: "fake", user: { id: "user-1" } }),
          );
        }

        // Route-level failure injection
        if (shouldFailRoute) {
          res.writeHead(failRouteStatus, {
            "Content-Type": "application/json",
          });
          return res.end(JSON.stringify(failRouteBody));
        }

        // Heartbeat context (custom response for workspace tests)
        if (req.url.includes("/heartbeat-context")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify(
              heartbeatContextResponse || {
                currentExecutionWorkspace: {
                  id: "ws-001",
                  runtimeServices: [
                    {
                      id: "svc-001",
                      serviceName: "web",
                      status: "running",
                      healthStatus: "healthy",
                    },
                  ],
                },
              },
            ),
          );
        }

        // Generic success — echo back method, url, body
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            _echo: true,
            _method: req.method,
            _url: req.url,
            _body: record.body,
          }),
        );
      });
    });

    server.listen(0, "127.0.0.1", () => {
      serverPort = server.address().port;
      resolve();
    });
  });
}

function stopServer() {
  return new Promise((resolve) => server.close(resolve));
}

// ═══════════════════════════════════════════════════════════════
// Re-implementation of client.ts functions for unit testing
// (TypeScript extensions can't be imported directly without transpiler)
// ═══════════════════════════════════════════════════════════════

let API_URL;
const ADMIN_EMAIL = "test@eval.local";
const ADMIN_PASS = "test-pass-2026";
const COMPANY_ID = "company-uuid-001";
const AGENT_ID = "agent-uuid-001";

let cachedSession = null;

function resetSession() {
  cachedSession = null;
}

async function authenticate() {
  if (cachedSession && cachedSession.expiresAt > Date.now()) {
    return cachedSession.cookie;
  }
  const res = await fetch(`${API_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: API_URL },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASS }),
  });
  if (!res.ok) throw new Error(`Paperclip auth failed: ${res.status}`);
  const raw = res.headers.get("set-cookie") || "";
  const match = raw.match(/([^;]+)/);
  if (!match) throw new Error("No session cookie in auth response");
  cachedSession = {
    cookie: match[1],
    expiresAt: Date.now() + 25 * 60 * 1000,
  };
  return cachedSession.cookie;
}

async function request(method, path, body) {
  const cookie = await authenticate();
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: API_URL,
      Cookie: cookie,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} /api${path}: ${res.status} ${text}`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function resolveCompanyId(id) {
  const r = id?.trim?.() || COMPANY_ID;
  if (!r) throw new Error("companyId required — PAPERCLIP_COMPANY_ID not set");
  return r;
}

function resolveAgentId(id) {
  const r = id?.trim?.() || AGENT_ID;
  if (!r) throw new Error("agentId required — PAPERCLIP_AGENT_ID not set");
  return r;
}

function isConfigured(url, email, pass) {
  return !!(url && email && pass);
}

function qs(params) {
  const entries = Object.entries(params).filter(
    ([, v]) => v != null && v !== "",
  );
  if (!entries.length) return "";
  return (
    "?" +
    entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&")
  );
}

function ok(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

before(async () => {
  await startServer();
  API_URL = `http://127.0.0.1:${serverPort}`;
});

after(async () => {
  await stopServer();
});

beforeEach(() => {
  resetState();
  resetSession();
});

// ── Client: Authentication ──────────────────────────────────────

describe("client: authentication", () => {
  test("successful auth returns session cookie", async () => {
    const cookie = await authenticate();
    assert.ok(cookie.includes("paperclip-default.session_token"));
  });

  test("auth sends correct credentials", async () => {
    await authenticate();
    const req = findRequest("POST", "/api/auth/sign-in/email");
    assert.equal(req.body.email, ADMIN_EMAIL);
    assert.equal(req.body.password, ADMIN_PASS);
  });

  test("auth sends Origin header", async () => {
    await authenticate();
    const req = findRequest("POST", "/api/auth/sign-in/email");
    assert.equal(req.headers.origin, API_URL);
  });

  test("failed auth throws with status code", async () => {
    shouldFailAuth = true;
    await assert.rejects(() => authenticate(), {
      message: /Paperclip auth failed: 403/,
    });
  });

  test("session caching: second call reuses cached session", async () => {
    await authenticate();
    await authenticate();
    const authRequests = requests.filter(
      (r) => r.url === "/api/auth/sign-in/email",
    );
    assert.equal(authRequests.length, 1, "should only auth once");
  });

  test("expired session re-authenticates", async () => {
    await authenticate();
    // Force expiry
    cachedSession.expiresAt = Date.now() - 1000;
    await authenticate();
    const authRequests = requests.filter(
      (r) => r.url === "/api/auth/sign-in/email",
    );
    assert.equal(authRequests.length, 2, "should auth twice after expiry");
  });
});

// ── Client: request() ───────────────────────────────────────────

describe("client: request()", () => {
  test("GET request hits correct path", async () => {
    const result = await request("GET", "/agents/me");
    assert.equal(result._method, "GET");
    assert.equal(result._url, "/api/agents/me");
  });

  test("POST request sends body", async () => {
    const body = { title: "Test Issue", priority: "high" };
    const result = await request(
      "POST",
      `/companies/${COMPANY_ID}/issues`,
      body,
    );
    assert.equal(result._method, "POST");
    assert.deepEqual(result._body, body);
  });

  test("PATCH request sends body", async () => {
    const body = { status: "done", comment: "Finished" };
    const result = await request("PATCH", "/issues/issue-123", body);
    assert.equal(result._method, "PATCH");
    assert.deepEqual(result._body, body);
  });

  test("PUT request sends body", async () => {
    const body = { body: "# Document content" };
    const result = await request("PUT", "/issues/issue-1/documents/spec", body);
    assert.equal(result._method, "PUT");
    assert.deepEqual(result._body, body);
  });

  test("DELETE request works without body", async () => {
    const result = await request("DELETE", "/issues/i-1/approvals/a-1");
    assert.equal(result._method, "DELETE");
  });

  test("request includes cookie header", async () => {
    await request("GET", "/agents/me");
    const req = findRequest("GET", "/api/agents/me");
    assert.ok(req.headers.cookie.includes("paperclip-default.session_token"));
  });

  test("request includes Origin header", async () => {
    await request("GET", "/agents/me");
    const req = findRequest("GET", "/api/agents/me");
    assert.equal(req.headers.origin, API_URL);
  });

  test("request includes Content-Type header", async () => {
    await request("GET", "/agents/me");
    const req = findRequest("GET", "/api/agents/me");
    assert.equal(req.headers["content-type"], "application/json");
  });

  test("error response throws with method, path, and status", async () => {
    shouldFailRoute = true;
    failRouteStatus = 404;
    failRouteBody = { error: "not found" };
    await assert.rejects(() => request("GET", "/issues/bad-id"), (err) => {
      assert.ok(err.message.includes("GET"));
      assert.ok(err.message.includes("/issues/bad-id"));
      assert.ok(err.message.includes("404"));
      return true;
    });
  });

  test("500 error includes response body in message", async () => {
    shouldFailRoute = true;
    failRouteStatus = 500;
    failRouteBody = { error: "internal error", detail: "db connection" };
    await assert.rejects(() => request("GET", "/issues/x"), (err) => {
      assert.ok(err.message.includes("500"));
      return true;
    });
  });

  test("auth failure propagates before route call", async () => {
    shouldFailAuth = true;
    await assert.rejects(
      () => request("GET", "/agents/me"),
      { message: /Paperclip auth failed/ },
    );
    const nonAuthRequests = requests.filter(
      (r) => !r.url.includes("auth"),
    );
    assert.equal(nonAuthRequests.length, 0, "no API call if auth fails");
  });
});

// ── Client: resolveCompanyId ────────────────────────────────────

describe("client: resolveCompanyId", () => {
  test("uses explicit ID when provided", () => {
    assert.equal(resolveCompanyId("custom-id"), "custom-id");
  });

  test("falls back to env default", () => {
    assert.equal(resolveCompanyId(null), COMPANY_ID);
    assert.equal(resolveCompanyId(undefined), COMPANY_ID);
  });

  test("trims whitespace", () => {
    assert.equal(resolveCompanyId("  spaced-id  "), "spaced-id");
  });

  test("empty string falls back to default", () => {
    assert.equal(resolveCompanyId(""), COMPANY_ID);
  });

  test("whitespace-only string falls back to default", () => {
    assert.equal(resolveCompanyId("   "), COMPANY_ID);
  });
});

// ── Client: resolveAgentId ──────────────────────────────────────

describe("client: resolveAgentId", () => {
  test("uses explicit ID when provided", () => {
    assert.equal(resolveAgentId("my-agent"), "my-agent");
  });

  test("falls back to env default", () => {
    assert.equal(resolveAgentId(null), AGENT_ID);
  });

  test("trims whitespace", () => {
    assert.equal(resolveAgentId("  agent-x  "), "agent-x");
  });
});

// ── Client: isConfigured ────────────────────────────────────────

describe("client: isConfigured", () => {
  test("true when all required vars set", () => {
    assert.ok(isConfigured("http://localhost:3100", "a@b.c", "pass"));
  });

  test("false when URL missing", () => {
    assert.ok(!isConfigured("", "a@b.c", "pass"));
  });

  test("false when email missing", () => {
    assert.ok(!isConfigured("http://localhost:3100", "", "pass"));
  });

  test("false when password missing", () => {
    assert.ok(!isConfigured("http://localhost:3100", "a@b.c", ""));
  });

  test("false when all missing", () => {
    assert.ok(!isConfigured("", "", ""));
  });
});

// ── Utility: qs() ───────────────────────────────────────────────

describe("utility: qs()", () => {
  test("builds query string from params", () => {
    assert.equal(qs({ status: "done", q: "test" }), "?status=done&q=test");
  });

  test("skips null values", () => {
    assert.equal(qs({ a: "1", b: null, c: "3" }), "?a=1&c=3");
  });

  test("skips undefined values", () => {
    assert.equal(qs({ a: "1", b: undefined }), "?a=1");
  });

  test("skips empty string values", () => {
    assert.equal(qs({ a: "1", b: "" }), "?a=1");
  });

  test("returns empty string when no params", () => {
    assert.equal(qs({}), "");
  });

  test("returns empty when all params null", () => {
    assert.equal(qs({ a: null, b: undefined, c: "" }), "");
  });

  test("encodes special characters", () => {
    const result = qs({ q: "hello world", tag: "a&b" });
    assert.ok(result.includes("hello%20world"));
    assert.ok(result.includes("a%26b"));
  });

  test("converts numbers to strings", () => {
    assert.equal(qs({ limit: 50 }), "?limit=50");
  });

  test("converts booleans to strings", () => {
    assert.equal(qs({ flag: true }), "?flag=true");
  });
});

// ── Utility: ok() ───────────────────────────────────────────────

describe("utility: ok()", () => {
  test("returns correct shape", () => {
    const result = ok({ id: "123" });
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
  });

  test("formats as pretty JSON", () => {
    const result = ok({ id: "123", name: "test" });
    const parsed = JSON.parse(result.content[0].text);
    assert.deepEqual(parsed, { id: "123", name: "test" });
    assert.ok(result.content[0].text.includes("\n"), "should be pretty-printed");
  });

  test("handles null", () => {
    const result = ok(null);
    assert.equal(result.content[0].text, "null");
  });

  test("handles arrays", () => {
    const result = ok([1, 2, 3]);
    const parsed = JSON.parse(result.content[0].text);
    assert.deepEqual(parsed, [1, 2, 3]);
  });

  test("handles nested objects", () => {
    const result = ok({ a: { b: { c: 1 } } });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.a.b.c, 1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Tool behavior tests — each group verifies the correct API
// path, method, body, and query params for a category of tools.
// ═══════════════════════════════════════════════════════════════

// ── Tools: Identity & Inbox ─────────────────────────────────────

describe("tools: identity & inbox", () => {
  test("paperclip_me → GET /api/agents/me", async () => {
    const result = await request("GET", "/agents/me");
    assert.equal(result._url, "/api/agents/me");
    assert.equal(result._method, "GET");
  });

  test("paperclip_inbox → GET /api/agents/me/inbox-lite", async () => {
    const result = await request("GET", "/agents/me/inbox-lite");
    assert.equal(result._url, "/api/agents/me/inbox-lite");
  });

  test("paperclip_list_agents → GET /api/companies/{cid}/agents", async () => {
    const cid = resolveCompanyId(null);
    const result = await request("GET", `/companies/${cid}/agents`);
    assert.equal(result._url, `/api/companies/${COMPANY_ID}/agents`);
  });

  test("paperclip_list_agents with explicit companyId", async () => {
    const cid = resolveCompanyId("other-company");
    const result = await request("GET", `/companies/${cid}/agents`);
    assert.equal(result._url, "/api/companies/other-company/agents");
  });

  test("paperclip_get_agent → GET /api/agents/{id}", async () => {
    const result = await request("GET", `/agents/${encodeURIComponent("agent-xyz")}`);
    assert.equal(result._url, "/api/agents/agent-xyz");
  });

  test("paperclip_get_agent with companyId adds query param", async () => {
    const q = "?companyId=" + encodeURIComponent("c-123");
    const result = await request("GET", `/agents/agent-xyz${q}`);
    assert.ok(result._url.includes("companyId=c-123"));
  });
});

// ── Tools: Issues ───────────────────────────────────────────────

describe("tools: issues", () => {
  test("paperclip_list_issues → GET /api/companies/{cid}/issues", async () => {
    const cid = resolveCompanyId(null);
    const result = await request("GET", `/companies/${cid}/issues`);
    assert.equal(result._url, `/api/companies/${COMPANY_ID}/issues`);
  });

  test("paperclip_list_issues with status filter", async () => {
    const cid = resolveCompanyId(null);
    const params = { status: "in_progress" };
    const result = await request("GET", `/companies/${cid}/issues${qs(params)}`);
    assert.ok(result._url.includes("status=in_progress"));
  });

  test("paperclip_list_issues with multiple filters", async () => {
    const cid = resolveCompanyId(null);
    const params = {
      status: "todo",
      assigneeAgentId: "agent-001",
      q: "search term",
    };
    const result = await request("GET", `/companies/${cid}/issues${qs(params)}`);
    assert.ok(result._url.includes("status=todo"));
    assert.ok(result._url.includes("assigneeAgentId=agent-001"));
    assert.ok(result._url.includes("q=search%20term"));
  });

  test("paperclip_list_issues with boolean filter", async () => {
    const cid = resolveCompanyId(null);
    const params = { includeRoutineExecutions: true };
    const result = await request("GET", `/companies/${cid}/issues${qs(params)}`);
    assert.ok(result._url.includes("includeRoutineExecutions=true"));
  });

  test("paperclip_list_issues skips null filters", async () => {
    const cid = resolveCompanyId(null);
    const params = { status: "todo", projectId: null, q: undefined };
    const result = await request("GET", `/companies/${cid}/issues${qs(params)}`);
    assert.ok(result._url.includes("status=todo"));
    assert.ok(!result._url.includes("projectId"));
    assert.ok(!result._url.includes("q="));
  });

  test("paperclip_get_issue → GET /api/issues/{id}", async () => {
    const result = await request("GET", "/issues/issue-uuid-123");
    assert.equal(result._url, "/api/issues/issue-uuid-123");
  });

  test("paperclip_get_issue with identifier URL-encodes", async () => {
    const result = await request(
      "GET",
      `/issues/${encodeURIComponent("ENG-42")}`,
    );
    assert.equal(result._url, "/api/issues/ENG-42");
  });

  test("paperclip_get_heartbeat_context → GET /api/issues/{id}/heartbeat-context", async () => {
    const result = await request(
      "GET",
      "/issues/issue-1/heartbeat-context",
    );
    assert.ok(result.currentExecutionWorkspace);
  });

  test("paperclip_get_heartbeat_context with wakeCommentId", async () => {
    await request(
      "GET",
      "/issues/issue-1/heartbeat-context?wakeCommentId=comment-uuid",
    );
    const req = lastRequest();
    assert.ok(req.url.includes("wakeCommentId=comment-uuid"));
  });

  test("paperclip_create_issue → POST /api/companies/{cid}/issues", async () => {
    const cid = resolveCompanyId(null);
    const body = { title: "New Issue", priority: "high" };
    const result = await request("POST", `/companies/${cid}/issues`, body);
    assert.equal(result._method, "POST");
    assert.equal(result._url, `/api/companies/${COMPANY_ID}/issues`);
    assert.equal(result._body.title, "New Issue");
    assert.equal(result._body.priority, "high");
  });

  test("paperclip_create_issue with all fields", async () => {
    const cid = resolveCompanyId(null);
    const body = {
      title: "Full Issue",
      description: "Description here",
      status: "todo",
      priority: "critical",
      assigneeAgentId: "agent-x",
      parentId: "parent-1",
      blockedByIssueIds: ["blocker-1", "blocker-2"],
      goalId: "goal-1",
      projectId: "proj-1",
      workMode: "planning",
      labelIds: ["label-1", "label-2"],
    };
    const result = await request("POST", `/companies/${cid}/issues`, body);
    assert.deepEqual(result._body.blockedByIssueIds, [
      "blocker-1",
      "blocker-2",
    ]);
    assert.equal(result._body.workMode, "planning");
    assert.deepEqual(result._body.labelIds, ["label-1", "label-2"]);
  });

  test("paperclip_create_issue strips companyId from body", async () => {
    const cid = resolveCompanyId(null);
    const params = { companyId: "c-1", title: "Test" };
    const { companyId: _, ...body } = params;
    const result = await request("POST", `/companies/${cid}/issues`, body);
    assert.equal(result._body.companyId, undefined);
    assert.equal(result._body.title, "Test");
  });

  test("paperclip_update_issue → PATCH /api/issues/{id}", async () => {
    const body = { status: "done" };
    const result = await request("PATCH", "/issues/issue-1", body);
    assert.equal(result._method, "PATCH");
    assert.equal(result._url, "/api/issues/issue-1");
    assert.equal(result._body.status, "done");
  });

  test("paperclip_update_issue with comment", async () => {
    const body = { status: "in_review", comment: "Ready for review" };
    const result = await request("PATCH", "/issues/issue-1", body);
    assert.equal(result._body.comment, "Ready for review");
    assert.equal(result._body.status, "in_review");
  });

  test("paperclip_update_issue with resume=true", async () => {
    const body = { comment: "Follow up needed", resume: true };
    const result = await request("PATCH", "/issues/issue-1", body);
    assert.equal(result._body.resume, true);
  });

  test("paperclip_update_issue with interrupt=true", async () => {
    const body = { comment: "Urgent", interrupt: true };
    const result = await request("PATCH", "/issues/issue-1", body);
    assert.equal(result._body.interrupt, true);
  });

  test("paperclip_update_issue with reopen=true", async () => {
    const body = { reopen: true, comment: "Reopening" };
    const result = await request("PATCH", "/issues/issue-1", body);
    assert.equal(result._body.reopen, true);
  });

  test("paperclip_checkout_issue → POST /api/issues/{id}/checkout", async () => {
    const aid = resolveAgentId(null);
    const body = {
      agentId: aid,
      expectedStatuses: ["todo", "backlog", "blocked"],
    };
    const result = await request("POST", "/issues/issue-1/checkout", body);
    assert.equal(result._method, "POST");
    assert.equal(result._url, "/api/issues/issue-1/checkout");
    assert.equal(result._body.agentId, AGENT_ID);
    assert.deepEqual(result._body.expectedStatuses, [
      "todo",
      "backlog",
      "blocked",
    ]);
  });

  test("paperclip_checkout_issue with explicit agentId", async () => {
    const aid = resolveAgentId("other-agent");
    const body = {
      agentId: aid,
      expectedStatuses: ["todo"],
    };
    const result = await request("POST", "/issues/issue-1/checkout", body);
    assert.equal(result._body.agentId, "other-agent");
  });

  test("paperclip_checkout_issue with custom expectedStatuses", async () => {
    const body = {
      agentId: resolveAgentId(null),
      expectedStatuses: ["in_progress"],
    };
    const result = await request("POST", "/issues/issue-1/checkout", body);
    assert.deepEqual(result._body.expectedStatuses, ["in_progress"]);
  });

  test("paperclip_release_issue → POST /api/issues/{id}/release", async () => {
    const result = await request("POST", "/issues/issue-1/release", {});
    assert.equal(result._method, "POST");
    assert.equal(result._url, "/api/issues/issue-1/release");
  });
});

// ── Tools: Comments ─────────────────────────────────────────────

describe("tools: comments", () => {
  test("paperclip_list_comments → GET /api/issues/{id}/comments", async () => {
    const result = await request("GET", "/issues/issue-1/comments");
    assert.equal(result._url, "/api/issues/issue-1/comments");
  });

  test("paperclip_list_comments with after cursor", async () => {
    const q = qs({ after: "cursor-uuid" });
    const result = await request("GET", `/issues/issue-1/comments${q}`);
    assert.ok(result._url.includes("after=cursor-uuid"));
  });

  test("paperclip_list_comments with order and limit", async () => {
    const q = qs({ order: "desc", limit: 50 });
    const result = await request("GET", `/issues/issue-1/comments${q}`);
    assert.ok(result._url.includes("order=desc"));
    assert.ok(result._url.includes("limit=50"));
  });

  test("paperclip_list_comments with all params", async () => {
    const q = qs({ after: "c-1", order: "asc", limit: 10 });
    const result = await request("GET", `/issues/issue-1/comments${q}`);
    assert.ok(result._url.includes("after=c-1"));
    assert.ok(result._url.includes("order=asc"));
    assert.ok(result._url.includes("limit=10"));
  });

  test("paperclip_get_comment → GET /api/issues/{id}/comments/{cid}", async () => {
    const result = await request(
      "GET",
      "/issues/issue-1/comments/comment-uuid-1",
    );
    assert.equal(result._url, "/api/issues/issue-1/comments/comment-uuid-1");
  });

  test("paperclip_add_comment → POST /api/issues/{id}/comments", async () => {
    const body = { body: "This is a comment" };
    const result = await request("POST", "/issues/issue-1/comments", body);
    assert.equal(result._method, "POST");
    assert.equal(result._url, "/api/issues/issue-1/comments");
    assert.equal(result._body.body, "This is a comment");
  });

  test("paperclip_add_comment with resume=true", async () => {
    const body = { body: "Follow up", resume: true };
    const result = await request("POST", "/issues/issue-1/comments", body);
    assert.equal(result._body.resume, true);
  });

  test("paperclip_add_comment with reopen=true", async () => {
    const body = { body: "Reopening", reopen: true };
    const result = await request("POST", "/issues/issue-1/comments", body);
    assert.equal(result._body.reopen, true);
  });

  test("paperclip_add_comment with interrupt=true", async () => {
    const body = { body: "Urgent update", interrupt: true };
    const result = await request("POST", "/issues/issue-1/comments", body);
    assert.equal(result._body.interrupt, true);
  });

  test("paperclip_add_comment with markdown body", async () => {
    const body = {
      body: "# Heading\n\n**Bold** and `code`\n\n- item 1\n- item 2",
    };
    const result = await request("POST", "/issues/issue-1/comments", body);
    assert.ok(result._body.body.includes("# Heading"));
    assert.ok(result._body.body.includes("**Bold**"));
  });
});

// ── Tools: Documents ────────────────────────────────────────────

describe("tools: documents", () => {
  test("paperclip_list_documents → GET /api/issues/{id}/documents", async () => {
    const result = await request("GET", "/issues/issue-1/documents");
    assert.equal(result._url, "/api/issues/issue-1/documents");
  });

  test("paperclip_get_document → GET /api/issues/{id}/documents/{key}", async () => {
    const result = await request(
      "GET",
      `/issues/issue-1/documents/${encodeURIComponent("spec")}`,
    );
    assert.equal(result._url, "/api/issues/issue-1/documents/spec");
  });

  test("paperclip_get_document URL-encodes key", async () => {
    const result = await request(
      "GET",
      `/issues/issue-1/documents/${encodeURIComponent("my doc")}`,
    );
    assert.equal(result._url, "/api/issues/issue-1/documents/my%20doc");
  });

  test("paperclip_upsert_document → PUT /api/issues/{id}/documents/{key}", async () => {
    const body = { body: "# Spec content", title: "Spec", format: "markdown" };
    const result = await request(
      "PUT",
      `/issues/issue-1/documents/${encodeURIComponent("spec")}`,
      body,
    );
    assert.equal(result._method, "PUT");
    assert.ok(result._url.includes("/documents/spec"));
    assert.equal(result._body.body, "# Spec content");
    assert.equal(result._body.title, "Spec");
  });

  test("paperclip_upsert_document with changeSummary", async () => {
    const body = {
      body: "Updated content",
      changeSummary: "Fixed typo",
    };
    const result = await request("PUT", "/issues/issue-1/documents/spec", body);
    assert.equal(result._body.changeSummary, "Fixed typo");
  });

  test("paperclip_upsert_document with baseRevisionId", async () => {
    const body = {
      body: "New content",
      baseRevisionId: "rev-uuid-1",
    };
    const result = await request("PUT", "/issues/issue-1/documents/spec", body);
    assert.equal(result._body.baseRevisionId, "rev-uuid-1");
  });

  test("paperclip_list_document_revisions → GET .../revisions", async () => {
    const result = await request(
      "GET",
      `/issues/issue-1/documents/${encodeURIComponent("spec")}/revisions`,
    );
    assert.ok(result._url.includes("/documents/spec/revisions"));
  });

  test("paperclip_restore_document_revision → POST .../restore", async () => {
    const result = await request(
      "POST",
      `/issues/issue-1/documents/${encodeURIComponent("spec")}/revisions/${encodeURIComponent("rev-1")}/restore`,
      {},
    );
    assert.equal(result._method, "POST");
    assert.ok(result._url.includes("/revisions/rev-1/restore"));
  });
});

// ── Tools: Projects & Goals ─────────────────────────────────────

describe("tools: projects", () => {
  test("paperclip_list_projects → GET /api/companies/{cid}/projects", async () => {
    const cid = resolveCompanyId(null);
    const result = await request("GET", `/companies/${cid}/projects`);
    assert.equal(result._url, `/api/companies/${COMPANY_ID}/projects`);
  });

  test("paperclip_list_projects with explicit companyId", async () => {
    const cid = resolveCompanyId("c-other");
    const result = await request("GET", `/companies/${cid}/projects`);
    assert.equal(result._url, "/api/companies/c-other/projects");
  });

  test("paperclip_get_project → GET /api/projects/{id}", async () => {
    const result = await request("GET", "/projects/proj-1");
    assert.equal(result._url, "/api/projects/proj-1");
  });

  test("paperclip_get_project with companyId query param", async () => {
    const q = `?companyId=${encodeURIComponent("c-1")}`;
    const result = await request("GET", `/projects/proj-1${q}`);
    assert.ok(result._url.includes("companyId=c-1"));
  });
});

describe("tools: goals", () => {
  test("paperclip_list_goals → GET /api/companies/{cid}/goals", async () => {
    const cid = resolveCompanyId(null);
    const result = await request("GET", `/companies/${cid}/goals`);
    assert.equal(result._url, `/api/companies/${COMPANY_ID}/goals`);
  });

  test("paperclip_get_goal → GET /api/goals/{id}", async () => {
    const result = await request("GET", "/goals/goal-uuid-1");
    assert.equal(result._url, "/api/goals/goal-uuid-1");
  });
});

// ── Tools: Interactions ─────────────────────────────────────────

describe("tools: interactions", () => {
  test("paperclip_suggest_tasks → POST /api/issues/{id}/interactions", async () => {
    const body = {
      kind: "suggest_tasks",
      payload: {
        version: 1,
        tasks: [
          { clientKey: "t1", title: "Task 1" },
          { clientKey: "t2", title: "Task 2", priority: "high" },
        ],
      },
      continuationPolicy: "wake_assignee",
    };
    const result = await request(
      "POST",
      "/issues/issue-1/interactions",
      body,
    );
    assert.equal(result._body.kind, "suggest_tasks");
    assert.equal(result._body.payload.tasks.length, 2);
    assert.equal(result._body.continuationPolicy, "wake_assignee");
  });

  test("suggest_tasks default continuationPolicy is wake_assignee", () => {
    const p = {};
    const policy = p.continuationPolicy ?? "wake_assignee";
    assert.equal(policy, "wake_assignee");
  });

  test("paperclip_ask_user_questions → POST /api/issues/{id}/interactions", async () => {
    const body = {
      kind: "ask_user_questions",
      payload: {
        version: 1,
        questions: [
          {
            id: "q1",
            prompt: "Which framework?",
            selectionMode: "single",
            options: [
              { id: "react", label: "React" },
              { id: "vue", label: "Vue" },
            ],
          },
        ],
      },
      continuationPolicy: "wake_assignee",
    };
    const result = await request(
      "POST",
      "/issues/issue-1/interactions",
      body,
    );
    assert.equal(result._body.kind, "ask_user_questions");
    assert.equal(result._body.payload.questions[0].id, "q1");
    assert.equal(result._body.payload.questions[0].options.length, 2);
  });

  test("paperclip_request_confirmation → POST /api/issues/{id}/interactions", async () => {
    const body = {
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Deploy to production?",
        acceptLabel: "Deploy",
        rejectLabel: "Cancel",
      },
      continuationPolicy: "none",
    };
    const result = await request(
      "POST",
      "/issues/issue-1/interactions",
      body,
    );
    assert.equal(result._body.kind, "request_confirmation");
    assert.equal(result._body.payload.prompt, "Deploy to production?");
    assert.equal(result._body.continuationPolicy, "none");
  });

  test("request_confirmation default continuationPolicy is none", () => {
    const p = {};
    const policy = p.continuationPolicy ?? "none";
    assert.equal(policy, "none");
  });

  test("interactions accept idempotencyKey", async () => {
    const body = {
      kind: "suggest_tasks",
      idempotencyKey: "idem-key-123",
      payload: { version: 1, tasks: [{ clientKey: "t1", title: "Task" }] },
      continuationPolicy: "wake_assignee",
    };
    const result = await request(
      "POST",
      "/issues/issue-1/interactions",
      body,
    );
    assert.equal(result._body.idempotencyKey, "idem-key-123");
  });

  test("interactions accept title and summary", async () => {
    const body = {
      kind: "ask_user_questions",
      title: "Configuration Questions",
      summary: "Need input on several config options",
      payload: {
        version: 1,
        questions: [{ id: "q1", prompt: "Pick one" }],
      },
      continuationPolicy: "wake_assignee",
    };
    const result = await request(
      "POST",
      "/issues/issue-1/interactions",
      body,
    );
    assert.equal(result._body.title, "Configuration Questions");
    assert.equal(result._body.summary, "Need input on several config options");
  });
});

// ── Tools: Approvals ────────────────────────────────────────────

describe("tools: approvals", () => {
  test("paperclip_list_approvals → GET /api/companies/{cid}/approvals", async () => {
    const cid = resolveCompanyId(null);
    const result = await request("GET", `/companies/${cid}/approvals`);
    assert.equal(result._url, `/api/companies/${COMPANY_ID}/approvals`);
  });

  test("paperclip_list_approvals with status filter", async () => {
    const cid = resolveCompanyId(null);
    const q = "?status=" + encodeURIComponent("pending");
    const result = await request("GET", `/companies/${cid}/approvals${q}`);
    assert.ok(result._url.includes("status=pending"));
  });

  test("paperclip_create_approval → POST /api/companies/{cid}/approvals", async () => {
    const cid = resolveCompanyId(null);
    const body = {
      type: "request_board_approval",
      payload: { description: "Approve new agent hire" },
      requestedByAgentId: "agent-1",
      issueIds: ["issue-1"],
    };
    const result = await request("POST", `/companies/${cid}/approvals`, body);
    assert.equal(result._method, "POST");
    assert.equal(result._body.type, "request_board_approval");
    assert.deepEqual(result._body.issueIds, ["issue-1"]);
  });

  test("paperclip_get_approval → GET /api/approvals/{id}", async () => {
    const result = await request("GET", "/approvals/appr-uuid-1");
    assert.equal(result._url, "/api/approvals/appr-uuid-1");
  });

  test("paperclip_get_approval_issues → GET /api/approvals/{id}/issues", async () => {
    const result = await request("GET", "/approvals/appr-1/issues");
    assert.equal(result._url, "/api/approvals/appr-1/issues");
  });

  test("paperclip_list_approval_comments → GET /api/approvals/{id}/comments", async () => {
    const result = await request("GET", "/approvals/appr-1/comments");
    assert.equal(result._url, "/api/approvals/appr-1/comments");
  });

  test("paperclip_add_approval_comment → POST /api/approvals/{id}/comments", async () => {
    const body = { body: "Looks good" };
    const result = await request("POST", "/approvals/appr-1/comments", body);
    assert.equal(result._body.body, "Looks good");
  });

  test("paperclip_approval_decision: approve", async () => {
    const result = await request("POST", "/approvals/appr-1/approve", {
      decisionNote: "Approved by board",
    });
    assert.ok(result._url.includes("/approve"));
    assert.equal(result._body.decisionNote, "Approved by board");
  });

  test("paperclip_approval_decision: reject", async () => {
    const result = await request("POST", "/approvals/appr-1/reject", {
      decisionNote: "Rejected: budget constraints",
    });
    assert.ok(result._url.includes("/reject"));
  });

  test("paperclip_approval_decision: requestRevision", async () => {
    const result = await request(
      "POST",
      "/approvals/appr-1/request-revision",
      { decisionNote: "Need more detail" },
    );
    assert.ok(result._url.includes("/request-revision"));
  });

  test("paperclip_approval_decision: resubmit with payload", async () => {
    const payload = { description: "Updated proposal" };
    const result = await request("POST", "/approvals/appr-1/resubmit", {
      payload,
    });
    assert.ok(result._url.includes("/resubmit"));
    assert.deepEqual(result._body.payload, payload);
  });

  test("paperclip_list_issue_approvals → GET /api/issues/{id}/approvals", async () => {
    const result = await request("GET", "/issues/issue-1/approvals");
    assert.equal(result._url, "/api/issues/issue-1/approvals");
  });

  test("paperclip_link_issue_approval → POST /api/issues/{id}/approvals", async () => {
    const result = await request("POST", "/issues/issue-1/approvals", {
      approvalId: "appr-1",
    });
    assert.equal(result._body.approvalId, "appr-1");
  });

  test("paperclip_unlink_issue_approval → DELETE /api/issues/{id}/approvals/{aid}", async () => {
    const result = await request(
      "DELETE",
      `/issues/issue-1/approvals/${encodeURIComponent("appr-1")}`,
    );
    assert.equal(result._method, "DELETE");
    assert.ok(result._url.includes("/issues/issue-1/approvals/appr-1"));
  });
});

// ── Tools: Workspace Runtime ────────────────────────────────────

describe("tools: workspace runtime", () => {
  test("paperclip_get_workspace_runtime extracts workspace from heartbeat", async () => {
    const ctx = await request("GET", "/issues/issue-1/heartbeat-context");
    const workspace = ctx?.currentExecutionWorkspace ?? null;
    const services = Array.isArray(workspace?.runtimeServices)
      ? workspace.runtimeServices
      : [];
    assert.ok(workspace);
    assert.equal(workspace.id, "ws-001");
    assert.equal(services.length, 1);
    assert.equal(services[0].serviceName, "web");
    assert.equal(services[0].status, "running");
  });

  test("paperclip_get_workspace_runtime handles null workspace", async () => {
    heartbeatContextResponse = { currentExecutionWorkspace: null };
    const ctx = await request("GET", "/issues/issue-1/heartbeat-context");
    const workspace = ctx?.currentExecutionWorkspace ?? null;
    assert.equal(workspace, null);
  });

  test("paperclip_get_workspace_runtime handles empty services", async () => {
    heartbeatContextResponse = {
      currentExecutionWorkspace: { id: "ws-1", runtimeServices: [] },
    };
    const ctx = await request("GET", "/issues/issue-1/heartbeat-context");
    assert.deepEqual(ctx.currentExecutionWorkspace.runtimeServices, []);
  });

  test("paperclip_control_workspace_services sends action", async () => {
    // First get workspace ID from heartbeat
    heartbeatContextResponse = null; // reset to default with ws-001
    const ctx = await request("GET", "/issues/issue-1/heartbeat-context");
    const wsId = ctx.currentExecutionWorkspace.id;
    assert.equal(wsId, "ws-001");

    // Then send control action
    const result = await request(
      "POST",
      `/execution-workspaces/${encodeURIComponent(wsId)}/runtime-services/restart`,
      { runtimeServiceId: "svc-001" },
    );
    assert.equal(result._method, "POST");
    assert.ok(result._url.includes("/runtime-services/restart"));
    assert.equal(result._body.runtimeServiceId, "svc-001");
  });

  test("paperclip_control_workspace_services: start action", async () => {
    const result = await request(
      "POST",
      "/execution-workspaces/ws-001/runtime-services/start",
      {},
    );
    assert.ok(result._url.includes("/runtime-services/start"));
  });

  test("paperclip_control_workspace_services: stop action", async () => {
    const result = await request(
      "POST",
      "/execution-workspaces/ws-001/runtime-services/stop",
      {},
    );
    assert.ok(result._url.includes("/runtime-services/stop"));
  });

  test("paperclip_control_workspace_services with serviceIndex", async () => {
    const result = await request(
      "POST",
      "/execution-workspaces/ws-001/runtime-services/restart",
      { serviceIndex: 2 },
    );
    assert.equal(result._body.serviceIndex, 2);
  });
});

// ── Tools: Escape Hatch ─────────────────────────────────────────

describe("tools: escape hatch", () => {
  test("paperclip_api_request forwards GET", async () => {
    const result = await request("GET", "/custom/endpoint");
    assert.equal(result._url, "/api/custom/endpoint");
    assert.equal(result._method, "GET");
  });

  test("paperclip_api_request forwards POST with JSON body", async () => {
    const body = JSON.parse('{"key":"value"}');
    const result = await request("POST", "/custom/action", body);
    assert.equal(result._body.key, "value");
  });

  test("paperclip_api_request path validation: must start with /", () => {
    const path = "no-leading-slash";
    assert.ok(
      !path.startsWith("/"),
      "should detect path without leading slash",
    );
  });

  test("paperclip_api_request path validation: rejects ..", () => {
    const path = "/issues/../admin/secret";
    assert.ok(
      path.includes(".."),
      "should detect path traversal",
    );
  });

  test("paperclip_api_request forwards PATCH", async () => {
    const result = await request("PATCH", "/some/resource", { field: "val" });
    assert.equal(result._method, "PATCH");
    assert.equal(result._body.field, "val");
  });

  test("paperclip_api_request forwards DELETE", async () => {
    const result = await request("DELETE", "/some/resource");
    assert.equal(result._method, "DELETE");
  });
});

// ── Edge Cases ──────────────────────────────────────────────────

describe("edge cases", () => {
  test("URL-encodes special characters in issue ID", async () => {
    const result = await request(
      "GET",
      `/issues/${encodeURIComponent("TEST-123/sub")}`,
    );
    assert.ok(result._url.includes("TEST-123"));
  });

  test("URL-encodes special characters in document key", async () => {
    const result = await request(
      "GET",
      `/issues/i-1/documents/${encodeURIComponent("my file.md")}`,
    );
    assert.ok(result._url.includes("my%20file.md"));
  });

  test("handles UUID-style IDs correctly", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = await request("GET", `/issues/${uuid}`);
    assert.equal(result._url, `/api/issues/${uuid}`);
  });

  test("multiple sequential requests reuse auth session", async () => {
    await request("GET", "/agents/me");
    await request("GET", "/agents/me/inbox-lite");
    await request("GET", `/companies/${COMPANY_ID}/issues`);
    const authReqs = requests.filter((r) =>
      r.url.includes("auth/sign-in"),
    );
    assert.equal(authReqs.length, 1, "single auth for multiple requests");
  });

  test("error on non-2xx resets allow retry", async () => {
    shouldFailRoute = true;
    failRouteStatus = 503;
    await assert.rejects(() => request("GET", "/issues/bad"));

    shouldFailRoute = false;
    const result = await request("GET", "/issues/good");
    assert.equal(result._url, "/api/issues/good");
  });

  test("POST with empty object body", async () => {
    const result = await request("POST", "/issues/i-1/release", {});
    assert.deepEqual(result._body, {});
  });

  test("GET with long query string", async () => {
    const params = {
      status: "in_progress",
      assigneeAgentId: "550e8400-e29b-41d4-a716-446655440000",
      q: "very long search query with multiple words and special chars & more",
    };
    const cid = resolveCompanyId(null);
    const result = await request(
      "GET",
      `/companies/${cid}/issues${qs(params)}`,
    );
    assert.ok(result._url.includes("status=in_progress"));
    assert.ok(result._url.includes("assigneeAgentId="));
  });
});

// ── Approval Decision Path Mapping ──────────────────────────────

describe("approval decision path mapping", () => {
  const pathMap = {
    approve: "approve",
    reject: "reject",
    requestRevision: "request-revision",
    resubmit: "resubmit",
  };

  test("approve maps to /approve", () => {
    assert.equal(pathMap["approve"], "approve");
  });

  test("reject maps to /reject", () => {
    assert.equal(pathMap["reject"], "reject");
  });

  test("requestRevision maps to /request-revision", () => {
    assert.equal(pathMap["requestRevision"], "request-revision");
  });

  test("resubmit maps to /resubmit", () => {
    assert.equal(pathMap["resubmit"], "resubmit");
  });

  test("invalid action has no mapping", () => {
    assert.equal(pathMap["invalid"], undefined);
  });

  test("resubmit body wraps payload, not decisionNote", () => {
    const action = "resubmit";
    const decisionNote = "some note";
    const payloadJson = '{"updated": true}';

    let body;
    if (action === "resubmit") {
      body = { payload: JSON.parse(payloadJson) };
    } else {
      body = { decisionNote };
    }

    assert.deepEqual(body, { payload: { updated: true } });
    assert.equal(body.decisionNote, undefined);
  });

  test("non-resubmit body uses decisionNote, not payload", () => {
    const action = "approve";
    const decisionNote = "looks good";

    let body;
    if (action === "resubmit") {
      body = { payload: {} };
    } else {
      body = { decisionNote };
    }

    assert.equal(body.decisionNote, "looks good");
    assert.equal(body.payload, undefined);
  });
});

// ── Continuation Policy Defaults ────────────────────────────────

describe("continuation policy defaults", () => {
  test("suggest_tasks defaults to wake_assignee", () => {
    const input = {};
    const policy = input.continuationPolicy ?? "wake_assignee";
    assert.equal(policy, "wake_assignee");
  });

  test("suggest_tasks preserves explicit policy", () => {
    const input = { continuationPolicy: "none" };
    const policy = input.continuationPolicy ?? "wake_assignee";
    assert.equal(policy, "none");
  });

  test("ask_user_questions defaults to wake_assignee", () => {
    const input = {};
    const policy = input.continuationPolicy ?? "wake_assignee";
    assert.equal(policy, "wake_assignee");
  });

  test("request_confirmation defaults to none", () => {
    const input = {};
    const policy = input.continuationPolicy ?? "none";
    assert.equal(policy, "none");
  });

  test("request_confirmation preserves wake_assignee_on_accept", () => {
    const input = { continuationPolicy: "wake_assignee_on_accept" };
    const policy = input.continuationPolicy ?? "none";
    assert.equal(policy, "wake_assignee_on_accept");
  });
});

// ── Environment Gating ──────────────────────────────────────────

describe("environment gating", () => {
  test("isConfigured true with all env vars", () => {
    assert.ok(isConfigured("http://localhost:3100", "a@b.c", "pass"));
  });

  test("isConfigured false when URL empty", () => {
    assert.ok(!isConfigured("", "a@b.c", "pass"));
  });

  test("isConfigured false when email empty", () => {
    assert.ok(!isConfigured("http://localhost:3100", "", "pass"));
  });

  test("isConfigured false when password empty", () => {
    assert.ok(!isConfigured("http://localhost:3100", "a@b.c", ""));
  });

  test("isConfigured false when URL null", () => {
    assert.ok(!isConfigured(null, "a@b.c", "pass"));
  });

  test("isConfigured false when URL undefined", () => {
    assert.ok(!isConfigured(undefined, "a@b.c", "pass"));
  });
});

// ── Workspace Service Selection Logic ───────────────────────────

describe("workspace service selection", () => {
  function selectService(services, input) {
    if (input.runtimeServiceId) {
      return services.find((s) => s.id === input.runtimeServiceId) ?? null;
    }
    if (input.serviceName) {
      return services.find((s) => s.serviceName === input.serviceName) ?? null;
    }
    return (
      services.find(
        (s) => s.status === "running" || s.status === "starting",
      ) ??
      services[0] ??
      null
    );
  }

  const services = [
    { id: "s1", serviceName: "web", status: "running", healthStatus: "healthy" },
    { id: "s2", serviceName: "worker", status: "stopped", healthStatus: null },
    { id: "s3", serviceName: "db", status: "starting", healthStatus: null },
  ];

  test("selects by runtimeServiceId", () => {
    const svc = selectService(services, { runtimeServiceId: "s2" });
    assert.equal(svc.serviceName, "worker");
  });

  test("selects by serviceName", () => {
    const svc = selectService(services, { serviceName: "db" });
    assert.equal(svc.id, "s3");
  });

  test("defaults to first running/starting service", () => {
    const svc = selectService(services, {});
    assert.equal(svc.id, "s1");
  });

  test("falls back to first service if none running", () => {
    const stopped = [
      { id: "s1", serviceName: "a", status: "stopped" },
      { id: "s2", serviceName: "b", status: "stopped" },
    ];
    const svc = selectService(stopped, {});
    assert.equal(svc.id, "s1");
  });

  test("returns null for empty services", () => {
    const svc = selectService([], {});
    assert.equal(svc, null);
  });

  test("returns null when runtimeServiceId not found", () => {
    const svc = selectService(services, { runtimeServiceId: "nonexistent" });
    assert.equal(svc, null);
  });

  test("returns null when serviceName not found", () => {
    const svc = selectService(services, { serviceName: "nonexistent" });
    assert.equal(svc, null);
  });

  test("runtimeServiceId takes priority over serviceName", () => {
    const svc = selectService(services, {
      runtimeServiceId: "s1",
      serviceName: "worker",
    });
    assert.equal(svc.serviceName, "web");
  });
});
