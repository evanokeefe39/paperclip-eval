import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { ScrapeData, ChallengeResult } from "./types.js";
import { detectChallenge } from "./challenge.js";
import { extractWithCheerio } from "./cheerio.js";
import { formatScrapeResult, buildDiagnostics } from "./format.js";
import { PaginationSchema, ExtractFieldsSchema } from "./schemas.js";

export function register(pi: ExtensionAPI): void {
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
