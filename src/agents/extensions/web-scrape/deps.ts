import { execFileSync } from "node:child_process";

export function hasPython(): boolean {
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

export function hasCheerio(): boolean {
  try {
    require("cheerio");
    return true;
  } catch {
    return false;
  }
}

export function hasScraplingFetcher(): boolean {
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

export function hasScraplingBrowser(): boolean {
  try {
    require("node:fs").accessSync("/app/.browsers-installed");
    return true;
  } catch {
    return false;
  }
}
