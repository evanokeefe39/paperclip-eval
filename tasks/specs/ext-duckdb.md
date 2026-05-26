# Extension: duckdb

## Status

Planned.

## Intent

Give agents an in-process analytical SQL engine via DuckDB. Agents can query, transform, and explore structured data (CSV, JSON, Parquet, Excel, SQLite, spatial files, remote URLs) without external database infrastructure. Adapts skills from duckdb/duckdb-skills (MIT) to the Pi extension tool-registration pattern.

Primary consumers: Data agent, Researcher agent. Secondary: any agent needing to analyze structured data in artifacts or workspace.

## Context Package

### Relevant existing code

- `src/agents/extensions/*.ts` -- existing Pi extensions, registration pattern via `export default function(pi: ExtensionAPI)` + `pi.registerTool()`
- `src/agents/extensions/artifacts.ts` -- shared artifact volume at `/artifacts`, metadata sidecars, path traversal protection
- `src/agents/bridge.mjs` lines 151-164 -- extension loading via `-e` flags
- `src/agents/Dockerfile` -- `node:22-slim` base, `COPY extensions/`, no build step, Pi loads raw `.ts`

### Upstream reference

- `duckdb/duckdb-skills` (GitHub, MIT license) -- Claude Code plugin with 9 skills: attach-db, query, read-file, convert-file, duckdb-docs, install-duckdb, read-memories, s3-explore, spatial
- Those are Claude Code slash-command skills (SKILL.md + bash). We adapt the capabilities as Pi tools, not port the code.

### Architectural constraints

- Extension is a single `.ts` file (or a main file + subdir like deep-research pattern)
- No anthropic provider/models/packages in this project
- DuckDB runs in-process via `@duckdb/node-api` (native addon, needs build tools in Dockerfile)
- Extensions loaded as raw TypeScript by Pi CLI -- no bundler
- Container has `/artifacts` shared volume and `/workspace` working directory
- Must not introduce Python dependency (DuckDB Node API is native C++)

### Anti-patterns to avoid

- Do not shell out to `duckdb` CLI -- use Node API directly
- Do not require a running database server
- Do not store state outside `/artifacts` or `/workspace`
- Do not hardcode file paths that differ between agents

## Tool Definitions

### Core tools (Phase 1)

#### 1. `duckdb_query`

Primary tool. Execute SQL against attached databases or ad-hoc against files.

```typescript
duckdb_query({
  sql: string,           // required -- raw SQL or natural-language question
  file?: string,         // optional -- path/URL to query ad-hoc (skips session state)
  limit?: number,        // optional -- max rows returned (default 100)
  format?: "table" | "json" | "csv"  // optional -- output format (default "table")
})
```

Behavior:
- If `file` provided: run in ad-hoc mode against `:memory:`, auto-detect format
- If no `file`: check for session state at `/artifacts/{agent}/duckdb/state.sql`, restore if present
- If `sql` looks like natural language (no SQL keywords): query schema context, generate SQL, execute
- Estimate result size before execution. Warn if >100k rows without LIMIT or aggregation.
- Return: formatted results + row count + column types + execution time
- Support DuckDB Friendly SQL: FROM-first, GROUP BY ALL, EXCLUDE/REPLACE, percentage LIMIT, ASOF joins

#### 2. `duckdb_read_file`

Explore any supported data file. Returns schema, row count, and preview.

```typescript
duckdb_read_file({
  path: string,          // required -- local path or remote URL (S3, HTTPS, GCS)
  question?: string      // optional -- question about the data (default: "describe the data")
})
```

Behavior:
- Auto-detect format from extension (csv, json, jsonl, parquet, xlsx, avro, sqlite, shp, gpkg, geojson, ipynb)
- Run 3 queries: schema description, row count, 20-row preview
- If `question` provided: generate and execute analytical SQL to answer it
- For remote URLs: DuckDB handles natively (httpfs extension auto-loaded)
- Return: schema table + stats + preview rows + answer if question asked

#### 3. `duckdb_attach`

Connect a database file for persistent querying within the session.

```typescript
duckdb_attach({
  path: string,          // required -- path to .duckdb file
  alias?: string,        // optional -- schema alias (default: derived from filename)
  read_only?: boolean    // optional -- attach read-only (default: false)
})
```

Behavior:
- Validate file exists (or create new if doesn't exist and user confirms)
- `ATTACH IF NOT EXISTS '<path>' AS <alias>`
- Explore schema: list tables with column definitions and row counts (cap at 50 tables)
- Persist attachment in session state file
- Return: schema summary

#### 4. `duckdb_convert`

Transform data between formats.

```typescript
duckdb_convert({
  input: string,         // required -- source file path or URL
  output: string,        // required -- destination file path
  query?: string         // optional -- transform SQL applied before writing (default: SELECT *)
})
```

Behavior:
- Detect input format from extension
- Detect output format from extension
- Supported outputs: parquet, csv, tsv, json, jsonl, xlsx
- If `query` provided: apply as transformation (e.g., filter, aggregate, rename)
- Use `COPY (SELECT ...) TO '<output>' (FORMAT ...)` 
- Auto-load required extensions (excel, spatial)
- Return: output path, row count, file size

### Discovery tools (Phase 2)

#### 5. `duckdb_s3_explore`

List and preview data on S3-compatible storage.

```typescript
duckdb_s3_explore({
  url: string,           // required -- s3://, r2://, gs://, or https:// URL
  credentials?: {        // optional -- explicit credentials
    key: string,
    secret: string,
    region?: string,
    endpoint?: string
  }
})
```

Behavior:
- Detect provider from URL pattern
- Configure credentials (explicit > env vars > credential chain)
- Directory URL: list contents with sizes
- File URL: schema + preview
- Support predicate pushdown for Parquet on S3

#### 6. `duckdb_docs`

Search DuckDB documentation.

```typescript
duckdb_docs({
  query: string          // required -- search query (function name, syntax, concept)
})
```

Behavior:
- Full-text search against DuckDB docs index
- Return: relevant doc sections with examples
- Useful for agents to self-help on SQL syntax without web search

#### 7. `duckdb_extensions`

List and install DuckDB extensions.

```typescript
duckdb_extensions({
  action: "list" | "install",   // required
  name?: string,                // required for install
  repo?: string                 // optional -- community extension repo
})
```

Behavior:
- `list`: show installed and available extensions
- `install`: `INSTALL <name>` or `INSTALL <name> FROM <repo>` for community extensions
- Return: extension status

## Session State

Single DuckDB connection instance per extension lifetime (per Pi process invocation). State persisted to `/artifacts/{agent}/duckdb/state.sql` as plain SQL (ATTACH, USE, LOAD, SET statements). Restored on next invocation.

State file structure:
```sql
-- DuckDB session state
ATTACH IF NOT EXISTS '/artifacts/shared/sales.duckdb' AS sales;
USE sales;
LOAD httpfs;
LOAD json;
```

## File Layout

```
src/agents/extensions/
  duckdb.ts              -- main extension entry point, tool registration
  duckdb/
    connection.ts         -- singleton DuckDB connection management
    session.ts            -- state.sql persistence and restore
    format.ts             -- result formatting (table, json, csv)
    detect.ts             -- file format detection from extension
    nlq.ts                -- natural language to SQL (schema-aware prompt generation)
    safety.ts             -- query safety checks (result size estimation, path validation)
```

## Dependencies

### npm (installed in container)

- `@duckdb/node-api` -- DuckDB Node.js bindings (native addon)

### Dockerfile changes

```dockerfile
# DuckDB native addon needs build tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Install DuckDB Node API
RUN npm install -g @duckdb/node-api
```

Note: `@duckdb/node-api` ships prebuilt binaries for linux/amd64 on node 22. If prebuilt available, python3/make/g++ not needed. Test during implementation -- if prebuilt works, drop build tools.

### Environment variables

- `DUCKDB_STATE_DIR` -- override state directory (default: `/artifacts/{agent}/duckdb`)
- `DUCKDB_MEMORY_LIMIT` -- DuckDB memory limit (default: `512MB`)
- `DUCKDB_THREADS` -- DuckDB thread count (default: `2`)
- AWS/S3 credentials for s3-explore: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`

## Behavioral Contracts

```
GIVEN no state file exists
WHEN agent calls duckdb_query with a file path
THEN query executes in ad-hoc mode against :memory: and returns results

GIVEN a state file exists with ATTACH statements
WHEN agent calls duckdb_query with table-referencing SQL
THEN state is restored and query runs against attached databases

GIVEN agent calls duckdb_read_file with a CSV path
WHEN the file exists and is valid CSV
THEN returns schema (column names + types), row count, and 20-row preview

GIVEN agent calls duckdb_read_file with a remote HTTPS URL to a parquet file
WHEN the URL is accessible
THEN httpfs extension auto-loads and returns schema + preview

GIVEN agent calls duckdb_attach with a path to a new .duckdb file
WHEN file does not exist
THEN creates new database, attaches it, persists to state.sql

GIVEN agent calls duckdb_convert with input CSV and output parquet
WHEN input file exists
THEN writes parquet file and returns path + row count + file size

GIVEN agent calls duckdb_query with SQL that would return >100k rows
WHEN no LIMIT or aggregation is present
THEN returns warning with estimated row count, does not execute, suggests adding LIMIT

GIVEN agent calls duckdb_query with natural language like "how many orders per month"
WHEN a database is attached with an orders table
THEN generates appropriate SQL, executes it, returns results with the generated SQL shown

GIVEN the DuckDB connection fails to initialize
WHEN any tool is called
THEN returns clear error message, does not crash the extension or bridge

GIVEN agent calls duckdb_read_file with an unsupported extension
WHEN format cannot be detected
THEN returns error listing supported formats
```

## Edge Case Inventory

1. File path traversal -- paths must be within `/artifacts`, `/workspace`, or absolute paths the agent has access to. No `../` escapes outside allowed roots.
2. Very large files -- DuckDB handles streaming reads, but memory limit (`DUCKDB_MEMORY_LIMIT`) prevents OOM. If query exceeds memory, DuckDB spills to disk automatically.
3. Corrupt files -- DuckDB throws on parse. Catch and return descriptive error.
4. Concurrent access -- single connection per process. No cross-agent locking needed (each agent has own Pi process).
5. Missing extensions -- if spatial/excel/httpfs needed but not installed, auto-install before query.
6. Empty files -- detect and return "file is empty" rather than cryptic schema error.
7. State file corruption -- if state.sql has invalid SQL, catch restore error, rename to `.bak`, start fresh.
8. Natural language ambiguity -- if NLQ generates SQL that fails, return the generated SQL + error so agent can refine.
9. Binary/non-data files -- detect non-data extensions early, return "unsupported format" before attempting read.
10. Network timeouts on remote URLs -- DuckDB httpfs has default timeouts. Surface timeout errors clearly.
11. DuckDB native addon missing/incompatible -- if `@duckdb/node-api` fails to load, skip all tool registration (same pattern as escalate.ts conditional registration).

## Definition of Done

- [ ] All 4 Phase 1 tools registered and functional
- [ ] Session state persists across invocations via state.sql
- [ ] Ad-hoc file querying works for CSV, JSON, Parquet at minimum
- [ ] Natural language to SQL works with schema context
- [ ] Result size safety check prevents unbounded queries
- [ ] Path traversal protection on all file operations
- [ ] Dockerfile updated with @duckdb/node-api dependency
- [ ] bridge.mjs updated with `-e /app/extensions/duckdb.ts`
- [ ] All behavioral contracts have corresponding tests
- [ ] All edge cases have corresponding tests
- [ ] Extension loads cleanly when DuckDB unavailable (conditional registration)
- [ ] Tested end-to-end: Data agent queries CSV in /artifacts via duckdb_query
- [ ] Phase 2 tools specced but not required for initial ship

## Negative Space

What must not change:
- Existing extensions -- no modifications to web-search, artifacts, logging, etc.
- Bridge protocol -- no changes to bridge.mjs HTTP/JSONL contract beyond adding `-e` flag
- Agent prompts -- agents discover tools via registration; no prompt changes required
- Shared Dockerfile for CEO/Writer/QA -- DuckDB only added to Data and Researcher images (bespoke Dockerfiles)

What is explicitly out of scope:
- Write-back to external databases (Postgres, MySQL) -- read/analytical only for now
- Streaming results to agent -- full result returned as text
- Multi-agent shared DuckDB instances -- each agent gets own connection
- DuckDB UDF registration -- not needed at this stage
- Spatial tools (Phase 2)
- S3 explore (Phase 2)
- DuckDB docs search (Phase 2)

What decisions are reserved for human review:
- Whether to add DuckDB to all agent images or only Data/Researcher
- Memory limit default (512MB proposed -- may need tuning)
- Whether NLQ should use the agent's own LLM or a dedicated call
- Whether Phase 2 tools warrant a separate extension file

## Open Questions

None. Ready for implementation review.

## Implementation Notes

### Adaptation strategy from duckdb-skills

duckdb-skills is a Claude Code plugin that uses bash + `duckdb` CLI. We adapt the *capabilities*, not the code:

| duckdb-skills skill | Our tool | Adaptation |
|---|---|---|
| query | `duckdb_query` | Bash CLI -> Node API. Friendly SQL support same. NLQ via agent's LLM instead of Claude. |
| read-file | `duckdb_read_file` | `read_any` macro logic reimplemented in TypeScript format detection + DuckDB queries |
| attach-db | `duckdb_attach` | Same ATTACH pattern. State.sql stored in /artifacts instead of .duckdb-skills/ |
| convert-file | `duckdb_convert` | Same COPY TO pattern via Node API |
| s3-explore | `duckdb_s3_explore` (Phase 2) | Same httpfs + credential detection |
| duckdb-docs | `duckdb_docs` (Phase 2) | Need to find/host searchable index |
| install-duckdb | `duckdb_extensions` (Phase 2) | Scoped to extension management, not CLI install |
| read-memories | Skipped | Claude Code specific. Not applicable to Pi agents. |
| spatial | Folded into read-file/query | Spatial extension auto-loaded when spatial formats detected |

### DuckDB Node API usage pattern

```typescript
import { DuckDBInstance } from "@duckdb/node-api";

const instance = await DuckDBInstance.create();
const connection = await instance.connect();
const result = await connection.run("SELECT * FROM 'data.csv' LIMIT 10");
const rows = result.getRows();
```

### Why @duckdb/node-api over duckdb (legacy)

- Async/await native (no callback hell)
- TypeScript types built-in
- Zero-copy result access
- Actively maintained by DuckDB team
- The legacy `duckdb` npm package is callback-based and has stale types
