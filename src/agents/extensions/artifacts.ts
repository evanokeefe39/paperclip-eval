import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

const ARTIFACTS_ROOT = "/artifacts";
const TEMPLATES_ROOT = "/app/templates";
const AGENT_NAME = process.env.AGENT_NAME || "";
const PAPERCLIP_AGENT_ID = process.env.PAPERCLIP_AGENT_ID || null;
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resolvePath(input: string): string {
  const resolved = input.startsWith("/")
    ? path.resolve(input)
    : path.resolve(ARTIFACTS_ROOT, input);
  if (!resolved.startsWith(ARTIFACTS_ROOT + "/") && resolved !== ARTIFACTS_ROOT) {
    throw new Error(`Path traversal rejected: resolved path "${resolved}" is outside ${ARTIFACTS_ROOT}`);
  }
  return resolved;
}

function deriveFormat(filename: string): string {
  const ext = path.extname(filename).replace(/^\./, "").toLowerCase();
  return ext || "txt";
}

interface SidecarParams {
  type: string;
  name: string;
  template?: string;
  issue_id?: string;
  run_id?: string;
  project_id?: string;
  goal_id?: string;
}

interface Sidecar {
  v: number;
  agent: string;
  agent_id: string | null;
  company_id: string | null;
  type: string;
  template: string | null;
  created: string;
  size_bytes: number;
  format: string;
  paperclip: {
    issue_id: string | null;
    run_id: string | null;
    project_id: string | null;
    goal_id: string | null;
  };
}

function buildSidecar(params: SidecarParams, content: string): Sidecar {
  return {
    v: 1,
    agent: AGENT_NAME,
    agent_id: PAPERCLIP_AGENT_ID,
    company_id: PAPERCLIP_COMPANY_ID,
    type: params.type,
    template: params.template || null,
    created: new Date().toISOString(),
    size_bytes: Buffer.byteLength(content, "utf8"),
    format: deriveFormat(params.name),
    paperclip: {
      issue_id: params.issue_id || null,
      run_id: params.run_id || null,
      project_id: params.project_id || null,
      goal_id: params.goal_id || null,
    },
  };
}

function walkDir(dir: string, collector: string[]): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, collector);
    } else if (!entry.name.endsWith(".meta.json")) {
      collector.push(full);
    }
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  if (!AGENT_NAME) return;

  // Workspace init
  const agentDir = path.join(ARTIFACTS_ROOT, AGENT_NAME);
  ensureDir(path.join(agentDir, "output"));
  ensureDir(path.join(agentDir, "current"));
  // TODO: log init event

  // ---- write_artifact ----
  pi.registerTool({
    name: "write_artifact",
    label: "Write Artifact",
    description:
      "Write a file to the shared artifact volume so other agents can read it. Returns the artifact path and metadata path.",
    promptSnippet:
      "When sharing work with other agents or referencing artifacts:\n" +
      "- Write output using the write_artifact tool. It returns a path.\n" +
      "- Pass that path in Paperclip issue comments or handoff messages. Never paste artifact content inline.\n" +
      "- To read another agent's work, call read_artifact with the path you received.\n" +
      "- To discover what artifacts exist, call list_artifacts.\n" +
      "- Large documents belong in artifacts, not in messages. A path like \"/artifacts/researcher/output/findings.md\" is the reference — the downstream agent reads it when needed.",
    parameters: Type.Object({
      name: Type.String({ description: "Filename including extension, e.g. findings.md" }),
      content: Type.String({ description: "File content to write" }),
      type: Type.String({ description: "Artifact type, e.g. report, dataset, code, brief" }),
      subdirectory: Type.Optional(Type.String({ description: "Subdirectory under agent folder (default: output)" })),
      template: Type.Optional(Type.String({ description: "Template name used to produce this artifact" })),
      issue_id: Type.Optional(Type.String({ description: "Paperclip issue ID this artifact relates to" })),
      run_id: Type.Optional(Type.String({ description: "Paperclip run ID" })),
      project_id: Type.Optional(Type.String({ description: "Paperclip project ID" })),
      goal_id: Type.Optional(Type.String({ description: "Paperclip goal ID" })),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        if (!params.name?.trim()) throw new Error("name is required and must be non-empty");
        if (!params.content) throw new Error("content is required and must be non-empty");
        if (!params.type?.trim()) throw new Error("type is required and must be non-empty");

        const subdir = params.subdirectory || "output";
        const filePath = path.resolve(path.join(ARTIFACTS_ROOT, AGENT_NAME, subdir, params.name));
        const agentRoot = path.join(ARTIFACTS_ROOT, AGENT_NAME);
        if (!filePath.startsWith(agentRoot + path.sep) && filePath !== agentRoot) {
          throw new Error(`Write rejected: path "${filePath}" escapes agent namespace "${agentRoot}"`);
        }
        const metaPath = filePath + ".meta.json";

        ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, params.content, "utf8");
        // TODO: log write event

        const sidecar = buildSidecar(params, params.content);
        fs.writeFileSync(metaPath, JSON.stringify(sidecar, null, 2), "utf8");

        const text = `Artifact written.\nPath: ${filePath}\nMetadata: ${metaPath}\nSize: ${sidecar.size_bytes} bytes`;
        return {
          content: [{ type: "text" as const, text }],
          details: { path: filePath, metadata_path: metaPath, size_bytes: sidecar.size_bytes },
        };
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
      "Read an artifact from the shared volume by path. Returns file content and metadata if available.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute or relative path to the artifact" }),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        const resolved = resolvePath(params.path);
        if (!fs.existsSync(resolved)) {
          return { content: [{ type: "text" as const, text: `Error: file not found at ${resolved}` }] };
        }

        const content = fs.readFileSync(resolved, "utf8");
        const metaPath = resolved + ".meta.json";
        let metadata: Sidecar | null = null;
        if (fs.existsSync(metaPath)) {
          try {
            metadata = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          } catch {
            // Malformed sidecar — treat as missing
            metadata = null;
          }
        }

        // TODO: log artifact_read event
        const lines: string[] = [content, "---", `Metadata: ${metadata ? JSON.stringify(metadata, null, 2) : "null"}`];
        const text = lines.join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: { path: resolved, has_metadata: metadata !== null },
        };
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
      "List artifacts on the shared volume with optional filters by agent, type, issue, subdirectory, or creation time.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Filter to a specific agent name" })),
      type: Type.Optional(Type.String({ description: "Filter by artifact type" })),
      issue_id: Type.Optional(Type.String({ description: "Filter by Paperclip issue ID" })),
      subdirectory: Type.Optional(Type.String({ description: "Filter to a specific subdirectory" })),
      since: Type.Optional(Type.String({ description: "ISO 8601 timestamp — only artifacts created after this" })),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        let scanRoot = ARTIFACTS_ROOT;
        if (params.agent) {
          scanRoot = path.join(ARTIFACTS_ROOT, params.agent);
          if (params.subdirectory) {
            scanRoot = path.join(scanRoot, params.subdirectory);
          }
        }

        const files: string[] = [];
        walkDir(scanRoot, files);

        interface ArtifactEntry {
          path: string;
          metadata: Sidecar | null;
        }

        const entries: ArtifactEntry[] = [];
        for (const filePath of files) {
          const metaPath = filePath + ".meta.json";
          let metadata: Sidecar | null = null;
          if (fs.existsSync(metaPath)) {
            try {
              metadata = JSON.parse(fs.readFileSync(metaPath, "utf8"));
            } catch {
              metadata = null;
            }
          }

          // Apply filters
          if (params.type && metadata?.type !== params.type) continue;
          if (params.issue_id && metadata?.paperclip?.issue_id !== params.issue_id) continue;
          if (params.since && metadata?.created) {
            if (metadata.created < params.since) continue;
          }

          entries.push({ path: filePath, metadata });
        }

        // Sort by created descending (entries without metadata sort last)
        entries.sort((a, b) => {
          const aTime = a.metadata?.created || "";
          const bTime = b.metadata?.created || "";
          return bTime.localeCompare(aTime);
        });

        if (entries.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No artifacts found matching filters." }],
            details: { count: 0 },
          };
        }

        // TODO: log artifact_list event
        const lines: string[] = [`Found ${entries.length} artifact(s):\n`];
        for (const entry of entries) {
          lines.push(`- ${entry.path}`);
          if (entry.metadata) {
            lines.push(`  agent: ${entry.metadata.agent} | type: ${entry.metadata.type} | created: ${entry.metadata.created} | size: ${entry.metadata.size_bytes}b`);
          } else {
            lines.push("  (no metadata)");
          }
        }

        const text = lines.join("\n");
        return {
          content: [{ type: "text" as const, text }],
          details: { count: entries.length },
        };
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

        // Template not found — list available options
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
