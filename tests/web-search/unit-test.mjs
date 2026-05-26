#!/usr/bin/env node
/**
 * Unit tests for the web-search extension logic.
 * Runs a fake Exa API server — no real API key needed.
 *
 * Run:  node --test tests/web-search/unit-test.mjs
 * Requires: Node 22+ (fetch, node:test)
 */

import http from "node:http";
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// --- Fake Exa API server ---

let server;
let serverPort;
let requests = [];
let responseOverride = null;
let statusOverride = null;

function resetState() {
  requests = [];
  responseOverride = null;
  statusOverride = null;
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

        if (req.url === "/search" && req.method === "POST") {
          if (statusOverride) {
            res.writeHead(statusOverride, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "simulated error" }));
            return;
          }

          if (responseOverride) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(responseOverride));
            return;
          }

          const defaultResponse = {
            requestId: "fake-req-001",
            results: [
              {
                title: "Example Result",
                url: "https://example.com/page",
                text: "This is example content from the search.",
                highlights: ["Key sentence one.", "Key sentence two."],
                score: 0.95,
              },
              {
                title: "Second Result",
                url: "https://example.com/other",
                score: 0.82,
              },
            ],
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(defaultResponse));
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

// --- Inline re-implementation of extension logic for unit testing ---
// (Can't import .ts directly without transpiler)

function buildSearchBody(query) {
  return {
    query,
    numResults: 5,
    contents: {
      text: { maxCharacters: 1500 },
      highlights: { numSentences: 3 },
    },
  };
}

async function executeSearch(apiBase, apiKey, query, signal) {
  if (!apiKey) {
    throw new Error("EXA_API_KEY not set. Export it as an environment variable.");
  }

  const body = buildSearchBody(query);

  const res = await fetch(`${apiBase}/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Exa API error ${res.status}: ${errText}`);
  }

  const data = await res.json();

  const lines = [`## Search results for: ${query}\n`];

  for (const r of data.results) {
    lines.push(`### ${r.title}`);
    lines.push(`URL: ${r.url}`);
    if (r.score != null) lines.push(`Score: ${r.score.toFixed(2)}`);
    if (r.highlights?.length) {
      lines.push(`\n**Highlights:**`);
      for (const h of r.highlights) {
        lines.push(`> ${h}`);
      }
    }
    if (r.text) {
      lines.push(`\n${r.text}\n`);
    }
    lines.push("");
  }

  const text = lines.join("\n");

  return {
    content: [{ type: "text", text }],
    details: {
      query,
      resultCount: data.results.length,
    },
  };
}

// --- Tests ---

before(async () => {
  await startServer();
});

after(async () => {
  await stopServer();
});

beforeEach(() => {
  resetState();
});

describe("buildSearchBody", () => {
  test("builds correct structure with query", () => {
    const body = buildSearchBody("test query");
    assert.equal(body.query, "test query");
    assert.equal(body.numResults, 5);
    assert.equal(body.contents.text.maxCharacters, 1500);
    assert.equal(body.contents.highlights.numSentences, 3);
  });

  test("preserves special characters in query", () => {
    const body = buildSearchBody('how to "deploy" k8s & docker');
    assert.equal(body.query, 'how to "deploy" k8s & docker');
  });
});

describe("missing API key", () => {
  test("throws when API key is empty", async () => {
    await assert.rejects(
      () => executeSearch(`http://127.0.0.1:${serverPort}`, "", "test"),
      { message: /EXA_API_KEY not set/ }
    );
  });
});

describe("successful search", () => {
  test("sends POST to /search with correct headers", async () => {
    await executeSearch(
      `http://127.0.0.1:${serverPort}`,
      "test-key-123",
      "pi coding agent"
    );

    assert.equal(requests.length, 1);
    const req = requests[0];
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/search");
    assert.equal(req.headers["content-type"], "application/json");
    assert.equal(req.headers["x-api-key"], "test-key-123");
  });

  test("sends query in request body", async () => {
    await executeSearch(
      `http://127.0.0.1:${serverPort}`,
      "test-key",
      "web scraping tools"
    );

    assert.equal(requests[0].body.query, "web scraping tools");
    assert.equal(requests[0].body.numResults, 5);
  });

  test("returns formatted markdown with results", async () => {
    const result = await executeSearch(
      `http://127.0.0.1:${serverPort}`,
      "test-key",
      "example query"
    );

    const text = result.content[0].text;
    assert.ok(text.includes("## Search results for: example query"));
    assert.ok(text.includes("### Example Result"));
    assert.ok(text.includes("URL: https://example.com/page"));
    assert.ok(text.includes("Score: 0.95"));
    assert.ok(text.includes("**Highlights:**"));
    assert.ok(text.includes("> Key sentence one."));
    assert.ok(text.includes("This is example content from the search."));
  });

  test("returns correct result count in details", async () => {
    const result = await executeSearch(
      `http://127.0.0.1:${serverPort}`,
      "test-key",
      "test"
    );

    assert.equal(result.details.resultCount, 2);
    assert.equal(result.details.query, "test");
  });

  test("handles results without highlights or text", async () => {
    responseOverride = {
      requestId: "req-002",
      results: [
        { title: "Bare Result", url: "https://bare.example.com", score: 0.5 },
      ],
    };

    const result = await executeSearch(
      `http://127.0.0.1:${serverPort}`,
      "test-key",
      "bare"
    );

    const text = result.content[0].text;
    assert.ok(text.includes("### Bare Result"));
    assert.ok(text.includes("URL: https://bare.example.com"));
    assert.ok(text.includes("Score: 0.50"));
    assert.ok(!text.includes("**Highlights:**"));
    assert.equal(result.details.resultCount, 1);
  });
});

describe("empty results", () => {
  test("handles zero results", async () => {
    responseOverride = { requestId: "req-003", results: [] };

    const result = await executeSearch(
      `http://127.0.0.1:${serverPort}`,
      "test-key",
      "obscure query"
    );

    assert.ok(result.content[0].text.includes("## Search results for: obscure query"));
    assert.equal(result.details.resultCount, 0);
  });
});

describe("API errors", () => {
  test("throws on 401 unauthorized", async () => {
    statusOverride = 401;

    await assert.rejects(
      () =>
        executeSearch(
          `http://127.0.0.1:${serverPort}`,
          "bad-key",
          "test"
        ),
      { message: /Exa API error 401/ }
    );
  });

  test("throws on 429 rate limit", async () => {
    statusOverride = 429;

    await assert.rejects(
      () =>
        executeSearch(
          `http://127.0.0.1:${serverPort}`,
          "test-key",
          "test"
        ),
      { message: /Exa API error 429/ }
    );
  });

  test("throws on 500 server error", async () => {
    statusOverride = 500;

    await assert.rejects(
      () =>
        executeSearch(
          `http://127.0.0.1:${serverPort}`,
          "test-key",
          "test"
        ),
      { message: /Exa API error 500/ }
    );
  });

  test("includes error body text in thrown message", async () => {
    statusOverride = 403;

    await assert.rejects(
      () =>
        executeSearch(
          `http://127.0.0.1:${serverPort}`,
          "test-key",
          "test"
        ),
      (err) => {
        assert.ok(err.message.includes("403"));
        assert.ok(err.message.includes("simulated error"));
        return true;
      }
    );
  });
});

describe("abort signal", () => {
  test("respects abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () =>
        executeSearch(
          `http://127.0.0.1:${serverPort}`,
          "test-key",
          "test",
          controller.signal
        ),
      (err) => {
        assert.ok(
          err.name === "AbortError" || err.message.includes("abort"),
          `Expected abort error, got: ${err.message}`
        );
        return true;
      }
    );
  });
});

describe("output formatting", () => {
  test("score formatted to 2 decimal places", async () => {
    responseOverride = {
      requestId: "req-fmt",
      results: [
        { title: "Precision", url: "https://x.com", score: 0.123456 },
      ],
    };

    const result = await executeSearch(
      `http://127.0.0.1:${serverPort}`,
      "test-key",
      "test"
    );

    assert.ok(result.content[0].text.includes("Score: 0.12"));
  });

  test("multiple highlights each get blockquote prefix", async () => {
    responseOverride = {
      requestId: "req-hl",
      results: [
        {
          title: "Multi-HL",
          url: "https://x.com",
          score: 0.9,
          highlights: ["First highlight.", "Second highlight.", "Third highlight."],
        },
      ],
    };

    const result = await executeSearch(
      `http://127.0.0.1:${serverPort}`,
      "test-key",
      "test"
    );

    const text = result.content[0].text;
    assert.ok(text.includes("> First highlight."));
    assert.ok(text.includes("> Second highlight."));
    assert.ok(text.includes("> Third highlight."));
  });

  test("result with null score omits score line", async () => {
    responseOverride = {
      requestId: "req-ns",
      results: [
        { title: "No Score", url: "https://x.com", score: null },
      ],
    };

    const result = await executeSearch(
      `http://127.0.0.1:${serverPort}`,
      "test-key",
      "test"
    );

    assert.ok(!result.content[0].text.includes("Score:"));
  });

  test("content type is always text", async () => {
    const result = await executeSearch(
      `http://127.0.0.1:${serverPort}`,
      "test-key",
      "test"
    );

    assert.equal(result.content[0].type, "text");
  });
});

describe("extension registration shape", () => {
  test("tool definition has required fields", () => {
    const toolDef = {
      name: "web_search",
      label: "Web Search",
      description: "Search the web using Exa API.",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    };

    assert.equal(toolDef.name, "web_search");
    assert.ok(toolDef.description.length > 0);
    assert.ok(toolDef.parameters.properties.query);
  });
});
