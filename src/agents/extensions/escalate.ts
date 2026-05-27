import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
  request,
  resolveCompanyId,
  resolveAgentId,
  isConfigured,
} from "../skills/_client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EscalateParams {
  message: string;
  urgency?: "blocking" | "when_you_can";
  inputs?: Array<{
    id: string;
    label: string;
    type: "select" | "text";
    options?: Array<{ value: string; label: string; description?: string }>;
  }>;
  suggestedReply?: string;
  confidenceScore?: number;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
};

type EscalateHandler = (params: EscalateParams, signal?: AbortSignal) => Promise<ToolResult>;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const LABEL_NAME = "escalation";
const LABEL_COLOR = "#dc2626";

let cachedLabelId: string | null | undefined;

async function getOrCreateLabel(signal?: AbortSignal): Promise<string | null> {
  if (cachedLabelId !== undefined) return cachedLabelId;
  try {
    const companyId = resolveCompanyId();
    const labels = (await request("GET", `/companies/${companyId}/labels`, undefined, signal)) as Array<{
      id: string;
      name: string;
    }>;
    const existing = labels.find((l) => l.name === LABEL_NAME);
    if (existing) {
      cachedLabelId = existing.id;
      return cachedLabelId;
    }
    const created = (await request("POST", `/companies/${companyId}/labels`, {
      name: LABEL_NAME,
      color: LABEL_COLOR,
    }, signal)) as { id: string };
    cachedLabelId = created.id;
    return cachedLabelId;
  } catch {
    cachedLabelId = null;
    return null;
  }
}

function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max - 3);
  const boundary = cut > max / 2 ? cut : max - 3;
  return text.slice(0, boundary) + "...";
}

function buildDescription(params: EscalateParams): string {
  const sections: string[] = [params.message];
  const textInputs = (params.inputs || []).filter((i) => i.type === "text");
  if (textInputs.length) {
    sections.push("");
    sections.push("## Requested Input");
    sections.push("");
    for (const input of textInputs) {
      sections.push(`**${input.label}** (free text)`);
      sections.push("");
    }
  }
  return sections.join("\n");
}

function ok(text: string, details?: unknown): ToolResult {
  return { content: [{ type: "text", text }], ...(details ? { details } : {}) };
}

// ---------------------------------------------------------------------------
// Backend: Paperclip (local — issue + interaction, human responds in UI)
// ---------------------------------------------------------------------------

function createPaperclipHandler(): EscalateHandler {
  return async (params, signal) => {
    const companyId = resolveCompanyId();
    const title = truncateAtWord(params.message, 80);
    const labelId = await getOrCreateLabel(signal);

    const issuePayload: Record<string, unknown> = {
      title,
      description: buildDescription(params),
      priority: params.urgency === "blocking" ? "high" : "medium",
    };
    if (labelId) issuePayload.labelIds = [labelId];

    const issue = (await request(
      "POST",
      `/companies/${companyId}/issues`,
      issuePayload,
      signal,
    )) as { id?: string; identifier?: string; title?: string };

    if (!issue?.id || !issue?.identifier) {
      return ok(
        `Escalation failed: unexpected response from issue creation.\nMessage preserved: ${params.message}`,
        { raw: issue },
      );
    }

    const selectInputs = (params.inputs || []).filter(
      (i) => i.type === "select" && i.options?.length,
    );

    if (selectInputs.length) {
      await request("POST", `/issues/${issue.id}/interactions`, {
        kind: "ask_user_questions",
        payload: {
          version: 1,
          questions: selectInputs.map((i) => ({
            id: i.id,
            prompt: i.label,
            selectionMode: "single",
            options: i.options!.map((o) => ({
              id: o.value,
              label: o.label,
              ...(o.description ? { description: o.description } : {}),
            })),
          })),
        },
        title: `Escalation: ${title}`,
        continuationPolicy: "wake_assignee",
      }, signal);
    } else {
      await request("POST", `/issues/${issue.id}/interactions`, {
        kind: "request_confirmation",
        payload: { version: 1, prompt: params.message },
        title: `Escalation: ${title}`,
        continuationPolicy: "wake_assignee",
      }, signal);
    }

    let paused = false;
    try {
      await request("POST", `/agents/${resolveAgentId()}/pause`, { reason: "escalation" }, signal);
      paused = true;
    } catch {
      // pause is best-effort — agent process may not support it
    }

    const status = paused
      ? "Agent paused. Waiting for human response in Paperclip UI."
      : "IMPORTANT: Could not pause agent. Stop working and wait for human response.";

    return ok(
      `Escalation created: ${issue.identifier} — ${issue.title}\n${status}\n\nWhen resumed, check issue ${issue.identifier} for the human's response.`,
      { issueId: issue.id, identifier: issue.identifier, paused },
    );
  };
}

// ---------------------------------------------------------------------------
// Backend: Discord (plugin tool execute, human responds in Discord thread)
// ---------------------------------------------------------------------------

function createDiscordHandler(pluginId: string): EscalateHandler {
  const agentName = process.env.AGENT_NAME || "agent";

  return async (params, signal) => {
    const companyId = resolveCompanyId();
    const result = (await request("POST", "/plugins/tools/execute", {
      tool: `${pluginId}:escalate_to_human`,
      parameters: {
        companyId,
        agentName,
        reason: params.message,
        ...(params.suggestedReply ? { suggestedReply: params.suggestedReply } : {}),
        ...(params.confidenceScore != null ? { confidenceScore: params.confidenceScore } : {}),
      },
      runContext: {
        agentId: resolveAgentId(),
        companyId,
      },
    }, signal)) as Record<string, unknown>;

    const lines = [
      `Escalation sent to Discord.`,
      `Reason: ${params.message}`,
      result.escalationId ? `Escalation ID: ${result.escalationId}` : "",
      `Waiting for human response in Discord.`,
    ].filter(Boolean);

    return ok(lines.join("\n"), result);
  };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  if (!isConfigured()) return;

  const pluginId = process.env.PAPERCLIP_DISCORD_PLUGIN_ID || "";
  const handler: EscalateHandler = pluginId
    ? createDiscordHandler(pluginId)
    : createPaperclipHandler();

  pi.registerTool({
    name: "escalate",
    label: "Escalate to Human",
    description:
      "Escalate a decision or question to a human. Use when you need human input, approval, or a manual action you cannot perform yourself.",
    promptSnippet:
      "Escalate to human when you need input, approval, or a manual action.",
    parameters: Type.Object({
      message: Type.String({ description: "Why you need human help — be specific" }),
      urgency: Type.Optional(
        Type.Union([Type.Literal("blocking"), Type.Literal("when_you_can")]),
      ),
      inputs: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String({ description: "Short key, e.g. db_choice" }),
            label: Type.String({ description: "Human-readable question" }),
            type: Type.Union([Type.Literal("select"), Type.Literal("text")]),
            options: Type.Optional(
              Type.Array(
                Type.Object({
                  value: Type.String(),
                  label: Type.String(),
                  description: Type.Optional(Type.String()),
                }),
              ),
            ),
          }),
        ),
      ),
      suggestedReply: Type.Optional(
        Type.String({ description: "Suggested answer for the human" }),
      ),
      confidenceScore: Type.Optional(
        Type.Number({ description: "Your confidence 0-1, lower = more uncertain" }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        return await handler(params as EscalateParams, signal);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return ok(
          `Escalation failed: ${msg}\nMessage preserved: ${(params as EscalateParams).message}`,
          { error: msg },
        );
      }
    },
  });
}
