import type {
  ExaResult,
  SubQuery,
  Finding,
  FetchedPage,
  SubQuerySummary,
  SweepResult,
  EngineState,
} from "./types.js";
import type { Config } from "./config.js";
import { heuristicRank } from "./rank.js";
import { selectUrls, extractFromPage } from "./extract.js";
import { LRUCache } from "./cache.js";
import { stripHtml } from "./utils.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const JINA_READER_BASE = "https://r.jina.ai/";
const FETCH_TIMEOUT_MS = 20_000;

export async function searchExa(
  query: string,
  numResults: number,
  cache: LRUCache<ExaResult[]>,
  config: Config,
  signal?: AbortSignal,
): Promise<ExaResult[]> {
  const cached = cache.get(query);
  if (cached) return cached;

  const res = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.exa_api_key,
    },
    body: JSON.stringify({
      query,
      numResults,
      contents: {
        text: { maxCharacters: 1500 },
        highlights: { numSentences: 3 },
      },
    }),
    signal: AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(signal ? [signal] : []),
    ]),
  });

  if (!res.ok) {
    throw new Error(`Exa API ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const results: ExaResult[] = data.results || [];
  cache.set(query, results);
  return results;
}

async function fetchPage(
  url: string,
  config: Config,
  signal?: AbortSignal,
): Promise<FetchedPage | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.any([
        AbortSignal.timeout(FETCH_TIMEOUT_MS),
        ...(signal ? [signal] : []),
      ]),
    });

    if (!res.ok) return null;

    const text = await res.text();
    if (text.length < config.min_content_length) return null;

    const contentType = res.headers.get("content-type") || "";
    const isHTML = contentType.includes("text/html") || contentType.includes("application/xhtml");

    if (!isHTML) {
      const titleMatch = text.match(/^#{1,2}\s+(.+)/m);
      return { url, title: titleMatch?.[1]?.trim() || url, content: text };
    }

    const { title } = stripHtml(text);
    const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const { content: cleaned } = stripHtml(bodyMatch?.[1] || text);

    if (cleaned.length < config.min_content_length) return null;
    return { url, title: title || url, content: cleaned };
  } catch {
    return null;
  }
}

async function fetchWithJinaFallback(
  url: string,
  config: Config,
  signal?: AbortSignal,
): Promise<FetchedPage | null> {
  const direct = await fetchPage(url, config, signal);
  if (direct && direct.content.length >= config.min_content_length) return direct;

  try {
    const res = await fetch(JINA_READER_BASE + url, {
      headers: { Accept: "text/markdown", "X-No-Cache": "true" },
      signal: AbortSignal.any([
        AbortSignal.timeout(FETCH_TIMEOUT_MS),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!res.ok) return direct;

    const text = await res.text();
    const contentStart = text.indexOf("Markdown Content:");
    if (contentStart < 0) return direct;

    const markdown = text.slice(contentStart + 17).trim();
    if (markdown.length < config.min_content_length) return direct;

    const titleMatch = markdown.match(/^#{1,2}\s+(.+)/m);
    return {
      url,
      title: titleMatch?.[1]?.replace(/\*+/g, "").trim() || url,
      content: markdown,
    };
  } catch {
    return direct;
  }
}

async function fetchPages(
  urls: string[],
  fetchCache: Map<string, { title: string; content: string }>,
  config: Config,
  signal?: AbortSignal,
): Promise<{ pages: FetchedPage[]; failedUrls: string[] }> {
  const results: FetchedPage[] = [];
  const failedUrls: string[] = [];

  const toFetch = urls.filter(url => {
    const cached = fetchCache.get(url);
    if (cached) {
      results.push({ url, ...cached });
      return false;
    }
    return true;
  });

  const fetched = await Promise.allSettled(
    toFetch.map(url => fetchWithJinaFallback(url, config, signal))
  );

  for (let i = 0; i < fetched.length; i++) {
    const result = fetched[i];
    if (result.status === "fulfilled" && result.value) {
      const page = result.value;
      fetchCache.set(page.url, { title: page.title, content: page.content });
      results.push(page);
    } else {
      failedUrls.push(toFetch[i]);
    }
  }

  return { pages: results, failedUrls };
}

export function chunkText(text: string, size: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start += size - overlap;
  }
  return chunks;
}

export function deduplicateFindings(findings: Finding[], threshold = 0.7): Finding[] {
  const result: Finding[] = [];
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

export async function executeSweep(
  subQuery: SubQuery,
  originalQuery: string,
  sessionId: string,
  config: Config,
  state: EngineState,
  signal?: AbortSignal,
): Promise<SweepResult> {
  const snippets = await searchExa(
    subQuery.query,
    config.snippet_results_per_query,
    state.searchCache,
    config,
    signal,
  );

  const ranked = heuristicRank(snippets, subQuery.query);
  const survivors = ranked.slice(0, Math.ceil(ranked.length * config.heuristic_keep_ratio));

  const selectedUrls = await selectUrls(subQuery.query, survivors, config, signal);

  const { pages, failedUrls } = await fetchPages(selectedUrls, state.fetchCache, config, signal);

  const pageChunks = pages.map(p => ({
    url: p.url,
    title: p.title,
    chunks: chunkText(p.content, config.chunk_size, config.chunk_overlap)
      .slice(0, config.max_chunks_per_page),
  }));

  const extractResults = await Promise.allSettled(
    pageChunks.map(({ url, title, chunks }) =>
      extractFromPage(url, title, chunks, subQuery, sessionId, config, signal)
    )
  );
  const allFindings: Finding[] = [];
  for (const result of extractResults) {
    if (result.status === "fulfilled") allFindings.push(...result.value);
  }

  const deduplicated = deduplicateFindings(allFindings);
  const capped = deduplicated
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, config.max_findings_per_sweep);

  const summary: SubQuerySummary = {
    sub_query_id: subQuery.id,
    query: subQuery.query,
    key_claims: capped.slice(0, config.key_claims_cap).map(f => f.claim_preview),
    coverage: `${capped.length} findings from ${selectedUrls.length} sources (${snippets.length} scanned).`,
    gaps: failedUrls.length > 0 ? [`${failedUrls.length} URLs failed to fetch`] : [],
    finding_count: capped.length,
    source_count: selectedUrls.length,
  };

  return {
    sub_query: subQuery,
    findings: capped,
    summary,
    sources_used: pages.map(p => ({ url: p.url, title: p.title })),
  };
}
