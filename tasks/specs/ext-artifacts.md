# Extension: artifacts

## Status

Stub. Empty file at src/agents/extensions/artifacts.ts.

## Intent

Shared artifact storage interface for inter-agent data exchange, workspace initialization, template enforcement, and learnings lifecycle management. Wraps the shared Docker volume (/artifacts) with structured read/write operations, path conventions, metadata, and discovery. The single integration point for all shared resources — agents interact with the artifact layer, never with raw filesystem paths.

Future: migrate from Docker volume to MinIO (S3-compatible) when infrastructure is ready (see ROADMAP.md). The tool interface stays the same; the backend changes.

## Tool Definitions

```typescript
// --- Core artifact operations ---

write_artifact({
  name: string,           // required — artifact filename
  content: string,        // required — artifact content (text/JSON/markdown)
  subdirectory?: string,  // default: "output" — relative to agent namespace
  type?: string,          // e.g., "research", "analysis", "content", "dataset", "code", "verdict", "receipt"
  issue_id?: string,      // Paperclip issue ID for traceability
  metadata?: object       // optional — arbitrary metadata (sources, timestamps, etc.)
})

read_artifact({
  path: string            // required — full path (e.g., "/artifacts/researcher/output/findings.md")
                          //            or relative to /artifacts (e.g., "researcher/output/findings.md")
})

list_artifacts({
  agent?: string,         // filter by agent namespace
  type?: string,          // filter by artifact type
  issue_id?: string,      // filter by Paperclip issue
  since?: string          // ISO 8601 — only artifacts created after this time
})

// --- Workspace management ---

init_workspace()
// Called automatically on agent startup.
// Creates /artifacts/{agent-name}/ directory structure if missing.
// Copies workspace templates (learnings.md, meta.json) from /app/templates/workspace/.
// Idempotent — safe to call multiple times.

// --- Learnings operations ---

append_learning({
  event: "rejection" | "error" | "discovery" | "waste" | "pattern",
  issue_id?: string,
  what_happened: string,
  root_cause?: string,
  action_taken?: string,
  pattern?: string,       // reference to prior entry timestamp if recurring
  upstream_improvement?: string
})
// Appends structured entry to /artifacts/{agent-name}/learnings.md
// Also writes to /artifacts/meta/agent/{agent-name}/learnings-live.jsonl (machine-readable mirror)

read_learnings({
  agent?: string,         // default: self. Can read other agents' learnings.
  event?: string,         // filter by event type
  limit?: number          // default: 20
})

// --- Meta / centralized operations ---

get_agent_profile({
  agent: string           // agent name
})
// Reads /artifacts/meta/agent/{agent-name}/profile.md
// Returns structured profile with health metrics, patterns, skill history

list_agents()
// Returns list of all agents with basic metadata from their meta.json files

// --- Template operations ---

get_template({
  category: "brief" | "output" | "meta",
  name: string            // e.g., "research-brief", "qa-verdict", "agent-profile"
})
// Reads template from /app/templates/{category}/{name}.md
// Agents use this to reference correct templates when producing output
```

## Behavior

### Agent startup (init_workspace)

Runs automatically when the extension loads (Pi extension `onLoad` hook):

1. Read AGENT_NAME from env
2. Create directory tree if missing:
   ```
   /artifacts/{agent-name}/
     current/
     output/
     logs/
   /artifacts/meta/agent/{agent-name}/
     learnings-archive/
   ```
3. Copy `learnings.md` from `/app/templates/workspace/learnings.md` if not exists
4. Write/update `meta.json` from template with current env vars
5. Write `learnings-live.jsonl` header if not exists (machine-readable mirror)
6. Log initialization event via logging extension

### write_artifact

1. Validate: name and content non-empty
2. Resolve path: `/artifacts/{AGENT_NAME}/{subdirectory}/{name}`
3. Create subdirectory if missing
4. Write content to path
5. Write metadata sidecar: `{path}.meta.json` with:
   - agent, issue_id, type, created (ISO 8601), version, size_bytes, format (derived from extension)
6. Log artifact_write event via logging extension
7. Return full path for handoff to other agents

### read_artifact

1. Normalize path (accept absolute or relative to /artifacts)
2. Verify path is under /artifacts (security: no path traversal)
3. Read content
4. Read .meta.json sidecar if present
5. Return { content, metadata }

### list_artifacts

1. Walk /artifacts directory tree
2. Read .meta.json sidecars for filtering and summaries
3. Apply filters (agent, type, issue_id, since)
4. Return sorted list (newest first) with path + metadata summary

### append_learning

1. Format entry per learnings.md template
2. Append to `/artifacts/{AGENT_NAME}/learnings.md`
3. Append JSON line to `/artifacts/meta/agent/{AGENT_NAME}/learnings-live.jsonl`
4. If entry has `pattern` field, check if pattern count exceeds threshold (default: 3) → log `flag_for_kaizen` event

### Learnings drain (deferred)

Not part of the extension runtime. Separate process described in ROADMAP.md — "Planned: Learnings Drain Process". The artifacts extension writes raw learnings; the drain process reads and centralizes them later.

## Dependencies

- Shared Docker volume `shared-artifacts` mounted at `/artifacts` in all containers
- Templates directory at `/app/templates/` inside container (COPYed from src/agents/templates/)
- Logging extension (for event logging)
- No external APIs
- No npm dependencies (fs operations only)

## Path Convention

```
/artifacts/
  {agent-name}/               Per-agent namespace
    learnings.md              Kaizen log (append-only from agent)
    meta.json                 Agent metadata
    current/                  Work-in-progress
      {issue-id}/             Per-issue subdirectory
        input/                Copies of input artifacts
        work/                 Intermediate files
        output/               Final deliverables for this issue
    output/                   Completed deliverables (promoted or direct)
    logs/                     Execution logs (from logging extension)
      run.log.jsonl
  qa/                         QA verdicts (written by QA agent)
    {issue-id}-verdict.md
  publisher/                  Publish receipts (written by Publisher)
    {issue-id}-receipt.json
  meta/                       Centralized meta-artifacts
    agent/
      {agent-name}/
        profile.md            Agent profile (health, patterns, skill history)
        learnings-digest.md   Distilled patterns from learnings
        learnings-live.jsonl  Machine-readable learnings mirror
        learnings-archive/    Monthly archives
          {YYYY-MM}.md
    pipeline/                 Pipeline-level metrics and reports
      kaizen-report-{date}.md
```

## Security

- Agents write to their own namespace: `/artifacts/{own-agent-name}/`
- Agents write to their own meta: `/artifacts/meta/agent/{own-agent-name}/`
- QA additionally writes to `/artifacts/qa/` and other agents' learnings.md (pattern notes only)
- All agents can read all of /artifacts (read-only cross-agent access)
- Path traversal blocked: all paths validated against /artifacts root
- No delete operations exposed to agents (immutable during a run)

## Git Sync (Deferred)

See ROADMAP.md — "Planned: Git-Managed Agent Workspaces". Not in scope for initial implementation. The `meta.json.git` field is reserved for future use.

## Loaded By

All agents (universal extension).

## Template Integration

The artifacts extension is the bridge between templates (at `/app/templates/`) and runtime:

1. **Workspace init** — copies workspace templates on startup
2. **Output validation** — agents call `get_template("output", "research-output")` to get the expected format, then produce output matching it
3. **Brief creation** — CEO calls `get_template("brief", "research-brief")` when creating issues
4. **Meta management** — drain process uses meta templates for profiles and digests

Templates are read-only at runtime. Changes go through the repo (src/agents/templates/) and are picked up on next container build.
