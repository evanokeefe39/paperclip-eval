# Artifacts Extension v1 — Implementation Plan

## Intent

Ship the artifacts extension: write, read, list, template access, workspace init, and pass-by-reference prompt injection. Single file, zero npm deps, works with or without Paperclip.

## Prerequisite Reading

- Spec: tasks/specs/ext-artifacts.md
- Extension patterns: src/agents/extensions/web-search.ts (simplest example), escalate.ts (env var gating, promptSnippet)
- Dockerfile: src/agents/Dockerfile
- Bridge: src/agents/bridge.mjs (spawn args at line 116)

## Changes

### 1. artifacts.ts (~250 lines)

`src/agents/extensions/artifacts.ts`

Structure follows existing extensions — default export function receiving `pi: ExtensionAPI`.

```
Imports:
  - type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
  - { Type } from "typebox"
  - fs, path from node:fs, node:path

Constants:
  - ARTIFACTS_ROOT = "/artifacts"
  - TEMPLATES_ROOT = "/app/templates"
  - AGENT_NAME = process.env.AGENT_NAME || ""
  - PAPERCLIP_AGENT_ID = process.env.PAPERCLIP_AGENT_ID || null
  - PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || null

Helpers (internal, not registered as tools):

  ensureDir(dirPath: string)
    - fs.mkdirSync(dirPath, { recursive: true })

  resolvePath(input: string): string
    - Normalize: prepend ARTIFACTS_ROOT if relative
    - path.resolve to collapse ../ etc
    - Reject if not under ARTIFACTS_ROOT (throw)
    - Return resolved absolute path

  deriveFormat(filename: string): string
    - path.extname → strip dot → lowercase
    - Default "txt" if empty

  buildSidecar(params, contentLength): object
    - Returns metadata sidecar object per spec
    - Reads AGENT_NAME, PAPERCLIP_AGENT_ID, PAPERCLIP_COMPANY_ID from module-level constants
    - Reads type, template, issue_id, run_id, project_id, goal_id from params
    - Sets created = new Date().toISOString()
    - Sets size_bytes = Buffer.byteLength(content, 'utf8')
    - Sets format from deriveFormat(name)

  walkDir(dir: string, collector: string[])
    - Recursive readdir, collect file paths (not directories, not .meta.json files)
    - Used by list_artifacts

Export default function(pi):
```

**init_workspace** (runs immediately inside the export default function, before tool registration):

```typescript
if (!AGENT_NAME) return; // not in container, skip everything

const agentDir = path.join(ARTIFACTS_ROOT, AGENT_NAME);
ensureDir(path.join(agentDir, "output"));
ensureDir(path.join(agentDir, "current"));
// TODO: log init event
```

**promptSnippet** (set on first tool registration, or via pi API if available):

```typescript
const PROMPT_SNIPPET = `When sharing work with other agents or referencing artifacts:
- Write output using the write_artifact tool. It returns a path.
- Pass that path in Paperclip issue comments or handoff messages. Never paste artifact content inline.
- To read another agent's work, call read_artifact with the path you received.
- To discover what artifacts exist, call list_artifacts.
- Large documents belong in artifacts, not in messages. A path like "/artifacts/researcher/output/findings.md" is the reference — the downstream agent reads it when needed.`;
```

**write_artifact tool:**

```typescript
pi.registerTool({
  name: "write_artifact",
  label: "Write Artifact",
  description: "Write an artifact to shared storage. Returns a path that other agents can use to read it.",
  promptSnippet: PROMPT_SNIPPET,
  parameters: Type.Object({
    name: Type.String({ description: "Filename, e.g. 'trend-analysis.md'" }),
    content: Type.String({ description: "Artifact content" }),
    type: Type.String({ description: "Artifact type: research, analysis, content, dataset, code, verdict, receipt, brief" }),
    subdirectory: Type.Optional(Type.String({ description: "Subdirectory under agent namespace. Default: 'output'" })),
    template: Type.Optional(Type.String({ description: "Output template followed, e.g. 'research-output'" })),
    issue_id: Type.Optional(Type.String({ description: "Paperclip issue ID" })),
    run_id: Type.Optional(Type.String({ description: "Paperclip run ID" })),
    project_id: Type.Optional(Type.String({ description: "Paperclip project ID" })),
    goal_id: Type.Optional(Type.String({ description: "Paperclip goal ID" })),
  }),
  async execute(_toolCallId, params, _signal) {
    // 1. Validate
    // 2. Resolve path: ARTIFACTS_ROOT / AGENT_NAME / subdirectory / name
    // 3. ensureDir
    // 4. fs.writeFileSync content
    // 5. buildSidecar → fs.writeFileSync .meta.json
    // 6. // TODO: log artifact_write { path, type, size_bytes, issue_id, run_id }
    // 7. Return { path, metadata_path } as text content
  },
});
```

**read_artifact tool:**

```typescript
pi.registerTool({
  name: "read_artifact",
  label: "Read Artifact",
  description: "Read an artifact by path. Returns content and metadata if available.",
  parameters: Type.Object({
    path: Type.String({ description: "Artifact path, e.g. '/artifacts/researcher/output/findings.md' or 'researcher/output/findings.md'" }),
  }),
  async execute(_toolCallId, params, _signal) {
    // 1. resolvePath (normalizes and guards traversal)
    // 2. fs.readFileSync content
    // 3. Try reading .meta.json sidecar, null if missing
    // 4. // TODO: log artifact_read { path }
    // 5. Return content + metadata as text (format: content first, then --- metadata JSON)
  },
});
```

**list_artifacts tool:**

```typescript
pi.registerTool({
  name: "list_artifacts",
  label: "List Artifacts",
  description: "List artifacts with optional filters. Returns metadata summaries, not content.",
  parameters: Type.Object({
    agent: Type.Optional(Type.String({ description: "Filter by agent name" })),
    type: Type.Optional(Type.String({ description: "Filter by artifact type" })),
    issue_id: Type.Optional(Type.String({ description: "Filter by Paperclip issue ID" })),
    subdirectory: Type.Optional(Type.String({ description: "Filter by subdirectory" })),
    since: Type.Optional(Type.String({ description: "ISO 8601 — only artifacts newer than this" })),
  }),
  async execute(_toolCallId, params, _signal) {
    // 1. Determine scan root from agent filter
    // 2. walkDir to collect artifact files
    // 3. For each: try read .meta.json, skip files without sidecars
    // 4. Apply filters (type, issue_id, since)
    // 5. Sort by created desc
    // 6. // TODO: log artifact_list { filters, count }
    // 7. Return formatted list as text
  },
});
```

**get_template tool:**

```typescript
pi.registerTool({
  name: "get_template",
  label: "Get Template",
  description: "Fetch a standard template for producing output or creating briefs.",
  parameters: Type.Object({
    category: Type.Union([Type.Literal("brief"), Type.Literal("output")]),
    name: Type.String({ description: "Template name, e.g. 'research-brief', 'qa-verdict'" }),
  }),
  async execute(_toolCallId, params, _signal) {
    // 1. Resolve: TEMPLATES_ROOT / category / name.md (or .json)
    // 2. Read and return content
    // 3. On not found: list available files in that category dir, return error with options
  },
});
```

### 2. Dockerfile change (+2 lines)

`src/agents/Dockerfile`

Add after the existing COPY lines:

```dockerfile
COPY templates/ /app/templates/
ENV AGENT_NAME=${AGENT_NAME}
```

The `AGENT_NAME` build arg already exists. The `ENV` line makes it available at runtime so `process.env.AGENT_NAME` works in the extension.

### 3. bridge.mjs change (+1 line)

`src/agents/bridge.mjs` line ~116, in the spawnArgs array. Add the artifacts extension to the `-e` flags:

```javascript
"-e", "/app/extensions/artifacts.ts",
```

Add it alongside the existing extensions. It loads on every agent (universal extension per spec).

### 4. .dockerignore check

`src/agents/.dockerignore` — verify `templates/` is not excluded. If it is, remove the exclusion so COPY works.

## Edge Cases to Handle

1. **AGENT_NAME missing** — extension does not register any tools (same pattern as escalate.ts with env var gating). Agent still works, just no artifact tools.
2. **Templates dir missing in container** — get_template returns a clear error. Does not crash.
3. **Path traversal attempt** — resolvePath rejects anything that escapes /artifacts/. Returns error to agent.
4. **File not found on read** — clear error message with the path attempted.
5. **Sidecar missing on read** — return content with metadata: null. Not an error.
6. **Empty list_artifacts result** — return empty array, not error.
7. **Overwrite on write** — allowed in v1. Sidecar gets overwritten too. Previous version lost. (Documented in spec as intentional for v1.)

## Test Plan

### Manual smoke test (against running stack)

```bash
# 1. Rebuild containers with new Dockerfile
docker compose build ceo researcher

# 2. Start stack
docker compose up -d

# 3. Invoke CEO with a prompt that triggers artifact writing
curl -X POST http://localhost:8081/invoke \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Write a brief test document using write_artifact with name test.md, type brief, and content Hello World"}'

# 4. Check artifact was written
docker exec -it $(docker ps -qf name=ceo) ls -la /artifacts/ceo/output/
docker exec -it $(docker ps -qf name=ceo) cat /artifacts/ceo/output/test.md
docker exec -it $(docker ps -qf name=ceo) cat /artifacts/ceo/output/test.md.meta.json

# 5. Verify researcher can read CEO's artifact
curl -X POST http://localhost:8082/invoke \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Read the artifact at /artifacts/ceo/output/test.md using read_artifact"}'

# 6. Verify list_artifacts works
curl -X POST http://localhost:8081/invoke \
  -H "Content-Type: application/json" \
  -d '{"prompt": "List all artifacts using list_artifacts"}'

# 7. Verify get_template works
curl -X POST http://localhost:8081/invoke \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Get the research-brief template using get_template with category brief and name research-brief"}'

# 8. Verify workspace init created directories
docker exec -it $(docker ps -qf name=ceo) ls -la /artifacts/ceo/
# Expect: output/ current/

# 9. Verify templates were copied
docker exec -it $(docker ps -qf name=ceo) ls /app/templates/briefs/
docker exec -it $(docker ps -qf name=ceo) ls /app/templates/outputs/
```

### Path traversal test

```bash
# Should fail gracefully, not expose host filesystem
curl -X POST http://localhost:8081/invoke \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Read the artifact at path ../../etc/passwd using read_artifact"}'
```

### Cross-agent artifact visibility

```bash
# CEO writes artifact → researcher reads it via path → confirm content matches
# This is the core pass-by-reference flow
```

## Definition of Done

- [ ] artifacts.ts compiles and loads without error
- [ ] write_artifact creates file + .meta.json sidecar with correct schema
- [ ] read_artifact returns content and metadata, rejects traversal
- [ ] list_artifacts returns filtered metadata summaries
- [ ] get_template returns template content, lists available on not-found
- [ ] Workspace directories created on agent startup
- [ ] promptSnippet visible in agent system prompt (check bridge logs for prompt content)
- [ ] Cross-agent read works (agent A writes, agent B reads by path)
- [ ] Templates dir exists at /app/templates/ in container
- [ ] AGENT_NAME env var available at runtime
- [ ] All // TODO: log comments present at instrumentation points
- [ ] No npm dependencies added
- [ ] Works with AGENT_NAME set (container), gracefully no-ops without it (local)

## Files Changed

| File | Change |
|------|--------|
| `src/agents/extensions/artifacts.ts` | New — full implementation (~250 lines) |
| `src/agents/Dockerfile` | Add COPY templates, ENV AGENT_NAME |
| `src/agents/bridge.mjs` | Add `-e /app/extensions/artifacts.ts` to spawnArgs |
| `src/agents/.dockerignore` | Verify templates/ not excluded |
