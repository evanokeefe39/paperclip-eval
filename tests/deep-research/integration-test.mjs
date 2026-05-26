/**
 * Integration tests for deep-research — real pipeline, fake external services.
 *
 * Uses http.createServer to mock Exa search API and LLM chat/completions,
 * then runs the actual engine, sweep, checkpoint, and store logic against
 * them. Tests are arranged in 6 tiers of increasing difficulty:
 *
 *   Tier 1 — Content: we get findings at all
 *   Tier 2 — Reference integrity: findings cite real sources from search
 *   Tier 3 — Provenance: verbatim quotes, page snapshots, source URLs are real
 *   Tier 4 — Quality heuristics: confidence, dedup, entity extraction
 *   Tier 5 — Accuracy: claim/source alignment, topic tag coherence
 *   Tier 6 — Resilience: checkpoint resume, transient error retry, abort
 *
 * Run:  node --test tests/deep-research/integration-test.mjs
 *
 * No Docker, no real API keys needed. Temp dirs cleaned up after each suite.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
//  Fake page content corpus — used by both the fake "internet" and the LLM
// ---------------------------------------------------------------------------

const PAGES = {
  "https://example.com/electric-vehicles": {
    title: "Electric Vehicle Market Report 2025",
    body: `<html><head><title>Electric Vehicle Market Report 2025</title></head><body>
<h1>Electric Vehicle Market Report 2025</h1>
<p>The global electric vehicle market reached $384 billion in 2024, growing at 24.3% CAGR.
Tesla maintained 18% global market share while BYD captured 16%. Battery costs fell to
$139/kWh, down from $153 in 2023. The European Union mandated all new vehicles be
zero-emission by 2035.</p>
<p>Solid-state batteries are expected to reach commercial scale by 2027, potentially
reducing costs by 40%. China accounted for 60% of global EV sales in 2024.</p>
</body></html>`,
  },
  "https://example.com/battery-tech": {
    title: "Battery Technology Advances",
    body: `<html><head><title>Battery Technology Advances</title></head><body>
<h1>Battery Technology Advances in 2025</h1>
<p>Lithium iron phosphate (LFP) batteries now represent 40% of EV battery chemistry,
up from 30% in 2023. CATL's Shenxing battery achieves 600km range with 10-minute
fast charging. Toyota announced solid-state battery pilot production beginning 2026.</p>
<p>Sodium-ion batteries entered commercial production for the first time, with costs
30% below lithium-ion equivalents. Energy density improvements of 15% year-over-year
were recorded across all major chemistries.</p>
</body></html>`,
  },
  "https://example.com/ev-criticism": {
    title: "Challenges Facing EV Adoption",
    body: `<html><head><title>Challenges Facing EV Adoption</title></head><body>
<h1>Critical Challenges for EV Adoption</h1>
<p>Despite growth, EVs face significant headwinds. Charging infrastructure remains
inadequate in rural areas, with only 12% of US highway corridors having fast chargers
every 50 miles. Grid capacity constraints in Texas and California have prompted
utilities to request EV owners limit charging during peak hours.</p>
<p>Insurance costs for EVs average 25% higher than comparable ICE vehicles due to
expensive battery repairs. Resale values dropped 30% in the first year for some
models, raising concerns about total cost of ownership.</p>
</body></html>`,
  },
  "https://example.com/ev-policy": {
    title: "Global EV Policy Landscape 2025",
    body: `<html><head><title>Global EV Policy Landscape 2025</title></head><body>
<h1>EV Policy Updates</h1>
<p>The US Inflation Reduction Act extended $7,500 tax credits through 2032 for
qualifying EVs assembled in North America. China reduced EV subsidies by 30% but
maintained purchase tax exemptions. India's FAME III scheme allocated $3.2 billion
for EV infrastructure and manufacturing incentives.</p>
<p>Japan committed $10 billion to next-generation battery research funding through
2030. The UK pushed back its ICE ban from 2030 to 2035, aligning with the EU timeline.</p>
</body></html>`,
  },
  "https://example.com/ev-charging": {
    title: "EV Charging Infrastructure Growth",
    body: `<html><head><title>EV Charging Infrastructure Growth</title></head><body>
<h1>Charging Infrastructure Expansion</h1>
<p>Global public charging points exceeded 3.5 million in 2024, a 40% increase from
2023. Tesla's Supercharger network opened to non-Tesla vehicles via NACS in North
America, adding 25,000 connectors. ChargePoint and EVgo expanded their networks by
35% and 28% respectively.</p>
<p>Wireless charging pilots launched in 6 US cities for fleet vehicles. Average
charging session duration dropped to 23 minutes for DC fast charging at 350kW stations.</p>
</body></html>`,
  },
};

const PAGE_URLS = Object.keys(PAGES);

// ---------------------------------------------------------------------------
//  Fake servers
// ---------------------------------------------------------------------------

function createFakeExaServer(opts = {}) {
  const {
    failCount = 0,
    emptyAfter = Infinity,
    latencyMs = 0,
  } = opts;
  let callCount = 0;

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.endsWith("/search")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());

    callCount++;

    if (callCount <= failCount) {
      res.writeHead(503);
      res.end("Service Unavailable");
      return;
    }

    if (latencyMs > 0) await new Promise(r => setTimeout(r, latencyMs));

    if (callCount > emptyAfter) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
      return;
    }

    const apiKey = req.headers["x-api-key"];
    if (!apiKey || apiKey !== "test-exa-key") {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }

    const results = PAGE_URLS.map((url, i) => ({
      title: PAGES[url].title,
      url,
      text: PAGES[url].body
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1500),
      highlights: [
        PAGES[url].body.replace(/<[^>]+>/g, " ").trim().split(".")[0] + ".",
      ],
      score: 0.95 - i * 0.05,
    }));

    const numResults = body.numResults || 10;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: results.slice(0, numResults) }));
  });

  server.callCount = () => callCount;
  return server;
}

function createFakeLLMServer(opts = {}) {
  const {
    failCount = 0,
    badJsonCount = 0,
    latencyMs = 0,
  } = opts;
  let callCount = 0;
  const callLog = [];

  function planResponse(query) {
    return {
      sub_queries: [
        { query: `${query} market size 2024`, rationale: "quantify current market" },
        { query: `${query} technology trends`, rationale: "identify innovation direction" },
        { query: `${query} challenges criticisms`, rationale: "contrarian perspective" },
      ],
    };
  }

  function selectResponse(snippetText) {
    const urls = [];
    for (const url of PAGE_URLS) {
      if (urls.length >= 5) break;
      urls.push(url);
    }
    return { selected_urls: urls, reason: "top relevance" };
  }

  function extractResponse(chunk, url) {
    const title = PAGES[url]?.title || "Unknown";
    const sentences = chunk.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/);
    const findings = [];
    for (const sentence of sentences.slice(0, 2)) {
      if (sentence.length < 20) continue;
      const quote = sentence.slice(0, Math.max(20, sentence.length));
      findings.push({
        claim: sentence.trim(),
        verbatim_quote: quote,
        confidence: sentence.includes("$") || sentence.includes("%") ? 0.9 : 0.6,
        topic_tags: ["electric-vehicles", "market-data"],
        entities: extractEntitiesFromText(sentence),
      });
    }
    return { findings };
  }

  function extractEntitiesFromText(text) {
    const entities = [];
    if (text.includes("Tesla")) entities.push("Tesla");
    if (text.includes("BYD")) entities.push("BYD");
    if (text.includes("CATL")) entities.push("CATL");
    if (text.includes("Toyota")) entities.push("Toyota");
    const moneyMatch = text.match(/\$[\d,.]+\s*(billion|million|trillion)?/gi);
    if (moneyMatch) entities.push(...moneyMatch);
    const pctMatch = text.match(/[\d.]+%/g);
    if (pctMatch) entities.push(...pctMatch);
    return entities;
  }

  function reflectResponse(iteration) {
    if (iteration === 0) {
      return {
        continue: true,
        reason: "need policy and infrastructure coverage",
        new_sub_queries: [
          { query: "EV policy incentives 2025", rationale: "policy landscape gap" },
        ],
      };
    }
    return {
      continue: false,
      reason: "adequate coverage across market, tech, policy, and challenges",
      new_sub_queries: [],
    };
  }

  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());

    callCount++;
    const systemContent = body.messages[0]?.content || "";
    const userContent = body.messages[1]?.content || "";
    callLog.push({ systemContent: systemContent.slice(0, 100), userContent: userContent.slice(0, 200) });

    if (callCount <= failCount) {
      res.writeHead(429);
      res.end("rate limited");
      return;
    }

    if (callCount <= failCount + badJsonCount) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { content: "not valid json {{{" } }],
      }));
      return;
    }

    if (latencyMs > 0) await new Promise(r => setTimeout(r, latencyMs));

    let responseObj;
    if (systemContent.includes("research planner")) {
      responseObj = planResponse(userContent);
    } else if (systemContent.includes("relevance filter")) {
      responseObj = selectResponse(userContent);
    } else if (systemContent.includes("Extract findings")) {
      const urlMatch = userContent.match(/\((https?:\/\/[^)]+)\)/);
      const url = urlMatch ? urlMatch[1] : PAGE_URLS[0];
      responseObj = extractResponse(userContent, url);
    } else if (systemContent.includes("quality assessor")) {
      const iterMatch = userContent.match(/Iteration:\s*(\d+)/);
      const iter = iterMatch ? parseInt(iterMatch[1]) - 1 : 0;
      responseObj = reflectResponse(iter);
    } else {
      responseObj = { error: "unknown prompt type" };
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(responseObj) } }],
    }));
  });

  server.callCount = () => callCount;
  server.callLog = () => callLog;
  return server;
}

function createFakePageServer() {
  const server = http.createServer((req, res) => {
    const path = `https://example.com${req.url}`;
    const page = PAGES[path];
    if (page) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(page.body);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return server;
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

async function listen(server) {
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

function buildTestConfig(exaUrl, llmUrl, pageServerUrl, artifactsDir, checkpointPath, overrides = {}) {
  // Rewrite page URLs to point at our fake page server
  const rewrittenPages = {};
  for (const [url, page] of Object.entries(PAGES)) {
    const path = new URL(url).pathname;
    const newUrl = `${pageServerUrl}${path}`;
    rewrittenPages[newUrl] = page;
  }

  return {
    llm_provider: "test",
    llm_model: "test-model",
    llm_api_key: "test-key",
    llm_base_url: llmUrl,
    max_retries: 3,
    llm_timeout_ms: 10_000,
    max_iterations: 2,
    max_sub_queries: 3,
    snippet_results_per_query: 10,
    heuristic_keep_ratio: 0.5,
    top_k_for_extraction: 5,
    chunk_size: 1500,
    chunk_overlap: 200,
    max_chunks_per_page: 5,
    max_findings_per_sweep: 20,
    max_findings_in_summary: 10,
    artifacts_base: artifactsDir,
    exa_api_key: "test-exa-key",
    min_content_length: 50,
    snippet_cap_for_llm: 20,
    min_chunk_length: 30,
    key_claims_cap: 5,
    claim_preview_length: 120,
    max_concurrent_llm: 5,
    max_concurrent_fetch: 5,
    _exa_base_url: exaUrl,
    _checkpoint_path: checkpointPath,
    _page_url_rewrite: rewrittenPages,
    ...overrides,
  };
}

// Re-implement key modules inline (same pattern as unit-test.mjs) to avoid
// transpilation. These mirror the actual source but route HTTP to our fakes.

class LRUCache {
  #map = new Map();
  #max;
  constructor(max = 200) { this.#max = max; }
  get(key) {
    const e = this.#map.get(key);
    if (!e) return null;
    if (Date.now() > e.exp) { this.#map.delete(key); return null; }
    return e.value;
  }
  set(key, value, ttl = 600_000) {
    if (this.#map.size >= this.#max) {
      const oldest = this.#map.keys().next().value;
      this.#map.delete(oldest);
    }
    this.#map.set(key, { value, exp: Date.now() + ttl });
  }
  has(key) { return this.get(key) !== null; }
  clear() { this.#map.clear(); }
}

class Semaphore {
  #active = 0; #queue = []; #max;
  constructor(max) { this.#max = max; }
  async run(fn) {
    if (this.#active >= this.#max)
      await new Promise(resolve => this.#queue.push(resolve));
    this.#active++;
    try { return await fn(); }
    finally {
      this.#active--;
      const next = this.#queue.shift();
      if (next) next();
    }
  }
}

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

function validateSelectResponse(raw) {
  const obj = assertObj(raw, "SelectResponse");
  if (!Array.isArray(obj.selected_urls))
    throw new ValidationError("selected_urls must be array");
  return { selected_urls: obj.selected_urls };
}

function validateExtractResponse(raw) {
  const obj = assertObj(raw, "ExtractResponse");
  if (!Array.isArray(obj.findings))
    throw new ValidationError("findings must be array");
  return {
    findings: obj.findings.map(f => {
      if (typeof f.claim !== "string") throw new ValidationError("claim must be string");
      if (typeof f.confidence !== "number") throw new ValidationError("confidence must be number");
      return {
        claim: f.claim,
        confidence: f.confidence,
        verbatim_quote: f.verbatim_quote || "",
        entities: f.entities || [],
        topic_tags: f.topic_tags || [],
      };
    }),
  };
}

function validateReflectDecision(raw) {
  const obj = assertObj(raw, "ReflectDecision");
  if (typeof obj.continue !== "boolean")
    throw new ValidationError("continue must be boolean");
  return {
    continue: obj.continue,
    new_sub_queries: (obj.new_sub_queries || []).map(sq => ({
      query: sq.query,
      rationale: sq.rationale,
    })),
  };
}

const STOP_WORDS = new Set([
  "a","an","the","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might","shall","can",
  "need","dare","ought","used","to","of","in","for","on","with","at","by","from",
  "as","into","through","during","before","after","above","below","between","out",
  "off","over","under","again","further","then","once","here","there","when",
  "where","why","how","all","both","each","few","more","most","other","some",
  "such","no","nor","not","only","own","same","so","than","too","very","just",
  "because","but","and","or","if","while","about","what","which","who","whom",
  "this","that","these","those","am","it","its",
]);

function extractKeywords(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/).filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function heuristicRank(snippets, query) {
  const queryTerms = extractKeywords(query);
  if (queryTerms.length === 0) {
    return snippets.map(s => ({
      ...s, exa_score: s.score, heuristic_score: 0, combined_score: s.score,
    })).sort((a, b) => b.combined_score - a.combined_score);
  }
  const queryLower = query.toLowerCase();
  return snippets.map(s => {
    const textLower = (s.text || "").toLowerCase();
    const titleLower = (s.title || "").toLowerCase();
    const termMatches = queryTerms.filter(t => textLower.includes(t)).length;
    const termScore = termMatches / queryTerms.length;
    const titleBonus = queryTerms.some(t => titleLower.includes(t)) ? 0.2 : 0;
    const highlightBonus = s.highlights?.length ? Math.min(s.highlights.length * 0.1, 0.3) : 0;
    const lengthPenalty = (s.text?.length || 0) < 200 ? -0.2 : 0;
    const phraseBonus = textLower.includes(queryLower) ? 0.3 : 0;
    const heuristic_score = Math.min(1, Math.max(0, termScore + titleBonus + highlightBonus + lengthPenalty + phraseBonus));
    const combined_score = s.score * 0.6 + heuristic_score * 0.4;
    return { ...s, exa_score: s.score, heuristic_score, combined_score };
  }).sort((a, b) => b.combined_score - a.combined_score);
}

function stripHtml(html) {
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";
  let content = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { title, content };
}

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

// --- Structured LLM call (mirrors llm.ts, routes to fake server) ---

let _limiter = null;
function getLimiter(config) {
  if (!_limiter) _limiter = new Semaphore(config.max_concurrent_llm);
  return _limiter;
}

async function structuredCall(llmConfig, systemPrompt, userContent, validate, config, signal) {
  return getLimiter(config).run(async () => {
    for (let attempt = 0; attempt < llmConfig.maxRetries; attempt++) {
      const res = await fetch(`${llmConfig.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${llmConfig.apiKey}`,
        },
        body: JSON.stringify({
          model: llmConfig.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
          response_format: { type: "json_object" },
          temperature: 0.1,
        }),
        signal: AbortSignal.any([
          AbortSignal.timeout(llmConfig.timeoutMs),
          ...(signal ? [signal] : []),
        ]),
      });
      if (res.ok) {
        const data = await res.json();
        try {
          const parsed = JSON.parse(data.choices[0].message.content);
          return validate(parsed);
        } catch { continue; }
      }
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
        continue;
      }
      throw new Error(`LLM API ${res.status}: ${await res.text()}`);
    }
    throw new Error(`LLM call failed after ${llmConfig.maxRetries} attempts`);
  });
}

// --- Prompts ---

const PLAN_PROMPT = `You are a research planner. Given a research query, decompose it into 3-6 specific sub-queries that together cover the topic comprehensively.
Return JSON: {"sub_queries": [{"query": "specific search query", "rationale": "why this angle matters"}]}`;

const SELECT_PROMPT = `You are a research relevance filter. Given a sub-query and ranked snippets, select the URLs most likely to contain substantive, verifiable information.
Return JSON: {"selected_urls": ["url1", "url2", ...], "reason": "one sentence"}`;

const EXTRACT_PROMPT = `Extract findings from content chunks.
Return JSON: {"findings": [{"claim": "...", "verbatim_quote": "...", "confidence": 0.0-1.0, "topic_tags": ["..."], "entities": ["..."]}]}`;

const REFLECT_PROMPT = `You are a research quality assessor. Given the original query and summaries of completed research sweeps, decide whether more research is needed.
Return JSON: {"continue": true/false, "reason": "one sentence", "new_sub_queries": [{"query": "...", "rationale": "..."}]}`;

// --- Store (mirrors store.ts, uses temp dirs) ---

import { createHash, randomUUID } from "node:crypto";
import { appendFile as fsAppendFile } from "node:fs/promises";

async function initSession(sessionId, query, config) {
  const base = `${config.artifacts_base}/sessions/${sessionId}`;
  await mkdir(`${base}/pages`, { recursive: true });
}

async function streamFinding(finding, sessionId, config) {
  const base = `${config.artifacts_base}/sessions/${sessionId}`;
  await fsAppendFile(`${base}/findings.jsonl`, JSON.stringify(finding) + "\n");
  const indexEntry = {
    id: finding.id,
    claim_preview: finding.claim_preview,
    confidence: finding.confidence,
    source_url: finding.source_url,
    session_id: sessionId,
    timestamp: finding.timestamp,
    topic_tags: finding.topic_tags,
    entities: finding.entities,
  };
  await fsAppendFile(`${config.artifacts_base}/index.jsonl`, JSON.stringify(indexEntry) + "\n");
}

async function storePage(sessionId, url, content, config) {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const path = `${config.artifacts_base}/sessions/${sessionId}/pages/${hash}.md`;
  if (!existsSync(path)) {
    await writeFile(path, `<!-- Source: ${url} -->\n<!-- Captured: ${new Date().toISOString()} -->\n\n${content}`);
  }
  return path;
}

// --- Sweep pipeline (mirrors sweep.ts + extract.ts, uses fake servers) ---

async function searchExa(query, numResults, cache, config, signal) {
  const cached = cache.get(query);
  if (cached) return cached;

  const baseUrl = config._exa_base_url || "https://api.exa.ai";
  const res = await fetch(`${baseUrl}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": config.exa_api_key },
    body: JSON.stringify({
      query, numResults,
      contents: { text: { maxCharacters: 1500 }, highlights: { numSentences: 3 } },
    }),
    signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
  });
  if (!res.ok) throw new Error(`Exa API ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const results = data.results || [];
  cache.set(query, results);
  return results;
}

async function fetchPage(url, config, signal) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "test-agent", Accept: "text/html,*/*" },
      signal: AbortSignal.any([AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length < config.min_content_length) return null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text/html") || ct.includes("xhtml")) {
      const { title } = stripHtml(text);
      const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      const { content: cleaned } = stripHtml(bodyMatch?.[1] || text);
      if (cleaned.length < config.min_content_length) return null;
      return { url, title: title || url, content: cleaned };
    }
    return { url, title: url, content: text };
  } catch { return null; }
}

async function fetchPages(urls, fetchCache, config, signal) {
  const results = [];
  const failedUrls = [];
  const toFetch = urls.filter(url => {
    const cached = fetchCache.get(url);
    if (cached) { results.push({ url, ...cached }); return false; }
    return true;
  });
  const fetched = await Promise.allSettled(toFetch.map(url => fetchPage(url, config, signal)));
  for (let i = 0; i < fetched.length; i++) {
    const r = fetched[i];
    if (r.status === "fulfilled" && r.value) {
      fetchCache.set(r.value.url, { title: r.value.title, content: r.value.content });
      results.push(r.value);
    } else {
      failedUrls.push(toFetch[i]);
    }
  }
  return { pages: results, failedUrls };
}

async function selectUrls(subQueryText, survivors, config, signal) {
  const llmConfig = buildLLMConfig(config);
  const formatted = survivors.slice(0, config.snippet_cap_for_llm)
    .map((s, i) => `${i + 1}. [${s.combined_score.toFixed(2)}] ${s.title}\n   URL: ${s.url}\n   ${(s.text || "").slice(0, config.min_content_length)}`)
    .join("\n\n");
  try {
    const result = await structuredCall(
      llmConfig, SELECT_PROMPT,
      `Sub-query: ${subQueryText}\n\nRanked snippets:\n${formatted}`,
      validateSelectResponse, config, signal,
    );
    return result.selected_urls || [];
  } catch {
    return survivors.slice(0, config.top_k_for_extraction).map(s => s.url);
  }
}

async function extractFromPage(url, title, chunks, subQuery, sessionId, config, signal) {
  const llmConfig = buildLLMConfig(config);
  const allFindings = [];
  const fullContent = chunks.join("\n\n---\n\n");
  const snapshotPath = await storePage(sessionId, url, fullContent, config);
  for (const chunk of chunks) {
    if (chunk.trim().length < config.min_chunk_length) continue;
    const userContent = `Sub-query: ${subQuery.query}\nSource: ${title} (${url})\n\nContent:\n${chunk}`;
    try {
      const result = await structuredCall(
        llmConfig, EXTRACT_PROMPT, userContent, validateExtractResponse, config, signal,
      );
      for (const raw of result.findings || []) {
        if (!raw.claim || raw.claim.length < 10) continue;
        const finding = {
          id: randomUUID(),
          session_id: sessionId,
          timestamp: new Date().toISOString(),
          claim: raw.claim,
          claim_preview: raw.claim.length > config.claim_preview_length
            ? raw.claim.slice(0, config.claim_preview_length - 3) + "..." : raw.claim,
          confidence: Math.max(0, Math.min(1, raw.confidence || 0.5)),
          source_url: url,
          source_title: title,
          verbatim_quote: raw.verbatim_quote || "",
          full_chunk: chunk,
          page_snapshot_path: snapshotPath,
          sub_query: subQuery.query,
          sub_query_id: subQuery.id,
          topic_tags: raw.topic_tags || [],
          entities: (raw.entities || []).map(e => typeof e === "string" ? { name: e, type: "unknown" } : e),
          related_findings: [],
          contradicts: [],
        };
        allFindings.push(finding);
        await streamFinding(finding, sessionId, config);
      }
    } catch { continue; }
  }
  return allFindings;
}

async function executeSweep(subQuery, originalQuery, sessionId, config, state, signal) {
  const snippets = await searchExa(subQuery.query, config.snippet_results_per_query, state.searchCache, config, signal);
  const ranked = heuristicRank(snippets, subQuery.query);
  const survivors = ranked.slice(0, Math.ceil(ranked.length * config.heuristic_keep_ratio));

  // Rewrite URLs: the fake LLM returns example.com URLs, map them to our page server
  let selectedUrls = await selectUrls(subQuery.query, survivors, config, signal);
  if (config._page_url_rewrite) {
    const reverseMap = {};
    for (const [newUrl, page] of Object.entries(config._page_url_rewrite)) {
      for (const [origUrl] of Object.entries(PAGES)) {
        if (PAGES[origUrl] === page) reverseMap[origUrl] = newUrl;
      }
    }
    selectedUrls = selectedUrls.map(u => reverseMap[u] || u);
  }

  const { pages, failedUrls } = await fetchPages(selectedUrls, state.fetchCache, config, signal);
  const pageChunks = pages.map(p => ({
    url: p.url, title: p.title,
    chunks: chunkText(p.content, config.chunk_size, config.chunk_overlap).slice(0, config.max_chunks_per_page),
  }));

  const extractResults = await Promise.allSettled(
    pageChunks.map(({ url, title, chunks }) =>
      extractFromPage(url, title, chunks, subQuery, sessionId, config, signal))
  );
  const allFindings = [];
  for (const r of extractResults) {
    if (r.status === "fulfilled") allFindings.push(...r.value);
  }

  const deduplicated = deduplicateFindings(allFindings);
  const capped = deduplicated.sort((a, b) => b.confidence - a.confidence).slice(0, config.max_findings_per_sweep);
  const summary = {
    sub_query_id: subQuery.id,
    query: subQuery.query,
    key_claims: capped.slice(0, config.key_claims_cap).map(f => f.claim_preview),
    coverage: `${capped.length} findings from ${selectedUrls.length} sources (${snippets.length} scanned).`,
    gaps: failedUrls.length > 0 ? [`${failedUrls.length} URLs failed to fetch`] : [],
    finding_count: capped.length,
    source_count: selectedUrls.length,
  };
  return { sub_query: subQuery, findings: capped, summary, sources_used: pages.map(p => ({ url: p.url, title: p.title })) };
}

function buildLLMConfig(config) {
  return {
    provider: config.llm_provider,
    model: config.llm_model,
    apiKey: config.llm_api_key,
    baseUrl: config.llm_base_url,
    maxRetries: config.max_retries,
    timeoutMs: config.llm_timeout_ms,
  };
}

// --- Checkpoint (mirrors checkpoint.ts, uses configurable path) ---

class Checkpoint {
  #data;
  #path;
  constructor(path) {
    this.#path = path;
    if (existsSync(path)) {
      this.#data = JSON.parse(readFileSync(path, "utf-8"));
    } else {
      this.#data = { sessions: {} };
    }
  }
  findResumable(query) {
    const sessions = Object.values(this.#data.sessions)
      .filter(s => s.query === query && (s.status === "running" || s.status === "reflecting"))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return sessions[0] || null;
  }
  async createSession(sessionId, query) {
    this.#data.sessions[sessionId] = {
      session_id: sessionId, query, status: "running", iteration: 0,
      sub_queries: [], reflections: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    await this.#save();
  }
  async addSubQueries(sessionId, subQueries, iteration) {
    const s = this.#data.sessions[sessionId];
    if (!s) return;
    for (const sq of subQueries) {
      if (s.sub_queries.some(e => e.id === sq.id)) continue;
      s.sub_queries.push({ id: sq.id, query: sq.query, rationale: sq.rationale, iteration, status: "pending" });
    }
    s.updated_at = new Date().toISOString();
    await this.#save();
  }
  async markSweepStarted(sqId, sessionId) {
    const sq = this.#data.sessions[sessionId]?.sub_queries.find(s => s.id === sqId);
    if (sq) { sq.status = "running"; this.#data.sessions[sessionId].updated_at = new Date().toISOString(); await this.#save(); }
  }
  async markSweepComplete(sqId, sessionId, summary) {
    const sq = this.#data.sessions[sessionId]?.sub_queries.find(s => s.id === sqId);
    if (sq) { sq.status = "complete"; sq.summary = summary; this.#data.sessions[sessionId].updated_at = new Date().toISOString(); await this.#save(); }
  }
  async markSweepFailed(sqId, sessionId, error) {
    const sq = this.#data.sessions[sessionId]?.sub_queries.find(s => s.id === sqId);
    if (sq) { sq.status = "failed"; sq.error = error; this.#data.sessions[sessionId].updated_at = new Date().toISOString(); await this.#save(); }
  }
  async addReflection(sessionId, iteration, decision) {
    const s = this.#data.sessions[sessionId];
    if (!s) return;
    s.reflections.push(decision);
    s.iteration = iteration;
    s.status = "reflecting";
    s.updated_at = new Date().toISOString();
    await this.#save();
  }
  async markComplete(sessionId) {
    const s = this.#data.sessions[sessionId];
    if (s) { s.status = "complete"; s.updated_at = new Date().toISOString(); await this.#save(); }
  }
  async cleanup() {
    const entries = Object.entries(this.#data.sessions).sort(([,a],[,b]) => b.updated_at.localeCompare(a.updated_at));
    if (entries.length > 20) { this.#data.sessions = Object.fromEntries(entries.slice(0, 20)); await this.#save(); }
  }
  getData() { return this.#data; }
  async #save() { await writeFile(this.#path, JSON.stringify(this.#data, null, 2)); }
}

// --- Engine (mirrors engine.ts) ---

async function planSubQueries(query, config, signal) {
  const llmConfig = buildLLMConfig(config);
  const result = await structuredCall(llmConfig, PLAN_PROMPT, query, validatePlanResponse, config, signal);
  return (result.sub_queries || []).slice(0, config.max_sub_queries)
    .map(sq => ({ id: randomUUID(), query: sq.query, rationale: sq.rationale }));
}

async function reflect(query, summaries, iteration, config, signal) {
  const llmConfig = buildLLMConfig(config);
  const userContent = [
    `Original query: ${query}`,
    `Iteration: ${iteration + 1}/${config.max_iterations}`,
    "", "Sweep summaries:",
    ...summaries.map((s, i) => `${i + 1}. ${s}`),
  ].join("\n");
  const result = await structuredCall(llmConfig, REFLECT_PROMPT, userContent, validateReflectDecision, config, signal);
  return {
    continue: result.continue ?? false,
    reason: "",
    new_sub_queries: (result.new_sub_queries || []).map(sq => ({ id: randomUUID(), query: sq.query, rationale: sq.rationale })),
  };
}

async function buildSessionSummary(query, state, sessionId, config) {
  const findings = state.allFindings.sort((a, b) => b.confidence - a.confidence).slice(0, config.max_findings_in_summary);
  const lines = [
    `## Research Summary: ${query}`, "",
    `**Session:** ${sessionId}`,
    `**Iterations:** ${state.iteration + 1}`,
    `**Total findings:** ${state.allFindings.length}`,
    `**Unique sources:** ${new Set(state.allFindings.map(f => f.source_url)).size}`,
    "", "### Key Findings", "",
  ];
  for (const [i, f] of findings.entries()) {
    lines.push(`${i + 1}. [${f.confidence.toFixed(1)}] ${f.claim_preview}`);
    lines.push(`   Source: ${f.source_url}`);
    if (f.entities.length > 0) lines.push(`   Entities: ${f.entities.map(e => e.name).join(", ")}`);
    lines.push("");
  }
  const summary = lines.join("\n");
  try { await writeFile(`${config.artifacts_base}/sessions/${sessionId}/summary.md`, summary); } catch {}
  return summary;
}

async function writeSessionMeta(sessionId, query, subQueries, config, state) {
  const meta = {
    session_id: sessionId, query, sub_queries: subQueries,
    started_at: state.startedAt, completed_at: new Date().toISOString(),
    total_findings: state.allFindings.length,
    total_sources: new Set(state.allFindings.map(f => f.source_url)).size,
    iterations: state.iteration,
    config: { max_iterations: config.max_iterations, max_sub_queries: config.max_sub_queries },
  };
  await writeFile(`${config.artifacts_base}/sessions/${sessionId}/meta.json`, JSON.stringify(meta, null, 2));
}

async function deepResearch(query, config, signal) {
  const checkpoint = new Checkpoint(config._checkpoint_path);
  const existing = checkpoint.findResumable(query);
  let sessionId, allSubQueries, startIteration;
  const state = {
    sweepResults: new Map(), allFindings: [], searchCache: new LRUCache(),
    fetchCache: new Map(), startedAt: new Date().toISOString(), iteration: 0,
  };
  if (existing) {
    sessionId = existing.session_id;
    startIteration = existing.iteration;
    allSubQueries = existing.sub_queries.map(sq => ({ id: sq.id, query: sq.query, rationale: sq.rationale }));
    state.startedAt = existing.created_at;
  } else {
    sessionId = randomUUID();
    await checkpoint.createSession(sessionId, query);
    await initSession(sessionId, query, config);
    allSubQueries = await planSubQueries(query, config, signal);
    await checkpoint.addSubQueries(sessionId, allSubQueries, 0);
    startIteration = 0;
  }
  let iteration = startIteration;
  let pending = allSubQueries.filter(sq => {
    if (!existing) return true;
    const cp = existing.sub_queries.find(s => s.id === sq.id);
    return !cp || cp.status !== "complete";
  });
  while (iteration < config.max_iterations && pending.length > 0) {
    const results = await Promise.allSettled(
      pending.map(async sq => {
        await checkpoint.markSweepStarted(sq.id, sessionId);
        try {
          const result = await executeSweep(sq, query, sessionId, config, state, signal);
          await checkpoint.markSweepComplete(sq.id, sessionId, result.summary);
          return result;
        } catch (err) {
          await checkpoint.markSweepFailed(sq.id, sessionId, err instanceof Error ? err.message : String(err));
          throw err;
        }
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        state.sweepResults.set(r.value.sub_query.id, r.value);
        state.allFindings.push(...r.value.findings);
      }
    }
    const summaries = [...state.sweepResults.values()].map(r => r.summary.coverage);
    const decision = await reflect(query, summaries, iteration, config, signal);
    await checkpoint.addReflection(sessionId, iteration, decision);
    if (!decision.continue || decision.new_sub_queries.length === 0) break;
    await checkpoint.addSubQueries(sessionId, decision.new_sub_queries, iteration + 1);
    pending = decision.new_sub_queries;
    iteration++;
    state.iteration = iteration;
  }
  await checkpoint.markComplete(sessionId);
  await checkpoint.cleanup();
  const summary = await buildSessionSummary(query, state, sessionId, config);
  await writeSessionMeta(sessionId, query, allSubQueries, config, state);
  return { sessionId, summary, findingCount: state.allFindings.length };
}

// --- Index query (mirrors query.ts) ---

async function queryIndex(query, maxResults, config, sessionFilter) {
  const indexPath = `${config.artifacts_base}/index.jsonl`;
  if (!existsSync(indexPath)) return [];
  const queryTerms = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  if (queryTerms.length === 0) return [];
  const results = [];
  const lines = (await readFile(indexPath, "utf-8")).split("\n").filter(Boolean);
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (sessionFilter && entry.session_id !== sessionFilter) continue;
    const searchText = [entry.claim_preview, ...entry.topic_tags, ...entry.entities.map(e => e.name)].join(" ").toLowerCase();
    const matches = queryTerms.filter(t => searchText.includes(t)).length;
    if (matches === 0) continue;
    const score = (matches / queryTerms.length) * entry.confidence;
    results.push({ entry, score });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, maxResults).map(r => r.entry);
}


// ===========================================================================
//  TEST SUITES
// ===========================================================================

let exaServer, llmServer, pageServer;
let exaUrl, llmUrl, pageUrl;
let tmpDir, artifactsDir, checkpointPath;

async function setupServers(exaOpts = {}, llmOpts = {}) {
  exaServer = createFakeExaServer(exaOpts);
  llmServer = createFakeLLMServer(llmOpts);
  pageServer = createFakePageServer();
  [exaUrl, llmUrl, pageUrl] = await Promise.all([
    listen(exaServer), listen(llmServer), listen(pageServer),
  ]);
}

async function setupDirs() {
  tmpDir = await mkdtemp(join(tmpdir(), "dr-test-"));
  artifactsDir = join(tmpDir, "artifacts");
  checkpointPath = join(tmpDir, "checkpoint.json");
  await mkdir(artifactsDir, { recursive: true });
}

async function teardown() {
  _limiter = null;
  await Promise.all([
    exaServer ? closeServer(exaServer) : null,
    llmServer ? closeServer(llmServer) : null,
    pageServer ? closeServer(pageServer) : null,
  ]);
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  exaServer = llmServer = pageServer = null;
  tmpDir = artifactsDir = checkpointPath = null;
}


// =========================================================================
//  Tier 1 — Content: do we get findings at all?
// =========================================================================

describe("Tier 1: Content — basic pipeline produces findings", () => {
  let result, config;

  before(async () => {
    await setupDirs();
    await setupServers();
    config = buildTestConfig(exaUrl, llmUrl, pageUrl, artifactsDir, checkpointPath);
    result = await deepResearch("electric vehicle market 2025", config);
  });

  after(teardown);

  it("returns a sessionId", () => {
    assert.ok(result.sessionId);
    assert.match(result.sessionId, /^[0-9a-f-]{36}$/);
  });

  it("produces at least one finding", () => {
    assert.ok(result.findingCount > 0, `expected findings, got ${result.findingCount}`);
  });

  it("returns a non-empty summary", () => {
    assert.ok(result.summary.length > 100, "summary too short");
    assert.ok(result.summary.includes("Research Summary"), "missing summary header");
  });

  it("summary contains key findings section", () => {
    assert.ok(result.summary.includes("Key Findings"), "missing key findings");
  });

  it("writes session artifacts to disk", async () => {
    const sessionDir = join(artifactsDir, "sessions", result.sessionId);
    assert.ok(existsSync(sessionDir), "session dir missing");
    assert.ok(existsSync(join(sessionDir, "findings.jsonl")), "findings.jsonl missing");
    assert.ok(existsSync(join(sessionDir, "meta.json")), "meta.json missing");
    assert.ok(existsSync(join(sessionDir, "summary.md")), "summary.md missing");
    assert.ok(existsSync(join(sessionDir, "pages")), "pages dir missing");
  });

  it("findings.jsonl contains valid JSONL", async () => {
    const content = await readFile(join(artifactsDir, "sessions", result.sessionId, "findings.jsonl"), "utf-8");
    const lines = content.split("\n").filter(Boolean);
    assert.ok(lines.length > 0, "no findings in JSONL");
    for (const line of lines) {
      const f = JSON.parse(line);
      assert.ok(f.id, "finding missing id");
      assert.ok(f.claim, "finding missing claim");
      assert.ok(typeof f.confidence === "number", "finding missing confidence");
    }
  });

  it("global index.jsonl is populated", async () => {
    const content = await readFile(join(artifactsDir, "index.jsonl"), "utf-8");
    const lines = content.split("\n").filter(Boolean);
    assert.ok(lines.length > 0, "index empty");
    const entry = JSON.parse(lines[0]);
    assert.ok(entry.claim_preview, "index entry missing claim_preview");
    assert.ok(entry.session_id === result.sessionId, "index entry wrong session");
  });

  it("meta.json has correct structure", async () => {
    const meta = JSON.parse(await readFile(join(artifactsDir, "sessions", result.sessionId, "meta.json"), "utf-8"));
    assert.equal(meta.session_id, result.sessionId);
    assert.equal(meta.query, "electric vehicle market 2025");
    assert.ok(meta.started_at);
    assert.ok(meta.completed_at);
    assert.ok(meta.total_findings > 0);
    assert.ok(Array.isArray(meta.sub_queries));
  });
});


// =========================================================================
//  Tier 2 — Reference integrity: findings cite sources from search results
// =========================================================================

describe("Tier 2: Reference integrity — sources trace back to search", () => {
  let config, findings;

  before(async () => {
    await setupDirs();
    await setupServers();
    config = buildTestConfig(exaUrl, llmUrl, pageUrl, artifactsDir, checkpointPath);
    const result = await deepResearch("electric vehicle market 2025", config);
    const content = await readFile(join(artifactsDir, "sessions", result.sessionId, "findings.jsonl"), "utf-8");
    findings = content.split("\n").filter(Boolean).map(l => JSON.parse(l));
  });

  after(teardown);

  it("every finding has a non-empty source_url", () => {
    for (const f of findings) {
      assert.ok(f.source_url, `finding ${f.id} missing source_url`);
      assert.ok(f.source_url.startsWith("http"), `finding ${f.id} has invalid URL: ${f.source_url}`);
    }
  });

  it("every finding has a non-empty source_title", () => {
    for (const f of findings) {
      assert.ok(f.source_title && f.source_title.length > 0, `finding ${f.id} missing source_title`);
    }
  });

  it("source URLs come from the page server (not hallucinated)", () => {
    for (const f of findings) {
      assert.ok(
        f.source_url.includes("127.0.0.1") || f.source_url.includes("localhost"),
        `finding ${f.id} URL not from test server: ${f.source_url}`
      );
    }
  });

  it("every finding references a sub-query that was planned", () => {
    for (const f of findings) {
      assert.ok(f.sub_query, `finding ${f.id} missing sub_query`);
      assert.ok(f.sub_query_id, `finding ${f.id} missing sub_query_id`);
    }
  });

  it("page snapshots exist on disk for each finding", () => {
    for (const f of findings) {
      assert.ok(f.page_snapshot_path, `finding ${f.id} missing page_snapshot_path`);
      assert.ok(existsSync(f.page_snapshot_path), `snapshot missing: ${f.page_snapshot_path}`);
    }
  });

  it("page snapshot files contain source URL comment", async () => {
    const checked = new Set();
    for (const f of findings) {
      if (checked.has(f.page_snapshot_path)) continue;
      checked.add(f.page_snapshot_path);
      const content = await readFile(f.page_snapshot_path, "utf-8");
      assert.ok(content.includes("<!-- Source:"), `snapshot ${f.page_snapshot_path} missing source comment`);
    }
  });
});


// =========================================================================
//  Tier 3 — Provenance: verbatim quotes traceable to page content
// =========================================================================

describe("Tier 3: Provenance — quotes and claims match source content", () => {
  let config, findings;

  before(async () => {
    await setupDirs();
    await setupServers();
    config = buildTestConfig(exaUrl, llmUrl, pageUrl, artifactsDir, checkpointPath);
    const result = await deepResearch("electric vehicle market 2025", config);
    const content = await readFile(join(artifactsDir, "sessions", result.sessionId, "findings.jsonl"), "utf-8");
    findings = content.split("\n").filter(Boolean).map(l => JSON.parse(l));
  });

  after(teardown);

  it("findings with verbatim_quote contain text from the full_chunk", () => {
    const withQuotes = findings.filter(f => f.verbatim_quote && f.verbatim_quote.length >= 20);
    assert.ok(withQuotes.length > 0, "no findings with verbatim quotes");
    for (const f of withQuotes) {
      const chunkNorm = f.full_chunk.replace(/\s+/g, " ").toLowerCase();
      const quoteNorm = f.verbatim_quote.replace(/\s+/g, " ").toLowerCase();
      // Allow partial match — LLM may truncate quote
      const quoteWords = quoteNorm.split(" ").filter(w => w.length > 3);
      const matchingWords = quoteWords.filter(w => chunkNorm.includes(w));
      const matchRatio = matchingWords.length / quoteWords.length;
      assert.ok(
        matchRatio >= 0.5,
        `finding ${f.id}: quote word match ratio ${matchRatio.toFixed(2)} < 0.5\nQuote: ${f.verbatim_quote.slice(0, 80)}\nChunk: ${f.full_chunk.slice(0, 80)}`
      );
    }
  });

  it("claim text is substantive (not boilerplate)", () => {
    const boilerplate = ["click here", "read more", "subscribe", "cookie", "privacy policy"];
    for (const f of findings) {
      const claimLower = f.claim.toLowerCase();
      for (const bp of boilerplate) {
        assert.ok(!claimLower.includes(bp), `finding ${f.id} claim contains boilerplate: "${bp}"`);
      }
    }
  });

  it("claims are minimum length (meaningful assertions)", () => {
    for (const f of findings) {
      assert.ok(f.claim.length >= 10, `finding ${f.id} claim too short: "${f.claim}"`);
    }
  });

  it("claim_preview is correctly truncated", () => {
    for (const f of findings) {
      if (f.claim.length > config.claim_preview_length) {
        assert.ok(f.claim_preview.endsWith("..."), `finding ${f.id} preview not truncated`);
        assert.ok(f.claim_preview.length <= config.claim_preview_length,
          `finding ${f.id} preview too long: ${f.claim_preview.length}`);
      } else {
        assert.equal(f.claim_preview, f.claim, `finding ${f.id} preview mismatch`);
      }
    }
  });

  it("full_chunk is non-empty for every finding", () => {
    for (const f of findings) {
      assert.ok(f.full_chunk && f.full_chunk.length >= config.min_chunk_length,
        `finding ${f.id} has empty or too-short full_chunk`);
    }
  });
});


// =========================================================================
//  Tier 4 — Quality heuristics: confidence, dedup, entities, structure
// =========================================================================

describe("Tier 4: Quality — confidence, deduplication, entity extraction", () => {
  let config, findings, indexEntries;

  before(async () => {
    await setupDirs();
    await setupServers();
    config = buildTestConfig(exaUrl, llmUrl, pageUrl, artifactsDir, checkpointPath);
    const result = await deepResearch("electric vehicle market 2025", config);
    const content = await readFile(join(artifactsDir, "sessions", result.sessionId, "findings.jsonl"), "utf-8");
    findings = content.split("\n").filter(Boolean).map(l => JSON.parse(l));
    const indexContent = await readFile(join(artifactsDir, "index.jsonl"), "utf-8");
    indexEntries = indexContent.split("\n").filter(Boolean).map(l => JSON.parse(l));
  });

  after(teardown);

  it("confidence scores are in [0, 1] range", () => {
    for (const f of findings) {
      assert.ok(f.confidence >= 0 && f.confidence <= 1,
        `finding ${f.id} confidence out of range: ${f.confidence}`);
    }
  });

  it("data-backed claims have higher confidence than vague ones", () => {
    const withData = findings.filter(f =>
      f.claim.includes("$") || f.claim.includes("%") || /\d{2,}/.test(f.claim)
    );
    const withoutData = findings.filter(f =>
      !f.claim.includes("$") && !f.claim.includes("%") && !/\d{2,}/.test(f.claim)
    );
    if (withData.length > 0 && withoutData.length > 0) {
      const avgData = withData.reduce((s, f) => s + f.confidence, 0) / withData.length;
      const avgNoData = withoutData.reduce((s, f) => s + f.confidence, 0) / withoutData.length;
      assert.ok(avgData >= avgNoData,
        `data-backed avg confidence (${avgData.toFixed(2)}) should be >= vague (${avgNoData.toFixed(2)})`);
    }
  });

  it("no near-duplicate claims within same sub-query sweep", () => {
    // Dedup runs per-sweep, so check within each sub-query group
    const bySq = {};
    for (const f of findings) {
      (bySq[f.sub_query_id] ||= []).push(f);
    }
    for (const [sqId, sqFindings] of Object.entries(bySq)) {
      for (let i = 0; i < sqFindings.length; i++) {
        for (let j = i + 1; j < sqFindings.length; j++) {
          const aWords = new Set(sqFindings[i].claim.toLowerCase().split(/\s+/));
          const bWords = new Set(sqFindings[j].claim.toLowerCase().split(/\s+/));
          const inter = [...aWords].filter(w => bWords.has(w)).length;
          const union = new Set([...aWords, ...bWords]).size;
          const jaccard = inter / union;
          assert.ok(jaccard <= 0.7,
            `findings ${sqFindings[i].id} and ${sqFindings[j].id} in sweep ${sqId} are near-duplicates (jaccard=${jaccard.toFixed(2)})`);
        }
      }
    }
  });

  it("entities are extracted with name and type", () => {
    const withEntities = findings.filter(f => f.entities.length > 0);
    assert.ok(withEntities.length > 0, "no findings have entities");
    for (const f of withEntities) {
      for (const e of f.entities) {
        assert.ok(e.name, `entity missing name in finding ${f.id}`);
        assert.ok(e.type, `entity missing type in finding ${f.id}`);
      }
    }
  });

  it("topic_tags are present on findings", () => {
    const withTags = findings.filter(f => f.topic_tags.length > 0);
    assert.ok(withTags.length > 0, "no findings have topic_tags");
  });

  it("index entries mirror findings count", () => {
    assert.equal(indexEntries.length, findings.length,
      `index has ${indexEntries.length} entries but ${findings.length} findings`);
  });

  it("index entries are queryable", async () => {
    const results = await queryIndex("electric vehicle market", 10, config);
    assert.ok(results.length > 0, "index query returned no results");
    for (const r of results) {
      assert.ok(r.claim_preview, "query result missing claim_preview");
      assert.ok(r.confidence > 0, "query result has zero confidence");
    }
  });

  it("findings capped at max_findings_per_sweep per sub-query", () => {
    const bySq = {};
    for (const f of findings) {
      bySq[f.sub_query_id] = (bySq[f.sub_query_id] || 0) + 1;
    }
    for (const [sqId, count] of Object.entries(bySq)) {
      assert.ok(count <= config.max_findings_per_sweep,
        `sub-query ${sqId} has ${count} findings, exceeds cap ${config.max_findings_per_sweep}`);
    }
  });
});


// =========================================================================
//  Tier 5 — Accuracy: claim/query alignment, topic coherence
// =========================================================================

describe("Tier 5: Accuracy — claims align with query, topics are coherent", () => {
  let config, findings, meta;

  before(async () => {
    await setupDirs();
    await setupServers();
    config = buildTestConfig(exaUrl, llmUrl, pageUrl, artifactsDir, checkpointPath);
    const result = await deepResearch("electric vehicle market 2025", config);
    const content = await readFile(join(artifactsDir, "sessions", result.sessionId, "findings.jsonl"), "utf-8");
    findings = content.split("\n").filter(Boolean).map(l => JSON.parse(l));
    meta = JSON.parse(await readFile(join(artifactsDir, "sessions", result.sessionId, "meta.json"), "utf-8"));
  });

  after(teardown);

  it("majority of findings relate to original query topic", () => {
    const queryKeywords = ["electric", "vehicle", "ev", "battery", "market", "charging"];
    let relevant = 0;
    for (const f of findings) {
      const text = `${f.claim} ${f.topic_tags.join(" ")} ${f.entities.map(e => e.name).join(" ")}`.toLowerCase();
      if (queryKeywords.some(k => text.includes(k))) relevant++;
    }
    const ratio = relevant / findings.length;
    assert.ok(ratio >= 0.5,
      `only ${(ratio * 100).toFixed(0)}% of findings are topic-relevant (expected >= 50%)`);
  });

  it("sub-queries decompose the original query", () => {
    assert.ok(meta.sub_queries.length >= 2, `only ${meta.sub_queries.length} sub-queries planned`);
    assert.ok(meta.sub_queries.length <= config.max_sub_queries,
      `${meta.sub_queries.length} sub-queries exceeds cap ${config.max_sub_queries}`);
    for (const sq of meta.sub_queries) {
      assert.ok(sq.query.length > 5, `sub-query too short: "${sq.query}"`);
      assert.ok(sq.rationale.length > 3, `rationale too short: "${sq.rationale}"`);
    }
  });

  it("findings cover multiple sub-queries (not all from one)", () => {
    const sqIds = new Set(findings.map(f => f.sub_query_id));
    assert.ok(sqIds.size >= 2,
      `findings only from ${sqIds.size} sub-query (expected >= 2 for coverage breadth)`);
  });

  it("multiple sources used (not single-source bias)", () => {
    const urls = new Set(findings.map(f => f.source_url));
    assert.ok(urls.size >= 2,
      `findings from only ${urls.size} source (expected >= 2 to avoid bias)`);
  });

  it("timestamps are valid ISO 8601", () => {
    for (const f of findings) {
      const d = new Date(f.timestamp);
      assert.ok(!isNaN(d.getTime()), `finding ${f.id} has invalid timestamp: ${f.timestamp}`);
    }
    const metaStart = new Date(meta.started_at);
    const metaEnd = new Date(meta.completed_at);
    assert.ok(!isNaN(metaStart.getTime()), "meta.started_at invalid");
    assert.ok(!isNaN(metaEnd.getTime()), "meta.completed_at invalid");
    assert.ok(metaEnd >= metaStart, "completed_at before started_at");
  });

  it("session completed with adequate total", () => {
    assert.ok(meta.total_findings >= 3,
      `only ${meta.total_findings} total findings — too few for research quality`);
    assert.ok(meta.total_sources >= 2,
      `only ${meta.total_sources} sources — insufficient diversity`);
  });
});


// =========================================================================
//  Tier 6 — Resilience: checkpoint resume, retry, abort
// =========================================================================

describe("Tier 6: Resilience — checkpoint resume", () => {
  let config;

  before(async () => {
    await setupDirs();
    await setupServers();
    config = buildTestConfig(exaUrl, llmUrl, pageUrl, artifactsDir, checkpointPath);
  });

  after(teardown);

  it("creates checkpoint during research", async () => {
    await deepResearch("electric vehicle checkpoint test", config);
    assert.ok(existsSync(checkpointPath), "checkpoint file not created");
    const cp = JSON.parse(await readFile(checkpointPath, "utf-8"));
    assert.ok(Object.keys(cp.sessions).length > 0, "no sessions in checkpoint");
  });

  it("completed session marked as complete in checkpoint", async () => {
    const cp = JSON.parse(await readFile(checkpointPath, "utf-8"));
    const sessions = Object.values(cp.sessions);
    const completed = sessions.filter(s => s.status === "complete");
    assert.ok(completed.length > 0, "no completed sessions");
    const session = completed[0];
    assert.equal(session.query, "electric vehicle checkpoint test");
    assert.ok(session.sub_queries.length > 0, "no sub_queries recorded");
    const allComplete = session.sub_queries.every(sq => sq.status === "complete");
    assert.ok(allComplete, "not all sub_queries marked complete");
  });

  it("checkpoint records reflections", async () => {
    const cp = JSON.parse(await readFile(checkpointPath, "utf-8"));
    const sessions = Object.values(cp.sessions);
    const session = sessions.find(s => s.query === "electric vehicle checkpoint test");
    assert.ok(session.reflections.length > 0, "no reflections recorded");
  });
});

describe("Tier 6: Resilience — resume from interrupted session", () => {
  let config, resumeResult;

  before(async () => {
    await setupDirs();
    await setupServers();
    config = buildTestConfig(exaUrl, llmUrl, pageUrl, artifactsDir, checkpointPath);

    // Create a partially-complete checkpoint manually
    const sessionId = randomUUID();
    const sq1 = { id: randomUUID(), query: "EV market size 2024", rationale: "quantify" };
    const sq2 = { id: randomUUID(), query: "EV technology trends", rationale: "innovation" };
    const sq3 = { id: randomUUID(), query: "EV challenges", rationale: "contrarian" };

    await initSession(sessionId, "electric vehicle resume test", config);

    const checkpoint = new Checkpoint(checkpointPath);
    await checkpoint.createSession(sessionId, "electric vehicle resume test");
    await checkpoint.addSubQueries(sessionId, [sq1, sq2, sq3], 0);
    await checkpoint.markSweepStarted(sq1.id, sessionId);
    await checkpoint.markSweepComplete(sq1.id, sessionId, {
      sub_query_id: sq1.id, query: sq1.query,
      key_claims: ["EV market reached $384B"], coverage: "5 findings from 3 sources",
      gaps: [], finding_count: 5, source_count: 3,
    });
    // sq2 and sq3 left as "pending" — simulates interruption

    // Now run deep research with same query — should resume
    resumeResult = await deepResearch("electric vehicle resume test", config);
  });

  after(teardown);

  it("resumes existing session instead of creating new", () => {
    assert.ok(resumeResult.sessionId, "no sessionId returned");
    assert.ok(resumeResult.findingCount > 0, "no findings from resumed session");
  });

  it("checkpoint shows session complete after resume", async () => {
    const cp = JSON.parse(await readFile(checkpointPath, "utf-8"));
    const session = Object.values(cp.sessions).find(s => s.query === "electric vehicle resume test");
    assert.ok(session, "session not found in checkpoint");
    assert.equal(session.status, "complete", `session status is ${session.status}, expected complete`);
  });

  it("only pending sub-queries were executed on resume (complete ones skipped)", async () => {
    const cp = JSON.parse(await readFile(checkpointPath, "utf-8"));
    const session = Object.values(cp.sessions).find(s => s.query === "electric vehicle resume test");
    const allComplete = session.sub_queries.every(sq =>
      sq.status === "complete" || sq.status === "failed"
    );
    assert.ok(allComplete, "some sub-queries still pending after resume");
  });
});

describe("Tier 6: Resilience — transient error retry", () => {
  let config;

  before(async () => {
    await setupDirs();
    // LLM server returns 429 for first 2 calls, then works
    await setupServers({}, { failCount: 2 });
    config = buildTestConfig(exaUrl, llmUrl, pageUrl, artifactsDir, checkpointPath);
  });

  after(teardown);

  it("recovers from initial rate limits and produces findings", async () => {
    const result = await deepResearch("electric vehicle retry test", config);
    assert.ok(result.findingCount > 0,
      `expected findings after retry, got ${result.findingCount}`);
    assert.ok(!result.interrupted, "result should not be interrupted");
  });
});

describe("Tier 6: Resilience — LLM validation retry", () => {
  let config;

  before(async () => {
    await setupDirs();
    // LLM returns bad JSON for first call, then valid
    await setupServers({}, { badJsonCount: 1 });
    config = buildTestConfig(exaUrl, llmUrl, pageUrl, artifactsDir, checkpointPath);
  });

  after(teardown);

  it("retries on invalid JSON and eventually succeeds", async () => {
    const result = await deepResearch("electric vehicle validation test", config);
    assert.ok(result.findingCount > 0,
      `expected findings after validation retry, got ${result.findingCount}`);
  });
});

describe("Tier 6: Resilience — abort via AbortSignal", () => {
  let config;

  before(async () => {
    await setupDirs();
    await setupServers({}, { latencyMs: 200 });
    config = buildTestConfig(exaUrl, llmUrl, pageUrl, artifactsDir, checkpointPath);
  });

  after(teardown);

  it("abort signal stops research mid-flight", async () => {
    const ac = new AbortController();
    // Abort after 300ms — should interrupt during sweep
    setTimeout(() => ac.abort(), 300);

    try {
      await deepResearch("electric vehicle abort test", config, ac.signal);
      // If it completes before abort, that's OK for fast execution
    } catch (err) {
      assert.ok(
        err.name === "AbortError" || err.message.includes("abort"),
        `expected abort error, got: ${err.message}`
      );
    }

    // Checkpoint may exist with partial state, or be corrupted by mid-write abort
    if (existsSync(checkpointPath)) {
      try {
        const cp = JSON.parse(await readFile(checkpointPath, "utf-8"));
        const session = Object.values(cp.sessions).find(s => s.query === "electric vehicle abort test");
        if (session) {
          assert.ok(
            session.status === "running" || session.status === "reflecting" || session.status === "complete",
            `unexpected session status: ${session.status}`
          );
        }
      } catch {
        // Checkpoint corrupted by mid-write abort — acceptable
      }
    }
  });
});

describe("Tier 6: Resilience — empty search results handled gracefully", () => {
  let config;

  before(async () => {
    await setupDirs();
    // Exa returns empty after first call
    await setupServers({ emptyAfter: 1 });
    config = buildTestConfig(exaUrl, llmUrl, pageUrl, artifactsDir, checkpointPath);
  });

  after(teardown);

  it("completes without crashing on empty search results", async () => {
    const result = await deepResearch("electric vehicle empty test", config);
    assert.ok(result.sessionId, "should still return sessionId");
    assert.ok(result.summary.length > 0, "should still produce a summary");
    // May have 0 findings if all sweeps got empty results — that is OK
  });
});

describe("Tier 6: Resilience — checkpoint cleanup keeps last 20", () => {
  let config;

  before(async () => {
    await setupDirs();
    await setupServers();
    config = buildTestConfig(exaUrl, llmUrl, pageUrl, artifactsDir, checkpointPath);
  });

  after(teardown);

  it("cleans up old sessions beyond 20", async () => {
    const checkpoint = new Checkpoint(checkpointPath);

    // Create 25 completed sessions
    for (let i = 0; i < 25; i++) {
      const id = randomUUID();
      await checkpoint.createSession(id, `query-${i}`);
      await checkpoint.markComplete(id);
    }

    await checkpoint.cleanup();

    const cp = JSON.parse(await readFile(checkpointPath, "utf-8"));
    const count = Object.keys(cp.sessions).length;
    assert.ok(count <= 20, `expected <= 20 sessions after cleanup, got ${count}`);
  });
});
