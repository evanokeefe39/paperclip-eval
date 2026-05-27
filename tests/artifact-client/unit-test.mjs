#!/usr/bin/env node
/**
 * Unit tests for artifact-client.ts — the HTTP client that talks to the
 * artifact service.  Re-implements client functions inline (no transpiler).
 * Uses a fake in-process HTTP server to capture and verify requests.
 *
 * Run:  node --test tests/artifact-client/unit-test.mjs
 */

import http from "node:http";
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// =========================================================================
//  Fake artifact service
// =========================================================================

let server;
let serverPort;
let requests = [];

/** Next response the fake server should return (overridable per-test). */
let nextResponse = null;

function resetState() {
  requests = [];
  nextResponse = null;
}

const SAMPLE_RECORD = {
  id: "test-ulid",
  filename: "report.md",
  artifact_type: "research",
  mime_type: "text/markdown",
  agent_name: "researcher",
  run_id: null,
  company_id: "comp-1",
  project_id: "proj-1",
  bucket: "default",
  s3_key: "artifacts/researcher/report.md",
  content_hash: "sha256:abc123",
  size_bytes: 42,
  metadata: {},
  created_at: "2026-05-27T00:00:00.000Z",
};

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

        // --- override path ---
        if (nextResponse) {
          const nr = nextResponse;
          nextResponse = null;
          res.writeHead(nr.status, nr.headers || { "content-type": "application/json" });
          res.end(typeof nr.body === "string" ? nr.body : JSON.stringify(nr.body));
          return;
        }

        // --- POST /artifacts ---
        if (req.method === "POST" && req.url === "/artifacts") {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({
            ref: "artifact://researcher/report.md",
            id: "test-ulid",
            size: 5,
            hash: "sha256:abc",
          }));
          return;
        }

        // --- GET /artifacts/:id (with actual id segment) ---
        const readMatch = req.url.match(/^\/artifacts\/([^?/]+)$/);
        if (req.method === "GET" && readMatch) {
          const id = readMatch[1];
          if (id === "not-found") {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "artifact not found" }));
            return;
          }
          if (id === "rbac-denied") {
            res.writeHead(403, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "access denied" }));
            return;
          }
          if (id === "no-meta-header") {
            res.writeHead(200, { "content-type": "application/octet-stream" });
            res.end("blob content");
            return;
          }
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "x-artifact-metadata": JSON.stringify(SAMPLE_RECORD),
          });
          res.end("blob content");
          return;
        }

        // --- GET /artifacts?... (list) ---
        if (req.method === "GET" && req.url.startsWith("/artifacts")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify([SAMPLE_RECORD]));
          return;
        }

        // --- PATCH /artifacts/:id ---
        const patchMatch = req.url.match(/^\/artifacts\/([^?/]+)$/);
        if (req.method === "PATCH" && patchMatch) {
          const id = patchMatch[1];
          if (id === "not-found") {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "artifact not found" }));
            return;
          }
          const merged = { ...SAMPLE_RECORD, metadata: record.body.metadata };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(merged));
          return;
        }

        // --- GET /health ---
        if (req.method === "GET" && req.url === "/health") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ status: "ok", postgres: true, minio: true }));
          return;
        }

        // --- fallback ---
        res.writeHead(404, { "content-type": "application/json" });
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

// =========================================================================
//  Inline re-implementation of artifact-client.ts
// =========================================================================
//
//  The real module reads AGENT_NAME and ARTIFACT_SERVICE_URL from env at
//  import time, so we cannot import it directly.  Instead we replicate the
//  logic here, parameterised by (serviceUrl, agentName).
// =========================================================================

function makeClient(serviceUrl, agentName) {
  function hdrs() {
    return { "x-agent-name": agentName, "content-type": "application/json" };
  }

  async function write(params) {
    const body = {
      filename: params.filename,
      content: Buffer.from(params.content, "utf8").toString("base64"),
      type: params.type,
      bucket: params.bucket,
      mime: params.mime,
      metadata: params.metadata,
      run_id: params.run_id,
      company_id: params.company_id,
      project_id: params.project_id,
    };
    const resp = await fetch(`${serviceUrl}/artifacts`, {
      method: "POST",
      headers: hdrs(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(`artifact write failed (${resp.status}): ${err.error}`);
    }
    return resp.json();
  }

  async function writeRaw(params) {
    const body = {
      filename: params.filename,
      content: params.contentBase64,
      type: params.type,
      bucket: params.bucket,
      mime: params.mime,
      metadata: params.metadata,
      run_id: params.run_id,
      company_id: params.company_id,
      project_id: params.project_id,
    };
    const resp = await fetch(`${serviceUrl}/artifacts`, {
      method: "POST",
      headers: hdrs(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(`artifact write failed (${resp.status}): ${err.error}`);
    }
    return resp.json();
  }

  async function read(id) {
    const resp = await fetch(`${serviceUrl}/artifacts/${id}`, {
      headers: { "x-agent-name": agentName },
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(`artifact read failed (${resp.status}): ${err.error}`);
    }
    const content = Buffer.from(await resp.arrayBuffer());
    const metaHeader = resp.headers.get("x-artifact-metadata");
    if (!metaHeader) {
      throw new Error(`artifact metadata header missing for id: ${id}`);
    }
    return { content, metadata: JSON.parse(metaHeader) };
  }

  async function list(filters) {
    const params = new URLSearchParams();
    if (filters.agent) params.set("agent_name", filters.agent);
    if (filters.type) params.set("artifact_type", filters.type);
    if (filters.bucket) params.set("bucket", filters.bucket);
    if (filters.run_id) params.set("run_id", filters.run_id);
    if (filters.since) params.set("since", filters.since);
    if (filters.metadata) params.set("metadata", JSON.stringify(filters.metadata));

    const qs = params.toString();
    const url = qs ? `${serviceUrl}/artifacts?${qs}` : `${serviceUrl}/artifacts`;

    const resp = await fetch(url, {
      headers: { "x-agent-name": agentName },
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(`artifact list failed (${resp.status}): ${err.error}`);
    }
    return resp.json();
  }

  async function updateMetadata(id, metadata) {
    const resp = await fetch(`${serviceUrl}/artifacts/${id}`, {
      method: "PATCH",
      headers: hdrs(),
      body: JSON.stringify({ metadata }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(`metadata update failed (${resp.status}): ${err.error}`);
    }
    return resp.json();
  }

  async function append(params) {
    return write({
      filename: params.filename,
      content: params.line + "\n",
      type: params.type,
      bucket: params.bucket,
      metadata: params.metadata,
      run_id: params.run_id,
    });
  }

  function getAgentName() {
    return agentName;
  }

  function getServiceUrl() {
    return serviceUrl;
  }

  return { write, writeRaw, read, list, updateMetadata, append, getAgentName, getServiceUrl };
}

// =========================================================================
//  Test lifecycle
// =========================================================================

let client;

before(async () => {
  await startServer();
  client = makeClient(`http://127.0.0.1:${serverPort}`, "test-agent");
});

after(async () => {
  await stopServer();
});

beforeEach(() => {
  resetState();
});

// =========================================================================
//  write
// =========================================================================

describe("write", () => {
  it("sends POST with base64-encoded content", async () => {
    await client.write({ filename: "f.md", content: "hello", type: "research" });
    assert.equal(requests.length, 1);
    const r = requests[0];
    assert.equal(r.method, "POST");
    assert.equal(r.url, "/artifacts");
    assert.equal(r.body.content, Buffer.from("hello", "utf8").toString("base64"));
  });

  it("sends X-Agent-Name header", async () => {
    await client.write({ filename: "f.md", content: "x", type: "research" });
    assert.equal(requests[0].headers["x-agent-name"], "test-agent");
  });

  it("returns ref, id, size, hash from response", async () => {
    const result = await client.write({ filename: "f.md", content: "x", type: "research" });
    assert.equal(result.ref, "artifact://researcher/report.md");
    assert.equal(result.id, "test-ulid");
    assert.equal(result.size, 5);
    assert.equal(result.hash, "sha256:abc");
  });

  it("sends correct bucket and mime in body", async () => {
    await client.write({ filename: "f.png", content: "img", type: "image", bucket: "media", mime: "image/png" });
    const body = requests[0].body;
    assert.equal(body.bucket, "media");
    assert.equal(body.mime, "image/png");
  });

  it("includes metadata in request body", async () => {
    const meta = { source: "web", priority: 1 };
    await client.write({ filename: "f.md", content: "x", type: "research", metadata: meta });
    assert.deepEqual(requests[0].body.metadata, meta);
  });

  it("includes company_id and project_id in request body", async () => {
    await client.write({ filename: "f.md", content: "x", type: "r", company_id: "c1", project_id: "p1" });
    assert.equal(requests[0].body.company_id, "c1");
    assert.equal(requests[0].body.project_id, "p1");
  });

  it("throws on HTTP 400 with error message", async () => {
    nextResponse = { status: 400, body: { error: "bad request: filename required" } };
    await assert.rejects(
      () => client.write({ filename: "", content: "x", type: "r" }),
      (err) => {
        assert.match(err.message, /artifact write failed \(400\)/);
        assert.match(err.message, /bad request/);
        return true;
      },
    );
  });

  it("throws on HTTP 500 with error message", async () => {
    nextResponse = { status: 500, body: { error: "internal server error" } };
    await assert.rejects(
      () => client.write({ filename: "f.md", content: "x", type: "r" }),
      (err) => {
        assert.match(err.message, /artifact write failed \(500\)/);
        return true;
      },
    );
  });

  it("throws on network error", async () => {
    const broken = makeClient("http://127.0.0.1:1", "agent");
    await assert.rejects(() => broken.write({ filename: "f.md", content: "x", type: "r" }));
  });
});

// =========================================================================
//  writeRaw
// =========================================================================

describe("writeRaw", () => {
  it("sends pre-encoded base64 content without re-encoding", async () => {
    const raw = Buffer.from("binary payload").toString("base64");
    await client.writeRaw({ filename: "bin.dat", contentBase64: raw, type: "binary" });
    assert.equal(requests[0].body.content, raw);
  });

  it("returns same shape as write", async () => {
    const result = await client.writeRaw({ filename: "b.dat", contentBase64: "AAAA", type: "binary" });
    assert.ok(result.ref);
    assert.ok(result.id);
    assert.ok(typeof result.size === "number");
    assert.ok(result.hash);
  });
});

// =========================================================================
//  read
// =========================================================================

describe("read", () => {
  it("sends GET with X-Agent-Name header", async () => {
    await client.read("test-ulid");
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[0].url, "/artifacts/test-ulid");
    assert.equal(requests[0].headers["x-agent-name"], "test-agent");
  });

  it("returns content as Buffer and parsed metadata from header", async () => {
    const result = await client.read("test-ulid");
    assert.ok(Buffer.isBuffer(result.content));
    assert.equal(result.content.toString(), "blob content");
    assert.equal(result.metadata.id, "test-ulid");
    assert.equal(result.metadata.filename, "report.md");
  });

  it("throws on 404 not found", async () => {
    await assert.rejects(
      () => client.read("not-found"),
      (err) => {
        assert.match(err.message, /artifact read failed \(404\)/);
        return true;
      },
    );
  });

  it("throws on 403 RBAC denied", async () => {
    await assert.rejects(
      () => client.read("rbac-denied"),
      (err) => {
        assert.match(err.message, /artifact read failed \(403\)/);
        assert.match(err.message, /access denied/);
        return true;
      },
    );
  });

  it("throws when metadata header missing", async () => {
    await assert.rejects(
      () => client.read("no-meta-header"),
      (err) => {
        assert.match(err.message, /artifact metadata header missing/);
        return true;
      },
    );
  });
});

// =========================================================================
//  list
// =========================================================================

describe("list", () => {
  it("sends GET with query params for each filter", async () => {
    await client.list({
      agent: "researcher",
      type: "research",
      bucket: "default",
      run_id: "run-1",
      since: "2026-01-01T00:00:00Z",
    });
    const url = requests[0].url;
    assert.ok(url.includes("agent_name=researcher"));
    assert.ok(url.includes("artifact_type=research"));
    assert.ok(url.includes("bucket=default"));
    assert.ok(url.includes("run_id=run-1"));
    assert.ok(url.includes("since="));
  });

  it("serializes metadata filter as JSON string in query param", async () => {
    const meta = { tag: "important" };
    await client.list({ metadata: meta });
    const url = requests[0].url;
    assert.ok(url.includes("metadata="));
    // Decode the query param and verify it round-trips
    const parsed = new URL(`http://localhost${url}`);
    const metaParam = parsed.searchParams.get("metadata");
    assert.deepEqual(JSON.parse(metaParam), meta);
  });

  it("returns array of records", async () => {
    const result = await client.list({});
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "test-ulid");
  });

  it("sends request with no params when filters empty", async () => {
    await client.list({});
    assert.equal(requests[0].url, "/artifacts");
  });

  it("throws on error response", async () => {
    nextResponse = { status: 500, body: { error: "db connection lost" } };
    await assert.rejects(
      () => client.list({}),
      (err) => {
        assert.match(err.message, /artifact list failed \(500\)/);
        return true;
      },
    );
  });
});

// =========================================================================
//  updateMetadata
// =========================================================================

describe("updateMetadata", () => {
  it("sends PATCH with metadata body", async () => {
    const meta = { reviewed: true, score: 0.95 };
    await client.updateMetadata("test-ulid", meta);
    const r = requests[0];
    assert.equal(r.method, "PATCH");
    assert.equal(r.url, "/artifacts/test-ulid");
    assert.deepEqual(r.body.metadata, meta);
  });

  it("sends correct headers", async () => {
    await client.updateMetadata("test-ulid", { x: 1 });
    assert.equal(requests[0].headers["x-agent-name"], "test-agent");
    assert.equal(requests[0].headers["content-type"], "application/json");
  });

  it("returns updated record with merged metadata", async () => {
    const meta = { reviewed: true };
    const result = await client.updateMetadata("test-ulid", meta);
    assert.equal(result.id, "test-ulid");
    assert.deepEqual(result.metadata, meta);
  });

  it("throws on 404", async () => {
    await assert.rejects(
      () => client.updateMetadata("not-found", { x: 1 }),
      (err) => {
        assert.match(err.message, /metadata update failed \(404\)/);
        return true;
      },
    );
  });
});

// =========================================================================
//  append
// =========================================================================

describe("append", () => {
  it("delegates to write with line + newline as content", async () => {
    await client.append({ filename: "log.jsonl", line: '{"event":"start"}', type: "log" });
    assert.equal(requests.length, 1);
    const body = requests[0].body;
    const decoded = Buffer.from(body.content, "base64").toString("utf8");
    assert.equal(decoded, '{"event":"start"}\n');
  });

  it("passes through bucket and metadata to write", async () => {
    const meta = { stream: "audit" };
    await client.append({
      filename: "audit.jsonl",
      line: "entry",
      type: "log",
      bucket: "logs",
      metadata: meta,
      run_id: "run-5",
    });
    const body = requests[0].body;
    assert.equal(body.bucket, "logs");
    assert.equal(body.run_id, "run-5");
    assert.deepEqual(body.metadata, meta);
  });

  it("returns same shape as write", async () => {
    const result = await client.append({ filename: "a.jsonl", line: "x", type: "log" });
    assert.ok(result.ref);
    assert.ok(result.id);
    assert.ok(typeof result.size === "number");
    assert.ok(result.hash);
  });
});

// =========================================================================
//  getAgentName / getServiceUrl
// =========================================================================

describe("accessors", () => {
  it("getAgentName returns the configured agent name", () => {
    assert.equal(client.getAgentName(), "test-agent");
  });

  it("getServiceUrl returns the configured service URL", () => {
    assert.equal(client.getServiceUrl(), `http://127.0.0.1:${serverPort}`);
  });
});
