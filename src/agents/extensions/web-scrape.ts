import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";

const APIFY_API_TOKEN = process.env.APIFY_API_TOKEN || "";

// ---------------------------------------------------------------------------
// Dependency detection — run at module load time, before registering tools
// ---------------------------------------------------------------------------

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

function hasCheerio(): boolean {
  try {
    require("cheerio");
    return true;
  } catch {
    return false;
  }
}

function hasScraplingFetcher(): boolean {
  if (!hasPython()) return false;
  try {
    execFileSync("python3", ["-c", "from scrapling import Fetcher"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

function hasScraplingBrowser(): boolean {
  try {
    require("node:fs").accessSync("/app/.browsers-installed");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Challenge page detection — sits between fetch and parse
// ---------------------------------------------------------------------------

interface ChallengeResult {
  isChallenge: boolean;
  vendor?: "cloudflare" | "datadome" | "perimeterx" | "aws_waf" | "unknown";
  signature?: string;
}

function detectChallenge(html: string): ChallengeResult {
  const lower = html.toLowerCase();

  if (
    lower.includes("<title>just a moment...</title>") ||
    lower.includes("cf-browser-verification") ||
    lower.includes("cf-challenge-running") ||
    lower.includes("cloudflare") && lower.includes("ray id")
  ) {
    return {
      isChallenge: true,
      vendor: "cloudflare",
      signature: "Cloudflare browser verification / challenge page",
    };
  }

  if (
    lower.includes("<title>datadome</title>") ||
    lower.includes("dd.js") ||
    lower.includes("window._ddc") ||
    lower.includes("geo.captcha-delivery.com")
  ) {
    return {
      isChallenge: true,
      vendor: "datadome",
      signature: "DataDome captcha / challenge",
    };
  }

  if (
    lower.includes("_px") && lower.includes("captcha") ||
    lower.includes("captcha.px-cdn.net") ||
    lower.includes("perimeterx")
  ) {
    return {
      isChallenge: true,
      vendor: "perimeterx",
      signature: "PerimeterX bot detection",
    };
  }

  if (
    lower.includes("aws-waf-token") ||
    lower.includes("awswaf") ||
    (lower.includes("captcha") && lower.includes("aws"))
  ) {
    return {
      isChallenge: true,
      vendor: "aws_waf",
      signature: "AWS WAF challenge",
    };
  }

  // Generic captcha / challenge heuristic
  const challengeSignals = [
    "verify you are human",
    "checking your browser",
    "please complete the security check",
    "access denied",
    "enable javascript and cookies",
  ];
  for (const sig of challengeSignals) {
    if (lower.includes(sig)) {
      return {
        isChallenge: true,
        vendor: "unknown",
        signature: sig,
      };
    }
  }

  return { isChallenge: false };
}

// ---------------------------------------------------------------------------
// Shared cheerio parse layer — one parser for all local tiers
// ---------------------------------------------------------------------------

interface ParseResult {
  items: (Record<string, string> | string)[];
  matchCount: number;
}

function extractWithCheerio(
  html: string,
  selector: string,
  extractFields?: Record<string, string>,
  maxItems?: number
): ParseResult {
  const cheerio = require("cheerio");
  const $ = cheerio.load(html);
  const max = maxItems ?? 100;
  const items: (Record<string, string> | string)[] = [];
  const elements = $(selector);
  const matchCount = elements.length;

  elements.each((_i: number, el: unknown) => {
    if (items.length >= max) return false;

    if (extractFields && Object.keys(extractFields).length > 0) {
      const record: Record<string, string> = {};
      for (const [field, fieldSelector] of Object.entries(extractFields)) {
        record[field] = $(el).find(fieldSelector).text().trim();
      }
      items.push(record);
    } else {
      const text = $(el).text().trim();
      if (text) items.push(text);
    }
  });

  return { items, matchCount };
}

// ---------------------------------------------------------------------------
// Shared formatting helper
// ---------------------------------------------------------------------------

interface ScrapeData {
  items: Record<string, string>[] | string[];
  pages_crawled: number;
  duration_ms: number;
  errors: string[];
}

function formatScrapeResult(
  data: ScrapeData,
  url: string,
  tier: string
): string {
  const lines: string[] = [];
  lines.push("## Scrape Results\n");
  lines.push(`**URL:** ${url}`);
  lines.push(`**Tier:** ${tier}`);
  lines.push(`**Items found:** ${data.items.length}`);
  lines.push(`**Pages crawled:** ${data.pages_crawled}`);
  lines.push(`**Duration:** ${data.duration_ms}ms\n`);

  if (data.items.length > 0) {
    lines.push("### Items\n");

    const first = data.items[0];
    if (typeof first === "object" && first !== null) {
      const keys = Object.keys(first);
      lines.push("| " + keys.join(" | ") + " |");
      lines.push("| " + keys.map(() => "---").join(" | ") + " |");
      for (const item of data.items as Record<string, string>[]) {
        const values = keys.map((k) => {
          const v = item[k] ?? "";
          return String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
        });
        lines.push("| " + values.join(" | ") + " |");
      }
    } else {
      for (let i = 0; i < data.items.length; i++) {
        lines.push(`${i + 1}. ${String(data.items[i])}`);
      }
    }
  }

  if (data.errors.length > 0) {
    lines.push("\n### Errors\n");
    for (const err of data.errors) {
      lines.push(`- ${err}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Diagnostic output — when extraction yields zero items
// ---------------------------------------------------------------------------

function buildDiagnostics(
  html: string,
  selector: string,
  challenge: ChallengeResult,
  matchCount: number,
  statusCode: number
): string {
  const lines: string[] = [];
  lines.push("\n### Diagnostics (zero items extracted)\n");
  lines.push(`**HTTP status:** ${statusCode}`);
  lines.push(`**HTML length:** ${html.length} chars`);

  if (challenge.isChallenge) {
    lines.push(`**Challenge detected:** ${challenge.vendor} — ${challenge.signature}`);
    lines.push("**Suggestion:** Try a higher tier or use T4 (Apify).");
  } else {
    lines.push("**Challenge detected:** none");
  }

  lines.push(`**Selector match count:** ${matchCount} elements matched \`${selector}\``);

  // Page title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim().slice(0, 200) : "(no title)";
  lines.push(`**Page title:** ${title}`);

  // Meta description
  const descMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i
  );
  const desc = descMatch ? descMatch[1].trim().slice(0, 300) : "(none)";
  lines.push(`**Meta description:** ${desc}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Shared parameter schemas (reused across tiers)
// ---------------------------------------------------------------------------

const PaginationSchema = Type.Optional(
  Type.Object({
    next_selector: Type.String({
      description: 'CSS selector for "next page" link',
    }),
    max_pages: Type.Number({
      description: "Maximum number of pages to crawl",
    }),
  })
);

const ExtractFieldsSchema = Type.Optional(
  Type.Record(Type.String(), Type.String(), {
    description:
      'Map of field names to CSS selectors relative to each item (e.g. {"name": ".title", "price": ".cost"})',
  })
);

// ---------------------------------------------------------------------------
// Python fetch-only helper — calls Python script, returns raw HTML + metadata
// ---------------------------------------------------------------------------

interface FetchResult {
  html: string;
  status_code: number;
  url: string;
  duration_ms: number;
  errors: string[];
}

function pythonFetch(
  scriptPath: string,
  url: string,
  timeoutMs: number,
  waitFor?: string
): FetchResult {
  const input: Record<string, unknown> = { url };
  if (waitFor) input.wait_for = waitFor;

  const result = execFileSync(
    "python3",
    [scriptPath, JSON.stringify(input)],
    {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  return JSON.parse(result) as FetchResult;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const cheerioAvailable = hasCheerio();
  const scraplingFetcherAvailable = hasScraplingFetcher();
  const scraplingBrowserAvailable = hasScraplingBrowser();

  // =========================================================================
  // Tier 1: scrape_static — Node fetch + cheerio parse
  // =========================================================================

  if (cheerioAvailable) {
    pi.registerTool({
      name: "scrape_static",
      label: "Static Scraper",
      description:
        "Scrape structured data from static HTML pages using CSS selectors. Uses cheerio for fast server-side parsing. Best for sites that render content in the initial HTML response without JavaScript.",
      promptSnippet:
        "Extract structured data from static HTML using CSS selectors.",
      parameters: Type.Object({
        url: Type.String({ description: "URL to scrape" }),
        selector: Type.String({
          description: 'CSS selector for items (e.g. ".product")',
        }),
        extract_fields: ExtractFieldsSchema,
        pagination: PaginationSchema,
        max_items: Type.Optional(
          Type.Number({
            description: "Maximum items to return (default 100)",
          })
        ),
      }),
      async execute(_toolCallId, params, signal) {
        try {
          const maxItems = params.max_items ?? 100;
          const maxPages = params.pagination?.max_pages ?? 1;
          const startTime = Date.now();
          const allItems: (Record<string, string> | string)[] = [];
          const errors: string[] = [];
          let pagesCrawled = 0;
          let currentUrl = params.url;
          let lastHtml = "";
          let lastChallenge: ChallengeResult = { isChallenge: false };
          let lastMatchCount = 0;
          let lastStatusCode = 0;

          for (let page = 0; page < maxPages; page++) {
            if (allItems.length >= maxItems) break;

            let html: string;
            try {
              const res = await fetch(currentUrl, {
                headers: {
                  "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                  Accept:
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                },
                signal,
              });
              lastStatusCode = res.status;
              if (!res.ok) {
                errors.push(`HTTP ${res.status} on ${currentUrl}`);
                break;
              }
              html = await res.text();
            } catch (fetchErr) {
              errors.push(
                `Fetch error on ${currentUrl}: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`
              );
              break;
            }

            lastHtml = html;
            pagesCrawled++;

            lastChallenge = detectChallenge(html);
            if (lastChallenge.isChallenge) {
              errors.push(
                `Challenge page detected (${lastChallenge.vendor}): ${lastChallenge.signature}. Try a higher tier.`
              );
              break;
            }

            const { items, matchCount } = extractWithCheerio(
              html,
              params.selector,
              params.extract_fields,
              maxItems - allItems.length
            );
            lastMatchCount = matchCount;
            allItems.push(...items);

            // Handle pagination
            if (params.pagination?.next_selector && page < maxPages - 1) {
              const cheerio = require("cheerio");
              const $ = cheerio.load(html);
              const nextHref = $(params.pagination.next_selector).attr("href");
              if (!nextHref) break;
              try {
                currentUrl = new URL(nextHref, currentUrl).toString();
              } catch {
                errors.push(`Invalid pagination URL: ${nextHref}`);
                break;
              }
            } else if (page < maxPages - 1 && params.pagination) {
              break;
            }
          }

          const durationMs = Date.now() - startTime;
          const data: ScrapeData = {
            items: allItems as ScrapeData["items"],
            pages_crawled: pagesCrawled,
            duration_ms: durationMs,
            errors,
          };

          let text = formatScrapeResult(data, params.url, "static (cheerio)");
          if (allItems.length === 0 && lastHtml) {
            text += buildDiagnostics(
              lastHtml,
              params.selector,
              lastChallenge,
              lastMatchCount,
              lastStatusCode
            );
          }

          return {
            content: [{ type: "text" as const, text }],
            details: {
              url: params.url,
              itemCount: allItems.length,
              pagesCrawled,
              durationMs,
              tier: "static",
              challenge: lastChallenge.isChallenge
                ? lastChallenge.vendor
                : null,
            },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: `Scrape failed: ${msg}`,
              },
            ],
            details: { url: params.url, error: msg, tier: "static" },
          };
        }
      },
    });
  }

  // =========================================================================
  // Tier 2: scrape_stealth — Python fetch + cheerio parse
  // =========================================================================

  if (scraplingFetcherAvailable && cheerioAvailable) {
    pi.registerTool({
      name: "scrape_stealth",
      label: "Stealth Scraper",
      description:
        "Scrape structured data using an anti-detection HTTP client. Better for sites that block standard requests. Uses Python scrapling Fetcher with realistic TLS fingerprints and header rotation. Parsing done with cheerio (same as T1).",
      promptSnippet:
        "Scrape sites that block standard requests using stealth HTTP client.",
      parameters: Type.Object({
        url: Type.String({ description: "URL to scrape" }),
        selector: Type.String({
          description: 'CSS selector for items (e.g. ".product")',
        }),
        extract_fields: ExtractFieldsSchema,
        pagination: PaginationSchema,
        max_items: Type.Optional(
          Type.Number({
            description: "Maximum items to return (default 100)",
          })
        ),
      }),
      async execute(_toolCallId, params, _signal) {
        try {
          const startTime = Date.now();
          const fetchResult = pythonFetch(
            "/app/scripts/scrape_stealth.py",
            params.url,
            60_000
          );

          const errors = [...fetchResult.errors];

          const challenge = detectChallenge(fetchResult.html);
          if (challenge.isChallenge) {
            errors.push(
              `Challenge page detected (${challenge.vendor}): ${challenge.signature}. Try T3 or T4.`
            );
          }

          const { items, matchCount } = challenge.isChallenge
            ? { items: [], matchCount: 0 }
            : extractWithCheerio(
                fetchResult.html,
                params.selector,
                params.extract_fields,
                params.max_items
              );

          const durationMs = Date.now() - startTime;
          const data: ScrapeData = {
            items: items as ScrapeData["items"],
            pages_crawled: fetchResult.html ? 1 : 0,
            duration_ms: durationMs,
            errors,
          };

          let text = formatScrapeResult(
            data,
            params.url,
            "stealth (scrapling Fetcher)"
          );
          if (items.length === 0 && fetchResult.html) {
            text += buildDiagnostics(
              fetchResult.html,
              params.selector,
              challenge,
              matchCount,
              fetchResult.status_code
            );
          }

          return {
            content: [{ type: "text" as const, text }],
            details: {
              url: params.url,
              itemCount: items.length,
              pagesCrawled: fetchResult.html ? 1 : 0,
              durationMs,
              tier: "stealth",
              challenge: challenge.isChallenge ? challenge.vendor : null,
            },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: `Stealth scrape failed: ${msg}`,
              },
            ],
            details: { url: params.url, error: msg, tier: "stealth" },
          };
        }
      },
    });
  }

  // =========================================================================
  // Tier 3: scrape_browser — Python browser fetch + cheerio parse
  // =========================================================================

  if (scraplingBrowserAvailable && cheerioAvailable) {
    pi.registerTool({
      name: "scrape_browser",
      label: "Browser Scraper",
      description:
        "Scrape structured data using a headless browser for JavaScript-rendered pages. Uses Python scrapling DynamicFetcher with anti-detection measures. Parsing done with cheerio (same as T1/T2). Slower but handles SPAs, dynamic content, and pages requiring JS execution.",
      promptSnippet:
        "Scrape JS-rendered pages using headless browser with anti-detection.",
      parameters: Type.Object({
        url: Type.String({ description: "URL to scrape" }),
        selector: Type.String({
          description: 'CSS selector for items (e.g. ".product")',
        }),
        extract_fields: ExtractFieldsSchema,
        pagination: PaginationSchema,
        max_items: Type.Optional(
          Type.Number({
            description: "Maximum items to return (default 100)",
          })
        ),
        wait_for: Type.Optional(
          Type.String({
            description:
              "CSS selector to wait for before extraction (for JS-rendered content)",
          })
        ),
      }),
      async execute(_toolCallId, params, _signal) {
        try {
          const startTime = Date.now();
          const fetchResult = pythonFetch(
            "/app/scripts/scrape_browser.py",
            params.url,
            120_000,
            params.wait_for ?? undefined
          );

          const errors = [...fetchResult.errors];

          const challenge = detectChallenge(fetchResult.html);
          if (challenge.isChallenge) {
            errors.push(
              `Challenge page detected (${challenge.vendor}): ${challenge.signature}. Try T4 (Apify).`
            );
          }

          const { items, matchCount } = challenge.isChallenge
            ? { items: [], matchCount: 0 }
            : extractWithCheerio(
                fetchResult.html,
                params.selector,
                params.extract_fields,
                params.max_items
              );

          const durationMs = Date.now() - startTime;
          const data: ScrapeData = {
            items: items as ScrapeData["items"],
            pages_crawled: fetchResult.html ? 1 : 0,
            duration_ms: durationMs,
            errors,
          };

          let text = formatScrapeResult(
            data,
            params.url,
            "browser (scrapling DynamicFetcher)"
          );
          if (items.length === 0 && fetchResult.html) {
            text += buildDiagnostics(
              fetchResult.html,
              params.selector,
              challenge,
              matchCount,
              fetchResult.status_code
            );
          }

          return {
            content: [{ type: "text" as const, text }],
            details: {
              url: params.url,
              itemCount: items.length,
              pagesCrawled: fetchResult.html ? 1 : 0,
              durationMs,
              tier: "browser",
              challenge: challenge.isChallenge ? challenge.vendor : null,
            },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: `Browser scrape failed: ${msg}`,
              },
            ],
            details: { url: params.url, error: msg, tier: "browser" },
          };
        }
      },
    });
  }

  // =========================================================================
  // Tier 4: Apify tools — always register, check token at execution time
  // =========================================================================

  // ---- scrape_apify: run an Apify actor ----

  pi.registerTool({
    name: "scrape_apify",
    label: "Apify Actor",
    description:
      "Run an Apify actor to scrape data. Apify provides hundreds of pre-built scrapers for major sites (Amazon, Google, YouTube, LinkedIn, etc). Provide the actor ID and input configuration. If the run completes within 30s, returns results directly; otherwise returns a run ID to check later with scrape_status.",
    promptSnippet:
      "Run an Apify scraping actor. Use list_actors to find the right actor first.",
    parameters: Type.Object({
      actor_id: Type.String({
        description: 'Apify actor ID (e.g. "apify/web-scraper")',
      }),
      actor_input: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Actor-specific input configuration",
        })
      ),
      url: Type.Optional(
        Type.String({
          description:
            "Convenience — if provided, merged into actor_input as startUrls",
        })
      ),
      max_results: Type.Optional(
        Type.Number({
          description: "Max items to return from dataset (default 100)",
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        if (!APIFY_API_TOKEN) {
          return {
            content: [
              {
                type: "text" as const,
                text: "APIFY_API_TOKEN is not set. Export it as an environment variable to use Apify tools.",
              },
            ],
            details: { error: "missing_token", tier: "apify" },
          };
        }

        const maxResults = params.max_results ?? 100;
        const input: Record<string, unknown> = {
          ...(params.actor_input ?? {}),
        };

        if (params.url) {
          if (!input.startUrls || !Array.isArray(input.startUrls)) {
            input.startUrls = [];
          }
          (input.startUrls as { url: string }[]).push({ url: params.url });
        }

        const runRes = await fetch(
          `https://api.apify.com/v2/acts/${encodeURIComponent(params.actor_id)}/runs?token=${APIFY_API_TOKEN}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
            signal,
          }
        );

        if (!runRes.ok) {
          const errText = await runRes.text().catch(() => "");
          return {
            content: [
              {
                type: "text" as const,
                text: `Apify API error ${runRes.status}: ${errText}`,
              },
            ],
            details: {
              actorId: params.actor_id,
              error: `HTTP ${runRes.status}`,
              tier: "apify",
            },
          };
        }

        const runData = (await runRes.json()) as {
          data: {
            id: string;
            status: string;
            defaultDatasetId: string;
          };
        };
        const runId = runData.data.id;
        const datasetId = runData.data.defaultDatasetId;

        const pollStart = Date.now();
        const POLL_TIMEOUT_MS = 30_000;
        const POLL_INTERVAL_MS = 2_000;
        let status = runData.data.status;

        while (
          Date.now() - pollStart < POLL_TIMEOUT_MS &&
          status !== "SUCCEEDED" &&
          status !== "FAILED" &&
          status !== "ABORTED" &&
          status !== "TIMED-OUT"
        ) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          try {
            const statusRes = await fetch(
              `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_API_TOKEN}`,
              { signal }
            );
            if (statusRes.ok) {
              const statusData = (await statusRes.json()) as {
                data: { status: string };
              };
              status = statusData.data.status;
            }
          } catch {
            // Ignore poll errors, continue waiting
          }
        }

        if (status === "SUCCEEDED") {
          const itemsRes = await fetch(
            `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_API_TOKEN}&limit=${maxResults}`,
            { signal }
          );
          if (!itemsRes.ok) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Actor run completed but failed to fetch results. Run ID: ${runId}, Dataset: ${datasetId}`,
                },
              ],
              details: {
                runId,
                datasetId,
                status: "SUCCEEDED",
                tier: "apify",
              },
            };
          }

          const items = (await itemsRes.json()) as Record<string, unknown>[];
          const lines: string[] = [];
          lines.push("## Apify Actor Results\n");
          lines.push(`**Actor:** ${params.actor_id}`);
          lines.push(`**Run ID:** ${runId}`);
          lines.push(`**Items returned:** ${items.length}\n`);

          if (items.length > 0) {
            lines.push("### Data\n");
            lines.push("```json");
            lines.push(JSON.stringify(items, null, 2));
            lines.push("```");
          }

          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
            details: {
              actorId: params.actor_id,
              runId,
              datasetId,
              status: "SUCCEEDED",
              itemCount: items.length,
              tier: "apify",
            },
          };
        }

        if (status === "FAILED" || status === "ABORTED" || status === "TIMED-OUT") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Apify actor run ${status.toLowerCase()}. Actor: ${params.actor_id}, Run ID: ${runId}. Check Apify console for details.`,
              },
            ],
            details: {
              actorId: params.actor_id,
              runId,
              status,
              tier: "apify",
            },
          };
        }

        const lines: string[] = [];
        lines.push("## Apify Actor Started\n");
        lines.push(`**Actor:** ${params.actor_id}`);
        lines.push(`**Run ID:** ${runId}`);
        lines.push(`**Status:** ${status} (still running)\n`);
        lines.push(
          "The run is still in progress. Use `scrape_status` with this run ID to check results later."
        );

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            actorId: params.actor_id,
            runId,
            datasetId,
            status,
            tier: "apify",
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Apify scrape failed: ${msg}`,
            },
          ],
          details: {
            actorId: params.actor_id,
            error: msg,
            tier: "apify",
          },
        };
      }
    },
  });

  // ---- list_actors: search Apify store ----

  pi.registerTool({
    name: "list_actors",
    label: "List Apify Actors",
    description:
      "Search the Apify actor store to find pre-built scrapers. Returns actor names, descriptions, and usage stats. Use this to discover the right actor before running scrape_apify.",
    promptSnippet: "Search Apify store for pre-built scraping actors.",
    parameters: Type.Object({
      query: Type.String({ description: "Search terms" }),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        if (!APIFY_API_TOKEN) {
          return {
            content: [
              {
                type: "text" as const,
                text: "APIFY_API_TOKEN is not set. Export it as an environment variable to use Apify tools.",
              },
            ],
            details: { error: "missing_token", tier: "apify" },
          };
        }

        const res = await fetch(
          `https://api.apify.com/v2/store?token=${APIFY_API_TOKEN}&search=${encodeURIComponent(params.query)}&limit=5`,
          { signal }
        );

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          return {
            content: [
              {
                type: "text" as const,
                text: `Apify store search failed (${res.status}): ${errText}`,
              },
            ],
            details: { error: `HTTP ${res.status}`, tier: "apify" },
          };
        }

        const data = (await res.json()) as {
          data: {
            items: {
              name: string;
              username: string;
              title?: string;
              description?: string;
              stats?: {
                totalRuns?: number;
                totalUsers?: number;
              };
            }[];
          };
        };

        const actors = data.data?.items ?? [];
        if (actors.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No Apify actors found for query: "${params.query}"`,
              },
            ],
            details: { query: params.query, count: 0, tier: "apify" },
          };
        }

        const lines: string[] = [];
        lines.push(`## Apify Actors matching "${params.query}"\n`);

        for (const actor of actors) {
          const fullId = `${actor.username}/${actor.name}`;
          lines.push(`### ${actor.title || actor.name}`);
          lines.push(`**ID:** \`${fullId}\``);
          if (actor.description) {
            lines.push(
              `**Description:** ${actor.description.slice(0, 200)}`
            );
          }
          if (actor.stats) {
            const runs = actor.stats.totalRuns ?? 0;
            const users = actor.stats.totalUsers ?? 0;
            lines.push(`**Usage:** ${runs} runs, ${users} users`);
          }
          lines.push("");
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            query: params.query,
            count: actors.length,
            tier: "apify",
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Apify store search failed: ${msg}`,
            },
          ],
          details: { query: params.query, error: msg, tier: "apify" },
        };
      }
    },
  });

  // ---- scrape_status: check Apify run status ----

  pi.registerTool({
    name: "scrape_status",
    label: "Apify Run Status",
    description:
      "Check the status of an Apify actor run and retrieve results if completed. Use after scrape_apify returns a run ID for a long-running job.",
    promptSnippet: "Check status of an Apify run and get results if ready.",
    parameters: Type.Object({
      job_id: Type.String({ description: "Apify run ID" }),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        if (!APIFY_API_TOKEN) {
          return {
            content: [
              {
                type: "text" as const,
                text: "APIFY_API_TOKEN is not set. Export it as an environment variable to use Apify tools.",
              },
            ],
            details: { error: "missing_token", tier: "apify" },
          };
        }

        const statusRes = await fetch(
          `https://api.apify.com/v2/actor-runs/${params.job_id}?token=${APIFY_API_TOKEN}`,
          { signal }
        );

        if (!statusRes.ok) {
          const errText = await statusRes.text().catch(() => "");
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to check run status (${statusRes.status}): ${errText}`,
              },
            ],
            details: {
              jobId: params.job_id,
              error: `HTTP ${statusRes.status}`,
              tier: "apify",
            },
          };
        }

        const runData = (await statusRes.json()) as {
          data: {
            id: string;
            status: string;
            defaultDatasetId: string;
            startedAt?: string;
            finishedAt?: string;
          };
        };

        const run = runData.data;
        const lines: string[] = [];
        lines.push("## Apify Run Status\n");
        lines.push(`**Run ID:** ${run.id}`);
        lines.push(`**Status:** ${run.status}`);
        if (run.startedAt) lines.push(`**Started:** ${run.startedAt}`);
        if (run.finishedAt) lines.push(`**Finished:** ${run.finishedAt}`);

        if (run.status === "SUCCEEDED" && run.defaultDatasetId) {
          const itemsRes = await fetch(
            `https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?token=${APIFY_API_TOKEN}&limit=100`,
            { signal }
          );

          if (itemsRes.ok) {
            const items = (await itemsRes.json()) as Record<
              string,
              unknown
            >[];
            lines.push(`**Items returned:** ${items.length}\n`);

            if (items.length > 0) {
              lines.push("### Data\n");
              lines.push("```json");
              lines.push(JSON.stringify(items, null, 2));
              lines.push("```");
            }

            return {
              content: [{ type: "text" as const, text: lines.join("\n") }],
              details: {
                jobId: params.job_id,
                status: run.status,
                datasetId: run.defaultDatasetId,
                itemCount: items.length,
                tier: "apify",
              },
            };
          } else {
            lines.push(
              "\nRun completed but failed to fetch dataset items."
            );
          }
        }

        if (
          run.status !== "SUCCEEDED" &&
          run.status !== "FAILED" &&
          run.status !== "ABORTED" &&
          run.status !== "TIMED-OUT"
        ) {
          lines.push(
            "\nThe run is still in progress. Check again later."
          );
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            jobId: params.job_id,
            status: run.status,
            tier: "apify",
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Apify status check failed: ${msg}`,
            },
          ],
          details: { jobId: params.job_id, error: msg, tier: "apify" },
        };
      }
    },
  });
}
