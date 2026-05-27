import { execFileSync } from "node:child_process";
import type { FetchResult } from "./types.js";

export function pythonFetch(
  scriptPath: string,
  url: string,
  timeoutMs: number,
  waitFor?: string
): FetchResult {
  const input: Record<string, unknown> = { url };
  if (waitFor) input.wait_for = waitFor;

  const result = execFileSync(
    "python3",
    [scriptPath, JSON.stringify(input)],
    {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  return JSON.parse(result) as FetchResult;
}
