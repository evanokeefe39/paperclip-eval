import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const EXA_API_KEY = process.env.EXA_API_KEY || "";

interface ExaResult {
  title: string;
  url: string;
  text?: string;
  highlights?: string[];
  score: number;
}

interface ExaResponse {
  results: ExaResult[];
  requestId: string;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Exa API. Returns ranked results with titles, URLs, and content. Use for finding current information, research, and fact-checking.",
    promptSnippet:
      "Search the web for information. Returns titles, URLs, and content.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
    }),
    async execute(_toolCallId, params, signal) {
      if (!EXA_API_KEY) {
        throw new Error(
          "EXA_API_KEY not set. Export it as an environment variable."
        );
      }

      const body = {
        query: params.query,
        numResults: params.num_results ?? 5,
        contents: {
          text: { maxCharacters: 1500 },
          highlights: { numSentences: 3 },
        },
      };

      const res = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": EXA_API_KEY,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Exa API error ${res.status}: ${errText}`);
      }

      const data: ExaResponse = await res.json();

      const lines: string[] = [`## Search results for: ${params.query}\n`];

      for (const r of data.results) {
        lines.push(`### ${r.title}`);
        lines.push(`URL: ${r.url}`);
        if (r.score != null) lines.push(`Score: ${r.score.toFixed(2)}`);
        if (r.highlights?.length) {
          lines.push(`\n**Highlights:**`);
          for (const h of r.highlights) {
            lines.push(`> ${h}`);
          }
        }
        if (r.text) {
          lines.push(`\n${r.text}\n`);
        }
        lines.push("");
      }

      const text = lines.join("\n");

      return {
        content: [{ type: "text" as const, text }],
        details: {
          query: params.query,
          resultCount: data.results.length,
        },
      };
    },
  });
}
