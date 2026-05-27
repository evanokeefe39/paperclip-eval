import type { ParseResult } from "./types.js";

export function extractWithCheerio(
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
