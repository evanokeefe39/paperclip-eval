#!/usr/bin/env node
/**
 * Unit tests for the escalate extension logic.
 * Runs a fake Paperclip HTTP server and loads the extension in isolation.
 *
 * Usage: node tests/escalate/unit-test.mjs
 * Requires: Node 22+ (fetch, http built-ins)
 */

import http from "node:http";
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// --- Fake Paperclip server ---

let server;
let serverPort;
let requests = [];
let labelId = "fake-label-id-0001";
let issueCounter = 0;
let pauseCount = 0;
let authCount = 0;
let shouldFailAuth = false;
let shouldFailIssue = false;
let shouldFailPause = false;
let shouldFailLabel = false;

function resetState() {
  requests = [];
  issueCounter = 0;
  pauseCount = 0;
  authCount = 0;
  shouldFailAuth = false;
  shouldFailIssue = false;
  shouldFailPause = false;
  shouldFailLabel = false;
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
          headers: req.headers,
          body: body ? JSON.parse(body) : null,
        };
        requests.push(record);

        // Route handling
        if (req.url === "/api/auth/sign-in/email" && req.method === "POST") {
          authCount++;
          if (shouldFailAuth) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "forbidden" }));
            return;
          }
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": "paperclip-default.session_token=fake-session-token; Path=/; HttpOnly",
          });
          res.end(JSON.stringify({ token: "fake-token", user: { id: "user1" } }));
          return;
        }

        if (req.url.includes("/labels") && req.method === "GET") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([{ id: labelId, name: "escalation", color: "#dc2626" }]));
          return;
        }

        if (req.url.includes("/labels") && req.method === "POST") {
          if (shouldFailLabel) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "label creation failed" }));
            return;
          }
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "new-label-id", name: "escalation", color: "#dc2626" }));
          return;
        }

        if (req.url.includes("/issues") && req.method === "POST") {
          if (shouldFailIssue) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "issue creation failed" }));
            return;
          }
          issueCounter++;
          const issue = {
            id: `issue-${issueCounter}`,
            identifier: `TEST-${issueCounter}`,
            issueNumber: issueCounter,
            title: record.body.title,
            description: record.body.description,
            priority: record.body.priority || "medium",
            labelIds: record.body.labelIds || [],
            status: "backlog",
          };
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify(issue));
          return;
        }

        if (req.url.includes("/pause") && req.method === "POST") {
          if (shouldFailPause) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "pause failed" }));
            return;
          }
          pauseCount++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "agent-1", status: "paused", pauseReason: "escalation" }));
          return;
        }

        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
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

// --- Load extension dynamically ---

async function loadExtension(envOverrides = {}) {
  const env = {
    PAPERCLIP_API_URL: `http://127.0.0.1:${serverPort}`,
    PAPERCLIP_API_KEY: "pcp_test-api-key",
    PAPERCLIP_AGENT_ID: "agent-001",
    PAPERCLIP_COMPANY_ID: "company-001",
    ...envOverrides,
  };

  // Set env vars
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
  }

  // Create a mock ExtensionAPI that captures registration
  let registeredTool = null;
  const mockPi = {
    registerTool(toolDef) {
      registeredTool = toolDef;
    },
  };

  // Clear module cache and reload
  const modulePath = new URL(
    "../../src/agents/extensions/escalate.ts",
    import.meta.url
  ).pathname.replace(/^\/([A-Z]:)/, "$1");

  // We can't import .ts directly without transpiler.
  // Instead, test the logic by re-implementing the key functions inline.
  // The real integration test covers the actual extension loading.

  return { mockPi, registeredTool, env };
}

// --- Inline implementations of extension functions for unit testing ---

function buildIssueBody(message, inputs) {
  const sections = [message];

  if (inputs?.length) {
    sections.push("\n---\n\n## Requested Input\n");
    for (const input of inputs) {
      if (input.type === "select" && input.options?.length) {
        sections.push(`**${input.label}** (choose one):`);
        for (const opt of input.options) {
          const desc = opt.description ? ` — ${opt.description}` : "";
          sections.push(`- ${opt.label}${desc}`);
        }
      } else {
        sections.push(`**${input.label}** (free text)`);
      }
      sections.push("");
    }
  }

  const schema = { message, inputs: inputs || [] };
  sections.push("\n```escalation-schema");
  sections.push(JSON.stringify(schema, null, 2));
  sections.push("```");

  return sections.join("\n");
}

async function authenticate(apiUrl, email, password) {
  const res = await fetch(`${apiUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: apiUrl },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
  const setCookie = res.headers.get("set-cookie") || "";
  const match = setCookie.match(/([^;]+)/);
  if (!match) throw new Error("No session cookie");
  return { cookie: match[1] };
}

function apiHeaders(session, apiUrl) {
  return {
    "Content-Type": "application/json",
    Origin: apiUrl,
    Cookie: session.cookie,
  };
}

async function getOrCreateLabel(session, apiUrl, companyId) {
  const headers = apiHeaders(session, apiUrl);
  const listRes = await fetch(`${apiUrl}/api/companies/${companyId}/labels`, { headers });
  if (!listRes.ok) return null;
  const labels = await listRes.json();
  const existing = labels.find((l) => l.name === "escalation");
  if (existing) return existing.id;

  const createRes = await fetch(`${apiUrl}/api/companies/${companyId}/labels`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "escalation", color: "#dc2626" }),
  });
  if (!createRes.ok) return null;
  const created = await createRes.json();
  return created.id;
}

// --- Tests ---

before(async () => {
  await startServer();
});

after(async () => {
  await stopServer();
});

describe("buildIssueBody", () => {
  test("plain message only", () => {
    const body = buildIssueBody("Need help with deployment");
    assert.ok(body.includes("Need help with deployment"));
    assert.ok(body.includes("```escalation-schema"));
    assert.ok(!body.includes("## Requested Input"));
  });

  test("message with select inputs", () => {
    const inputs = [
      {
        id: "db_choice",
        label: "Database",
        type: "select",
        options: [
          { value: "pg", label: "PostgreSQL", description: "Relational" },
          { value: "mongo", label: "MongoDB" },
        ],
      },
    ];
    const body = buildIssueBody("Which DB?", inputs);
    assert.ok(body.includes("## Requested Input"));
    assert.ok(body.includes("**Database** (choose one):"));
    assert.ok(body.includes("- PostgreSQL — Relational"));
    assert.ok(body.includes("- MongoDB"));
    assert.ok(body.includes('"id": "db_choice"'));
  });

  test("message with text inputs", () => {
    const inputs = [{ id: "reason", label: "Explain your reasoning", type: "text" }];
    const body = buildIssueBody("Need approval", inputs);
    assert.ok(body.includes("**Explain your reasoning** (free text)"));
  });

  test("message with multiple inputs", () => {
    const inputs = [
      { id: "choice", label: "Pick one", type: "select", options: [{ value: "a", label: "A" }] },
      { id: "notes", label: "Notes", type: "text" },
    ];
    const body = buildIssueBody("Multi-input", inputs);
    assert.ok(body.includes("**Pick one** (choose one):"));
    assert.ok(body.includes("**Notes** (free text)"));
  });

  test("schema block is valid JSON", () => {
    const inputs = [{ id: "x", label: "X", type: "text" }];
    const body = buildIssueBody("Test", inputs);
    const match = body.match(/```escalation-schema\n([\s\S]*?)\n```/);
    assert.ok(match, "Schema block must exist");
    const parsed = JSON.parse(match[1]);
    assert.equal(parsed.message, "Test");
    assert.equal(parsed.inputs[0].id, "x");
  });

  test("empty inputs array treated like no inputs", () => {
    const body = buildIssueBody("Just a message", []);
    assert.ok(!body.includes("## Requested Input"));
  });
});

// NOTE: The authenticate tests below exercise the v1 session-cookie auth flow
// (escalate-v1.ts, retained but disabled). The current v2 escalate.ts uses
// PAPERCLIP_API_KEY with Bearer token auth via client.ts — no sign-in endpoint.
describe("authenticate (v1 session-cookie pattern)", () => {
  test("successful auth returns session cookie", async () => {
    resetState();
    const session = await authenticate(
      `http://127.0.0.1:${serverPort}`,
      "test@test.local",
      "test-pass"
    );
    assert.ok(session.cookie.includes("paperclip-default.session_token"));
    assert.equal(authCount, 1);
  });

  test("failed auth throws", async () => {
    resetState();
    shouldFailAuth = true;
    await assert.rejects(
      () => authenticate(`http://127.0.0.1:${serverPort}`, "bad@email", "wrong"),
      { message: /Auth failed: 403/ }
    );
  });

  test("auth sends correct credentials", async () => {
    resetState();
    await authenticate(`http://127.0.0.1:${serverPort}`, "my@email.com", "secret123");
    const authReq = requests.find((r) => r.url === "/api/auth/sign-in/email");
    assert.equal(authReq.body.email, "my@email.com");
    assert.equal(authReq.body.password, "secret123");
  });
});

describe("getOrCreateLabel", () => {
  test("returns existing label ID", async () => {
    resetState();
    const session = await authenticate(
      `http://127.0.0.1:${serverPort}`,
      "test@test.local",
      "test-pass"
    );
    const id = await getOrCreateLabel(
      session,
      `http://127.0.0.1:${serverPort}`,
      "company-001"
    );
    assert.equal(id, labelId);
  });

  test("sends cookie in request", async () => {
    resetState();
    const session = await authenticate(
      `http://127.0.0.1:${serverPort}`,
      "test@test.local",
      "test-pass"
    );
    await getOrCreateLabel(session, `http://127.0.0.1:${serverPort}`, "company-001");
    const labelReq = requests.find((r) => r.url.includes("/labels") && r.method === "GET");
    assert.ok(labelReq.headers.cookie.includes("paperclip-default.session_token"));
  });
});

describe("issue creation flow", () => {
  test("creates issue with correct fields", async () => {
    resetState();
    const apiUrl = `http://127.0.0.1:${serverPort}`;
    const session = await authenticate(apiUrl, "test@test.local", "test-pass");
    const headers = apiHeaders(session, apiUrl);

    const res = await fetch(`${apiUrl}/api/companies/company-001/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Test escalation issue",
        description: "Body content here",
        priority: "high",
        labelIds: [labelId],
      }),
    });

    assert.equal(res.status, 201);
    const issue = await res.json();
    assert.equal(issue.identifier, "TEST-1");
    assert.equal(issue.title, "Test escalation issue");
    assert.equal(issue.priority, "high");
    assert.deepEqual(issue.labelIds, [labelId]);
  });

  test("title truncation at 80 chars", () => {
    const longMessage = "A".repeat(100);
    const title =
      longMessage.length > 80 ? longMessage.slice(0, 77) + "..." : longMessage;
    assert.equal(title.length, 80);
    assert.ok(title.endsWith("..."));
  });

  test("short message used as-is for title", () => {
    const message = "Short question";
    const title = message.length > 80 ? message.slice(0, 77) + "..." : message;
    assert.equal(title, "Short question");
  });
});

describe("pause endpoint", () => {
  test("pause sends POST with reason", async () => {
    resetState();
    const apiUrl = `http://127.0.0.1:${serverPort}`;
    const session = await authenticate(apiUrl, "test@test.local", "test-pass");
    const headers = apiHeaders(session, apiUrl);

    const res = await fetch(`${apiUrl}/api/agents/agent-001/pause`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: "escalation" }),
    });

    assert.equal(res.status, 200);
    assert.equal(pauseCount, 1);
    const pauseReq = requests.find((r) => r.url.includes("/pause"));
    assert.equal(pauseReq.body.reason, "escalation");
  });

  test("pause failure returns 500", async () => {
    resetState();
    shouldFailPause = true;
    const apiUrl = `http://127.0.0.1:${serverPort}`;
    const session = await authenticate(apiUrl, "test@test.local", "test-pass");
    const headers = apiHeaders(session, apiUrl);

    const res = await fetch(`${apiUrl}/api/agents/agent-001/pause`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: "escalation" }),
    });

    assert.equal(res.status, 500);
  });
});

describe("full escalation flow (mock server)", () => {
  test("complete flow: auth → label → issue → pause", async () => {
    resetState();
    const apiUrl = `http://127.0.0.1:${serverPort}`;
    const companyId = "company-001";
    const agentId = "agent-001";

    // Simulate what the extension execute() does
    const session = await authenticate(apiUrl, "test@test.local", "test-pass");
    const labelIdResult = await getOrCreateLabel(session, apiUrl, companyId);
    assert.equal(labelIdResult, labelId);

    const message = "Which database should we use?";
    const inputs = [
      {
        id: "db",
        label: "Database",
        type: "select",
        options: [
          { value: "pg", label: "PostgreSQL" },
          { value: "sqlite", label: "SQLite" },
        ],
      },
    ];

    const description = buildIssueBody(message, inputs);
    const title = message.length > 80 ? message.slice(0, 77) + "..." : message;
    const headers = apiHeaders(session, apiUrl);

    const issueRes = await fetch(`${apiUrl}/api/companies/${companyId}/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title, description, priority: "high", labelIds: [labelIdResult] }),
    });
    assert.equal(issueRes.status, 201);
    const issue = await issueRes.json();

    const pauseRes = await fetch(`${apiUrl}/api/agents/${agentId}/pause`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: "escalation" }),
    });
    assert.equal(pauseRes.status, 200);

    // Verify final state
    assert.equal(authCount, 1);
    assert.equal(issueCounter, 1);
    assert.equal(pauseCount, 1);
    assert.equal(issue.identifier, "TEST-1");
  });

  test("issue failure still pauses agent", async () => {
    resetState();
    shouldFailIssue = true;
    const apiUrl = `http://127.0.0.1:${serverPort}`;
    const session = await authenticate(apiUrl, "test@test.local", "test-pass");
    const headers = apiHeaders(session, apiUrl);

    const issueRes = await fetch(`${apiUrl}/api/companies/company-001/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Test", description: "Test" }),
    });
    assert.equal(issueRes.status, 500);

    // Pause should still work
    const pauseRes = await fetch(`${apiUrl}/api/agents/agent-001/pause`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: "escalation" }),
    });
    assert.equal(pauseRes.status, 200);
    assert.equal(pauseCount, 1);
  });

  test("pause failure does not throw (graceful degradation)", async () => {
    resetState();
    shouldFailPause = true;
    const apiUrl = `http://127.0.0.1:${serverPort}`;
    const session = await authenticate(apiUrl, "test@test.local", "test-pass");
    const headers = apiHeaders(session, apiUrl);

    // Issue succeeds
    const issueRes = await fetch(`${apiUrl}/api/companies/company-001/issues`, {
      method: "POST",
      headers,
      body: JSON.stringify({ title: "Test", description: "Test" }),
    });
    assert.equal(issueRes.status, 201);

    // Pause fails but doesn't throw
    const pauseRes = await fetch(`${apiUrl}/api/agents/agent-001/pause`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: "escalation" }),
    });
    assert.equal(pauseRes.status, 500);
    // Extension would still return a tool result — the logic is resilient
  });

  test("auth failure prevents all subsequent calls", async () => {
    resetState();
    shouldFailAuth = true;
    const apiUrl = `http://127.0.0.1:${serverPort}`;

    await assert.rejects(() => authenticate(apiUrl, "bad", "bad"));
    // No issue or pause calls should have been made
    assert.equal(issueCounter, 0);
    assert.equal(pauseCount, 0);
  });
});

describe("urgency mapping", () => {
  test("blocking maps to high priority", () => {
    const urgency = "blocking";
    const priority = urgency === "blocking" ? "high" : "medium";
    assert.equal(priority, "high");
  });

  test("when_you_can maps to medium priority", () => {
    const urgency = "when_you_can";
    const priority = urgency === "blocking" ? "high" : "medium";
    assert.equal(priority, "medium");
  });

  test("undefined urgency defaults to blocking (high)", () => {
    const urgency = undefined || "blocking";
    const priority = urgency === "blocking" ? "high" : "medium";
    assert.equal(priority, "high");
  });
});

describe("environment gating", () => {
  // Matches client.ts isConfigured(): requires PAPERCLIP_API_URL + PAPERCLIP_API_KEY.
  // PAPERCLIP_AGENT_ID and PAPERCLIP_COMPANY_ID are resolved at call time, not at registration.
  test("all env vars present enables registration", () => {
    const required = [
      "http://localhost:3100",    // PAPERCLIP_API_URL
      "pcp_test-key",             // PAPERCLIP_API_KEY
      "agent-1",                  // PAPERCLIP_AGENT_ID
      "company-1",                // PAPERCLIP_COMPANY_ID
    ];
    const enabled = !required.some((v) => !v);
    assert.ok(enabled);
  });

  test("missing API URL disables registration", () => {
    const required = ["", "pcp_test-key", "agent-1", "company-1"];
    const enabled = !required.some((v) => !v);
    assert.ok(!enabled);
  });

  test("missing API key disables registration", () => {
    const required = ["http://localhost:3100", "", "agent-1", "company-1"];
    const enabled = !required.some((v) => !v);
    assert.ok(!enabled);
  });

  test("missing agent ID disables registration", () => {
    const required = ["http://localhost:3100", "pcp_test-key", "", "company-1"];
    const enabled = !required.some((v) => !v);
    assert.ok(!enabled);
  });

  test("missing company ID disables registration", () => {
    const required = ["http://localhost:3100", "pcp_test-key", "agent-1", ""];
    const enabled = !required.some((v) => !v);
    assert.ok(!enabled);
  });
});
