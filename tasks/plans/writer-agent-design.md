# Writer Agent Design — Model Selection & Document Generation

## Status: Research / Design

## Problem

Writer agent needs to produce large structured documents (research reports, strategy briefs)
from material gathered by Researcher and Data agents. Current config is a bare scaffold —
no document generation strategy, no context window management, no model tuning for writing tasks.

Key challenges:
- Input material may exceed context window (multiple research reports, scraped data sets)
- Output documents need structural coherence across sections
- Quality must be high enough for human consumption without heavy editing
- Must work within free-tier model constraints

## Research Findings

### Pattern: Skeleton-of-Thought (SoT)

Source: Microsoft Research / ICLR 2024

Two-stage process:
1. **Skeleton stage** — LLM generates outline with 3-10 points, each 3-5 words
2. **Point-expanding stage** — each skeleton point expanded in parallel (concurrent API calls or batched decoding)

Performance: 1.95-2.27x speedup on knowledge/generic/roleplay tasks.

Limitation: not suited for step-by-step reasoning or very short answers. Works well for
report-style documents where sections are relatively independent.

**Applicability to Writer agent**: High. Research reports and strategy briefs are exactly
the structured-sections-from-outline pattern SoT targets. Each section can reference the
same source material but produce independent prose.

### Pattern: DeepAgents / Supervisor-Worker File-Based Communication

Source: LangChain Deep Agents architecture

Key principles:
- **Supervisor** creates document plan, assigns sections to sub-agents
- **Sub-agents write to intermediate files**, not chat — "context quarantine"
- Sub-agents report completion status only, not content, back to supervisor
- Final tool stitches intermediate files into complete document
- Each sub-agent gets clean context with only the material it needs

**Applicability**: This maps directly to Pi's subagent extension + /artifacts filesystem.
Writer agent as supervisor, Pi subagents for section expansion, artifacts for intermediate files.

### Pattern: Context Compression for Large Inputs

Strategies from research:
- Chunked/offset-based reads — don't load entire source files
- Summarize previous interactions, filter stale info
- Search/retrieval within source material rather than dumping everything in context
- Each sub-agent gets only the subset of source material relevant to its section

**Applicability**: Critical. Researcher deep-research output can be very large. Writer
should not ingest everything — should query/retrieve relevant sections per outline point.

### Model Selection for Long-Form Writing (Free Tier)

Current landscape (2026):
- **DeepSeek V3/V4**: Best overall open-source. V4 supports 1M context, 384K output tokens.
  Excels at "complex narratives blending analytical depth with engaging storytelling."
- **Qwen3-235B-A22B**: Top recommendation for creative writing
- **DeepSeek-chat**: Current default in Writer config. Solid but not optimized for long-form
- **Llama 4 Scout**: 10M token context but weaker on prose quality
- **Groq/Cerebras**: Fast inference but smaller context windows, less suited for long documents

## Execution Model

### Why 1 Invocation Per Document

Paperclip has no durable execution. Each POST /invoke to bridge.mjs spawns a fresh
Pi process — stateless, atomic, 120s default timeout (configurable via BRIDGE_TIMEOUT_MS).
If invocation dies mid-task, no state is preserved at the platform level.

However, issue-level state and /artifacts persist across invocations. This means:

- **1 invocation per document** — CEO creates N issues (one per doc), Writer processes independently
- If doc 3 of 5 fails, only that issue is affected. Other 4 proceed or already succeeded.
- Parallelism is natural: multiple Writer invocations can run concurrently on different issues
- Resume is natural: next invocation checks /artifacts for partial progress

**N docs in 1 invocation is wrong** because:
- Single timeout governs all docs — one slow section kills entire batch
- No partial progress reporting to Paperclip (issue stays "in progress" until all N finish or fail)
- Context bloat — tracking state for N documents in one LLM conversation
- Failure blast radius: one doc error can corrupt context for remaining docs

### Checkpoint-Based Resumability

Pattern borrowed from deep-research extension. Writer writes a manifest as it progresses:

```
/artifacts/{context}/
  manifest.json          <- checkpoint: tracks pipeline stage + completed sections
  skeleton.json          <- output of PLAN step
  sections/
    01-introduction.md   <- completed section
    02-methodology.md    <- completed section
    03-findings.md       <- in progress (partial or missing = resume point)
  draft.md               <- output of STITCH step (only exists if all sections done)
  final.md               <- output of POLISH step
```

manifest.json schema:
```json
{
  "doc_style": "report",
  "stage": "expand",
  "skeleton_done": true,
  "sections_total": 6,
  "sections_done": ["01-introduction", "02-methodology"],
  "stitch_done": false,
  "polish_done": false,
  "created_at": "...",
  "updated_at": "..."
}
```

On invocation, Writer checks for existing manifest:
- No manifest → fresh start from PLAN
- Manifest with stage "expand" → resume from first missing section
- Manifest with stage "stitch" → skip to STITCH
- Manifest with stage "polish" → skip to POLISH

This survives timeout, OOM, or any other mid-flight failure. Next invocation
picks up where the last one died. CEO can re-invoke Writer on same issue and
it resumes automatically.

### Timeout Considerations

Default 120s may be tight for large documents. Options:
- Increase BRIDGE_TIMEOUT_MS for Writer container (e.g. 300s)
- Or: design pipeline so each step fits within 120s (PLAN is fast, each EXPAND
  subagent is one section, STITCH and POLISH read completed files)
- Checkpoint granularity means even if timeout hits mid-EXPAND, completed sections
  are already on disk. Next invocation resumes from the gap.

### Proposed Architecture

#### Document Generation Pipeline

```
Input: Source material paths in /artifacts (from Researcher + Data agents)
       doc_style hint (freeform string)
       Issue ID (for artifact namespacing)

Step 0 — RESUME CHECK
  Read /artifacts/{context}/manifest.json
  If exists, skip to appropriate stage
  If not, proceed to PLAN

Step 1 — PLAN (model role: plan)
  Writer reads source material summaries (not full content)
  Generates document skeleton: title, section headings, 2-3 bullet objectives per section
  Identifies which source files are relevant to each section
  Interprets doc_style hint to set section count, depth, tone
  Writes skeleton.json + updates manifest (stage: "expand")

Step 2 — EXPAND (model role: default, concurrent via subagents)
  For each skeleton section not already completed:
    Spawn Pi subagent with:
      - Section heading + objectives
      - Relevant source file paths only
      - Style/tone guidelines
      - Target word count for section
    Subagent writes section to /artifacts/{context}/sections/{n}-{slug}.md
    On completion, update manifest (sections_done += section)
  Checkpoint after each section — survives mid-expand timeout

Step 3 — STITCH (model role: review)
  Writer reads all section files
  Checks coherence, removes redundancy, adds transitions
  Writes draft to /artifacts/{context}/draft.md
  Updates manifest (stage: "polish")

Step 4 — POLISH (model role: default)
  Self-review for formatting integrity only:
    - Broken/mangled URLs
    - Malformed markdown
    - Inconsistent heading levels
    - Orphaned citations
    - Missing section transitions
  No semantic fact-checking (Researcher already scored intel quality upstream)
  Writes final to /artifacts/{context}/final.md
  Updates manifest (stage: "complete", polish_done: true)
  Posts completion comment on Paperclip issue
```

### Input Contract: Intel Quality Scoring

Researcher scores all intel before handoff using NATO ADMIRALTY system:

**Source Reliability** (who provided it):
- A — Completely reliable
- B — Usually reliable
- C — Fairly reliable
- D — Not usually reliable
- E — Unreliable
- F — Cannot be judged

**Information Credibility** (how credible is the content):
- 1 — Confirmed
- 2 — Probably true
- 3 — Possibly true
- 4 — Doubtful
- 5 — Improbable
- 6 — Cannot be judged

Each finding in Researcher output carries a grade (e.g. "B2", "C3"). Writer treats
anything B3 or better as usable without caveat. C3/D2 gets hedging language.
Anything worse is excluded or explicitly flagged as unverified.

### Input Contract: doc_style Parameter

Freeform string hint passed to Writer in task payload. Writer interprets to set
structural parameters. Not an enum — LLM maps the hint to appropriate depth,
section count, and tone. Examples: "report", "executive summary", "briefing note",
"deep-dive guide", "competitive analysis", "strategy memo".

### Model Role Mapping (Writer-Specific)

| Step | Role | Recommended Model | Why |
|------|------|-------------------|-----|
| Plan | `plan` | deepseek-reasoner | Structural thinking, outline quality |
| Expand | `default` | deepseek-chat | Good prose, fast, handles section-sized chunks well |
| Stitch | `review` | deepseek-reasoner | Needs to evaluate coherence across sections |
| Polish | `default` | deepseek-chat | Prose refinement, not heavy reasoning |

### Context Window Strategy

- **Never dump all source material into one context**
- Plan stage: summaries only (first 200 lines of each source, or executive summaries if present)
- Expand stage: each subagent gets only files tagged as relevant to its section
- Stitch stage: reads section outputs only (not original sources)
- Polish stage: reads stitched document only

### Subagent Configuration

Pi subagents via `@ifi/pi-extension-subagents` extension:
- Each gets isolated context (natural "context quarantine")
- File-based communication via /artifacts (matches DeepAgents pattern exactly)
- Concurrent execution — multiple sections expand simultaneously
- Failure isolation — one section failing doesn't corrupt others

## Testing Plan

### Test 1: Skeleton Quality
- Give Writer a mock research dump (3-4 source files in /artifacts)
- Verify skeleton has logical structure, correct section count, clear objectives
- Check source-to-section mapping is reasonable

### Test 2: Section Expansion (Single)
- Give one section skeleton + relevant sources to a subagent
- Verify output quality, adherence to style guidelines, correct citation of sources
- Check word count is within target range

### Test 3: Concurrent Expansion
- Run full skeleton with 4-6 sections expanding concurrently
- Verify all sections complete, no file conflicts
- Check subagent context stays clean (no cross-contamination)

### Test 4: Stitch Coherence
- Take independently written sections
- Verify stitch step adds transitions, removes redundancy
- Check final document reads as unified piece, not stitched fragments

### Test 5: End-to-End
- Full pipeline: source material → skeleton → expand → stitch → polish
- Compare against manually written equivalent for quality baseline
- Measure total token usage and wall-clock time

## Resolved Questions

### Fact-checking is Researcher's job, not Writer's
Writer has no web access and does not fact-check. Researcher scores all intel using
NATO ADMIRALTY system (source reliability + information credibility) before handoff.
Writer trusts the grading — if material is rated below threshold, it was already
excluded or flagged upstream.

Writer's self-review is limited to **formatting integrity**: broken URLs, malformed
markdown, mangled references, inconsistent heading levels, orphaned citations. No
semantic verification.

### Document length is parameterized, not enumerated
Caller passes a freeform `doc_style` hint (e.g. "report", "executive summary",
"deep-dive guide", "briefing note"). Writer interprets the hint to set section count,
target word count per section, and depth of detail. No rigid enum — the LLM maps
the hint to appropriate structural parameters. Examples:

| Hint | Approx Sections | Approx Length |
|------|----------------|---------------|
| summary | 2-3 | 500-1000 words |
| briefing | 3-5 | 1000-2000 words |
| report | 5-8 | 3000-6000 words |
| deep-dive guide | 8-12 | 6000-12000 words |

### Subagent concurrency at 512M is fine
Pi subagents are API-call-bound, not compute-bound. Each subagent is a lightweight
Node process making HTTP calls to external LLM providers — no local model loading.
At 512M container memory, 4-6 concurrent subagents is well within safe limits.
The bottleneck is provider rate limits and API latency, not container memory.
Standard practice for API-orchestrated agent systems.

## Resolved: Multi-Format Output

Not a special case. CEO creates separate issues: one for "report", one for "executive summary",
one for "briefing note" — each with the same source material paths but different doc_style hint.
Writer processes each independently. Natural parallelism if multiple Writer invocations run
concurrently. No need for a single invocation to produce multiple formats.

## Open Questions

- [ ] Should model config diverge from other agents? (Currently all agents share identical models.json)
- [ ] What BRIDGE_TIMEOUT_MS should Writer use? (120s default may be tight for STITCH step on large docs)

## Dependencies

- Writer wired into docker-compose (port TBD, likely 8084)
- Pi subagent extension tested with file-based communication
- /artifacts volume accessible to Writer container
- Source material format standardized (Researcher/Data output contract)

## Sources

- [Skeleton-of-Thought — Microsoft Research](https://www.microsoft.com/en-us/research/blog/skeleton-of-thought-parallel-decoding-speeds-up-and-improves-llm-output/)
- [SoT Paper — ICLR 2024](https://arxiv.org/abs/2307.15337)
- [Multi-Agent Document Generation — HMS Analytics](https://www.analytical-software.de/en/multi-agent-models-for-document-generation/)
- [DeepAgents Long-Horizon Tasks](https://medium.com/@georgekar91/why-your-ai-cant-write-a-100-page-report-and-how-deep-agents-can-3e16f261732a)
- [Context Management in Agent Harnesses — Arize AI](https://arize.com/blog/context-management-in-agent-harnesses/)
- [Context Engineering: Why More Tokens Makes Agents Worse — MorphLLM](https://www.morphllm.com/context-engineering)
- [LangChain Deep Agents](https://blog.langchain.com/deep-agents/)
- [Best Open-Source LLMs 2026 — HuggingFace](https://huggingface.co/blog/daya-shankar/open-source-llms)
- [Best LLM for Creative Writing 2026 — SiliconFlow](https://www.siliconflow.com/articles/en/best-open-source-llm-for-creative-writing-ideation)
- [LlamaIndex Report Generation](https://www.llamaindex.ai/blog/building-blocks-of-llm-report-generation-beyond-basic-rag)
