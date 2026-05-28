# Workproduct Expansion — Per-Agent Workproducts

## Intent

Expand the workproduct system from a single shared module (findings only) to per-agent workproduct modules. Each agent produces structured, validated artifacts native to its role: researcher records findings, data records dataset references and metrics, writer records content kinds, QA records assessments. Restructure the extension layout so each agent's workproduct tools live in its own directory, while shared infrastructure (validation engine, schemas, ULID, templates) stays centralized. Zero Dockerfile changes required.

Project stage is evaluation. Workproducts are pointers and structured metadata, not full payloads — datasets reference tables, content references source findings, assessments reference reviewed artifacts.

## Context Package

### Relevant existing code

- `src/agents/extensions/workproduct/index.ts` — current findings extension (record_finding, add_source, query_findings, get_finding)
- `src/agents/extensions/workproduct/validate.ts` — generic two-level validation engine (`validateByStyle`), already decoupled from findings
- `src/agents/extensions/workproduct/ulid.ts` — monotonic ULID generator
- `src/agents/extensions/workproduct/templates/` — brief and output templates per role
- `src/agents/extensions/artifact-client.ts` — shared HTTP client for artifact service (write, read, list, updateMetadata)
- `src/agents/extensions/artifacts.ts` — read/write/list/get_template tools (universal)
- `src/agents/extensions/duckdb/` — data agent analytics tools (`duckdb_query`, `duckdb_read_file`, `duckdb_attach`, `duckdb_convert`)
- `src/agents/extensions/writing-style/` — writer style and lint tools
- `src/agents/Dockerfile` — base stage sweeps `extensions/` to `/root/.pi/agent/extensions/`; per-agent stages sweep `{agent}/.pi/agent/` to `/root/.pi/agent/`
- `tasks/specs/findings-schema.md` — original findings spec

### Architectural constraints

- Pi auto-discovers extensions from `/root/.pi/agent/extensions/`: flat `*.ts` files and `*/index.ts` subdirs. A subdir without `index.ts` is ignored as an extension but its files remain on disk for import.
- Agent identity comes from `AGENT_NAME` env var. Per-agent extensions self-gate.
- HTTP adapter agents do not receive Paperclip's built-in MCP tools — only Pi-native tools registered by extensions.
- pi-permissions.jsonc gates tools the LLM sees, but cannot reduce module load surface; preferring per-agent files keeps disk footprint and registration minimal.
- Artifact service stores blob in MinIO and metadata in Postgres JSONB. Metadata is queryable via `client.list({ type, metadata })`.

### Prior decisions

- Findings used a single `style` discriminator (`intelligence`, `academic`, `journalism`, `data`, `general`) because all findings share the same structural shape (claim + sources). Style varied only required/encouraged fields.
- Data workproducts are structurally distinct per kind (`dataset_ref` ≠ `metric` ≠ `chart`), so per-kind tools chosen over single-tool-with-kind. LLM picks better when tool schema is tight.
- Workproducts that reference data (data agent kinds) store pointers, not payloads. Datasets are too large for artifact content.

### Anti-patterns to avoid

- Do not duplicate validation logic per agent. `validate.ts` is generic, reuse it.
- Do not register all agents' tools in every container and then permission-gate. Per-agent files mean per-agent registration.
- Do not store full datasets as artifact content. Reference by table + filter, materialization via duckdb on demand.
- Do not pre-create empty subdirs in agent `.pi/agent/`. Pi probes for `extensions/` natively when present.
- Do not introduce a dispatcher pattern (`if AGENT_NAME === "x"` inside a shared module) — restructure on disk instead.

## Behavioral Contracts

### Restructure

GIVEN the current `src/agents/extensions/workproduct/index.ts` registers findings tools globally
WHEN the restructure is applied
THEN `src/agents/extensions/workproduct/index.ts` no longer exists
AND the directory is renamed to `src/agents/extensions/workproduct-lib/` (no `index.ts`)
AND `workproduct-lib/` contains `validate.ts`, `ulid.ts`, `schemas.ts`, `templates/`
AND each agent (researcher, data, writer, qa) has `src/agents/{agent}/.pi/agent/extensions/workproduct.ts`
AND each per-agent file imports utilities via relative path `./workproduct-lib/<module>.js`
AND Pi loads only the per-agent file as an extension (workproduct-lib has no `index.ts`)

### Researcher (no behavioral change, only file relocation)

GIVEN the researcher container starts
WHEN bridge spawns Pi
THEN Pi discovers `/root/.pi/agent/extensions/workproduct.ts`
AND that file registers `record_finding`, `add_source`, `query_findings`, `get_finding`
AND tool behavior is unchanged from the current implementation

### Data agent — per-kind tools

GIVEN the data container starts
WHEN Pi loads its workproduct extension
THEN four record tools are registered: `record_dataset_ref`, `record_query_result`, `record_metric`, `record_chart`
AND two query tools are registered: `query_data_products`, `get_data_product`

### Writer agent — per-kind tools

GIVEN the writer container starts
WHEN Pi loads its workproduct extension
THEN five record tools are registered: `record_report`, `record_guide`, `record_article`, `record_marketing_copy`, `record_newsletter`
AND two query tools are registered: `query_content`, `get_content`

### QA agent — per-kind tools

GIVEN the QA container starts
WHEN Pi loads its workproduct extension
THEN three record tools are registered: `record_artifact_review`, `record_plan_review`, `record_stage_gate`
AND two query tools are registered: `query_assessments`, `get_assessment`

### Shared schemas

GIVEN `workproduct-lib/schemas.ts` defines reusable TypeBox types
WHEN per-agent files need to reference an artifact (e.g., writer cites a finding)
THEN they import `ArtifactRef`, `ISODate`, `SourceSchema` from `workproduct-lib/schemas.js`
AND no per-agent file redeclares these types

### Validation

GIVEN per-agent files use style-based or kind-based validation
WHEN a record tool is called with missing required fields
THEN the tool returns an error and does not write to the artifact service
WHEN a record tool is called with missing encouraged fields
THEN the tool writes the artifact and returns warnings alongside the ID

## Per-Agent Workproduct Specifications

### Researcher (existing — no schema change)

Kinds: `finding` (existing)
Styles: `intelligence`, `academic`, `journalism`, `data`, `general` (existing)

### Data — kinds and schemas

#### `dataset_ref` — reference to a dataset

**Artifact content:** manifest JSON (`{ source, table, filters, columns, row_count_estimate, as_of }`)

**Metadata fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `source` | enum | yes | `postgres`, `duckdb`, `parquet`, `csv`, `tinybird`, `s3`, `api`, `other` |
| `table` | string | yes (if source is db) | table name or fully-qualified path |
| `path` | string | yes (if source is file) | file URI or S3 key |
| `filters` | object | no | column → predicate map (e.g., `{ status: "active" }`) |
| `columns` | string[] | no | projected columns; omit = all |
| `row_count_estimate` | integer | no | best-effort estimate |
| `schema_hash` | string | no | hash of column names+types for change detection |
| `as_of` | ISO date | yes | data freshness timestamp |
| `caveats` | string | no | known issues (e.g., "partial backfill") |
| `topic_tags` | string[] | no | searchability |
| `related_artifacts` | string[] | no | other artifact IDs this references |

**Tool:** `record_dataset_ref`

#### `query_result` — materialized query output

**Artifact content:** small results inline (≤ 100 rows); large results pointer JSON

**Metadata fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `sql` | string | yes | the query (truncated to 8KB if longer, full SQL in content) |
| `engine` | enum | yes | `duckdb`, `postgres`, `tinybird`, `other` |
| `row_count` | integer | yes | actual row count of result |
| `materialized_at` | ISO date | yes | when query was executed |
| `result_artifact_ref` | string | no | artifact ID of exported parquet/csv if too large for inline |
| `source_dataset_refs` | string[] | no | artifact IDs of `dataset_ref` inputs |
| `columns` | array | yes | column metadata (name, type) |
| `duration_ms` | integer | no | execution time |
| `topic_tags` | string[] | no | searchability |

**Tool:** `record_query_result`

#### `metric` — scalar or small series

**Artifact content:** value JSON (`{ value, series? }`)

**Metadata fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | yes | e.g., `monthly_recurring_revenue`, `churn_rate_7d` |
| `value` | number\|string | yes | scalar; series goes in content |
| `unit` | string | no | e.g., `USD`, `count`, `percent`, `seconds` |
| `dimensions` | object | no | breakdown (e.g., `{ region: "us-east" }`) |
| `window` | object | no | `{ start, end }` ISO range or label like `"trailing_7d"` |
| `source_query_ref` | string | yes | artifact ID of `query_result` that produced this |
| `confidence` | enum | no | `high`, `medium`, `low` |
| `topic_tags` | string[] | no | searchability |
| `entities` | string[] | no | entities measured |

**Tool:** `record_metric`

#### `chart` — visualization spec

**Artifact content:** vega-lite or chart spec JSON

**Metadata fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `chart_type` | enum | yes | `line`, `bar`, `scatter`, `area`, `pie`, `table`, `other` |
| `data_ref` | string | yes | artifact ID of `query_result` or `dataset_ref` |
| `dimensions` | string[] | no | x-axis / grouping columns |
| `measures` | string[] | no | y-axis / aggregated columns |
| `rendered_artifact_ref` | string | no | artifact ID of PNG/SVG if rendered |
| `title` | string | no | display title |
| `caveats` | string | no | what the chart does not show |
| `topic_tags` | string[] | no | searchability |

**Tool:** `record_chart`

### Writer — kinds and schemas

All writer kinds share a common shape: content body in artifact content, metadata holds format/audience/traceability.

#### Common metadata across writer kinds

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | yes | document title |
| `audience` | string | yes | target reader (e.g., "technical PMs", "general consumer") |
| `source_refs` | string[] | yes (min 1, except marketing_copy) | artifact IDs of findings/research/analysis informing the content |
| `word_count` | integer | yes | computed from content |
| `format_version` | string | no | semantic version if iterating |
| `topic_tags` | string[] | no | searchability |
| `prior_content_refs` | string[] | no | related/predecessor content for continuity |

#### `report` — long-form structured document

**Additional metadata:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `sections` | string[] | yes | section headings (exec summary, body sections, recommendations) |
| `executive_summary` | string | yes | 3-5 sentence summary (also appears in content) |
| `recommendations` | string[] | no | actionable items |
| `confidence` | enum | no | `high`, `medium`, `low` overall |

**Tool:** `record_report`

#### `guide` — instructional / how-to

**Additional metadata:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `prerequisites` | string[] | no | what reader needs to know/have first |
| `steps_count` | integer | yes | number of steps |
| `outcome` | string | yes | what the reader achieves |
| `difficulty` | enum | no | `beginner`, `intermediate`, `advanced` |

**Tool:** `record_guide`

#### `article` — blog post / editorial

**Additional metadata:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `angle` | string | yes | the argument or perspective |
| `platform` | string | yes | target publishing platform |
| `tone` | string | no | e.g., `analytical`, `conversational`, `provocative` |
| `seo_keywords` | string[] | no | target search terms |

**Tool:** `record_article`

#### `marketing_copy` — landing page / ad / email / social

**Additional metadata:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `platform` | string | yes | e.g., `landing_page`, `email`, `twitter`, `linkedin`, `meta_ad` |
| `call_to_action` | string | yes | the ask |
| `format_constraints` | object | no | character/word limits (e.g., `{ max_chars: 280 }`) |
| `variants` | string[] | no | A/B test variant labels |
| `source_refs` | string[] | no (min 0) | optional — copy may be original |

**Tool:** `record_marketing_copy`

#### `newsletter` — curated digest

**Additional metadata:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `issue_number` | integer | no | sequential issue |
| `cadence` | enum | yes | `daily`, `weekly`, `biweekly`, `monthly`, `ad_hoc` |
| `sections` | string[] | yes | digest sections (e.g., top stories, deep dive, links) |
| `featured_items` | string[] | yes | artifact IDs of featured content |

**Tool:** `record_newsletter`

### QA — kinds and schemas

#### `artifact_review` — review of a single agent output

(Subsumes the existing qa-verdict template)

**Artifact content:** verdict text + findings list

**Metadata fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `verdict` | enum | yes | `pass`, `fail`, `escalate` |
| `artifact_under_review` | string | yes | artifact ID being reviewed |
| `producing_agent` | string | yes | which agent produced it |
| `source_issue` | string | yes | Paperclip issue ID |
| `output_template` | string | yes | which output template was expected (e.g., `research-output`) |
| `standards_applied` | string[] | yes | list of quality standards checked |
| `checklist` | object | yes | named checks → boolean (template conformance, scope, attribution, accuracy, threshold, no contradictions, metadata) |
| `findings` | object[] | no | list of `{ severity, location, standard, detail, expected }` |
| `metrics` | object | yes | `{ critical: n, major: n, minor: n, total: n }` |
| `brief_ref` | string | no | artifact ID of original brief |

**Tool:** `record_artifact_review`

#### `plan_review` — review of a spec/plan before execution

**Artifact content:** review text + risk inventory

**Metadata fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `verdict` | enum | yes | `go`, `no_go`, `conditional` |
| `plan_under_review` | string | yes | artifact ID or path of plan/spec being reviewed |
| `gate_checklist` | object | yes | spec gate items from CLAUDE.md → boolean (intent stated, context package, behavioral contracts, edge cases, definition of done, open questions empty, negative space) |
| `risk_inventory` | object[] | yes | list of `{ risk, likelihood, impact, mitigation }` |
| `feasibility_score` | enum | no | `high`, `medium`, `low` |
| `unresolved_questions` | string[] | no | questions that must be answered before execution |
| `conditions` | string[] | no | required conditions if verdict is `conditional` |
| `source_issue` | string | no | Paperclip issue ID if applicable |

**Tool:** `record_plan_review`

#### `stage_gate` — pipeline phase transition review

**Artifact content:** gate verdict + blocking issues

**Metadata fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `verdict` | enum | yes | `pass`, `block`, `conditional_pass` |
| `from_stage` | string | yes | upstream stage (e.g., `research`, `draft`) |
| `to_stage` | string | yes | downstream stage (e.g., `analysis`, `publish`) |
| `inputs` | string[] | yes | artifact IDs entering the gate |
| `gate_criteria` | object | yes | named criteria → boolean |
| `blocking_issues` | object[] | no | list of `{ issue, severity, owner_agent }` |
| `conditions` | string[] | no | required if `conditional_pass` |
| `source_issue` | string | no | Paperclip issue ID |
| `prior_gate_ref` | string | no | artifact ID of previous gate review in this pipeline |

**Tool:** `record_stage_gate`

## Edge Case Inventory

| Case | Required behavior |
|------|-------------------|
| Per-agent `workproduct.ts` loads but `AGENT_NAME` is unset | self-gate via `client.getAgentName()`; return without registering |
| Per-agent `workproduct.ts` loads in wrong agent (file accidentally on wrong image) | self-gate via `AGENT_NAME` check at top of register function; log warning, do not register |
| `record_*` called with missing required metadata | `validateByStyle` returns errors; tool returns error text, no write |
| `record_*` called with missing encouraged metadata | tool writes artifact, returns ID + warnings |
| `record_metric` references a `source_query_ref` artifact ID that does not exist | tool writes anyway (referential integrity not enforced at write time); `query_data_products` may surface dangling refs later |
| `query_*` returns zero matches | tool returns "No <kind> match the filters." (matches findings behavior) |
| Large query_result inline content exceeds practical artifact size (>1MB) | record_query_result writes summary JSON inline, requires `result_artifact_ref` for full result |
| Writer `record_marketing_copy` has zero source_refs | allowed (copy may be original); other writer kinds require min 1 |
| QA `record_artifact_review` references an artifact that was deleted | write succeeds; review remains as historical record |
| Workproduct-lib dir is on disk but Pi tries to load `validate.ts` as extension | `validate.ts` has no default export; Pi will skip or error gracefully — verify with smoke test |
| Multiple agents' workproduct.ts files write to overlapping artifact types | by design — `type: "finding"`, `type: "metric"`, `type: "report"` etc. are disjoint per kind |
| Existing findings written under old layout | metadata unchanged; new code reads same shape via same `client.read()` calls |

## Definition of Done

- [ ] `src/agents/extensions/workproduct/` renamed to `workproduct-lib/` with no `index.ts`
- [ ] `validate.ts`, `ulid.ts`, `templates/` retained under `workproduct-lib/`
- [ ] New `workproduct-lib/schemas.ts` extracts `SourceReliability`, `InformationCredibility`, `SourceType`, `CollectionMethod`, `Corroboration`, `SourceSchema`, plus new shared types (`ArtifactRef`, `ISODate`)
- [ ] `src/agents/researcher/.pi/agent/extensions/workproduct.ts` registers findings tools (logic moved verbatim from old index.ts, imports updated)
- [ ] `src/agents/data/.pi/agent/extensions/workproduct.ts` registers `record_dataset_ref`, `record_query_result`, `record_metric`, `record_chart`, `query_data_products`, `get_data_product`
- [ ] `src/agents/writer/.pi/agent/extensions/workproduct.ts` registers `record_report`, `record_guide`, `record_article`, `record_marketing_copy`, `record_newsletter`, `query_content`, `get_content`
- [ ] `src/agents/qa/.pi/agent/extensions/workproduct.ts` registers `record_artifact_review`, `record_plan_review`, `record_stage_gate`, `query_assessments`, `get_assessment`
- [ ] All record tools use `validateByStyle` (or equivalent kind-based variant) for required/encouraged validation
- [ ] All artifacts written via `client.write()` with `type` set to the kind name (`finding`, `dataset_ref`, `query_result`, `metric`, `chart`, `report`, `guide`, `article`, `marketing_copy`, `newsletter`, `artifact_review`, `plan_review`, `stage_gate`)
- [ ] Query tools filter by agent's own kinds (e.g., `query_data_products` lists `dataset_ref|query_result|metric|chart` only)
- [ ] Dockerfile unchanged
- [ ] Per-agent pi-permissions.jsonc updated to allow agent's own workproduct tools (deny remains for others, though they won't be loaded)
- [ ] Templates updated: add `outputs/data-product.md`, `outputs/report.md`, `outputs/guide.md`, `outputs/article.md`, `outputs/marketing-copy.md`, `outputs/newsletter.md`, `outputs/plan-review.md`, `outputs/stage-gate.md`
- [ ] Unit tests: `tests/workproduct/data-test.mjs`, `tests/workproduct/writer-test.mjs`, `tests/workproduct/qa-test.mjs` cover validation and registration paths
- [ ] Existing `tests/workproduct/` findings tests pass after relocation (path updates only)
- [ ] Smoke test confirms each agent container loads its workproduct extension at startup (check logs for tool registration)
- [ ] Reasoning trace written
- [ ] Assumption log written
- [ ] `tasks/todo.md` plan items checked off

## Negative Space

**Must not change:**
- Artifact service API or schema
- Findings storage format (existing findings still readable)
- `validate.ts` function signature
- Dockerfile structure
- pi-permissions.jsonc DENY rules for cross-agent tools (still deny invoke_agent, create_issue for executors, etc.)
- Templates that aren't being added — leave existing templates as-is

**Out of scope:**
- Cross-agent workproduct sharing tools (writer querying findings happens via universal `list_artifacts` / `read_artifact`, no new tool needed)
- Workproduct lifecycle (versioning, supersession) — separate spec if needed
- UI for browsing workproducts — artifact service has no UI; out of scope
- Migration of existing artifacts (the only existing kind is `finding`; no migration needed)
- Validation of referential integrity (e.g., `source_query_ref` points to a real artifact)
- Auto-rendering of charts to PNG/SVG — `rendered_artifact_ref` is optional pointer for when caller renders externally
- Publisher agent workproducts — defer until publisher is fleshed out (currently a stub stage in Dockerfile)
- Coder agent workproducts — defer; coder produces code, which is already a first-class artifact concept (commits, files); separate spec if needed

**Reserved for human review:**
- Whether `query_result` inline threshold should be 100 rows or different
- Whether `marketing_copy` `source_refs` should require min 1 instead of 0 in some contexts
- Final enum values for `chart_type`, `cadence`, `difficulty`, `tone`
- Whether to add `record_dataset_join` for derived datasets (decided: out of scope; use `record_query_result` instead)

## Open Questions

(empty — proceed to implementation)
