export interface ChallengeResult {
  isChallenge: boolean;
  vendor?: "cloudflare" | "datadome" | "perimeterx" | "aws_waf" | "unknown";
  signature?: string;
}

export interface ParseResult {
  items: (Record<string, string> | string)[];
  matchCount: number;
}

export interface ScrapeData {
  items: Record<string, string>[] | string[];
  pages_crawled: number;
  duration_ms: number;
  errors: string[];
}

export interface FetchResult {
  html: string;
  status_code: number;
  url: string;
  duration_ms: number;
  errors: string[];
}
