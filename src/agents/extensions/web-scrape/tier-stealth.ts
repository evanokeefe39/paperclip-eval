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
