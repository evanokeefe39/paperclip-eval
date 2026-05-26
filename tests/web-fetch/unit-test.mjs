#!/usr/bin/env node
/**
 * Unit tests for the web-fetch extension logic.
 * Runs a fake HTTP server for direct fetch and a fake Jina Reader server.
 * No external network calls.
 *
 * Run:  node --test tests/web-fetch/unit-test.mjs
 * Requires: Node 22+ (fetch, node:test)
 */

import http from "node:http";
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// --- Constants (mirror extension) ---

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// --- Fake target server ---

let targetServer;
let targetPort;
let targetRequests = [];
let targetHandler = null;

function startTargetServer() {
  return new Promise((resolve) => {
    targetServer = http.createServer((req, res) => {
      targetRequests.push({ method: req.method, url: req.url, headers: req.headers });

      if (targetHandler) {
        targetHandler(req, res);
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><head><title>Test Page</title></head><body><p>${"Content word. ".repeat(50)}</p></body></html>`);
    });

    targetServer.listen(0, "127.0.0.1", () => {
      targetPort = targetServer.address().port;
      resolve();
    });
  });
}

// --- Fake Jina Reader server ---

let jinaServer;
let jinaPort;
let jinaRequests = [];
let jinaHandler = null;

function startJinaServer() {
  return new Promise((resolve) => {
    jinaServer = http.createServer((req, res) => {
      jinaRequests.push({ method: req.method, url: req.url, headers: req.headers });

      if (jinaHandler) {
        jinaHandler(req, res);
        return;
      }

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`Title: Jina Page\nMarkdown Content:\n# Jina Title\n\n${"Jina content paragraph. ".repeat(20)}`);
    });

    jinaServer.listen(0, "127.0.0.1", () => {
      jinaPort = jinaServer.address().port;
      resolve();
    });
  });
}

function resetState() {
  targetRequests = [];
  jinaRequests = [];
  targetHandler = null;
  jinaHandler = null;
}

function stopServer(srv) {
  return new Promise((resolve) => srv.close(resolve));
}

// --- Inline re-implementation of extension logic ---

async function fetchWithJina(jinaBase, url, signal) {
  try {
    const res = await fetch(jinaBase + url, {
      headers: { Accept: "text/markdown", "X-No-Cache": "true" },
      signal: AbortSignal.any([
        AbortSignal.timeout(30000),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!res.ok) return null;

    const text = await res.text();
    const contentStart = text.indexOf("Markdown Content:");
    if (contentStart < 0) return null;

    const markdown = text.slice(contentStart + 17).trim();
    if (markdown.length < 100) return null;

    const titleMatch = markdown.match(/^#{1,2}\s+(.+)/m);
    const title = titleMatch?.[1]?.replace(/\*+/g, "").trim() || "";
    return { title, content: markdown };
  } catch {
    return null;
  }
}

async function fetchDirect(url, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!res.ok) {
      return { title: "", content: "", error: `HTTP ${res.status}` };
    }

    const contentType = res.headers.get("content-type") || "";
    const lengthHeader = res.headers.get("content-length");
    if (lengthHeader && parseInt(lengthHeader) > MAX_RESPONSE_SIZE) {
      return { title: "", content: "", error: "Response too large" };
    }

    const text = await res.text();
    const isHTML =
      contentType.includes("text/html") ||
      contentType.includes("application/xhtml");

    if (!isHTML) {
      const titleMatch = text.match(/^#{1,2}\s+(.+)/m);
      const title = titleMatch?.[1]?.trim() || url;
      return { title, content: text };
    }

    const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch?.[1]?.trim() || "";

    const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const body = bodyMatch?.[1] || text;

    const cleaned = body
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();

    if (cleaned.length < 200) {
      return { title, content: cleaned, error: "Content may be JS-rendered" };
    }

    return { title, content: cleaned };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { title: "", content: "", error: msg };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function executeWebFetch(targetUrl, jinaBase, signal) {
  try {
    new URL(targetUrl);
  } catch {
    throw new Error(`Invalid URL: ${targetUrl}`);
  }

  const direct = await fetchDirect(targetUrl, signal);

  if (!direct.error && direct.content.length >= 200) {
    const header = direct.title
      ? `# ${direct.title}\n\nSource: ${targetUrl}\n\n---\n\n`
      : "";
    return {
      content: [{ type: "text", text: header + direct.content }],
      details: {
        url: targetUrl,
        title: direct.title,
        chars: direct.content.length,
        method: "direct",
      },
    };
  }

  const jina = await fetchWithJina(jinaBase, targetUrl, signal);
  if (jina) {
    const header = jina.title
      ? `# ${jina.title}\n\nSource: ${targetUrl}\n\n---\n\n`
      : "";
    return {
      content: [{ type: "text", text: header + jina.content }],
      details: {
        url: targetUrl,
        title: jina.title,
        chars: jina.content.length,
        method: "jina",
      },
    };
  }

  if (direct.content) {
    return {
      content: [{ type: "text", text: direct.content }],
      details: {
        url: targetUrl,
        title: direct.title,
        chars: direct.content.length,
        method: "direct-partial",
        warning: direct.error,
      },
    };
  }

  throw new Error(
    `Could not fetch ${targetUrl}: ${direct.error || "unknown error"}`
  );
}

// --- Tests ---

before(async () => {
  await startTargetServer();
  await startJinaServer();
});

after(async () => {
  await stopServer(targetServer);
  await stopServer(jinaServer);
});

beforeEach(() => {
  resetState();
});

describe("URL validation", () => {
  test("invalid URL throws", async () => {
    await assert.rejects(
      () => executeWebFetch("not-a-url", `http://127.0.0.1:${jinaPort}/`, null),
      { message: /Invalid URL: not-a-url/ }
    );
  });

  test("empty string throws", async () => {
    await assert.rejects(
      () => executeWebFetch("", `http://127.0.0.1:${jinaPort}/`, null),
      { message: /Invalid URL/ }
    );
  });

  test("valid URL accepted", async () => {
    const result = await executeWebFetch(
      `http://127.0.0.1:${targetPort}/page`,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );
    assert.ok(result.content[0].text.length > 0);
  });
});

describe("direct fetch — HTML", () => {
  test("extracts title from HTML", async () => {
    const result = await executeWebFetch(
      `http://127.0.0.1:${targetPort}/`,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );

    assert.equal(result.details.title, "Test Page");
    assert.equal(result.details.method, "direct");
  });

  test("strips script tags", async () => {
    targetHandler = (_req, res) => {
      const longContent = "Real content here. ".repeat(30);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><head><title>T</title></head><body><script>alert('xss')</script><p>${longContent}</p></body></html>`);
    };

    const result = await executeWebFetch(
      `http://127.0.0.1:${targetPort}/`,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );

    assert.ok(!result.content[0].text.includes("alert"));
    assert.ok(result.content[0].text.includes("Real content here"));
  });

  test("strips style tags", async () => {
    targetHandler = (_req, res) => {
      const longContent = "Styled content. ".repeat(30);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><style>.hidden{display:none}</style><p>${longContent}</p></body></html>`);
    };

    const result = await executeWebFetch(
      `http://127.0.0.1:${targetPort}/`,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );

    assert.ok(!result.content[0].text.includes("display:none"));
  });

  test("strips nav, footer, header tags", async () => {
    targetHandler = (_req, res) => {
      const longContent = "Main content paragraph. ".repeat(30);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><header>Site Header</header><nav>Menu</nav><p>${longContent}</p><footer>Copyright</footer></body></html>`);
    };

    const result = await executeWebFetch(
      `http://127.0.0.1:${targetPort}/`,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );

    const text = result.content[0].text;
    assert.ok(!text.includes("Site Header"));
    assert.ok(!text.includes("Menu"));
    assert.ok(!text.includes("Copyright"));
    assert.ok(text.includes("Main content paragraph"));
  });

  test("decodes HTML entities", async () => {
    targetHandler = (_req, res) => {
      const longContent = "Entity content test. ".repeat(30);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><p>&amp; &lt; &gt; &quot; &#39; &nbsp; ${longContent}</p></body></html>`);
    };

    const result = await executeWebFetch(
      `http://127.0.0.1:${targetPort}/`,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );

    const text = result.content[0].text;
    assert.ok(text.includes("&"));
    assert.ok(text.includes("<"));
    assert.ok(text.includes(">"));
    assert.ok(text.includes('"'));
    assert.ok(text.includes("'"));
  });

  test("adds header with title and source URL", async () => {
    const url = `http://127.0.0.1:${targetPort}/`;
    const result = await executeWebFetch(
      url,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );

    assert.ok(result.content[0].text.startsWith("# Test Page"));
    assert.ok(result.content[0].text.includes(`Source: ${url}`));
  });
});

describe("direct fetch — non-HTML", () => {
  test("returns markdown content as-is", async () => {
    targetHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/markdown" });
      res.end(`# Markdown Doc\n\n${"Paragraph content here. ".repeat(30)}`);
    };

    const result = await executeWebFetch(
      `http://127.0.0.1:${targetPort}/doc.md`,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );

    assert.equal(result.details.method, "direct");
    assert.equal(result.details.title, "Markdown Doc");
    assert.ok(result.content[0].text.includes("Paragraph content here"));
  });

  test("plain text returns with URL as fallback title", async () => {
    targetHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("No heading here. ".repeat(30));
    };

    const url = `http://127.0.0.1:${targetPort}/plain.txt`;
    const result = await executeWebFetch(
      url,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );

    assert.equal(result.details.title, url);
  });
});

describe("direct fetch — error cases", () => {
  test("HTTP 404 triggers Jina fallback", async () => {
    targetHandler = (_req, res) => {
      res.writeHead(404);
      res.end("Not Found");
    };

    const result = await executeWebFetch(
      `http://127.0.0.1:${targetPort}/missing`,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );

    assert.equal(result.details.method, "jina");
    assert.equal(jinaRequests.length, 1);
  });

  test("HTTP 500 triggers Jina fallback", async () => {
    targetHandler = (_req, res) => {
      res.writeHead(500);
      res.end("Server Error");
    };

    const result = await executeWebFetch(
      `http://127.0.0.1:${targetPort}/error`,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );

    assert.equal(result.details.method, "jina");
  });

  test("response too large returns error", async () => {
    targetHandler = (_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Length": String(MAX_RESPONSE_SIZE + 1),
      });
      res.end("<html><body>small</body></html>");
    };

    // Direct fails (too large), Jina should be tried
    const result = await executeWebFetch(
      `http://127.0.0.1:${targetPort}/huge`,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );

    assert.equal(result.details.method, "jina");
  });
});

describe("short content — Jina fallback", () => {
  test("HTML with <200 chars cleaned content falls back to Jina", async () => {
    targetHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><p>Short</p></body></html>");
    };

    const result = await executeWebFetch(
      `http://127.0.0.1:${targetPort}/short`,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );

    assert.equal(result.details.method, "jina");
    assert.ok(result.content[0].text.includes("Jina content paragraph"));
  });
});

describe("Jina Reader", () => {
  test("sends correct headers to Jina", async () => {
    targetHandler = (_req, res) => {
      res.writeHead(404);
      res.end();
    };

    await executeWebFetch(
      `http://127.0.0.1:${targetPort}/page`,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );

    assert.equal(jinaRequests.length, 1);
    assert.equal(jinaRequests[0].headers.accept, "text/markdown");
    assert.equal(jinaRequests[0].headers["x-no-cache"], "true");
  });

  test("extracts title from markdown heading", async () => {
    targetHandler = (_req, res) => {
      res.writeHead(404);
      res.end();
    };

    const result = await executeWebFetch(
      `http://127.0.0.1:${targetPort}/page`,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );

    assert.equal(result.details.title, "Jina Title");
  });

  test("returns null when no Markdown Content marker", async () => {
    targetHandler = (_req, res) => {
      res.writeHead(404);
      res.end();
    };
    jinaHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("No marker here, just plain text without the expected format.");
    };

    await assert.rejects(
      () =>
        executeWebFetch(
          `http://127.0.0.1:${targetPort}/page`,
          `http://127.0.0.1:${jinaPort}/`,
          null
        ),
      { message: /Could not fetch/ }
    );
  });

  test("returns null when markdown content too short (<100 chars)", async () => {
    targetHandler = (_req, res) => {
      res.writeHead(404);
      res.end();
    };
    jinaHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Title: Short\nMarkdown Content:\nToo short.");
    };

    await assert.rejects(
      () =>
        executeWebFetch(
          `http://127.0.0.1:${targetPort}/page`,
          `http://127.0.0.1:${jinaPort}/`,
          null
        ),
      { message: /Could not fetch/ }
    );
  });

  test("Jina 500 returns null gracefully", async () => {
    targetHandler = (_req, res) => {
      res.writeHead(404);
      res.end();
    };
    jinaHandler = (_req, res) => {
      res.writeHead(500);
      res.end("Internal Server Error");
    };

    await assert.rejects(
      () =>
        executeWebFetch(
          `http://127.0.0.1:${targetPort}/page`,
          `http://127.0.0.1:${jinaPort}/`,
          null
        ),
      { message: /Could not fetch/ }
    );
  });
});

describe("both fail — partial content", () => {
  test("returns partial direct content when Jina also fails", async () => {
    targetHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><p>Some partial stuff here</p></body></html>");
    };
    jinaHandler = (_req, res) => {
      res.writeHead(500);
      res.end();
    };

    const result = await executeWebFetch(
      `http://127.0.0.1:${targetPort}/partial`,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );

    assert.equal(result.details.method, "direct-partial");
    assert.ok(result.details.warning);
    assert.ok(result.content[0].text.includes("Some partial stuff here"));
  });
});

describe("both fail — total failure", () => {
  test("throws when both direct and Jina return nothing", async () => {
    targetHandler = (_req, res) => {
      res.writeHead(403);
      res.end("Forbidden");
    };
    jinaHandler = (_req, res) => {
      res.writeHead(500);
      res.end();
    };

    await assert.rejects(
      () =>
        executeWebFetch(
          `http://127.0.0.1:${targetPort}/blocked`,
          `http://127.0.0.1:${jinaPort}/`,
          null
        ),
      { message: /Could not fetch/ }
    );
  });
});

describe("abort signal", () => {
  test("abort listener is wired to external signal", async () => {
    const controller = new AbortController();
    let listenerAdded = false;
    const origAdd = controller.signal.addEventListener.bind(controller.signal);
    controller.signal.addEventListener = (type, fn, opts) => {
      if (type === "abort") listenerAdded = true;
      return origAdd(type, fn, opts);
    };

    // fetchDirect should wire up the abort listener
    await fetchDirect(`http://127.0.0.1:${targetPort}/`, controller.signal);
    assert.ok(listenerAdded, "fetchDirect should add abort listener to external signal");
  });

  test("unreachable host with abort returns error", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    // Use a non-routable IP to ensure fetch doesn't complete before abort
    const direct = await fetchDirect("http://192.0.2.1:1/", controller.signal);
    assert.ok(direct.error, "Should return error when aborted");
  });
});

describe("request headers", () => {
  test("direct fetch sends User-Agent header", async () => {
    await executeWebFetch(
      `http://127.0.0.1:${targetPort}/`,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );

    assert.equal(targetRequests[0].headers["user-agent"], USER_AGENT);
  });

  test("direct fetch sends Accept header", async () => {
    await executeWebFetch(
      `http://127.0.0.1:${targetPort}/`,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );

    assert.ok(targetRequests[0].headers.accept.includes("text/html"));
  });
});

describe("content type detection", () => {
  test("application/xhtml+xml treated as HTML", async () => {
    targetHandler = (_req, res) => {
      const longContent = "XHTML content block. ".repeat(30);
      res.writeHead(200, { "Content-Type": "application/xhtml+xml" });
      res.end(`<html><head><title>XHTML</title></head><body><p>${longContent}</p></body></html>`);
    };

    const result = await executeWebFetch(
      `http://127.0.0.1:${targetPort}/`,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );

    assert.equal(result.details.title, "XHTML");
    assert.equal(result.details.method, "direct");
  });

  test("application/json treated as non-HTML", async () => {
    targetHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: "value", more: "A ".repeat(150) }));
    };

    const result = await executeWebFetch(
      `http://127.0.0.1:${targetPort}/api`,
      `http://127.0.0.1:${jinaPort}/`,
      null
    );

    assert.equal(result.details.method, "direct");
  });
});
