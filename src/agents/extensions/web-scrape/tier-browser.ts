import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { ScrapeData } from "./types.js";
import { detectChallenge } from "./challenge.js";
import { extractWithCheerio } from "./cheerio.js";
import { formatScrapeResult, buildDiagnostics } from "./format.js";
import { PaginationSchema, ExtractFieldsSchema } from "./schemas.js";
import { pythonFetch } from "./python-fetch.js";

export function register(pi: ExtensionAPI): void {
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
