# Extension: artifacts

## Status

Stub. Empty file at src/agents/extensions/artifacts.ts.

## Intent

Shared artifact storage interface for inter-agent data exchange. Wraps the shared Docker volume (/artifacts) with structured read/write operations, path conventions, metadata, and discovery. Replaces ad-hoc file path passing with a proper artifact protocol.

Future: migrate from Docker volume to MinIO (S3-compatible) when infrastructure is ready (see ROADMAP.md).

## Tool Definitions

```typescript
write_artifact({
  name: string,           // required — artifact filename
  content: string,        // required — artifact content (text/JSON/markdown)
  context: string,        // required — producing agent's context/run identifier
  type?: string,          // e.g., "research", "analysis", "content", "dataset", "code"
  metadata?: object       // optional — arbitrary metadata (sources, timestamps, etc.)
})

read_artifact({
  path: string            // required — full artifact path (e.g., "/artifacts/researcher/findings.md")
})

list_artifacts({
  context?: string,       // filter by producing agent/context
  type?: string           // filter by artifact type
})
```

## Behavior

### write_artifact
1. Validate inputs (name, content non-empty)
2. Construct path: `/artifacts/{context}/{name}`
3. Write metadata sidecar: `/artifacts/{context}/{name}.meta.json` with type, timestamp, producing agent, size
4. Write content to path
5. Return path reference for passing to other agents

### read_artifact
1. Check path exists under /artifacts
2. Read and return content
3. Optionally read .meta.json sidecar if present

### list_artifacts
1. Scan /artifacts directory (optionally filtered by context/type)
2. Return list of artifact paths with metadata summaries

## Dependencies

- Shared Docker volume `shared-artifacts` mounted at `/artifacts` in all containers
- No external APIs
- No npm dependencies (fs operations only)

## Path Convention

```
/artifacts/
  {agent-name}/           Per-agent namespace
    {artifact-name}       Artifact content
    {artifact-name}.meta.json  Metadata sidecar
  qa/                     QA verdicts
  publisher/              Publish receipts
```

## Security

- Agents write only to their own context: `/artifacts/{own-agent-name}/`
- All agents can read all of /artifacts (read-only cross-agent access)
- QA writes to /artifacts/qa/
- Publisher writes to /artifacts/publisher/
- No delete operations (immutable artifacts during a run)

## Loaded By

- All agents that produce or consume artifacts (Analyst, Data Engineer, Dev, Writer, QA, Publisher)
- CEO reads artifacts but may not need the extension (reads via Paperclip context)

## Gaps / Open Questions

- No artifact versioning — overwrites silently
- No artifact TTL or cleanup policy
- No large artifact streaming (entire content in memory)
- No artifact locking for concurrent writes
- No migration path to MinIO encoded in the interface yet
- Should metadata sidecar be JSON or embedded in artifact header?
- How do agents discover artifacts from other agents' prior runs (not just current run)?
