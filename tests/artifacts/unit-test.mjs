#!/usr/bin/env node
/**
 * Unit tests for the artifacts extension.
 * Re-implements helpers inline (can't import .ts without transpiler).
 * Uses real filesystem via temp directories for integration-level tests.
 *
 * Usage: node --test tests/artifacts/unit-test.mjs
 * Requires: Node 22+
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Temp directory setup — each test suite gets an isolated filesystem root
// ---------------------------------------------------------------------------

let tmpRoot;
let ARTIFACTS_ROOT;
let TEMPLATES_ROOT;

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "artifacts-test-"));
  ARTIFACTS_ROOT = path.join(tmpRoot, "artifacts");
  TEMPLATES_ROOT = path.join(tmpRoot, "templates");
  fs.mkdirSync(ARTIFACTS_ROOT, { recursive: true });
  fs.mkdirSync(TEMPLATES_ROOT, { recursive: true });
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Inline re-implementation of extension helpers (mirrors artifacts.ts)
// ---------------------------------------------------------------------------

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resolvePath(input, artifactsRoot) {
  const resolved = input.startsWith("/")
    ? path.resolve(input)
    : path.resolve(artifactsRoot, input);
  const normalized = path.normalize(resolved);
  if (!normalized.startsWith(artifactsRoot + path.sep) && normalized !== artifactsRoot) {
    throw new Error(`Path traversal rejected: resolved path "${normalized}" is outside ${artifactsRoot}`);
  }
  return normalized;
}

function deriveFormat(filename) {
  const ext = path.extname(filename).replace(/^\./, "").toLowerCase();
  return ext || "txt";
}

function buildSidecar(params, content, agentName, agentId, companyId) {
  return {
    v: 1,
    agent: agentName,
    agent_id: agentId,
    company_id: companyId,
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

function walkDir(dir, collector) {
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
// Mock Pi extension API — captures registered tools for execute() testing
// ---------------------------------------------------------------------------

function createMockPi() {
  const tools = {};
  return {
    registerTool(toolDef) {
      tools[toolDef.name] = toolDef;
    },
    tools,
  };
}

// ---------------------------------------------------------------------------
// Full extension logic re-implementation for execute() testing
// ---------------------------------------------------------------------------

function loadArtifactsExtension(mockPi, opts = {}) {
  const agentName = opts.agentName || "";
  const agentId = opts.agentId || null;
  const companyId = opts.companyId || null;
  const artifactsRoot = opts.artifactsRoot || ARTIFACTS_ROOT;
  const templatesRoot = opts.templatesRoot || TEMPLATES_ROOT;

  if (!agentName) return;

  const agentDir = path.join(artifactsRoot, agentName);
  ensureDir(path.join(agentDir, "output"));
  ensureDir(path.join(agentDir, "current"));

  const PROMPT_SNIPPET =
    "When sharing work with other agents or referencing artifacts:\n" +
    "- Write output using the write_artifact tool. It returns a path.\n" +
    "- Pass that path in Paperclip issue comments or handoff messages. Never paste artifact content inline.\n" +
    "- To read another agent's work, call read_artifact with the path you received.\n" +
    "- To discover what artifacts exist, call list_artifacts.\n" +
    '- Large documents belong in artifacts, not in messages. A path like "/artifacts/researcher/output/findings.md" is the reference — the downstream agent reads it when needed.';

  mockPi.registerTool({
    name: "write_artifact",
    label: "Write Artifact",
    description: "Write a file to the shared artifact volume so other agents can read it.",
    promptSnippet: PROMPT_SNIPPET,
    parameters: {},
    async execute(_toolCallId, params, _signal) {
      try {
        if (!params.name?.trim()) throw new Error("name is required and must be non-empty");
        if (!params.content) throw new Error("content is required and must be non-empty");
        if (!params.type?.trim()) throw new Error("type is required and must be non-empty");

        const subdir = params.subdirectory || "output";
        const filePath = path.resolve(path.join(artifactsRoot, agentName, subdir, params.name));
        const agentRoot = path.join(artifactsRoot, agentName);
        if (!filePath.startsWith(agentRoot + path.sep) && filePath !== agentRoot) {
          throw new Error(`Write rejected: path "${filePath}" escapes agent namespace "${agentRoot}"`);
        }
        const metaPath = filePath + ".meta.json";

        ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, params.content, "utf8");

        const sidecar = buildSidecar(params, params.content, agentName, agentId, companyId);
        fs.writeFileSync(metaPath, JSON.stringify(sidecar, null, 2), "utf8");

        const text = `Artifact written.\nPath: ${filePath}\nMetadata: ${metaPath}\nSize: ${sidecar.size_bytes} bytes`;
        return {
          content: [{ type: "text", text }],
          details: { path: filePath, metadata_path: metaPath, size_bytes: sidecar.size_bytes },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }] };
      }
    },
  });

  mockPi.registerTool({
    name: "read_artifact",
    label: "Read Artifact",
    description: "Read an artifact from the shared volume by path.",
    parameters: {},
    async execute(_toolCallId, params, _signal) {
      try {
        const resolved = resolvePath(params.path, artifactsRoot);
        if (!fs.existsSync(resolved)) {
          return { content: [{ type: "text", text: `Error: file not found at ${resolved}` }] };
        }

        const content = fs.readFileSync(resolved, "utf8");
        const metaPath = resolved + ".meta.json";
        let metadata = null;
        if (fs.existsSync(metaPath)) {
          try {
            metadata = JSON.parse(fs.readFileSync(metaPath, "utf8"));
          } catch {
            metadata = null;
          }
        }

        const lines = [content, "---", `Metadata: ${metadata ? JSON.stringify(metadata, null, 2) : "null"}`];
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { path: resolved, has_metadata: metadata !== null },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }] };
      }
    },
  });

  mockPi.registerTool({
    name: "list_artifacts",
    label: "List Artifacts",
    description: "List artifacts on the shared volume with optional filters.",
    parameters: {},
    async execute(_toolCallId, params, _signal) {
      try {
        let scanRoot = artifactsRoot;
        if (params.agent) {
          scanRoot = path.join(artifactsRoot, params.agent);
          if (params.subdirectory) {
            scanRoot = path.join(scanRoot, params.subdirectory);
          }
        }

        const files = [];
        walkDir(scanRoot, files);

        const entries = [];
        for (const filePath of files) {
          const metaPath = filePath + ".meta.json";
          let metadata = null;
          if (fs.existsSync(metaPath)) {
            try {
              metadata = JSON.parse(fs.readFileSync(metaPath, "utf8"));
            } catch {
              metadata = null;
            }
          }

          if (params.type && metadata?.type !== params.type) continue;
          if (params.issue_id && metadata?.paperclip?.issue_id !== params.issue_id) continue;
          if (params.since && metadata?.created) {
            if (metadata.created < params.since) continue;
          }

          entries.push({ path: filePath, metadata });
        }

        entries.sort((a, b) => {
          const aTime = a.metadata?.created || "";
          const bTime = b.metadata?.created || "";
          return bTime.localeCompare(aTime);
        });

        if (entries.length === 0) {
          return {
            content: [{ type: "text", text: "No artifacts found matching filters." }],
            details: { count: 0 },
          };
        }

        const lines = [`Found ${entries.length} artifact(s):\n`];
        for (const entry of entries) {
          lines.push(`- ${entry.path}`);
          if (entry.metadata) {
            lines.push(`  agent: ${entry.metadata.agent} | type: ${entry.metadata.type} | created: ${entry.metadata.created} | size: ${entry.metadata.size_bytes}b`);
          } else {
            lines.push("  (no metadata)");
          }
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { count: entries.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }] };
      }
    },
  });

  mockPi.registerTool({
    name: "get_template",
    label: "Get Template",
    description: "Retrieve an output or brief template.",
    parameters: {},
    async execute(_toolCallId, params, _signal) {
      try {
        const categoryDir = params.category === "brief" ? "briefs" : "outputs";
        const baseDir = path.join(templatesRoot, categoryDir);
        const mdPath = path.join(baseDir, `${params.name}.md`);
        const jsonPath = path.join(baseDir, `${params.name}.json`);

        let templatePath = null;
        if (fs.existsSync(mdPath)) {
          templatePath = mdPath;
        } else if (fs.existsSync(jsonPath)) {
          templatePath = jsonPath;
        }

        if (templatePath) {
          const content = fs.readFileSync(templatePath, "utf8");
          return {
            content: [{ type: "text", text: content }],
            details: { template_path: templatePath },
          };
        }

        const available = [];
        if (fs.existsSync(baseDir)) {
          for (const entry of fs.readdirSync(baseDir)) {
            available.push(entry);
          }
        }

        const optionsText = available.length > 0
          ? `Available in ${categoryDir}/: ${available.join(", ")}`
          : `No templates found in ${categoryDir}/ directory.`;

        return {
          content: [{ type: "text", text: `Error: template "${params.name}" not found in ${categoryDir}/. ${optionsText}` }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Error: ${msg}` }] };
      }
    },
  });
}

// ===========================================================================
// TESTS
// ===========================================================================

// ---------------------------------------------------------------------------
// Helper: deriveFormat
// ---------------------------------------------------------------------------

describe("deriveFormat", () => {
  test("extracts md from .md file", () => {
    assert.equal(deriveFormat("findings.md"), "md");
  });

  test("extracts json from .json file", () => {
    assert.equal(deriveFormat("receipt.json"), "json");
  });

  test("extracts csv from .csv file", () => {
    assert.equal(deriveFormat("data.csv"), "csv");
  });

  test("handles uppercase extensions", () => {
    assert.equal(deriveFormat("README.MD"), "md");
  });

  test("defaults to txt for no extension", () => {
    assert.equal(deriveFormat("Makefile"), "txt");
  });

  test("handles dotfiles as txt (no extension)", () => {
    // path.extname(".gitignore") returns "" — leading dot is not an extension
    assert.equal(deriveFormat(".gitignore"), "txt");
  });

  test("handles double extensions (uses last)", () => {
    assert.equal(deriveFormat("archive.tar.gz"), "gz");
  });
});

// ---------------------------------------------------------------------------
// Helper: resolvePath
// ---------------------------------------------------------------------------

describe("resolvePath", () => {
  test("absolute path under artifacts root passes", () => {
    const result = resolvePath(
      path.join(ARTIFACTS_ROOT, "researcher", "output", "f.md"),
      ARTIFACTS_ROOT
    );
    assert.ok(result.startsWith(ARTIFACTS_ROOT));
  });

  test("relative path gets prepended with root", () => {
    const result = resolvePath("researcher/output/f.md", ARTIFACTS_ROOT);
    assert.equal(result, path.join(ARTIFACTS_ROOT, "researcher", "output", "f.md"));
  });

  test("path traversal with ../ rejected", () => {
    assert.throws(
      () => resolvePath("../../etc/passwd", ARTIFACTS_ROOT),
      /Path traversal rejected/
    );
  });

  test("path traversal with absolute escape rejected", () => {
    assert.throws(
      () => resolvePath("/etc/passwd", ARTIFACTS_ROOT),
      /Path traversal rejected/
    );
  });

  test("path traversal via embedded ../ rejected", () => {
    assert.throws(
      () => resolvePath("researcher/../../../etc/shadow", ARTIFACTS_ROOT),
      /Path traversal rejected/
    );
  });

  test("path with .. that stays under root is allowed", () => {
    const result = resolvePath("researcher/../ceo/output/f.md", ARTIFACTS_ROOT);
    assert.ok(result.startsWith(ARTIFACTS_ROOT));
    assert.ok(result.includes("ceo"));
  });
});

// ---------------------------------------------------------------------------
// Helper: buildSidecar
// ---------------------------------------------------------------------------

describe("buildSidecar", () => {
  test("produces v1 schema with all fields", () => {
    const params = {
      name: "analysis.md",
      type: "research",
      template: "research-output",
      issue_id: "iss-1",
      run_id: "run-1",
      project_id: "proj-1",
      goal_id: "goal-1",
    };
    const sidecar = buildSidecar(params, "hello world", "researcher", "agent-uuid", "company-uuid");

    assert.equal(sidecar.v, 1);
    assert.equal(sidecar.agent, "researcher");
    assert.equal(sidecar.agent_id, "agent-uuid");
    assert.equal(sidecar.company_id, "company-uuid");
    assert.equal(sidecar.type, "research");
    assert.equal(sidecar.template, "research-output");
    assert.equal(sidecar.format, "md");
    assert.equal(sidecar.size_bytes, Buffer.byteLength("hello world", "utf8"));
    assert.equal(sidecar.paperclip.issue_id, "iss-1");
    assert.equal(sidecar.paperclip.run_id, "run-1");
    assert.equal(sidecar.paperclip.project_id, "proj-1");
    assert.equal(sidecar.paperclip.goal_id, "goal-1");
    assert.ok(sidecar.created.match(/^\d{4}-\d{2}-\d{2}T/));
  });

  test("optional fields default to null", () => {
    const params = { name: "data.csv", type: "dataset" };
    const sidecar = buildSidecar(params, "a,b,c", "ceo", null, null);

    assert.equal(sidecar.agent_id, null);
    assert.equal(sidecar.company_id, null);
    assert.equal(sidecar.template, null);
    assert.equal(sidecar.paperclip.issue_id, null);
    assert.equal(sidecar.paperclip.run_id, null);
    assert.equal(sidecar.paperclip.project_id, null);
    assert.equal(sidecar.paperclip.goal_id, null);
  });

  test("size_bytes reflects UTF-8 byte count, not char count", () => {
    const content = "\u{1F600}"; // emoji, 4 bytes in UTF-8
    const sidecar = buildSidecar({ name: "emoji.txt", type: "content" }, content, "writer", null, null);
    assert.equal(sidecar.size_bytes, 4);
    assert.equal(content.length, 2); // JS string length differs
  });

  test("format derived from filename extension", () => {
    const sidecar = buildSidecar({ name: "output.json", type: "dataset" }, "{}", "data", null, null);
    assert.equal(sidecar.format, "json");
  });
});

// ---------------------------------------------------------------------------
// Helper: walkDir
// ---------------------------------------------------------------------------

describe("walkDir", () => {
  let walkRoot;

  before(() => {
    walkRoot = path.join(tmpRoot, "walk-test");
    fs.mkdirSync(path.join(walkRoot, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(walkRoot, "file1.md"), "content");
    fs.writeFileSync(path.join(walkRoot, "file1.md.meta.json"), "{}");
    fs.writeFileSync(path.join(walkRoot, "a", "file2.txt"), "content");
    fs.writeFileSync(path.join(walkRoot, "a", "file2.txt.meta.json"), "{}");
    fs.writeFileSync(path.join(walkRoot, "a", "b", "file3.json"), "{}");
  });

  test("collects files recursively", () => {
    const files = [];
    walkDir(walkRoot, files);
    assert.equal(files.length, 3);
  });

  test("excludes .meta.json sidecar files", () => {
    const files = [];
    walkDir(walkRoot, files);
    const metaFiles = files.filter((f) => f.endsWith(".meta.json"));
    assert.equal(metaFiles.length, 0);
  });

  test("handles non-existent directory gracefully", () => {
    const files = [];
    walkDir(path.join(tmpRoot, "does-not-exist"), files);
    assert.equal(files.length, 0);
  });

  test("handles empty directory", () => {
    const emptyDir = path.join(tmpRoot, "empty-walk");
    fs.mkdirSync(emptyDir, { recursive: true });
    const files = [];
    walkDir(emptyDir, files);
    assert.equal(files.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Environment gating
// ---------------------------------------------------------------------------

describe("environment gating", () => {
  test("no AGENT_NAME registers zero tools", () => {
    const mockPi = createMockPi();
    loadArtifactsExtension(mockPi, { agentName: "", artifactsRoot: ARTIFACTS_ROOT });
    assert.equal(Object.keys(mockPi.tools).length, 0);
  });

  test("AGENT_NAME present registers all four tools", () => {
    const mockPi = createMockPi();
    loadArtifactsExtension(mockPi, { agentName: "test-gating", artifactsRoot: ARTIFACTS_ROOT });
    const names = Object.keys(mockPi.tools).sort();
    assert.deepEqual(names, ["get_template", "list_artifacts", "read_artifact", "write_artifact"]);
  });
});

// ---------------------------------------------------------------------------
// Workspace init
// ---------------------------------------------------------------------------

describe("workspace init", () => {
  test("creates output/ and current/ directories for agent", () => {
    const mockPi = createMockPi();
    loadArtifactsExtension(mockPi, { agentName: "init-test", artifactsRoot: ARTIFACTS_ROOT });

    assert.ok(fs.existsSync(path.join(ARTIFACTS_ROOT, "init-test", "output")));
    assert.ok(fs.existsSync(path.join(ARTIFACTS_ROOT, "init-test", "current")));
  });

  test("idempotent — re-init does not error", () => {
    const mockPi = createMockPi();
    loadArtifactsExtension(mockPi, { agentName: "init-test", artifactsRoot: ARTIFACTS_ROOT });
    loadArtifactsExtension(mockPi, { agentName: "init-test", artifactsRoot: ARTIFACTS_ROOT });

    assert.ok(fs.existsSync(path.join(ARTIFACTS_ROOT, "init-test", "output")));
  });
});

// ---------------------------------------------------------------------------
// promptSnippet
// ---------------------------------------------------------------------------

describe("promptSnippet", () => {
  test("write_artifact carries the pass-by-reference snippet", () => {
    const mockPi = createMockPi();
    loadArtifactsExtension(mockPi, { agentName: "snippet-test", artifactsRoot: ARTIFACTS_ROOT });

    const snippet = mockPi.tools.write_artifact.promptSnippet;
    assert.ok(snippet.includes("write_artifact"));
    assert.ok(snippet.includes("read_artifact"));
    assert.ok(snippet.includes("Never paste artifact content inline"));
    assert.ok(snippet.includes("/artifacts/researcher/output/findings.md"));
  });
});

// ---------------------------------------------------------------------------
// write_artifact tool
// ---------------------------------------------------------------------------

describe("write_artifact", () => {
  let mockPi;
  const AGENT = "writer-test";

  before(() => {
    mockPi = createMockPi();
    loadArtifactsExtension(mockPi, {
      agentName: AGENT,
      agentId: "agent-uuid-1",
      companyId: "company-uuid-1",
      artifactsRoot: ARTIFACTS_ROOT,
    });
  });

  test("writes file and sidecar to correct location", async () => {
    const result = await mockPi.tools.write_artifact.execute("tc1", {
      name: "report.md",
      content: "# Report\n\nFindings here.",
      type: "research",
    }, null);

    const text = result.content[0].text;
    assert.ok(text.includes("Artifact written"));
    assert.ok(result.details.path.includes(path.join(AGENT, "output", "report.md")));

    const filePath = result.details.path;
    assert.ok(fs.existsSync(filePath));
    assert.equal(fs.readFileSync(filePath, "utf8"), "# Report\n\nFindings here.");

    const metaPath = result.details.metadata_path;
    assert.ok(fs.existsSync(metaPath));
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    assert.equal(meta.v, 1);
    assert.equal(meta.agent, AGENT);
    assert.equal(meta.type, "research");
    assert.equal(meta.format, "md");
  });

  test("defaults to output/ subdirectory", async () => {
    const result = await mockPi.tools.write_artifact.execute("tc2", {
      name: "default-sub.txt",
      content: "content",
      type: "content",
    }, null);

    assert.ok(result.details.path.includes(path.join(AGENT, "output", "default-sub.txt")));
  });

  test("respects custom subdirectory", async () => {
    const result = await mockPi.tools.write_artifact.execute("tc3", {
      name: "wip.md",
      content: "draft",
      type: "content",
      subdirectory: "current",
    }, null);

    assert.ok(result.details.path.includes(path.join(AGENT, "current", "wip.md")));
    assert.ok(fs.existsSync(result.details.path));
  });

  test("creates nested subdirectories", async () => {
    const result = await mockPi.tools.write_artifact.execute("tc4", {
      name: "deep.md",
      content: "deep content",
      type: "analysis",
      subdirectory: "output/reports/2026",
    }, null);

    assert.ok(fs.existsSync(result.details.path));
  });

  test("sidecar includes Paperclip context when provided", async () => {
    const result = await mockPi.tools.write_artifact.execute("tc5", {
      name: "ctx.md",
      content: "with context",
      type: "research",
      template: "research-output",
      issue_id: "iss-42",
      run_id: "run-99",
      project_id: "proj-7",
      goal_id: "goal-3",
    }, null);

    const meta = JSON.parse(fs.readFileSync(result.details.metadata_path, "utf8"));
    assert.equal(meta.template, "research-output");
    assert.equal(meta.agent_id, "agent-uuid-1");
    assert.equal(meta.company_id, "company-uuid-1");
    assert.equal(meta.paperclip.issue_id, "iss-42");
    assert.equal(meta.paperclip.run_id, "run-99");
    assert.equal(meta.paperclip.project_id, "proj-7");
    assert.equal(meta.paperclip.goal_id, "goal-3");
  });

  test("sidecar nulls missing Paperclip context", async () => {
    const result = await mockPi.tools.write_artifact.execute("tc6", {
      name: "minimal.md",
      content: "bare minimum",
      type: "brief",
    }, null);

    const meta = JSON.parse(fs.readFileSync(result.details.metadata_path, "utf8"));
    assert.equal(meta.template, null);
    assert.equal(meta.paperclip.issue_id, null);
    assert.equal(meta.paperclip.run_id, null);
  });

  test("rejects empty name", async () => {
    const result = await mockPi.tools.write_artifact.execute("tc7", {
      name: "",
      content: "stuff",
      type: "research",
    }, null);

    assert.ok(result.content[0].text.includes("Error:"));
    assert.ok(result.content[0].text.includes("name"));
  });

  test("rejects whitespace-only name", async () => {
    const result = await mockPi.tools.write_artifact.execute("tc8", {
      name: "   ",
      content: "stuff",
      type: "research",
    }, null);

    assert.ok(result.content[0].text.includes("Error:"));
  });

  test("rejects empty content", async () => {
    const result = await mockPi.tools.write_artifact.execute("tc9", {
      name: "valid.md",
      content: "",
      type: "research",
    }, null);

    assert.ok(result.content[0].text.includes("Error:"));
    assert.ok(result.content[0].text.includes("content"));
  });

  test("rejects empty type", async () => {
    const result = await mockPi.tools.write_artifact.execute("tc10", {
      name: "valid.md",
      content: "valid",
      type: "",
    }, null);

    assert.ok(result.content[0].text.includes("Error:"));
    assert.ok(result.content[0].text.includes("type"));
  });

  test("overwrites existing artifact (last writer wins)", async () => {
    await mockPi.tools.write_artifact.execute("tc11a", {
      name: "overwrite.md",
      content: "version 1",
      type: "content",
    }, null);

    const result = await mockPi.tools.write_artifact.execute("tc11b", {
      name: "overwrite.md",
      content: "version 2",
      type: "content",
    }, null);

    assert.equal(fs.readFileSync(result.details.path, "utf8"), "version 2");
  });

  test("size_bytes is correct for multi-byte content", async () => {
    const content = "Hello \u{1F600} World";
    const result = await mockPi.tools.write_artifact.execute("tc12", {
      name: "emoji.md",
      content,
      type: "content",
    }, null);

    const meta = JSON.parse(fs.readFileSync(result.details.metadata_path, "utf8"));
    assert.equal(meta.size_bytes, Buffer.byteLength(content, "utf8"));
  });
});

// ---------------------------------------------------------------------------
// read_artifact tool
// ---------------------------------------------------------------------------

describe("read_artifact", () => {
  let mockPi;
  const AGENT = "reader-test";

  before(async () => {
    mockPi = createMockPi();
    loadArtifactsExtension(mockPi, {
      agentName: AGENT,
      agentId: "agent-r",
      companyId: "comp-r",
      artifactsRoot: ARTIFACTS_ROOT,
    });

    // Seed an artifact
    await mockPi.tools.write_artifact.execute("seed", {
      name: "seeded.md",
      content: "Seeded content here.",
      type: "research",
      issue_id: "iss-seed",
    }, null);
  });

  test("reads artifact by absolute path", async () => {
    const absPath = path.join(ARTIFACTS_ROOT, AGENT, "output", "seeded.md");
    const result = await mockPi.tools.read_artifact.execute("r1", { path: absPath }, null);

    assert.ok(result.content[0].text.includes("Seeded content here."));
    assert.ok(result.details.has_metadata);
  });

  test("reads artifact by relative path", async () => {
    const relPath = path.join(AGENT, "output", "seeded.md");
    const result = await mockPi.tools.read_artifact.execute("r2", { path: relPath }, null);

    assert.ok(result.content[0].text.includes("Seeded content here."));
  });

  test("returns content and metadata separated by ---", async () => {
    const relPath = path.join(AGENT, "output", "seeded.md");
    const result = await mockPi.tools.read_artifact.execute("r3", { path: relPath }, null);

    const text = result.content[0].text;
    assert.ok(text.includes("---"));
    assert.ok(text.includes('"v": 1'));
    assert.ok(text.includes('"agent": "reader-test"'));
  });

  test("file not found returns error with path", async () => {
    const result = await mockPi.tools.read_artifact.execute("r4", {
      path: path.join(AGENT, "output", "nonexistent.md"),
    }, null);

    assert.ok(result.content[0].text.includes("Error:"));
    assert.ok(result.content[0].text.includes("file not found"));
  });

  test("missing sidecar returns content with metadata null", async () => {
    // Write a file without sidecar
    const noMetaPath = path.join(ARTIFACTS_ROOT, AGENT, "output", "no-sidecar.txt");
    fs.writeFileSync(noMetaPath, "orphan content");

    const result = await mockPi.tools.read_artifact.execute("r5", {
      path: path.join(AGENT, "output", "no-sidecar.txt"),
    }, null);

    assert.ok(result.content[0].text.includes("orphan content"));
    assert.ok(result.content[0].text.includes("Metadata: null"));
    assert.equal(result.details.has_metadata, false);
  });

  test("malformed sidecar treated as missing", async () => {
    const brokenMetaFile = path.join(ARTIFACTS_ROOT, AGENT, "output", "broken.txt");
    fs.writeFileSync(brokenMetaFile, "content");
    fs.writeFileSync(brokenMetaFile + ".meta.json", "NOT VALID JSON {{{}");

    const result = await mockPi.tools.read_artifact.execute("r6", {
      path: path.join(AGENT, "output", "broken.txt"),
    }, null);

    assert.ok(result.content[0].text.includes("content"));
    assert.ok(result.content[0].text.includes("Metadata: null"));
  });

  test("cross-agent read works (agent B reads agent A's artifact)", async () => {
    // Agent A writes
    const piA = createMockPi();
    loadArtifactsExtension(piA, { agentName: "agent-a", artifactsRoot: ARTIFACTS_ROOT });
    await piA.tools.write_artifact.execute("xa", {
      name: "shared.md",
      content: "From agent A",
      type: "analysis",
    }, null);

    // Agent B reads A's artifact
    const result = await mockPi.tools.read_artifact.execute("xb", {
      path: path.join("agent-a", "output", "shared.md"),
    }, null);

    assert.ok(result.content[0].text.includes("From agent A"));
    assert.ok(result.details.has_metadata);
  });
});

// ---------------------------------------------------------------------------
// Path traversal security
// ---------------------------------------------------------------------------

describe("path traversal security", () => {
  let mockPi;

  before(() => {
    mockPi = createMockPi();
    loadArtifactsExtension(mockPi, {
      agentName: "sec-test",
      artifactsRoot: ARTIFACTS_ROOT,
    });
  });

  test("read_artifact rejects ../../etc/passwd", async () => {
    const result = await mockPi.tools.read_artifact.execute("sec1", {
      path: "../../etc/passwd",
    }, null);

    assert.ok(result.content[0].text.includes("Error:"));
    assert.ok(result.content[0].text.includes("traversal"));
  });

  test("read_artifact rejects absolute escape", async () => {
    const result = await mockPi.tools.read_artifact.execute("sec2", {
      path: "/etc/shadow",
    }, null);

    assert.ok(result.content[0].text.includes("Error:"));
  });

  test("read_artifact rejects ../ embedded in valid-looking path", async () => {
    const result = await mockPi.tools.read_artifact.execute("sec3", {
      path: "researcher/output/../../../etc/hosts",
    }, null);

    assert.ok(result.content[0].text.includes("Error:"));
  });

  test("write_artifact rejects subdirectory that escapes agent namespace", async () => {
    const result = await mockPi.tools.write_artifact.execute("sec4", {
      name: "evil.txt",
      content: "pwned",
      type: "code",
      subdirectory: "../../other-agent/output",
    }, null);

    assert.ok(result.content[0].text.includes("Error:"));
    assert.ok(result.content[0].text.includes("escapes agent namespace"));
  });
});

// ---------------------------------------------------------------------------
// list_artifacts tool
// ---------------------------------------------------------------------------

describe("list_artifacts", () => {
  let mockPi;

  before(async () => {
    mockPi = createMockPi();
    loadArtifactsExtension(mockPi, {
      agentName: "lister",
      artifactsRoot: ARTIFACTS_ROOT,
    });

    // Seed several artifacts with different types and timestamps
    await mockPi.tools.write_artifact.execute("l1", {
      name: "research-1.md",
      content: "Research content",
      type: "research",
      issue_id: "iss-10",
    }, null);

    // Small delay for distinct timestamps
    await new Promise((r) => setTimeout(r, 50));

    await mockPi.tools.write_artifact.execute("l2", {
      name: "analysis-1.md",
      content: "Analysis content",
      type: "analysis",
      issue_id: "iss-10",
    }, null);

    await new Promise((r) => setTimeout(r, 50));

    await mockPi.tools.write_artifact.execute("l3", {
      name: "dataset-1.csv",
      content: "a,b,c\n1,2,3",
      type: "dataset",
      issue_id: "iss-20",
    }, null);
  });

  test("lists all artifacts for an agent", async () => {
    const result = await mockPi.tools.list_artifacts.execute("ll1", {
      agent: "lister",
    }, null);

    assert.ok(result.details.count >= 3);
    assert.ok(result.content[0].text.includes("research-1.md"));
    assert.ok(result.content[0].text.includes("analysis-1.md"));
    assert.ok(result.content[0].text.includes("dataset-1.csv"));
  });

  test("filters by type", async () => {
    const result = await mockPi.tools.list_artifacts.execute("ll2", {
      agent: "lister",
      type: "research",
    }, null);

    assert.ok(result.content[0].text.includes("research-1.md"));
    assert.ok(!result.content[0].text.includes("dataset-1.csv"));
  });

  test("filters by issue_id", async () => {
    const result = await mockPi.tools.list_artifacts.execute("ll3", {
      agent: "lister",
      issue_id: "iss-20",
    }, null);

    assert.ok(result.content[0].text.includes("dataset-1.csv"));
    assert.ok(!result.content[0].text.includes("research-1.md"));
  });

  test("filters by subdirectory", async () => {
    const result = await mockPi.tools.list_artifacts.execute("ll4", {
      agent: "lister",
      subdirectory: "output",
    }, null);

    assert.ok(result.details.count >= 3);
  });

  test("returns empty result for non-matching filters", async () => {
    const result = await mockPi.tools.list_artifacts.execute("ll5", {
      agent: "lister",
      type: "verdict",
    }, null);

    assert.equal(result.details.count, 0);
    assert.ok(result.content[0].text.includes("No artifacts found"));
  });

  test("returns empty for non-existent agent", async () => {
    const result = await mockPi.tools.list_artifacts.execute("ll6", {
      agent: "ghost-agent",
    }, null);

    assert.equal(result.details.count, 0);
  });

  test("lists all agents when no agent filter", async () => {
    // Write an artifact as a different agent
    const otherPi = createMockPi();
    loadArtifactsExtension(otherPi, { agentName: "other-lister", artifactsRoot: ARTIFACTS_ROOT });
    await otherPi.tools.write_artifact.execute("ol1", {
      name: "other.md",
      content: "from other",
      type: "content",
    }, null);

    const result = await mockPi.tools.list_artifacts.execute("ll7", {}, null);
    const text = result.content[0].text;

    // Should include artifacts from multiple agents
    assert.ok(result.details.count > 3);
  });

  test("results sorted newest first", async () => {
    const result = await mockPi.tools.list_artifacts.execute("ll8", {
      agent: "lister",
    }, null);

    const text = result.content[0].text;
    const lines = text.split("\n").filter((l) => l.startsWith("- "));

    // dataset-1 was written last, should appear first
    assert.ok(lines[0].includes("dataset-1.csv"));
  });

  test("since filter excludes old artifacts", async () => {
    const futureDate = new Date(Date.now() + 60000).toISOString();
    const result = await mockPi.tools.list_artifacts.execute("ll9", {
      agent: "lister",
      since: futureDate,
    }, null);

    assert.equal(result.details.count, 0);
  });
});

// ---------------------------------------------------------------------------
// get_template tool
// ---------------------------------------------------------------------------

describe("get_template", () => {
  let mockPi;

  before(() => {
    mockPi = createMockPi();

    // Create template directories and files
    fs.mkdirSync(path.join(TEMPLATES_ROOT, "briefs"), { recursive: true });
    fs.mkdirSync(path.join(TEMPLATES_ROOT, "outputs"), { recursive: true });

    fs.writeFileSync(
      path.join(TEMPLATES_ROOT, "briefs", "research-brief.md"),
      "# Research Brief\n\n## Objective\n[fill in]\n\n## Scope\n[fill in]"
    );
    fs.writeFileSync(
      path.join(TEMPLATES_ROOT, "outputs", "qa-verdict.md"),
      "# QA Verdict\n\n## Pass/Fail\n[verdict]\n\n## Issues Found\n[list]"
    );
    fs.writeFileSync(
      path.join(TEMPLATES_ROOT, "outputs", "publish-receipt.json"),
      '{"published": false, "url": null, "timestamp": null}'
    );

    loadArtifactsExtension(mockPi, {
      agentName: "template-test",
      artifactsRoot: ARTIFACTS_ROOT,
      templatesRoot: TEMPLATES_ROOT,
    });
  });

  test("reads brief template by name", async () => {
    const result = await mockPi.tools.get_template.execute("t1", {
      category: "brief",
      name: "research-brief",
    }, null);

    assert.ok(result.content[0].text.includes("# Research Brief"));
    assert.ok(result.content[0].text.includes("## Objective"));
  });

  test("reads output template by name", async () => {
    const result = await mockPi.tools.get_template.execute("t2", {
      category: "output",
      name: "qa-verdict",
    }, null);

    assert.ok(result.content[0].text.includes("# QA Verdict"));
  });

  test("falls back to .json when .md not found", async () => {
    const result = await mockPi.tools.get_template.execute("t3", {
      category: "output",
      name: "publish-receipt",
    }, null);

    assert.ok(result.content[0].text.includes('"published"'));
  });

  test("not-found lists available templates", async () => {
    const result = await mockPi.tools.get_template.execute("t4", {
      category: "brief",
      name: "nonexistent",
    }, null);

    const text = result.content[0].text;
    assert.ok(text.includes("Error:"));
    assert.ok(text.includes("not found"));
    assert.ok(text.includes("research-brief.md"));
  });

  test("not-found in empty category shows no templates message", async () => {
    const emptyTemplatesRoot = path.join(tmpRoot, "empty-templates");
    fs.mkdirSync(emptyTemplatesRoot, { recursive: true });

    const emptyPi = createMockPi();
    loadArtifactsExtension(emptyPi, {
      agentName: "empty-tmpl",
      artifactsRoot: ARTIFACTS_ROOT,
      templatesRoot: emptyTemplatesRoot,
    });

    const result = await emptyPi.tools.get_template.execute("t5", {
      category: "brief",
      name: "anything",
    }, null);

    assert.ok(result.content[0].text.includes("No templates found"));
  });

  test("singular category maps to plural directory", async () => {
    // "brief" → "briefs/", "output" → "outputs/"
    const result = await mockPi.tools.get_template.execute("t6", {
      category: "brief",
      name: "research-brief",
    }, null);

    assert.ok(result.details.template_path.includes("briefs"));
  });
});

// ---------------------------------------------------------------------------
// End-to-end: cross-agent pass-by-reference workflow
// ---------------------------------------------------------------------------

describe("cross-agent pass-by-reference flow", () => {
  test("agent A writes, agent B reads by returned path", async () => {
    const piA = createMockPi();
    loadArtifactsExtension(piA, { agentName: "ceo", artifactsRoot: ARTIFACTS_ROOT });

    const piB = createMockPi();
    loadArtifactsExtension(piB, { agentName: "researcher", artifactsRoot: ARTIFACTS_ROOT });

    // CEO writes a brief
    const writeResult = await piA.tools.write_artifact.execute("e2e-w", {
      name: "research-brief.md",
      content: "# Brief\n\nInvestigate market trends in AI.",
      type: "brief",
      issue_id: "iss-e2e",
    }, null);

    const artifactPath = writeResult.details.path;
    assert.ok(artifactPath.includes("ceo"));

    // Researcher reads the CEO's brief by path
    const readResult = await piB.tools.read_artifact.execute("e2e-r", {
      path: artifactPath,
    }, null);

    assert.ok(readResult.content[0].text.includes("Investigate market trends in AI"));
    assert.ok(readResult.details.has_metadata);

    // Researcher writes findings
    const findingsResult = await piB.tools.write_artifact.execute("e2e-f", {
      name: "ai-trends.md",
      content: "# AI Trends\n\n1. LLMs are everywhere.\n2. Agents are the new frontier.",
      type: "research",
      template: "research-output",
      issue_id: "iss-e2e",
    }, null);

    assert.ok(findingsResult.details.path.includes("researcher"));

    // CEO reads researcher's findings
    const ceoRead = await piA.tools.read_artifact.execute("e2e-cr", {
      path: findingsResult.details.path,
    }, null);

    assert.ok(ceoRead.content[0].text.includes("Agents are the new frontier"));

    // List all artifacts for issue iss-e2e
    const listResult = await piA.tools.list_artifacts.execute("e2e-l", {
      issue_id: "iss-e2e",
    }, null);

    assert.ok(listResult.details.count >= 2);
  });

  test("three-agent chain: ceo → researcher → qa", async () => {
    const piCeo = createMockPi();
    const piRes = createMockPi();
    const piQa = createMockPi();

    loadArtifactsExtension(piCeo, { agentName: "ceo-chain", artifactsRoot: ARTIFACTS_ROOT });
    loadArtifactsExtension(piRes, { agentName: "res-chain", artifactsRoot: ARTIFACTS_ROOT });
    loadArtifactsExtension(piQa, { agentName: "qa-chain", artifactsRoot: ARTIFACTS_ROOT });

    // CEO briefs researcher
    const brief = await piCeo.tools.write_artifact.execute("c1", {
      name: "task.md",
      content: "Research topic X",
      type: "brief",
      run_id: "run-chain",
    }, null);

    // Researcher reads brief, writes findings
    const resRead = await piRes.tools.read_artifact.execute("c2", {
      path: brief.details.path,
    }, null);
    assert.ok(resRead.content[0].text.includes("Research topic X"));

    const findings = await piRes.tools.write_artifact.execute("c3", {
      name: "findings.md",
      content: "Topic X results: significant findings.",
      type: "research",
      run_id: "run-chain",
    }, null);

    // QA reads findings, writes verdict
    const qaRead = await piQa.tools.read_artifact.execute("c4", {
      path: findings.details.path,
    }, null);
    assert.ok(qaRead.content[0].text.includes("significant findings"));

    const verdict = await piQa.tools.write_artifact.execute("c5", {
      name: "verdict.md",
      content: "PASS. Findings are well-supported.",
      type: "verdict",
      run_id: "run-chain",
    }, null);

    // All artifacts for this run
    const all = await piCeo.tools.list_artifacts.execute("c6", {}, null);
    // Filter by text content since we can't filter by run_id in list without sidecar check
    assert.ok(all.details.count >= 3);
  });
});

// ---------------------------------------------------------------------------
// Edge cases and robustness
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  let mockPi;

  before(() => {
    mockPi = createMockPi();
    loadArtifactsExtension(mockPi, {
      agentName: "edge-test",
      artifactsRoot: ARTIFACTS_ROOT,
    });
  });

  test("write then immediate read returns same content", async () => {
    const content = "Exact content — with unicode → arrows ✅";
    await mockPi.tools.write_artifact.execute("eg1", {
      name: "unicode.md",
      content,
      type: "content",
    }, null);

    const result = await mockPi.tools.read_artifact.execute("eg2", {
      path: path.join("edge-test", "output", "unicode.md"),
    }, null);

    // Content is the first part before ---
    const readContent = result.content[0].text.split("\n---\n")[0];
    assert.equal(readContent, content);
  });

  test("large artifact round-trips correctly", async () => {
    const large = "x".repeat(100_000);
    await mockPi.tools.write_artifact.execute("eg3", {
      name: "large.txt",
      content: large,
      type: "dataset",
    }, null);

    const result = await mockPi.tools.read_artifact.execute("eg4", {
      path: path.join("edge-test", "output", "large.txt"),
    }, null);

    const readContent = result.content[0].text.split("\n---\n")[0];
    assert.equal(readContent.length, 100_000);
  });

  test("filename with spaces works", async () => {
    const result = await mockPi.tools.write_artifact.execute("eg5", {
      name: "my report final v2.md",
      content: "spaced filename",
      type: "content",
    }, null);

    assert.ok(fs.existsSync(result.details.path));

    const read = await mockPi.tools.read_artifact.execute("eg6", {
      path: result.details.path,
    }, null);
    assert.ok(read.content[0].text.includes("spaced filename"));
  });

  test("JSON artifact content preserved exactly", async () => {
    const jsonContent = JSON.stringify({ key: "value", nested: { arr: [1, 2, 3] } }, null, 2);
    await mockPi.tools.write_artifact.execute("eg7", {
      name: "data.json",
      content: jsonContent,
      type: "dataset",
    }, null);

    const result = await mockPi.tools.read_artifact.execute("eg8", {
      path: path.join("edge-test", "output", "data.json"),
    }, null);

    const readContent = result.content[0].text.split("\n---\n")[0];
    assert.equal(readContent, jsonContent);
    assert.deepEqual(JSON.parse(readContent), JSON.parse(jsonContent));
  });

  test("write_artifact never throws, always returns content array", async () => {
    // Even with bad input, should return gracefully
    const result = await mockPi.tools.write_artifact.execute("eg9", {
      name: null,
      content: "stuff",
      type: "research",
    }, null);

    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0].type, "text");
  });

  test("read_artifact never throws, always returns content array", async () => {
    const result = await mockPi.tools.read_artifact.execute("eg10", {
      path: "../../definitely/not/real",
    }, null);

    assert.ok(Array.isArray(result.content));
    assert.equal(result.content[0].type, "text");
  });

  test("list_artifacts never throws, always returns content array", async () => {
    const result = await mockPi.tools.list_artifacts.execute("eg11", {
      agent: "../../escape",
    }, null);

    assert.ok(Array.isArray(result.content));
  });
});
