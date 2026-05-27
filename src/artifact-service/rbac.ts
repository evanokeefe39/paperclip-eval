import { readFileSync, existsSync } from "node:fs";

interface AgentRules {
  read: string[];
  write: string[];
}

interface RbacConfig {
  agents: Record<string, AgentRules>;
}

let rules: RbacConfig = { agents: {} };

/**
 * Load RBAC rules from disk.
 * Looks for /app/rbac.json first (container), falls back to ./rbac.json (local dev).
 */
export function loadRules(): void {
  const paths = ["/app/rbac.json", "./rbac.json"];
  for (const p of paths) {
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf-8");
      rules = JSON.parse(raw) as RbacConfig;
      console.log(`rbac: loaded rules from ${p}`);
      return;
    }
  }
  console.warn("rbac: no rbac.json found — all access denied by default");
}

/** Check whether agentName may read the given s3Key. */
export function canRead(agentName: string, s3Key: string): boolean {
  return matchAny(agentName, "read", s3Key);
}

/** Check whether agentName may write the given s3Key. */
export function canWrite(agentName: string, s3Key: string): boolean {
  return matchAny(agentName, "write", s3Key);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function matchAny(
  agentName: string,
  action: "read" | "write",
  s3Key: string,
): boolean {
  const agent = rules.agents[agentName];
  if (!agent) return false;

  const patterns = agent[action];
  if (!patterns || patterns.length === 0) return false;

  return patterns.some((pattern) => globMatch(pattern, s3Key));
}

/**
 * Simple glob matching.
 * Converts glob pattern to regex:
 *   **  -> .*   (match across path separators)
 *   *   -> [^/]*  (match within a single segment)
 *   ?   -> .
 * All other regex-special characters are escaped.
 */
function globMatch(pattern: string, value: string): boolean {
  // Escape regex specials except * and ?
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i += 2;
      // skip trailing slash after ** if present
      if (pattern[i] === "/") i++;
    } else if (ch === "*") {
      re += "[^/]*";
      i++;
    } else if (ch === "?") {
      re += ".";
      i++;
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      re += `\\${ch}`;
      i++;
    } else {
      re += ch;
      i++;
    }
  }

  return new RegExp(`^${re}$`).test(value);
}
