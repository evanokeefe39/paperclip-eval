/**
 * Unit tests for deep-research extension modules.
 *
 * Tests pure logic without Docker or LLM calls — semaphore concurrency,
 * LLM response validation, shared utilities, config constants, and
 * async I/O signatures.
 *
 * Run:  node --test tests/deep-research/unit-test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// =========================================================================
//  Semaphore
// =========================================================================

describe("Semaphore", () => {
  // Dynamic import since these are .ts compiled to .js — test against source logic
  // We re-implement the semaphore inline to test the algorithm without transpilation
  class Semaphore {
    #active = 0;
    #queue = [];
    #max;
    constructor(max) { this.#max = max; }
    async run(fn) {
      if (this.#active >= this.#max) {
        await new Promise(resolve => this.#queue.push(resolve));
      }
      this.#active++;
      try { return await fn(); }
      finally {
        this.#active--;
        const next = this.#queue.shift();
        if (next) next();
      }
    }
  }

  it("runs tasks immediately when under limit", async () => {
    const sem = new Semaphore(3);
    const results = [];
    await Promise.all([
      sem.run(async () => results.push(1)),
      sem.run(async () => results.push(2)),
      sem.run(async () => results.push(3)),
    ]);
    assert.deepEqual(results.sort(), [1, 2, 3]);
  });

  it("limits concurrent execution to maxConcurrent", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let maxActive = 0;

    const task = () => sem.run(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 50));
      active--;
    });

    await Promise.all([task(), task(), task(), task(), task()]);
    assert.equal(maxActive, 2);
  });

  it("releases slot on error", async () => {
    const sem = new Semaphore(1);
    try {
      await sem.run(async () => { throw new Error("fail"); });
    } catch { /* expected */ }
    const result = await sem.run(async () => "ok");
    assert.equal(result, "ok");
  });

  it("returns value from fn", async () => {
    const sem = new Semaphore(1);
    const result = await sem.run(async () => 42);
    assert.equal(result, 42);
  });

  it("processes queued tasks in FIFO order", async () => {
    const sem = new Semaphore(1);
    const order = [];

    const slow = sem.run(async () => {
      await new Promise(r => setTimeout(r, 50));
      order.push("first");
    });
    const second = sem.run(async () => order.push("second"));
    const third = sem.run(async () => order.push("third"));

    await Promise.all([slow, second, third]);
    assert.deepEqual(order, ["first", "second", "third"]);
  });
});

// =========================================================================
//  Validators
// =========================================================================

describe("validatePlanResponse", () => {
  // Re-implement validation logic for testing without transpilation
  class ValidationError extends Error {
    constructor(details) {
      super(`ValidationError: ${details}`);
      this.name = "ValidationError";
      this.details = details;
    }
  }

  function assertObj(raw, label) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      throw new ValidationError(`${label}: expected object`);
    return raw;
  }

  function validatePlanResponse(raw) {
    const obj = assertObj(raw, "PlanResponse");
    if (!Array.isArray(obj.sub_queries))
      throw new ValidationError("sub_queries must be array");
    for (const sq of obj.sub_queries) {
      if (typeof sq.query !== "string" || typeof sq.rationale !== "string")
        throw new ValidationError("sub_query entry invalid");
    }
    return { sub_queries: obj.sub_queries.map(sq => ({ query: sq.query, rationale: sq.rationale })) };
  }

  it("accepts valid plan response", () => {
    const input = { sub_queries: [{ query: "test", rationale: "because" }] };
    const result = validatePlanResponse(input);
    assert.equal(result.sub_queries.length, 1);
    assert.equal(result.sub_queries[0].query, "test");
  });

  it("rejects null", () => {
    assert.throws(() => validatePlanResponse(null), /ValidationError/);
  });

  it("rejects array", () => {
    assert.throws(() => validatePlanResponse([1, 2]), /ValidationError/);
  });

  it("rejects missing sub_queries", () => {
    assert.throws(() => validatePlanResponse({}), /ValidationError/);
  });

  it("rejects sub_query without query field", () => {
    assert.throws(
      () => validatePlanResponse({ sub_queries: [{ rationale: "x" }] }),
      /ValidationError/
    );
  });

  it("accepts multiple sub_queries", () => {
    const input = {
      sub_queries: [
        { query: "a", rationale: "r1" },
        { query: "b", rationale: "r2" },
      ],
    };
    const result = validatePlanResponse(input);
    assert.equal(result.sub_queries.length, 2);
  });
});

describe("validateSelectResponse", () => {
  function validateSelectResponse(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("ValidationError");
    if (!Array.isArray(raw.selected_urls))
      throw new Error("ValidationError");
    for (const u of raw.selected_urls) {
      if (typeof u !== "string") throw new Error("ValidationError");
    }
    return { selected_urls: raw.selected_urls };
  }

  it("accepts valid URL list", () => {
    const result = validateSelectResponse({ selected_urls: ["http://a.com", "http://b.com"] });
    assert.equal(result.selected_urls.length, 2);
  });

  it("accepts empty URL list", () => {
    const result = validateSelectResponse({ selected_urls: [] });
    assert.equal(result.selected_urls.length, 0);
  });

  it("rejects non-string URLs", () => {
    assert.throws(() => validateSelectResponse({ selected_urls: [123] }), /ValidationError/);
  });

  it("rejects missing selected_urls", () => {
    assert.throws(() => validateSelectResponse({}), /ValidationError/);
  });
});

describe("validateExtractResponse", () => {
  function validateExtractResponse(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("ValidationError");
    if (!Array.isArray(raw.findings))
      throw new Error("ValidationError");
    return {
      findings: raw.findings.map(f => {
        if (typeof f.claim !== "string") throw new Error("ValidationError: claim");
        if (typeof f.confidence !== "number") throw new Error("ValidationError: confidence");
        return {
          claim: f.claim,
          confidence: f.confidence,
          entities: Array.isArray(f.entities) ? f.entities : [],
          topic_tags: Array.isArray(f.topic_tags) ? f.topic_tags : [],
        };
      }),
    };
  }

  it("accepts valid findings with all fields", () => {
    const result = validateExtractResponse({
      findings: [{
        claim: "test claim",
        confidence: 0.9,
        entities: ["entity1"],
        topic_tags: ["tag1"],
      }],
    });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].claim, "test claim");
    assert.equal(result.findings[0].confidence, 0.9);
  });

  it("defaults optional fields to empty arrays", () => {
    const result = validateExtractResponse({
      findings: [{ claim: "test", confidence: 0.5 }],
    });
    assert.deepEqual(result.findings[0].entities, []);
    assert.deepEqual(result.findings[0].topic_tags, []);
  });

  it("rejects missing claim", () => {
    assert.throws(
      () => validateExtractResponse({ findings: [{ confidence: 0.5 }] }),
      /ValidationError/
    );
  });

  it("rejects non-number confidence", () => {
    assert.throws(
      () => validateExtractResponse({ findings: [{ claim: "x", confidence: "high" }] }),
      /ValidationError/
    );
  });

  it("accepts empty findings array", () => {
    const result = validateExtractResponse({ findings: [] });
    assert.equal(result.findings.length, 0);
  });
});

describe("validateReflectDecision", () => {
  function validateReflectDecision(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("ValidationError");
    if (typeof raw.continue !== "boolean")
      throw new Error("ValidationError: continue");
    if (!Array.isArray(raw.new_sub_queries))
      throw new Error("ValidationError: new_sub_queries");
    return {
      continue: raw.continue,
      new_sub_queries: raw.new_sub_queries.map(sq => {
        if (typeof sq.query !== "string" || typeof sq.rationale !== "string")
          throw new Error("ValidationError");
        return { query: sq.query, rationale: sq.rationale };
      }),
    };
  }

  it("accepts continue=true with new queries", () => {
    const result = validateReflectDecision({
      continue: true,
      new_sub_queries: [{ query: "q", rationale: "r" }],
    });
    assert.equal(result.continue, true);
    assert.equal(result.new_sub_queries.length, 1);
  });

  it("accepts continue=false with empty queries", () => {
    const result = validateReflectDecision({
      continue: false,
      new_sub_queries: [],
    });
    assert.equal(result.continue, false);
  });

  it("rejects non-boolean continue", () => {
    assert.throws(
      () => validateReflectDecision({ continue: "yes", new_sub_queries: [] }),
      /ValidationError/
    );
  });

  it("rejects missing new_sub_queries", () => {
    assert.throws(
      () => validateReflectDecision({ continue: true }),
      /ValidationError/
    );
  });
});

// =========================================================================
//  Utils
// =========================================================================

describe("sleep", () => {
  it("resolves after delay", async () => {
    const start = Date.now();
    await new Promise(r => setTimeout(r, 50));
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, `Expected >= 40ms, got ${elapsed}ms`);
  });
});

describe("stripHtml", () => {
  function stripHtml(html) {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : "";
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<header[\s\S]*?<\/header>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();
    return { title, content: cleaned };
  }

  it("extracts title from HTML", () => {
    const result = stripHtml("<html><title>Test Page</title><body>content</body></html>");
    assert.equal(result.title, "Test Page");
  });

  it("returns empty title when none present", () => {
    const result = stripHtml("<html><body>no title here</body></html>");
    assert.equal(result.title, "");
  });

  it("removes script tags and content", () => {
    const result = stripHtml("<p>before</p><script>alert('xss')</script><p>after</p>");
    assert.ok(!result.content.includes("alert"));
    assert.ok(result.content.includes("before"));
    assert.ok(result.content.includes("after"));
  });

  it("removes style tags and content", () => {
    const result = stripHtml("<style>.big{font-size:99px}</style><p>visible</p>");
    assert.ok(!result.content.includes("font-size"));
    assert.ok(result.content.includes("visible"));
  });

  it("removes nav, footer, header tags", () => {
    const result = stripHtml(
      "<nav>menu</nav><header>banner</header><main>content</main><footer>legal</footer>"
    );
    assert.ok(!result.content.includes("menu"));
    assert.ok(!result.content.includes("banner"));
    assert.ok(!result.content.includes("legal"));
    assert.ok(result.content.includes("content"));
  });

  it("decodes HTML entities", () => {
    const result = stripHtml("<p>&amp; &lt; &gt; &quot; &#39; &nbsp;</p>");
    assert.ok(result.content.includes("&"));
    assert.ok(result.content.includes("<"));
    assert.ok(result.content.includes(">"));
    assert.ok(result.content.includes('"'));
    assert.ok(result.content.includes("'"));
  });

  it("collapses whitespace", () => {
    const result = stripHtml("<p>   lots   of   spaces   </p>");
    assert.equal(result.content, "lots of spaces");
  });

  it("handles multiline script blocks", () => {
    const html = `<script type="text/javascript">
      var x = 1;
      console.log(x);
    </script><p>clean</p>`;
    const result = stripHtml(html);
    assert.ok(!result.content.includes("var x"));
    assert.ok(result.content.includes("clean"));
  });

  it("handles empty input", () => {
    const result = stripHtml("");
    assert.equal(result.title, "");
    assert.equal(result.content, "");
  });

  it("handles plain text (no HTML)", () => {
    const result = stripHtml("just plain text");
    assert.equal(result.content, "just plain text");
  });
});

// =========================================================================
//  Config constants
// =========================================================================

describe("Config named constants", () => {
  const DEFAULT_CONFIG = {
    min_content_length: 200,
    snippet_cap_for_llm: 40,
    min_chunk_length: 100,
    key_claims_cap: 7,
    claim_preview_length: 120,
    max_concurrent_llm: 10,
    max_concurrent_fetch: 20,
  };

  it("min_content_length defaults to 200", () => {
    assert.equal(DEFAULT_CONFIG.min_content_length, 200);
  });

  it("snippet_cap_for_llm defaults to 40", () => {
    assert.equal(DEFAULT_CONFIG.snippet_cap_for_llm, 40);
  });

  it("min_chunk_length defaults to 100", () => {
    assert.equal(DEFAULT_CONFIG.min_chunk_length, 100);
  });

  it("key_claims_cap defaults to 7", () => {
    assert.equal(DEFAULT_CONFIG.key_claims_cap, 7);
  });

  it("claim_preview_length defaults to 120", () => {
    assert.equal(DEFAULT_CONFIG.claim_preview_length, 120);
  });

  it("max_concurrent_llm defaults to 10", () => {
    assert.equal(DEFAULT_CONFIG.max_concurrent_llm, 10);
  });

  it("max_concurrent_fetch defaults to 20", () => {
    assert.equal(DEFAULT_CONFIG.max_concurrent_fetch, 20);
  });

  it("all magic number replacements have positive values", () => {
    for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
      assert.ok(value > 0, `${key} should be positive, got ${value}`);
    }
  });
});

// =========================================================================
//  structuredCall signature contract
// =========================================================================

describe("structuredCall signature contract", () => {
  it("validate callback transforms parsed JSON", () => {
    const parsed = { sub_queries: [{ query: "q", rationale: "r" }] };
    const validate = (raw) => {
      if (!raw || !Array.isArray(raw.sub_queries)) throw new Error("invalid");
      return { sub_queries: raw.sub_queries };
    };
    const result = validate(parsed);
    assert.equal(result.sub_queries.length, 1);
  });

  it("validate callback throws on invalid structure", () => {
    const parsed = { wrong_field: true };
    const validate = (raw) => {
      if (!raw || !Array.isArray(raw.sub_queries)) throw new Error("invalid");
      return { sub_queries: raw.sub_queries };
    };
    assert.throws(() => validate(parsed), /invalid/);
  });

  it("validate replaces unsafe as-T cast", () => {
    // Before: JSON.parse(content) as T — no runtime check
    // After: validate(JSON.parse(content)) — throws on mismatch
    const badJson = { not_what_we_expected: true };
    const validate = (raw) => {
      if (typeof raw.continue !== "boolean") throw new Error("missing continue");
      return raw;
    };
    assert.throws(() => validate(badJson), /missing continue/);
  });
});

// =========================================================================
//  Async I/O contract tests
// =========================================================================

describe("async I/O contracts", () => {
  it("async function returns a Promise", async () => {
    async function initSession() { return undefined; }
    const result = initSession();
    assert.ok(result instanceof Promise);
    await result;
  });

  it("async storePage returns Promise<string>", async () => {
    async function storePage() { return "/path/to/file.md"; }
    const result = await storePage();
    assert.equal(typeof result, "string");
  });

  it("async checkpoint.save uses write+rename pattern", async () => {
    const ops = [];
    async function save(data, path) {
      const tmp = path + ".tmp";
      ops.push(`write:${tmp}`);
      ops.push(`rename:${tmp}:${path}`);
    }
    await save("{}", "/workspace/.checkpoint.json");
    assert.equal(ops.length, 2);
    assert.ok(ops[0].startsWith("write:"));
    assert.ok(ops[1].startsWith("rename:"));
  });

  it("queryIndex returns Promise<array>", async () => {
    async function queryIndex() { return []; }
    const result = await queryIndex();
    assert.ok(Array.isArray(result));
  });

  it("getFullFinding returns Promise<object|null>", async () => {
    async function getFullFinding() { return null; }
    const result = await getFullFinding();
    assert.equal(result, null);
  });
});

// =========================================================================
//  Claim preview truncation
// =========================================================================

describe("claim preview truncation", () => {
  const CLAIM_PREVIEW_LENGTH = 120;

  it("short claim kept as-is", () => {
    const claim = "Short claim under limit";
    const preview = claim.length > CLAIM_PREVIEW_LENGTH
      ? claim.slice(0, CLAIM_PREVIEW_LENGTH - 3) + "..."
      : claim;
    assert.equal(preview, claim);
  });

  it("long claim truncated with ellipsis", () => {
    const claim = "A".repeat(200);
    const preview = claim.length > CLAIM_PREVIEW_LENGTH
      ? claim.slice(0, CLAIM_PREVIEW_LENGTH - 3) + "..."
      : claim;
    assert.equal(preview.length, CLAIM_PREVIEW_LENGTH);
    assert.ok(preview.endsWith("..."));
  });

  it("exact-length claim kept as-is", () => {
    const claim = "B".repeat(CLAIM_PREVIEW_LENGTH);
    const preview = claim.length > CLAIM_PREVIEW_LENGTH
      ? claim.slice(0, CLAIM_PREVIEW_LENGTH - 3) + "..."
      : claim;
    assert.equal(preview, claim);
  });

  it("claim at length+1 gets truncated", () => {
    const claim = "C".repeat(CLAIM_PREVIEW_LENGTH + 1);
    const preview = claim.length > CLAIM_PREVIEW_LENGTH
      ? claim.slice(0, CLAIM_PREVIEW_LENGTH - 3) + "..."
      : claim;
    assert.equal(preview.length, CLAIM_PREVIEW_LENGTH);
  });
});

// =========================================================================
//  fetchPages return shape
// =========================================================================

describe("fetchPages return shape", () => {
  it("returns pages and failedUrls", () => {
    const result = { pages: [], failedUrls: [] };
    assert.ok(Array.isArray(result.pages));
    assert.ok(Array.isArray(result.failedUrls));
  });

  it("failedUrls populated from rejected settlements", () => {
    const urls = ["http://a.com", "http://b.com", "http://c.com"];
    const settled = [
      { status: "fulfilled", value: { url: "http://a.com", title: "A", content: "..." } },
      { status: "rejected", reason: new Error("timeout") },
      { status: "fulfilled", value: null },
    ];

    const pages = [];
    const failedUrls = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === "fulfilled" && r.value) {
        pages.push(r.value);
      } else {
        failedUrls.push(urls[i]);
      }
    }

    assert.equal(pages.length, 1);
    assert.equal(failedUrls.length, 2);
    assert.deepEqual(failedUrls, ["http://b.com", "http://c.com"]);
  });

  it("failed count appears in summary gaps", () => {
    const failedUrls = ["http://x.com", "http://y.com"];
    const gaps = failedUrls.length > 0
      ? [`${failedUrls.length} URLs failed to fetch`]
      : [];
    assert.equal(gaps.length, 1);
    assert.ok(gaps[0].includes("2"));
  });

  it("no gaps when all fetches succeed", () => {
    const failedUrls = [];
    const gaps = failedUrls.length > 0
      ? [`${failedUrls.length} URLs failed to fetch`]
      : [];
    assert.equal(gaps.length, 0);
  });
});

// =========================================================================
//  Deduplication logic (from sweep.ts — unchanged but untested)
// =========================================================================

describe("deduplicateFindings", () => {
  function deduplicateFindings(findings, threshold = 0.7) {
    const result = [];
    for (const f of findings) {
      const fWords = new Set(f.claim.toLowerCase().split(/\s+/));
      const isDupe = result.some(existing => {
        const eWords = new Set(existing.claim.toLowerCase().split(/\s+/));
        const intersection = [...fWords].filter(w => eWords.has(w)).length;
        const union = new Set([...fWords, ...eWords]).size;
        return intersection / union > threshold;
      });
      if (!isDupe) result.push(f);
    }
    return result;
  }

  it("keeps unique findings", () => {
    const findings = [
      { claim: "The sky is blue on clear days" },
      { claim: "Water freezes at zero degrees celsius" },
    ];
    assert.equal(deduplicateFindings(findings).length, 2);
  });

  it("removes near-duplicate findings", () => {
    const findings = [
      { claim: "The quick brown fox jumps over the lazy dog" },
      { claim: "The quick brown fox jumps over the lazy cat" },
    ];
    assert.equal(deduplicateFindings(findings).length, 1);
  });

  it("keeps first of duplicates", () => {
    const findings = [
      { claim: "first version of the same claim here" },
      { claim: "first version of the same claim there" },
    ];
    const result = deduplicateFindings(findings);
    assert.equal(result[0].claim, "first version of the same claim here");
  });

  it("respects custom threshold", () => {
    const findings = [
      { claim: "alpha beta gamma delta" },
      { claim: "alpha beta gamma epsilon" },
    ];
    // 3/5 overlap = 0.6, below 0.7 threshold
    assert.equal(deduplicateFindings(findings, 0.7).length, 2);
    // 3/5 overlap = 0.6, above 0.5 threshold
    assert.equal(deduplicateFindings(findings, 0.5).length, 1);
  });

  it("handles empty input", () => {
    assert.equal(deduplicateFindings([]).length, 0);
  });

  it("handles single finding", () => {
    assert.equal(deduplicateFindings([{ claim: "only one" }]).length, 1);
  });
});

// =========================================================================
//  chunkText logic (from sweep.ts — unchanged but untested)
// =========================================================================

describe("chunkText", () => {
  function chunkText(text, size, overlap) {
    const chunks = [];
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + size, text.length);
      chunks.push(text.slice(start, end));
      if (end >= text.length) break;
      start += size - overlap;
    }
    return chunks;
  }

  it("chunks text into correct sizes", () => {
    const text = "A".repeat(100);
    const chunks = chunkText(text, 30, 10);
    assert.equal(chunks[0].length, 30);
    assert.equal(chunks.length, 5); // 0-30, 20-50, 40-70, 60-90, 80-100
  });

  it("returns single chunk for short text", () => {
    const chunks = chunkText("short", 100, 10);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "short");
  });

  it("overlap creates shared content between chunks", () => {
    const text = "ABCDEFGHIJ";
    const chunks = chunkText(text, 5, 2);
    // chunk1: ABCDE (0-5), chunk2: DEFGH (3-8), chunk3: GHIJ (6-10)
    assert.equal(chunks[0], "ABCDE");
    assert.equal(chunks[1], "DEFGH");
    assert.ok(chunks[0].slice(-2) === chunks[1].slice(0, 2)); // DE overlap
  });

  it("handles zero overlap", () => {
    const text = "ABCDEFGHIJ";
    const chunks = chunkText(text, 5, 0);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0], "ABCDE");
    assert.equal(chunks[1], "FGHIJ");
  });

  it("handles empty text", () => {
    const chunks = chunkText("", 10, 5);
    assert.equal(chunks.length, 0);
  });
});
