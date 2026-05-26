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
  if (!hasPython()) return false;
  try {
    execFileSync(
      "python3",
      ["-c", "from scrapling import PlayWrightFetcher"],
      { encoding: "utf-8", timeout: 10000 }
    );
    return true;
  } catch {
    return false;
  }
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

    // Determine if items are objects with fields or plain strings
    const first = data.items[0];
    if (typeof first === "object" && first !== null) {
      const keys = Object.keys(first);
      // Render as markdown table
      lines.push("| " + keys.join(" | ") + " |");
      lines.push("| " + keys.map(() => "---").join(" | ") + " |");
      for (const item of data.items as Record<string, string>[]) {
        const values = keys.map((k) => {
          const v = item[k] ?? "";
          // Escape pipes in cell values
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
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Cache dependency checks so we only probe once
  const cheerioAvailable = hasCheerio();
  const scraplingFetcherAvailable = hasScraplingFetcher();
  const scraplingBrowserAvailable = hasScraplingBrowser();

  // =========================================================================
  // Tier 1: scrape_static — cheerio-based
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
          const cheerio = require("cheerio");
          const maxItems = params.max_items ?? 100;
          const maxPages = params.pagination?.max_pages ?? 1;
          const startTime = Date.now();
          const items: (Record<string, string> | string)[] = [];
          const errors: string[] = [];
          let pagesCrawled = 0;
          let currentUrl = params.url;

          for (let page = 0; page < maxPages; page++) {
            if (items.length >= maxItems) break;

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

            const $ = cheerio.load(html);
            pagesCrawled++;

            $(params.selector).each((_i: number, el: unknown) => {
              if (items.length >= maxItems) return false;

              if (
                params.extract_fields &&
                Object.keys(params.extract_fields).length > 0
              ) {
                const record: Record<string, string> = {};
                for (const [field, fieldSelector] of Object.entries(
                  params.extract_fields
                )) {
                  record[field] = $(el).find(fieldSelector).text().trim();
                }
                items.push(record);
              } else {
                const text = $(el).text().trim();
                if (text) items.push(text);
              }
            });

            // Handle pagination
            if (params.pagination?.next_selector && page < maxPages - 1) {
              const nextHref = $(params.pagination.next_selector).attr("href");
              if (!nextHref) break;
              try {
                currentUrl = new URL(nextHref, currentUrl).toString();
              } catch {
                errors.push(`Invalid pagination URL: ${nextHref}`);
                break;
              }
            } else if (page < maxPages - 1 && params.pagination) {
              // No next link found, stop
              break;
            }
          }

          const durationMs = Date.now() - startTime;
          const data: ScrapeData = {
            items: items as ScrapeData["items"],
            pages_crawled: pagesCrawled,
            duration_ms: durationMs,
            errors,
          };

          const text = formatScrapeResult(data, params.url, "static (cheerio)");
          return {
            content: [{ type: "text" as const, text }],
            details: {
              url: params.url,
              itemCount: items.length,
              pagesCrawled,
              durationMs,
              tier: "static",
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
  // Tier 2: scrape_stealth — Python scrapling Fetcher
  // =========================================================================

  if (scraplingFetcherAvailable) {
    pi.registerTool({
      name: "scrape_stealth",
      label: "Stealth Scraper",
      description:
        "Scrape structured data using an anti-detection HTTP client. Better for sites that block standard requests. Uses Python scrapling Fetcher with realistic TLS fingerprints and header rotation.",
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
          const input = {
            url: params.url,
            selector: params.selector,
            extract_fields: params.extract_fields ?? null,
            pagination: params.pagination ?? null,
            max_items: params.max_items ?? 100,
          };

          const result = execFileSync(
            "python3",
            ["/app/scripts/scrape_stealth.py", JSON.stringify(input)],
            {
              encoding: "utf-8",
              timeout: 60_000,
              maxBuffer: 5 * 1024 * 1024,
            }
          );

          const parsed: ScrapeData = JSON.parse(result);
          const text = formatScrapeResult(
            parsed,
            params.url,
            "stealth (scrapling Fetcher)"
          );

          return {
            content: [{ type: "text" as const, text }],
            details: {
              url: params.url,
              itemCount: parsed.items.length,
              pagesCrawled: parsed.pages_crawled,
              durationMs: parsed.duration_ms,
              tier: "stealth",
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
  // Tier 3: scrape_browser — Python scrapling PlayWrightFetcher
  // =========================================================================

  if (scraplingBrowserAvailable) {
    pi.registerTool({
      name: "scrape_browser",
      label: "Browser Scraper",
      description:
        "Scrape structured data using a headless browser for JavaScript-rendered pages. Uses Python scrapling PlayWrightFetcher with anti-detection measures. Slower but handles SPAs, dynamic content, and pages requiring JS execution.",
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
          const input = {
            url: params.url,
            selector: params.selector,
            extract_fields: params.extract_fields ?? null,
            pagination: params.pagination ?? null,
            max_items: params.max_items ?? 100,
            wait_for: params.wait_for ?? null,
          };

          const result = execFileSync(
            "python3",
            ["/app/scripts/scrape_browser.py", JSON.stringify(input)],
            {
              encoding: "utf-8",
              timeout: 120_000,
              maxBuffer: 5 * 1024 * 1024,
            }
          );

          const parsed: ScrapeData = JSON.parse(result);
          const text = formatScrapeResult(
            parsed,
            params.url,
            "browser (scrapling PlayWrightFetcher)"
          );

          return {
            content: [{ type: "text" as const, text }],
            details: {
              url: params.url,
              itemCount: parsed.items.length,
              pagesCrawled: parsed.pages_crawled,
              durationMs: parsed.duration_ms,
              tier: "browser",
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

        // Merge url into startUrls if provided
        if (params.url) {
          if (!input.startUrls || !Array.isArray(input.startUrls)) {
            input.startUrls = [];
          }
          (input.startUrls as { url: string }[]).push({ url: params.url });
        }

        // Start the actor run
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

        // Poll for completion (up to 30s)
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
          // Fetch dataset items
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

        // Still running after poll timeout — return run ID for later checking
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
