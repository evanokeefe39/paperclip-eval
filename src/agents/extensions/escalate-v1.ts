import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL || "";
const PAPERCLIP_ADMIN_EMAIL = process.env.PAPERCLIP_ADMIN_EMAIL || "";
const PAPERCLIP_ADMIN_PASS = process.env.PAPERCLIP_ADMIN_PASS || "";
const PAPERCLIP_AGENT_ID = process.env.PAPERCLIP_AGENT_ID || "";
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "";

const ESCALATION_LABEL_NAME = "escalation";
const ESCALATION_LABEL_COLOR = "#dc2626";

interface PaperclipSession {
  cookie: string;
}

interface PaperclipIssue {
  id: string;
  identifier: string;
  issueNumber: number;
  title: string;
}

interface PaperclipLabel {
  id: string;
  name: string;
}

async function authenticate(): Promise<PaperclipSession> {
  const res = await fetch(`${PAPERCLIP_API_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: PAPERCLIP_API_URL,
    },
    body: JSON.stringify({
      email: PAPERCLIP_ADMIN_EMAIL,
      password: PAPERCLIP_ADMIN_PASS,
    }),
  });
  if (!res.ok) {
    throw new Error(`Paperclip auth failed: ${res.status}`);
  }
  const setCookie = res.headers.get("set-cookie") || "";
  const match = setCookie.match(/([^;]+)/);
  if (!match) {
    throw new Error("No session cookie in auth response");
  }
  return { cookie: match[1] };
}

function apiHeaders(session: PaperclipSession): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Origin: PAPERCLIP_API_URL,
    Cookie: session.cookie,
  };
}

async function getOrCreateLabel(session: PaperclipSession): Promise<string | null> {
  const headers = apiHeaders(session);
  const listRes = await fetch(
    `${PAPERCLIP_API_URL}/api/companies/${PAPERCLIP_COMPANY_ID}/labels`,
    { headers }
  );
  if (!listRes.ok) return null;

  const labels: PaperclipLabel[] = await listRes.json();
  const existing = labels.find((l) => l.name === ESCALATION_LABEL_NAME);
  if (existing) return existing.id;

  const createRes = await fetch(
    `${PAPERCLIP_API_URL}/api/companies/${PAPERCLIP_COMPANY_ID}/labels`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ name: ESCALATION_LABEL_NAME, color: ESCALATION_LABEL_COLOR }),
    }
  );
  if (!createRes.ok) return null;

  const created: PaperclipLabel = await createRes.json();
  return created.id;
}

interface EscalateInput {
  id: string;
  label: string;
  type: "select" | "text";
  options?: Array<{ value: string; label: string; description?: string }>;
}

function buildIssueBody(message: string, inputs?: EscalateInput[]): string {
  const sections: string[] = [message];

  if (inputs?.length) {
    sections.push("\n---\n\n## Requested Input\n");
    for (const input of inputs) {
      if (input.type === "select" && input.options?.length) {
        sections.push(`**${input.label}** (choose one):`);
        for (const opt of input.options) {
          const desc = opt.description ? ` — ${opt.description}` : "";
          sections.push(`- ${opt.label}${desc}`);
        }
      } else {
        sections.push(`**${input.label}** (free text)`);
      }
      sections.push("");
    }
  }

  const schema = { message, inputs: inputs || [] };
  sections.push("\n```escalation-schema");
  sections.push(JSON.stringify(schema, null, 2));
  sections.push("```");

  return sections.join("\n");
}

export default function (pi: ExtensionAPI) {
  const required = [PAPERCLIP_API_URL, PAPERCLIP_ADMIN_EMAIL, PAPERCLIP_ADMIN_PASS, PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID];
  if (required.some((v) => !v)) return;

  pi.registerTool({
    name: "escalate",
    label: "Escalate to Human",
    description:
      "Escalate a decision or question to a human via Paperclip. Creates an issue and pauses the agent. Use when you need human input, approval, or a manual action that you cannot perform yourself.",
    promptSnippet:
      "Escalate to human when you need input, approval, or a manual action.",
    parameters: Type.Object({
      message: Type.String({ description: "Why you need human help — be specific" }),
      urgency: Type.Optional(
        Type.Union([Type.Literal("blocking"), Type.Literal("when_you_can")])
      ),
      inputs: Type.Optional(
        Type.Array(
          Type.Object({
            id: Type.String({ description: "Short key, e.g. db_choice" }),
            label: Type.String({ description: "Human-readable label" }),
            type: Type.Union([Type.Literal("select"), Type.Literal("text")]),
            options: Type.Optional(
              Type.Array(
                Type.Object({
                  value: Type.String(),
                  label: Type.String(),
                  description: Type.Optional(Type.String()),
                })
              )
            ),
          })
        )
      ),
    }),
    async execute(_toolCallId, params, _signal) {
      const urgency = params.urgency || "blocking";
      const session = await authenticate();

      const description = buildIssueBody(params.message, params.inputs);
      const title = params.message.length > 80
        ? params.message.slice(0, 77) + "..."
        : params.message;

      const labelId = await getOrCreateLabel(session);

      const issuePayload: Record<string, unknown> = {
        title,
        description,
        priority: urgency === "blocking" ? "high" : "medium",
      };
      if (labelId) {
        issuePayload.labelIds = [labelId];
      }

      let issue: PaperclipIssue | null = null;
      const issueRes = await fetch(
        `${PAPERCLIP_API_URL}/api/companies/${PAPERCLIP_COMPANY_ID}/issues`,
        {
          method: "POST",
          headers: apiHeaders(session),
          body: JSON.stringify(issuePayload),
        }
      );
      if (issueRes.ok) {
        issue = await issueRes.json();
      }

      let paused = false;
      const pauseRes = await fetch(
        `${PAPERCLIP_API_URL}/api/agents/${PAPERCLIP_AGENT_ID}/pause`,
        {
          method: "POST",
          headers: apiHeaders(session),
          body: JSON.stringify({ reason: "escalation" }),
        }
      );
      paused = pauseRes.ok;

      const lines: string[] = [];
      if (issue) {
        lines.push(`Escalation issue created: ${issue.identifier} (${issue.title})`);
      } else {
        lines.push("Failed to create escalation issue. Escalation message preserved below.");
        lines.push(`Message: ${params.message}`);
      }

      if (paused) {
        lines.push("Agent paused. Waiting for human response.");
      } else {
        lines.push("IMPORTANT: Could not pause agent via API. Stop working immediately and wait for a response.");
      }

      lines.push("");
      lines.push(`When resumed, check issue ${issue?.identifier || "(unknown)"} for the human's response.`);
      lines.push("Use the get_issue or list_comments tools to read their reply before continuing.");

      const text = lines.join("\n");
      return {
        content: [{ type: "text" as const, text }],
        details: {
          issueId: issue?.id || null,
          identifier: issue?.identifier || null,
          paused,
          urgency,
        },
      };
    },
  });
}
