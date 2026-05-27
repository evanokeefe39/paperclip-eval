import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { writeFileSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";

const BLOCKED_TOOLS = (process.env.BLOCKED_TOOLS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const AGENT_NAME = process.env.AGENT_NAME || "unknown";
const LOG_PATH = join("/artifacts", AGENT_NAME, "role-guard.log.jsonl");

function logAttempt(toolName: string, input: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    agent: AGENT_NAME,
    event: "blocked_tool_call",
    tool: toolName,
    input_summary: Object.keys(input).reduce(
      (acc, k) => {
        const v = input[k];
        acc[k] = typeof v === "string" ? v.slice(0, 200) : v;
        return acc;
      },
      {} as Record<string, unknown>
    ),
  };
  const line = JSON.stringify(entry) + "\n";
  process.stderr.write(`[role-guard] BLOCKED: ${toolName}\n`);
  try {
    appendFileSync(LOG_PATH, line);
  } catch {
    try {
      mkdirSync(join("/artifacts", AGENT_NAME), { recursive: true });
      appendFileSync(LOG_PATH, line);
    } catch {}
  }
}

export default function (pi: ExtensionAPI) {
  if (BLOCKED_TOOLS.length === 0) return;

  (pi as any).on(
    "tool_call",
    async (event: { toolName: string; toolCallId: string; input: Record<string, unknown> }) => {
      if (BLOCKED_TOOLS.includes(event.toolName)) {
        logAttempt(event.toolName, event.input);
        const reason = event.toolName === "subagent"
          ? `The "subagent" tool is not available. To delegate work, use paperclip_create_issue to create a child issue assigned to an agent, then paperclip_invoke_agent to wake them.`
          : `Tool "${event.toolName}" is not available for the ${AGENT_NAME} agent. Delegate this work to the appropriate agent instead.`;
        return { block: true, reason };
      }
    }
  );
}
