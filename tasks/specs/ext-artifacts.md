# Extension: artifacts (v1)

## Status

Stub. Empty file at src/agents/extensions/artifacts.ts.

## Intent

Shared artifact storage for inter-agent data exchange. Agents write structured output, read each other's artifacts by path, and never inline large documents in orchestration messages. Works with or without Paperclip — Paperclip metadata enriches artifacts when available but is never required.

V1 scope: write, read, list, workspace init, template access, pass-by-reference prompt injection. No learnings management, no agent profiles, no git sync, no MinIO.

## Principles

1. **Pass by reference** — agents exchange artifact paths, never content. The extension injects this rule via `promptSnippet`.
2. **Rich metadata when available** — Paperclip context (issue, run, project, goal) is captured in sidecars when the caller provides it. Missing fields are null, never faked.
3. **Standalone operation** — works on a bare Docker volume with no Paperclip. Metadata just has fewer fields.
4. **Templates as guardrails** — agents can fetch output templates to know what format to produce. Not enforced in v1 (that's the verification plugin in Phase 2).
5. **Logging deferred** — `// TODO: log` comments at every instrumentation point. Replaced with real calls when logging.ts ships.

## Environment (container-level, stable)

Read from `process.env` on extension load. These identify the agent, not the work.

```
AGENT_NAME          — required, identifies the agent namespace (e.g., "researcher")
PAPERCLIP_AGENT_ID  — optional, Paperclip's UUID for this agent
PAPERCLIP_COMPANY_ID — optional, Paperclip's company UUID
```

Per-invocation context (issue, run, project, goal) is NOT read from env. It comes through tool params so agents can call write_artifact with the right context per task.

## promptSnippet

Injected into every agent's system prompt automatically when the extension loads:

```
When sharing work with other agents or referencing artifacts:
- Write output using the write_artifact tool. It returns a path.
- Pass that path in Paperclip issue comments or handoff messages. Never paste artifact content inline.
- To read another agent's work, call read_artifact with the path you received.
- To discover available artifacts, call list_artifacts with filters.
- Large documents belong in artifacts, not in messages. A path like "/artifacts/researcher/output/findings.md" is the reference — the downstream agent reads it when needed.
```

This replaces the need for manual pass-by-reference instructions in every AGENTS.md. Loading the extension teaches the behavior.

## Tool Definitions

### write_artifact

```typescript
write_artifact({
  name: string,             // required — filename (e.g., "trend-analysis.md")
  content: string,          // required — the artifact content
  type: string,             // required — "research" | "analysis" | "content" | "dataset" | "code" | "verdict" | "receipt" | "brief"
  subdirectory?: string,    // default: "output" — relative to agent namespace
  template?: string,        // optional — which output template was followed (e.g., "research-output")
  // --- Paperclip context (all optional, for traceability) ---
  issue_id?: string,        // Paperclip issue ID this artifact relates to
  run_id?: string,          // Paperclip run ID (primary correlation key across the system)
  project_id?: string,      // Paperclip project ID
  goal_id?: string,         // Paperclip goal ID
})
```

Returns: `{ path: string, metadata_path: string }` — the artifact path and its sidecar path. The agent passes `path` in handoff messages.

### read_artifact

```typescript
read_artifact({
  path: string              // required — full or relative path to artifact
                            //   "/artifacts/researcher/output/findings.md" or
                            //   "researcher/output/findings.md"
})
```

Returns: `{ content: string, metadata: object | null }` — content + sidecar if present.

### list_artifacts

```typescript
list_artifacts({
  agent?: string,           // filter by agent namespace
  type?: string,            // filter by artifact type
  issue_id?: string,        // filter by Paperclip issue
  subdirectory?: string,    // filter by subdirectory (e.g., "output", "current")
  since?: string            // ISO 8601 — only artifacts newer than this
})
```

Returns: array of `{ path, type, created, size_bytes, issue_id, run_id, template }` — metadata summaries, no content. Agent calls `read_artifact` for the ones it needs.

### get_template

```typescript
get_template({
  category: "brief" | "output",
  name: string              // e.g., "research-brief", "qa-verdict", "research-output"
})
```

Returns: `{ content: string }` — the template markdown. Agent uses it as a format reference when producing output.

### init_workspace (not a tool — runs on load)

Automatic. Not callable by the agent. Runs when the extension initializes.

## Behavior

### Extension load (onLoad)

```
1. Read AGENT_NAME from env — if missing, skip registration (running outside container)
2. Create directory tree if missing:
     /artifacts/{AGENT_NAME}/
       current/
       output/
   // TODO: log init event
3. Register tools: write_artifact, read_artifact, list_artifacts, get_template
4. Set promptSnippet (pass-by-reference instructions)
```

### write_artifact

```
1. Validate: name non-empty, content non-empty, type non-empty
2. Resolve path: /artifacts/{AGENT_NAME}/{subdirectory}/{name}
3. Create subdirectory if missing
4. Write content to path
5. Build metadata sidecar (see Metadata Sidecar below)
6. Write sidecar to {path}.meta.json
   // TODO: log artifact_write event with { path, type, size, issue_id, run_id }
7. Return { path, metadata_path }
```

### read_artifact

```
1. Normalize path:
   - If starts with "/artifacts/", use as-is
   - If relative, prepend "/artifacts/"
   - Reject if resolved path is not under /artifacts/ (path traversal guard)
2. Read file content
3. Read {path}.meta.json if exists, else metadata = null
   // TODO: log artifact_read event with { path, agent requesting }
4. Return { content, metadata }
```

### list_artifacts

```
1. Determine scan root:
   - If agent filter: /artifacts/{agent}/
   - Else: /artifacts/ (all agents)
2. Walk directory, collect files that have .meta.json sidecars
3. Read each sidecar, apply filters (type, issue_id, since)
4. Sort newest first
5. Return metadata summaries (no content)
   // TODO: log artifact_list event with { filters, result_count }
```

### get_template

```
1. Resolve path: /app/templates/{category}/{name}.md
   (or .json for publish-receipt)
2. Read and return content
3. If not found, return error with available templates in that category
```

## Metadata Sidecar

Every artifact gets a companion `.meta.json`. This is the observability and data relation layer.

```json
{
  "v": 1,
  "agent": "researcher",
  "agent_id": "paperclip-uuid-or-null",
  "company_id": "paperclip-uuid-or-null",
  "type": "research",
  "template": "research-output",
  "created": "2026-05-26T12:00:00Z",
  "size_bytes": 4200,
  "format": "md",
  "paperclip": {
    "issue_id": "uuid-or-null",
    "run_id": "uuid-or-null",
    "project_id": "uuid-or-null",
    "goal_id": "uuid-or-null"
  }
}
```

Field rules:
- `v` — schema version, always 1 for now. Lets future code handle old sidecars.
- `agent` — from AGENT_NAME env. Always present.
- `agent_id`, `company_id` — from container env. Null if not in Paperclip.
- `type` — from tool param. Always present (required).
- `template` — from tool param. Null if agent didn't specify.
- `created` — ISO 8601, generated at write time.
- `size_bytes` — byte length of content.
- `format` — derived from filename extension (md, json, csv, txt). Default "txt".
- `paperclip.*` — from tool params. Each field independently nullable. If the agent provides `issue_id` but not `project_id`, that is fine.

The `run_id` is the primary correlation key. When Paperclip invokes an agent, the wake payload includes a run ID. If the agent passes it through to write_artifact, every artifact from that invocation shares the same run_id. You can join: Paperclip run → bridge request log → all artifacts written → downstream agent reads.

## Path Convention

```
/artifacts/
  {agent-name}/
    output/                 Completed deliverables (default subdirectory)
      {name}                Artifact content
      {name}.meta.json      Metadata sidecar
    current/                Work-in-progress (agents can use freely)
  qa/                       QA verdicts (QA agent writes here via subdirectory="")
    {issue-id}-verdict.md
  publisher/                Publish receipts
    {issue-id}-receipt.json
```

QA writes to `/artifacts/qa/` by being named "qa" (AGENT_NAME=qa). Same for publisher. No special-casing in the extension — the agent namespace IS the directory.

## Security

- Write: agents write only to `/artifacts/{own-AGENT_NAME}/`
- Read: all agents can read all of `/artifacts/`
- Path traversal: rejected if resolved path escapes `/artifacts/`
- No delete tool exposed
- No overwrite protection in v1 (last writer wins). Sidecar tracks creation time.

## Dependencies

- Shared Docker volume `shared-artifacts` mounted at `/artifacts`
- Templates at `/app/templates/` (COPYed from src/agents/templates/ in Dockerfile)
- `fs` and `path` from Node stdlib. Zero npm dependencies.
- Logging extension: cross-dependency. V1 uses `// TODO: log` comments. When logging.ts ships, replace with `pi.callTool("log_event", {...})` or direct import if Pi supports extension-to-extension calls.

## What v1 Does NOT Include

- **Learnings management** (append_learning, read_learnings) — agents can write to learnings.md manually via write_artifact. Structured tooling deferred to v2.
- **Agent profiles / list_agents** — meta-agent operations, deferred.
- **Artifact versioning** — last writer wins. Sidecar timestamps provide ordering.
- **Content validation against templates** — extension provides templates but doesn't enforce. Verification plugin (Phase 2) handles enforcement.
- **Git sync** — deferred per ROADMAP.md.
- **MinIO backend** — deferred per ROADMAP.md. Tool interface designed to be backend-agnostic.
- **Logging** — `// TODO: log` at every instrumentation point. Wired when logging.ts exists.

## File

```
src/agents/extensions/artifacts.ts    Single file, ~200-300 lines
```

No subdirectory. V1 is small enough for one file. If it grows past 400 lines, split into artifacts/ directory with separate modules.
