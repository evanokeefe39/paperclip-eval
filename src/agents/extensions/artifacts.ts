import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as client from "./lib/artifact-client.js";

const TEMPLATES_ROOT = "/root/.pi/agent/extensions/workproduct-lib/templates";

const MIME_MAP: Record<string, string> = {
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  txt: "text/plain",
};

function guessMime(filename: string): string {
  const ext = path.extname(filename).replace(/^\./, "").toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

function parseId(input: string): string {
  if (input.startsWith("artifact://")) {
    const lastSegment = input.split("/").pop() || "";
    const ulid = lastSegment.split("_")[0];
    return ulid;
  }
  return input;
}

export default function (pi: ExtensionAPI) {
  if (!client.getAgentName()) return;

  // ---- write_artifact ----
  pi.registerTool({
    name: "write_artifact",
    label: "Write Artifact",
    description:
      "Write a file to the artifact service so other agents can read it. Returns an artifact URI, ID, size, and hash.",
    promptSnippet:
      "When sharing work with other agents or referencing artifacts:\n" +
      "- Write output using write_artifact. It returns an artifact reference (URI).\n" +
      "- Pass that URI in Paperclip issue comments or handoff messages. Never paste artifact content inline.\n" +
      "- To read another agent's work, call read_artifact with the URI you received.\n" +
      "- To discover available artifacts, call list_artifacts with filters.\n" +
      "- URIs look like: artifact://default/default/run123/researcher/research/01JHX_findings.md\n" +
      "- The downstream agent resolves the URI when it needs the content.",
    parameters: Type.Object({
      name: Type.String({ description: "Filename including extension, e.g. findings.md" }),
      content: Type.String({ description: "File content to write" }),
      type: Type.String({ description: "Artifact type, e.g. report, dataset, code, brief" }),
      template: Type.Optional(Type.String({ description: "Template name used to produce this artifact" })),
      issue_id: Type.Optional(Type.String({ description: "Paperclip issue ID this artifact relates to" })),
      run_id: Type.Optional(Type.String({ description: "Paperclip run ID" })),
      project_id: Type.Optional(Type.String({ description: "Paperclip project ID" })),
      goal_id: Type.Optional(Type.String({ description: "Paperclip goal ID" })),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        const result = await client.write({
          filename: params.name,
          content: params.content,
          type: params.type,
          bucket: "artifacts",
          mime: guessMime(params.name),
          metadata: {
            ...(params.template ? { template: params.template } : {}),
            ...(params.issue_id ? { issue_id: params.issue_id } : {}),
            ...(params.goal_id ? { goal_id: params.goal_id } : {}),
          },
          run_id: params.run_id,
          project_id: params.project_id,
        });
        const text = `Artifact written.\nRef: ${result.ref}\nID: ${result.id}\nSize: ${result.size} bytes\nHash: ${result.hash}`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });

  // ---- read_artifact ----
  pi.registerTool({
    name: "read_artifact",
    label: "Read Artifact",
    description:
      "Read an artifact by ULID or artifact:// URI. Returns file content and metadata.",
    parameters: Type.Object({
      id: Type.String({ description: "Artifact ULID or artifact:// URI" }),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        const id = parseId(params.id);
        const result = await client.read(id);
        const content = result.content.toString("utf8");
        const text = content + "\n---\n" + JSON.stringify(result.metadata, null, 2);
        return { content: [{ type: "text" as const, text }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });

  // ---- list_artifacts ----
  pi.registerTool({
    name: "list_artifacts",
    label: "List Artifacts",
    description:
      "List artifacts from the artifact service with optional filters.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Filter by agent name" })),
      type: Type.Optional(Type.String({ description: "Filter by artifact type" })),
      since: Type.Optional(Type.String({ description: "ISO 8601 timestamp — only artifacts created after this" })),
      run_id: Type.Optional(Type.String({ description: "Filter by run ID" })),
      bucket: Type.Optional(Type.String({ description: "Filter by bucket" })),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        const records = await client.list({
          agent: params.agent,
          type: params.type,
          since: params.since,
          run_id: params.run_id,
          bucket: params.bucket,
        });

        if (records.length === 0) {
          return { content: [{ type: "text" as const, text: "No artifacts found matching filters." }] };
        }

        const lines: string[] = [`Found ${records.length} artifact(s):\n`];
        for (const r of records) {
          lines.push(`- ${r.id} | ${r.filename}`);
          lines.push(`  agent: ${r.agent_name} | type: ${r.artifact_type} | created: ${r.created_at} | size: ${r.size_bytes}b`);
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });

  // ---- get_template ----
  pi.registerTool({
    name: "get_template",
    label: "Get Template",
    description:
      "Retrieve an output or brief template from the templates directory. Returns the template content.",
    parameters: Type.Object({
      category: Type.Union([Type.Literal("brief"), Type.Literal("output")], {
        description: "Template category: brief or output",
      }),
      name: Type.String({ description: "Template name (without extension)" }),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        const categoryDir = params.category === "brief" ? "briefs" : "outputs";
        const baseDir = path.join(TEMPLATES_ROOT, categoryDir);
        const mdPath = path.join(baseDir, `${params.name}.md`);
        const jsonPath = path.join(baseDir, `${params.name}.json`);

        let templatePath: string | null = null;
        if (fs.existsSync(mdPath)) {
          templatePath = mdPath;
        } else if (fs.existsSync(jsonPath)) {
          templatePath = jsonPath;
        }

        if (templatePath) {
          const content = fs.readFileSync(templatePath, "utf8");
          return {
            content: [{ type: "text" as const, text: content }],
            details: { template_path: templatePath },
          };
        }

        const available: string[] = [];
        if (fs.existsSync(baseDir)) {
          const dirEntries = fs.readdirSync(baseDir);
          for (const entry of dirEntries) {
            available.push(entry);
          }
        }

        const optionsText = available.length > 0
          ? `Available in ${categoryDir}/: ${available.join(", ")}`
          : `No templates found in ${categoryDir}/ directory.`;

        return {
          content: [{ type: "text" as const, text: `Error: template "${params.name}" not found in ${categoryDir}/. ${optionsText}` }],
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });
}
