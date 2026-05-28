/**
 * Unit tests for bridge issue-scoped working directory logic.
 *
 * Tests the cwd resolution that determines where Pi processes write their
 * local workspace files, scoped by issue ID.
 *
 * Run:  node --test tests/bridge/cwd-test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
//  Inline re-implementation of the bridge's resolveWorkDir logic
//  (mirrors src/agents/bridge.mjs — keep in sync when bridge changes)
// ---------------------------------------------------------------------------

function resolveWorkDir(body) {
  const ctx = body.context || {};
  const runId = body.runId || null;
  const wakeContext = {
    issueId: ctx.issueId || null,
    runId,
  };
  const rawScope = wakeContext.issueId || runId || "scratch";
  const issueScope = rawScope.replace(/[^a-zA-Z0-9_-]/g, "-");
  return body.workspace || `/workspace/${issueScope}`;
}

// ---------------------------------------------------------------------------
//  1. Basic resolution
// ---------------------------------------------------------------------------

describe("resolveWorkDir — basic resolution", () => {
  it("uses issueId when present", () => {
    const result = resolveWorkDir({ context: { issueId: "PROJ-42" } });
    assert.equal(result, "/workspace/PROJ-42");
  });

  it("falls back to runId when no issueId", () => {
    const result = resolveWorkDir({ runId: "run-abc-123" });
    assert.equal(result, "/workspace/run-abc-123");
  });

  it("falls back to scratch when neither issueId nor runId", () => {
    const result = resolveWorkDir({});
    assert.equal(result, "/workspace/scratch");
  });

  it("workspace override takes precedence over issueId", () => {
    const result = resolveWorkDir({
      workspace: "/custom/path",
      context: { issueId: "PROJ-42" },
    });
    assert.equal(result, "/custom/path");
  });
});

// ---------------------------------------------------------------------------
//  2. Sanitization
// ---------------------------------------------------------------------------

describe("resolveWorkDir — sanitization", () => {
  it("strips special characters (path traversal attempt)", () => {
    const result = resolveWorkDir({ context: { issueId: "../../etc/passwd" } });
    assert.equal(result, "/workspace/------etc-passwd");
  });

  it("preserves alphanumeric, hyphens, and underscores", () => {
    const result = resolveWorkDir({ context: { issueId: "PROJ-42_draft" } });
    assert.equal(result, "/workspace/PROJ-42_draft");
  });

  it("converts spaces to hyphens", () => {
    const result = resolveWorkDir({ context: { issueId: "my issue" } });
    assert.equal(result, "/workspace/my-issue");
  });

  it("converts unicode to hyphens", () => {
    const result = resolveWorkDir({ context: { issueId: "café☕" } });
    assert.equal(result, "/workspace/caf--");
  });

  it("empty issueId falls back to runId", () => {
    const result = resolveWorkDir({ context: { issueId: "" }, runId: "run-1" });
    assert.equal(result, "/workspace/run-1");
  });

  it("null issueId falls back to runId", () => {
    const result = resolveWorkDir({ context: { issueId: null }, runId: "run-1" });
    assert.equal(result, "/workspace/run-1");
  });
});

// ---------------------------------------------------------------------------
//  3. Directory creation (integration — uses a real temp directory)
// ---------------------------------------------------------------------------

describe("resolveWorkDir — directory creation", () => {
  it("creates the resolved directory", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cwd-test-"));
    try {
      const workDir = path.join(tmpBase, "PROJ-99");
      fs.mkdirSync(workDir, { recursive: true });
      assert.ok(fs.existsSync(workDir), "directory should exist after mkdirSync");
      assert.ok(fs.statSync(workDir).isDirectory(), "path should be a directory");
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("handles nested paths (recursive creation)", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cwd-test-"));
    try {
      const workDir = path.join(tmpBase, "level1", "level2", "level3");
      fs.mkdirSync(workDir, { recursive: true });
      assert.ok(fs.existsSync(workDir), "nested directory should exist");
      assert.ok(fs.statSync(workDir).isDirectory(), "nested path should be a directory");
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("is idempotent — calling mkdirSync twice does not throw", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-cwd-test-"));
    try {
      const workDir = path.join(tmpBase, "idempotent-check");
      fs.mkdirSync(workDir, { recursive: true });
      assert.doesNotThrow(() => {
        fs.mkdirSync(workDir, { recursive: true });
      });
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
//  4. Isolation
// ---------------------------------------------------------------------------

describe("resolveWorkDir — isolation", () => {
  it("different issues get different directories", () => {
    const pathA = resolveWorkDir({ context: { issueId: "issue-A" } });
    const pathB = resolveWorkDir({ context: { issueId: "issue-B" } });
    assert.notEqual(pathA, pathB);
  });

  it("same issue always resolves to the same directory", () => {
    const first = resolveWorkDir({ context: { issueId: "PROJ-42" } });
    const second = resolveWorkDir({ context: { issueId: "PROJ-42" } });
    assert.equal(first, second);
  });
});
