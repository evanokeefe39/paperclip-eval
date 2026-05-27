import type { ScrapeData, ChallengeResult } from "./types.js";

export function formatScrapeResult(
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

export function buildDiagnostics(
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

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim().slice(0, 200) : "(no title)";
  lines.push(`**Page title:** ${title}`);

  const descMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i
  );
  const desc = descMatch ? descMatch[1].trim().slice(0, 300) : "(none)";
  lines.push(`**Meta description:** ${desc}`);

  return lines.join("\n");
}
