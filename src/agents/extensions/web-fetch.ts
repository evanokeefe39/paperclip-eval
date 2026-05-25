import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const JINA_READER_BASE = "https://r.jina.ai/";

async function fetchWithJina(
  url: string,
  signal?: AbortSignal
): Promise<{ title: string; content: string } | null> {
  try {
    const res = await fetch(JINA_READER_BASE + url, {
      headers: { Accept: "text/markdown", "X-No-Cache": "true" },
      signal: AbortSignal.any([
        AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!res.ok) return null;

    const text = await res.text();
    const contentStart = text.indexOf("Markdown Content:");
    if (contentStart < 0) return null;

    const markdown = text.slice(contentStart + 17).trim();
    if (markdown.length < 100) return null;

    const titleMatch = markdown.match(/^#{1,2}\s+(.+)/m);
    const title = titleMatch?.[1]?.replace(/\*+/g, "").trim() || "";
    return { title, content: markdown };
  } catch {
    return null;
  }
}

async function fetchDirect(
  url: string,
  signal?: AbortSignal
): Promise<{ title: string; content: string; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    if (!res.ok) {
      return { title: "", content: "", error: `HTTP ${res.status}` };
    }

    const contentType = res.headers.get("content-type") || "";
    const lengthHeader = res.headers.get("content-length");
    if (lengthHeader && parseInt(lengthHeader) > MAX_RESPONSE_SIZE) {
      return { title: "", content: "", error: "Response too large" };
    }

    const text = await res.text();
    const isHTML =
      contentType.includes("text/html") ||
      contentType.includes("application/xhtml");

    if (!isHTML) {
      const titleMatch = text.match(/^#{1,2}\s+(.+)/m);
      const title = titleMatch?.[1]?.trim() || url;
      return { title, content: text };
    }

    // Basic HTML text extraction — strip tags, collapse whitespace
    const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch?.[1]?.trim() || "";

    const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const body = bodyMatch?.[1] || text;

    const cleaned = body
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      .replace(/<header[\s\S]*?<\/header>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();

    if (cleaned.length < 200) {
      return { title, content: cleaned, error: "Content may be JS-rendered" };
    }

    return { title, content: cleaned };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { title: "", content: "", error: msg };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a web page and extract readable content. Tries direct fetch first, falls back to Jina Reader for JS-rendered pages. Returns clean text/markdown.",
    promptSnippet:
      "Fetch a URL and extract readable content as text or markdown.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        new URL(params.url);
      } catch {
        throw new Error(`Invalid URL: ${params.url}`);
      }

      // Try direct fetch first
      const direct = await fetchDirect(params.url, signal);

      if (!direct.error && direct.content.length >= 200) {
        const header = direct.title
          ? `# ${direct.title}\n\nSource: ${params.url}\n\n---\n\n`
          : "";
        return {
          content: [{ type: "text" as const, text: header + direct.content }],
          details: {
            url: params.url,
            title: direct.title,
            chars: direct.content.length,
            method: "direct",
          },
        };
      }

      // Fallback to Jina Reader
      const jina = await fetchWithJina(params.url, signal);
      if (jina) {
        const header = jina.title
          ? `# ${jina.title}\n\nSource: ${params.url}\n\n---\n\n`
          : "";
        return {
          content: [{ type: "text" as const, text: header + jina.content }],
          details: {
            url: params.url,
            title: jina.title,
            chars: jina.content.length,
            method: "jina",
          },
        };
      }

      // Return whatever we got from direct, even if partial
      if (direct.content) {
        return {
          content: [{ type: "text" as const, text: direct.content }],
          details: {
            url: params.url,
            title: direct.title,
            chars: direct.content.length,
            method: "direct-partial",
            warning: direct.error,
          },
        };
      }

      throw new Error(
        `Could not fetch ${params.url}: ${direct.error || "unknown error"}`
      );
    },
  });
}
