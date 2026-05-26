/**
 * Unit tests for scraping extension logic patterns.
 *
 * These test pure logic without Docker — URL resolution, output parsing,
 * boundary conditions, and API URL construction.
 *
 * Run:  node --test tests/scraping/unit-test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// =========================================================================
//  URL resolution
// =========================================================================

describe("URL resolution", () => {
  it("resolves absolute path from base URL", () => {
    const resolved = new URL("/page2", "http://example.com/page1").toString();
    assert.equal(resolved, "http://example.com/page2");
  });

  it("resolves relative path with parent traversal", () => {
    const resolved = new URL(
      "../other",
      "http://example.com/dir/page"
    ).toString();
    assert.equal(resolved, "http://example.com/other");
  });

  it("preserves query parameters in base URL path resolution", () => {
    const resolved = new URL(
      "/next?page=2",
      "http://example.com/list?page=1"
    ).toString();
    assert.equal(resolved, "http://example.com/next?page=2");
  });

  it("handles trailing slash in base URL", () => {
    const resolved = new URL("page2", "http://example.com/dir/").toString();
    assert.equal(resolved, "http://example.com/dir/page2");
  });

  it("handles protocol-relative URLs", () => {
    const resolved = new URL(
      "//cdn.example.com/page",
      "http://example.com/"
    ).toString();
    assert.equal(resolved, "http://cdn.example.com/page");
  });
});

// =========================================================================
//  Apify URL construction
// =========================================================================

describe("Apify URL construction", () => {
  const APIFY_BASE = "https://api.apify.com/v2";

  it("constructs actor run URL from actor ID", () => {
    const actorId = "apify/hello-world";
    const encoded = encodeURIComponent(actorId);
    const url = `${APIFY_BASE}/acts/${encoded}/runs`;
    assert.equal(url, "https://api.apify.com/v2/acts/apify%2Fhello-world/runs");
  });

  it("constructs store search URL with query", () => {
    const query = "web scraper";
    const encoded = encodeURIComponent(query);
    const url = `${APIFY_BASE}/store?search=${encoded}&limit=10`;
    assert.equal(
      url,
      "https://api.apify.com/v2/store?search=web%20scraper&limit=10"
    );
  });

  it("constructs dataset items URL from dataset ID", () => {
    const datasetId = "abc123";
    const url = `${APIFY_BASE}/datasets/${datasetId}/items?format=json`;
    assert.equal(
      url,
      "https://api.apify.com/v2/datasets/abc123/items?format=json"
    );
  });

  it("constructs run status URL from run ID", () => {
    const runId = "run-xyz-456";
    const url = `${APIFY_BASE}/actor-runs/${runId}`;
    assert.equal(url, "https://api.apify.com/v2/actor-runs/run-xyz-456");
  });
});

// =========================================================================
//  JSON output parsing
// =========================================================================

describe("JSON output parsing", () => {
  it("parses well-formed Python script output", () => {
    const rawOutput = JSON.stringify({
      items: [
        { name: "Widget A", price: "$10.00" },
        { name: "Widget B", price: "$25.50" },
      ],
      total: 2,
      url: "http://example.com/",
    });
    const parsed = JSON.parse(rawOutput);
    assert.equal(parsed.items.length, 2);
    assert.equal(parsed.items[0].name, "Widget A");
    assert.equal(parsed.total, 2);
  });

  it("handles empty items array", () => {
    const rawOutput = JSON.stringify({ items: [], total: 0, url: "http://example.com/" });
    const parsed = JSON.parse(rawOutput);
    assert.equal(parsed.items.length, 0);
    assert.equal(parsed.total, 0);
  });

  it("handles malformed JSON gracefully", () => {
    const rawOutput = "not valid json {";
    assert.throws(() => JSON.parse(rawOutput), SyntaxError);
  });

  it("handles JSON with trailing newline", () => {
    const rawOutput = '{"items":[],"total":0}\n';
    const parsed = JSON.parse(rawOutput.trim());
    assert.equal(parsed.total, 0);
  });

  it("handles multiple JSON lines (JSONL)", () => {
    const lines = [
      '{"type":"log","message":"starting"}',
      '{"type":"result","items":[{"name":"A"}]}',
    ];
    const parsed = lines.map((line) => JSON.parse(line));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].type, "log");
    assert.equal(parsed[1].type, "result");
    assert.equal(parsed[1].items[0].name, "A");
  });
});

// =========================================================================
//  max_items boundary conditions
// =========================================================================

describe("max_items boundary conditions", () => {
  const applyMaxItems = (items, maxItems) => {
    if (maxItems === undefined || maxItems === null) return items;
    if (maxItems <= 0) return [];
    return items.slice(0, maxItems);
  };

  const sampleItems = Array.from({ length: 20 }, (_, i) => ({
    name: `Product ${i + 1}`,
  }));

  it("returns empty array for max_items=0", () => {
    const result = applyMaxItems(sampleItems, 0);
    assert.equal(result.length, 0);
  });

  it("returns empty array for negative max_items", () => {
    const result = applyMaxItems(sampleItems, -5);
    assert.equal(result.length, 0);
  });

  it("returns all items when max_items exceeds length", () => {
    const result = applyMaxItems(sampleItems, 1000);
    assert.equal(result.length, 20);
  });

  it("returns exact count for valid max_items", () => {
    const result = applyMaxItems(sampleItems, 10);
    assert.equal(result.length, 10);
    assert.equal(result[9].name, "Product 10");
  });

  it("returns all items when max_items is undefined", () => {
    const result = applyMaxItems(sampleItems, undefined);
    assert.equal(result.length, 20);
  });

  it("returns all items when max_items is null", () => {
    const result = applyMaxItems(sampleItems, null);
    assert.equal(result.length, 20);
  });

  it("handles max_items=1 (single item)", () => {
    const result = applyMaxItems(sampleItems, 1);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Product 1");
  });

  it("handles very large max_items", () => {
    const result = applyMaxItems(sampleItems, Number.MAX_SAFE_INTEGER);
    assert.equal(result.length, 20);
  });
});

// =========================================================================
//  Field extraction logic
// =========================================================================

describe("field extraction logic", () => {
  // Simulates the field mapping pattern used in the scraping extension:
  // given a set of field definitions { fieldName: selectorWithinElement },
  // extract values from a parsed structure.
  const extractFields = (elements, fieldDefs) => {
    return elements.map((el) => {
      const record = {};
      for (const [fieldName, selector] of Object.entries(fieldDefs)) {
        record[fieldName] = el[selector] ?? null;
      }
      return record;
    });
  };

  const mockElements = [
    { ".name": "Widget A", ".price": "$10.00", ".link": "/widget-a" },
    { ".name": "Widget B", ".price": "$25.50", ".link": "/widget-b" },
    { ".name": "Widget C", ".price": "$7.99", ".link": "/widget-c" },
  ];

  it("extracts specified fields", () => {
    const result = extractFields(mockElements, {
      name: ".name",
      price: ".price",
    });
    assert.equal(result.length, 3);
    assert.equal(result[0].name, "Widget A");
    assert.equal(result[0].price, "$10.00");
    assert.equal(result[1].name, "Widget B");
  });

  it("returns null for missing selectors", () => {
    const result = extractFields(mockElements, {
      name: ".name",
      rating: ".rating",
    });
    assert.equal(result[0].name, "Widget A");
    assert.equal(result[0].rating, null);
  });

  it("handles empty elements array", () => {
    const result = extractFields([], { name: ".name" });
    assert.equal(result.length, 0);
  });

  it("handles empty field definitions", () => {
    const result = extractFields(mockElements, {});
    assert.equal(result.length, 3);
    assert.deepEqual(result[0], {});
  });

  it("extracts all fields when all selectors match", () => {
    const result = extractFields(mockElements, {
      name: ".name",
      price: ".price",
      link: ".link",
    });
    assert.equal(result[2].name, "Widget C");
    assert.equal(result[2].price, "$7.99");
    assert.equal(result[2].link, "/widget-c");
  });
});
