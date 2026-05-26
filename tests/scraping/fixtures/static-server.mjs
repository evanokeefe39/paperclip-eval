/**
 * Static fixture server for scraping tests.
 * Pure Node http module — zero dependencies.
 *
 * Endpoints:
 *   GET /         3 products with .product/.name/.price/.link classes
 *   GET /page1    Paginated page 1 (3 items + next link)
 *   GET /page2    Paginated page 2 (2 items, no next)
 *   GET /blocked  403 if UA contains "node" or "fetch", else product HTML
 *   GET /js       Content injected by JS after 500ms
 *   GET /large    500 generated products
 *   GET /health   JSON health check
 */

import { createServer } from "node:http";

const PORT = parseInt(process.env.PORT || "9999", 10);

// --- HTML payloads --------------------------------------------------------

const INDEX_HTML = `<html><body>
<div class="product"><span class="name">Widget A</span><span class="price">$10.00</span><a class="link" href="/widget-a">Details</a></div>
<div class="product"><span class="name">Widget B</span><span class="price">$25.50</span><a class="link" href="/widget-b">Details</a></div>
<div class="product"><span class="name">Widget C</span><span class="price">$7.99</span><a class="link" href="/widget-c">Details</a></div>
</body></html>`;

const PAGE1_HTML = `<html><body>
<div class="item"><span class="name">Item 1</span></div>
<div class="item"><span class="name">Item 2</span></div>
<div class="item"><span class="name">Item 3</span></div>
<a class="next" href="/page2">Next</a>
</body></html>`;

const PAGE2_HTML = `<html><body>
<div class="item"><span class="name">Item 4</span></div>
<div class="item"><span class="name">Item 5</span></div>
</body></html>`;

const BLOCKED_HTML = `<html><body>
<div class="product"><span class="name">Secret Product</span><span class="price">$99.00</span></div>
</body></html>`;

const JS_HTML = `<html><body>
<div id="root"></div>
<script>
setTimeout(function() {
  document.getElementById('root').innerHTML = '<div class="product"><span class="name">Dynamic Product</span><span class="price">$42.00</span></div>';
}, 500);
</script>
</body></html>`;

function buildLargeHTML() {
  const parts = ["<html><body>"];
  for (let i = 1; i <= 500; i++) {
    parts.push(
      `<div class="product"><span class="name">Product ${i}</span><span class="price">$${i}.00</span></div>`
    );
  }
  parts.push("</body></html>");
  return parts.join("\n");
}

// Cache /large so it is built once
const LARGE_HTML = buildLargeHTML();

// --- Routing --------------------------------------------------------------

function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method !== "GET") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
    return;
  }

  switch (path) {
    case "/": {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(INDEX_HTML);
      break;
    }

    case "/page1": {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE1_HTML);
      break;
    }

    case "/page2": {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE2_HTML);
      break;
    }

    case "/blocked": {
      const ua = (req.headers["user-agent"] || "").toLowerCase();
      if (ua.includes("node") || ua.includes("fetch")) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Access Denied");
      } else {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(BLOCKED_HTML);
      }
      break;
    }

    case "/js": {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(JS_HTML);
      break;
    }

    case "/large": {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(LARGE_HTML);
      break;
    }

    case "/health": {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      break;
    }

    default: {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      break;
    }
  }
}

// --- Server lifecycle -----------------------------------------------------

const server = createServer(handleRequest);

server.listen(PORT, () => {
  console.error(`[fixture-server] listening on :${PORT}`);
});

function shutdown() {
  console.error("[fixture-server] shutting down");
  server.close(() => process.exit(0));
  // Force exit after 3s if connections linger
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
