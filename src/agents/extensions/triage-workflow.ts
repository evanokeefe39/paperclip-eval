import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

const AGENT_NAME = process.env.AGENT_NAME || "unknown";

// --- Workflow phases ---
// TRIAGE:    must call triage_task first
// GROUNDING: may call web_search (0-2), escalate, ask_user_questions
// READY:     may call create_issue, invoke_agent, update_issue

type Phase = "TRIAGE" | "GROUNDING" | "READY";
let phase: Phase = "TRIAGE";
let searchCount = 0;
const MAX_SEARCHES = 2;

// Tools allowed per phase
const PHASE_TOOLS: Record<Phase, string[]> = {
  TRIAGE: [
    "triage_task",
    // always allowed (read-only / coordination)
    "paperclip_inbox", "paperclip_me", "paperclip_list_agents",
    "paperclip_get_agent", "paperclip_list_issues", "paperclip_get_issue",
    "paperclip_list_comments", "paperclip_get_comment",
    "paperclip_get_heartbeat_context",
    "read", "grep", "find", "ls",
    "read_artifact", "list_artifacts",
    "log_event", "get_log", "get_trace_id",
    "escalate",
  ],
  GROUNDING: [
    "web_search",
    "escalate",
    "paperclip_ask_user_questions",
    "paperclip_request_confirmation",
    "advance_to_delegation",
  ],
  READY: [
    "paperclip_create_issue",
    "paperclip_update_issue",
    "paperclip_invoke_agent",
    "paperclip_add_comment",
    "paperclip_suggest_tasks",
    "paperclip_create_approval",
    "paperclip_list_approvals",
    "paperclip_get_approval",
    "paperclip_approval_decision",
    "paperclip_link_issue_approval",
    "paperclip_list_issue_approvals",
    "web_search",
    "paperclip_ask_user_questions",
    "paperclip_request_confirmation",
  ],
};

// Tools allowed in ALL phases
const ALWAYS_ALLOWED = PHASE_TOOLS.TRIAGE;

function isAllowed(toolName: string): boolean {
  if (ALWAYS_ALLOWED.includes(toolName)) return true;
  return (PHASE_TOOLS[phase] || []).includes(toolName);
}

function logEvent(event: string, data?: Record<string, unknown>) {
  const dir = path.join(process.cwd(), "triage");
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, "audit.jsonl"),
    JSON.stringify({ ts: new Date().toISOString(), agent: AGENT_NAME, phase, event, ...data }) + "\n"
  );
}

export default function (pi: ExtensionAPI) {
  if (AGENT_NAME !== "ceo") return;

  phase = "TRIAGE";
  searchCount = 0;

  // --- Tool: triage_task (Phase 1 → Phase 2 transition) ---
  pi.registerTool({
    name: "triage_task",
    label: "Triage Task",
    description:
      "Classify an incoming task and plan your approach. MUST be called before any delegation. " +
      "Returns routing guidance. After triage, you may use web_search for grounding and escalate/ask_user_questions for clarification.",
    promptSnippet:
      "Always call triage_task first when you receive work. It unlocks web_search for grounding and delegation tools.",
    parameters: Type.Object({
      task_summary: Type.String({ description: "One-sentence summary of the task" }),
      complexity: Type.String({ description: "simple | moderate | complex" }),
      needs_clarification: Type.Boolean({ description: "True if task is ambiguous and human input would help" }),
      clarification_questions: Type.Optional(
        Type.Array(Type.String(), { description: "Questions to ask the human if clarification needed" })
      ),
      suggested_searches: Type.Optional(
        Type.Array(Type.String(), {
          maxItems: MAX_SEARCHES,
          description: "Up to 2 web search queries for domain grounding (coarse context, not research)",
        })
      ),
      suggested_agents: Type.Optional(
        Type.Array(Type.String(), { description: "Which agents should handle this: Researcher, Data, Writer, etc." })
      ),
    }),
    async execute(_toolCallId, params) {
      phase = "GROUNDING";

      logEvent("triage_complete", {
        task: params.task_summary,
        complexity: params.complexity,
        needs_clarification: params.needs_clarification,
        suggested_searches: params.suggested_searches,
        suggested_agents: params.suggested_agents,
      });

      const sections = [
        `## Triage Result`,
        ``,
        `**Task:** ${params.task_summary}`,
        `**Complexity:** ${params.complexity}`,
        `**Needs clarification:** ${params.needs_clarification}`,
        ``,
        `## Available actions (grounding phase)`,
        ``,
      ];

      if (params.suggested_searches?.length) {
        sections.push(
          `**Suggested searches** (call web_search for each):`,
          ...params.suggested_searches.map((q) => `- \`${q}\``),
          ``,
        );
      }

      if (params.needs_clarification && params.clarification_questions?.length) {
        sections.push(
          `**Clarification needed** — use escalate or paperclip_ask_user_questions:`,
          ...params.clarification_questions.map((q) => `- ${q}`),
          ``,
        );
      }

      if (params.suggested_agents?.length) {
        sections.push(
          `**Suggested delegation:** ${params.suggested_agents.join(", ")}`,
          ``,
        );
      }

      sections.push(
        `## Next steps`,
        ``,
        `1. (Optional) Call web_search for domain grounding (max ${MAX_SEARCHES} searches)`,
        `2. (If needed) Call escalate or paperclip_ask_user_questions for clarification`,
        `3. Call advance_to_delegation when ready to create issues and delegate`,
      );

      return {
        content: [{ type: "text" as const, text: sections.join("\n") }],
        details: {
          phase: "GROUNDING",
          task: params.task_summary,
          complexity: params.complexity,
          needs_clarification: params.needs_clarification,
        },
      };
    },
  });

  // --- Tool: advance_to_delegation (Phase 2 → Phase 3 transition) ---
  pi.registerTool({
    name: "advance_to_delegation",
    label: "Ready to Delegate",
    description:
      "Signal that grounding and clarification are done. Unlocks issue creation and agent invocation tools. " +
      "Call this after web searches and any needed clarification, before creating issues.",
    parameters: Type.Object({
      grounding_summary: Type.Optional(
        Type.String({ description: "Brief summary of what you learned from web searches" })
      ),
      clarification_resolved: Type.Optional(
        Type.Boolean({ description: "True if clarification was obtained or not needed" })
      ),
    }),
    async execute(_toolCallId, params) {
      phase = "READY";

      logEvent("delegation_unlocked", {
        grounding_summary: params.grounding_summary,
        searches_used: searchCount,
        clarification_resolved: params.clarification_resolved,
      });

      return {
        content: [{
          type: "text" as const,
          text: [
            `## Delegation Unlocked`,
            ``,
            `You may now create child issues and invoke agents.`,
            params.grounding_summary ? `**Context:** ${params.grounding_summary}` : "",
            `**Searches used:** ${searchCount}/${MAX_SEARCHES}`,
            ``,
            `Create well-scoped child issues with clear descriptions. Assign to the right agent. Set status to todo.`,
          ].filter(Boolean).join("\n"),
        }],
        details: { phase: "READY", searchCount },
      };
    },
  });

  // --- Hook: enforce phase sequence ---
  (pi as any).on(
    "tool_call",
    async (event: { toolName: string; toolCallId: string; input: Record<string, unknown> }) => {
      // Cap web searches in grounding phase
      if (event.toolName === "web_search" && phase === "GROUNDING") {
        if (searchCount >= MAX_SEARCHES) {
          logEvent("search_cap_hit", { tool: event.toolName, count: searchCount });
          return {
            block: true,
            reason: `Search limit reached (${MAX_SEARCHES}/${MAX_SEARCHES}). Call advance_to_delegation to proceed to issue creation.`,
          };
        }
        searchCount++;
        return;
      }

      // Check phase permissions
      if (!isAllowed(event.toolName)) {
        const hint = phaseHint(event.toolName);
        logEvent("phase_blocked", { tool: event.toolName, phase, hint });
        return { block: true, reason: hint };
      }
    }
  );
}

function phaseHint(toolName: string): string {
  switch (phase) {
    case "TRIAGE":
      if (PHASE_TOOLS.GROUNDING.includes(toolName))
        return `Call triage_task first. "${toolName}" is available after triage.`;
      if (PHASE_TOOLS.READY.includes(toolName))
        return `Call triage_task first, then do grounding, then advance_to_delegation. "${toolName}" is available in the delegation phase.`;
      return `"${toolName}" is not available for the ${AGENT_NAME} agent.`;

    case "GROUNDING":
      if (PHASE_TOOLS.READY.includes(toolName))
        return `Call advance_to_delegation first. "${toolName}" is available after grounding is complete.`;
      return `"${toolName}" is not available in the grounding phase.`;

    case "READY":
      return `"${toolName}" is not available for the ${AGENT_NAME} agent.`;

    default:
      return `"${toolName}" is not available in the current workflow phase.`;
  }
}
