# Milestones

## M0: Faceless Channel Analysis (Platform Proof-of-Concept)

### What

Small-scope analysis of faceless Instagram and TikTok content channels. CEO delegates research to Researcher, Researcher gathers data, Writer synthesizes a report. The analysis itself is useful but secondary — the primary goal is proving multi-agent orchestration works through Paperclip.

### Why

Before tackling M1 (full social media trend analysis across 5+ platforms), validate that the foundational plumbing works:

- Agents receive tasks from Paperclip, do work, and report back
- CEO can decompose a goal into sub-issues and delegate to specialized agents
- Agents use Paperclip skills to follow the heartbeat procedure (checkout, work, update, release)
- Inter-agent handoffs work (Researcher completes → Writer picks up)
- Artifacts flow between agents via shared volume
- The full cycle completes without manual intervention beyond the initial issue creation

### Scope

- 10-15 faceless Instagram accounts across niches (motivation, finance, AI art, tutorials, nature)
- 10-15 faceless TikTok accounts across similar niches
- Per account: follower count, posting frequency, content format, engagement patterns
- Cross-platform comparison and top 5 actionable insights

### Deliverables

- Structured data per account in `/artifacts/faceless-analysis/`
- Cross-platform comparison
- Recommended niche + content strategy

### Success criteria

- [x] CEO creates sub-issues and delegates without manual intervention
- [x] Researcher completes Instagram and TikTok research via Paperclip tools
- [ ] Writer synthesizes final report from Researcher output
- [x] All status transitions happen through Paperclip (checkout → in_progress → done)
- [x] Agents follow Paperclip skill conventions (heartbeat procedure, comments, status updates)

### Blockers resolved during execution

- Paperclip hostname rejection for Docker-internal requests (`tasks/issues/paperclip-hostname-rejection.md`) — workaround applied
- `wakeOnDemand` not auto-invoking agents on issue assignment (`tasks/issues/wake-on-demand-not-triggering.md`) — heartbeat polling used instead
- Paperclip skills not yet injected into HTTP adapter agents — bridge.mjs skill loading added
- HTTP adapter payload mismatch — bridge was reading wrong fields, fixed to read `body.context`
- CEO had work tools loaded — removed, now coordination-only

### Issues observed

These are agent behavior and subsystem wiring issues, not platform issues. The platform proof-of-concept succeeded.

1. **CEO doing work instead of delegating** — even after removing work tools, CEO sometimes attempted research directly rather than decomposing and assigning to specialists
2. **Researcher not writing structured findings** — Researcher did web research but didn't persist results using the findings/workproduct system, leaving output only in Paperclip issue comments
3. **Writer couldn't produce report** — without structured findings artifacts to consume, Writer had no usable input and couldn't synthesize a proper deliverable

These issues are addressed in M0.1.

### Status

Complete (with caveats). 2026-05-27. Platform orchestration validated — agents register, receive tasks, heartbeat, delegate, and transition status through Paperclip. Writer synthesis failed due to upstream findings format issues. See M0.1 for the subsystem-wiring follow-up.

---

## M0.1: Faceless Channel Analysis (Subsystems Wired)

### What

Same brief as M0 — faceless Instagram and TikTok channel analysis. But this time every subsystem is wired correctly: structured logging, standardized workproducts, proper artifact storage, permissions without the BRIDGE_EXTENSIONS hack, and full observability. The analysis should complete end-to-end with no manual intervention beyond the initial issue.

### Why

M0 proved the platform works. M0.1 proves the agents work as a system. The gap between "agents can talk to Paperclip" and "agents produce useful output" is subsystem integration: logging so we can debug, findings so researchers produce consumable output, artifacts so work products flow between agents, permissions so each agent has exactly the tools it needs.

### What changed since M0

- BRIDGE_EXTENSIONS env var replaced with 2-layer permissions model (agent config + bridge defaults)
- Findings extension writes ADMIRALTY-graded structured findings via workproduct system
- Logging extension emits structured logs to Aspire Dashboard via OTel
- Artifacts written to shared volume with standardized paths and metadata

### Scope

Same as M0:
- 10-15 faceless Instagram accounts across niches
- 10-15 faceless TikTok accounts across similar niches
- Per account: follower count, posting frequency, content format, engagement patterns
- Cross-platform comparison and top 5 actionable insights

### Success criteria

- [ ] CEO delegates all research work — zero direct work execution by CEO
- [ ] Researcher writes structured findings using workproduct/findings system (ADMIRALTY-graded, JSONL-persisted)
- [ ] Writer reads Researcher findings from artifacts and synthesizes report
- [ ] Final report delivered as artifact with cross-platform comparison and actionable insights
- [ ] All agents produce structured logs visible in Aspire Dashboard
- [ ] Permissions use 2-layer model — no BRIDGE_EXTENSIONS env var
- [ ] Workproducts follow standardized format (ULID, session ID, validated fields)
- [ ] Artifacts stored at standardized paths under `/artifacts/{agent}/`
- [ ] Full agent turn traces visible in Aspire Dashboard (LLM calls, tool executions, timing)
- [ ] No manual intervention beyond initial issue creation

### Prerequisites

- Logging extension operational (OTel → Aspire)
- Findings extension writes valid workproducts
- 2-layer permissions deployed (commit 85d6249)
- Agent prompts updated to enforce delegation (CEO) and findings output (Researcher)

### Status

Not started. Blocked on verifying all subsystems are individually functional before running the full brief.

---

## M1: Artifact Store v2 (Bun Service + Postgres + MinIO)

### What

Replace the bind-mounted `./artifacts` directory and `.meta.json` sidecar files with a proper artifact store: Bun-based REST service, MinIO for blob storage, Postgres for metadata. Agents interact over HTTP — no direct filesystem, database, or S3 connections from extensions.

### Why

Every downstream milestone depends on reliable, structured artifact storage. The current v1 approach (shared Docker volume, sidecar JSON files, filesystem walks) doesn't scale to multi-agent workflows with RBAC, cross-agent discovery, or durable storage that survives stack teardown. This is the infrastructure gate for M2 and beyond.

### Spec

`tasks/specs/artifact-store-v2.md`

### Scope

- Postgres container (shared instance for Paperclip + artifact metadata)
- MinIO container (S3-compatible blob storage)
- Bun artifact service (`src/artifact-service/`) with 4 routes: write, read, list, health
- RBAC via `rbac.json` (application-level, agent identity from X-Agent-Name header)
- `artifacts.ts` rewritten as thin HTTP client (~100 lines, down from 354)
- `artifact://` URI scheme for cross-agent references
- docker-compose updated with new containers, Paperclip on external Postgres
- Bind mount `./artifacts:/artifacts` removed from all agents

### Success criteria

- [ ] `docker compose up -d` brings up full stack from clean state (Postgres, MinIO, artifact service, Paperclip, agents)
- [ ] Paperclip runs correctly on external Postgres
- [ ] Agent writes artifact via `write_artifact` → gets `artifact://` URI back
- [ ] Another agent reads artifact via `read_artifact` with that URI
- [ ] `list_artifacts` returns filtered results from artifact service
- [ ] RBAC enforced (agent can't write outside own namespace, read rules respected)
- [ ] MinIO Console at :9001 shows stored blobs
- [ ] Existing tests updated for v2 behavior

### Status

Spec complete. Implementation not started.

---

## M2: Social Media Trend Analysis for the Developer Space

### What

Produce a thorough analysis of the developer / creator / indie dev / solopreneur space on social media. Cover four dimensions:

1. **Trends** — what topics, formats, and content strategies are gaining momentum across platforms (X/Twitter, LinkedIn, YouTube, Bluesky, Threads)
2. **Established growth accounts** — who has sustained growth, what patterns and templates they use
3. **Fast-rising new accounts** — who is new but growing disproportionately fast, what they are doing differently
4. **Legacy accounts** — long-established accounts, how their strategies have evolved or stagnated

### Why

Two reasons:

- **Platform proof** — this is the first real research task run through Paperclip with our agents. Completing it validates the orchestration pipeline end to end.
- **Content intelligence** — the findings directly inform content strategy when it is time to start posting. Knowing what works, what is saturated, and where the gaps are before entering the space.

### Deliverables

- Trend report with supporting data points
- Account taxonomy (established / fast-rising / legacy) with examples
- Pattern library of content templates and growth tactics
- Actionable recommendations for someone entering or scaling in this space

### Success criteria

- [ ] Agents can discover and profile accounts across at least two platforms
- [ ] Trend detection produces non-obvious insights (not just "AI is popular")
- [ ] Account categorization is defensible with data
- [ ] Pattern library contains at least 10 distinct, replicable templates
- [ ] Final report is useful to someone entering the space cold

### Status

Not started.

---

## M3: AI Model Intelligence Pipeline

### What

A recurring agent-driven intelligence system that tracks, analyzes, and reports on the LLM/AI model landscape. The agent workforce (CEO orchestrating, Researcher investigating, Writer synthesizing) produces regular intelligence briefs covering what models people are actually using, why those models are winning, and what challengers are emerging — with a deliberate emphasis on the non-incumbent story: sovereign AI, open-source, and self-hosted setups that compete with or undercut subscription-model flagships.

### Why

The model landscape shifts weekly. Frontier labs (Anthropic, OpenAI, Google) dominate mindshare but the competitive story is broader — QWEN, DeepSeek, Mistral, Llama derivatives, and regional players are shipping competitive capabilities at different cost and sovereignty points. Understanding _what is actually being used and why_ is intelligence you can't get from benchmark leaderboards. This system turns the agent workforce into a standing research capability that surfaces the real adoption story, not just the marketing one.

### Dimensions

1. **Adoption leaders** — most-used models across inference APIs (OpenRouter, Together, Groq, Replicate), community platforms (Hugging Face, Ollama downloads), and enterprise channels. What are people _actually_ calling, not just benchmarking?
2. **Why they win** — per-model analysis: price-performance positioning, capability niche (coding, long-context, multilingual, vision), ecosystem moats (tool calling reliability, structured output quality, agent-framework integrations). What makes a model the default choice for a use case?
3. **How they're used** — emerging usage patterns: agentic coding workflows, RAG pipelines, fine-tuning for domain-specific tasks, multi-model routing, local-first stacks. What workflows are people building around these models?
4. **Challenger models** — non-incumbent models shipping competitive capabilities at lower cost or with open weights: QWEN (Qwen3, Qwen-Agent), DeepSeek (V3, R1), Mistral (Large, Codestral), Llama derivatives, Cohere Command R, AI21 Jamba, and regional sovereign models (EU, Middle East, Asia-Pacific)
5. **Sovereign AI & open-source** — national/regional AI strategies, government-funded model development, open-weight model ecosystems, deployment infrastructure (vLLM, TGI, Ollama, llama.cpp). Which sovereign/open setups are genuinely competitive with closed subscription APIs?
6. **Self-hosting economics** — cost comparison: running a competitive open model on your own hardware (consumer GPUs, cloud GPU instances, dedicated inference servers) vs. paying per-token to a closed API. Break-even analysis, latency tradeoffs, operational overhead

### Deliverables (recurring)

- **Weekly brief** — executive summary of significant model releases, adoption shifts, and ecosystem news (2-3 paragraphs, top 5 bullets)
- **Monthly deep-dive** — detailed report on one dimension (rotating): adoption patterns, challenger profile, self-hosting economics, sovereign AI landscape
- **Model comparison card** — standardised comparison format for each tracked model: provider, weights (open/closed), context window, standout capabilities, pricing (input/output per 1M tokens), self-host viability, ecosystem support
- **Competitive displacement tracker** — instances where an open/local model replaces a closed API in a documented production use case, with before/after economics

### Success criteria

- [ ] Goal created in Paperclip with projects for each dimension (adoption tracking, challenger analysis, self-hosting economics, sovereign AI)
- [ ] CEO decomposes goal into recurring issues with appropriate cadences (weekly brief, monthly deep-dive)
- [ ] Researcher can discover and track model releases, community adoption signals, and self-hosting stories across web, GitHub, Hugging Face, and Reddit/HN
- [ ] Writer produces standardised model comparison cards with consistent format
- [ ] At least 3 weekly briefs delivered with actionable intelligence (not just release-notes rehash)
- [ ] At least 1 monthly deep-dive completed on a dimension the user picks
- [ ] Self-hosting cost comparison delivers concrete before/after economics for at least 2 model families (e.g., Llama 3 vs. GPT-4o, QWEN vs. Claude)
- [ ] Competitive displacement tracker surfaces at least 3 documented real-world migrations

### Agent roles

- **CEO** — maintains the goal/project structure, decomposes work into issues, reviews completed briefs before release, adjusts scope based on user feedback
- **Researcher** — monitors model release channels, scrapes adoption data, gathers self-hosting experiences and economics, surfaces non-obvious signals
- **Writer** — synthesizes Researcher output into standardized briefs, comparison cards, and deep-dive reports with consistent formatting
- **QA** (optional, M3.1) — fact-checks claims, verifies pricing/benchmark data, validates comparison card accuracy

### Paperclip structure

- **Goal**: "AI Model Intelligence" — the standing intelligence capability
- **Projects**:
  - "Adoption & Trends" — weekly briefs, adoption tracking, usage patterns
  - "Challenger Deep-Dives" — monthly profile of a specific competitor model or ecosystem
  - "Self-Hosting Economics" — cost comparisons, break-even analysis, infrastructure guides
  - "Sovereign AI Watch" — regional model development, government AI strategies, open-weight ecosystem health
- **Issues**: recurring (weekly brief, monthly deep-dive rotation) and ad-hoc (model launch triggered, competitive displacement surfaced)

### Status

Not started. Awaiting M1 (artifact store v2) and M0.1 (subsystems wired) completion before agents can reliably run recurring intelligence workflows.

---

## M4: YouTube Revenue Intelligence — Faceless Channels & Ambience Niche

### What

A two-phase research project analyzing the revenue mechanics of faceless YouTube channels, starting with a wide survey across multiple niches and then drilling deep into the "cozy ambience" category (lo-fi music streams, 8-hour ambient soundscapes, study/sleep/rain videos). The end goal is a complete revenue picture: how much money these channels make, what the TAM is, what the unit economics look like, and where the unexploited opportunities are.

### Why

Faceless YouTube channels — particularly long-duration ambience content — are a low-creation-effort, high-consumption-volume format. A single 8-hour lo-fi stream can run for months with minimal upkeep while generating steady ad revenue. Understanding the real economics (not the creator-hype numbers) tells us:

- Whether this is a saturated cash cow or still has entry points
- What revenue per 1K views actually looks like in this niche (CPM varies wildly by niche)
- Whether AI-generated ambience content can compete with curated/human-produced channels
- What adjacent revenue models (playlist licensing, sleep apps, white-label ambient music) are viable

### Sample reference

[Cozy Coffee Shop Ambience 8HR](https://www.youtube.com/watch?v=8EM7btM7-XQ) — typical of the format: long duration, atmospheric, low production complexity, comment sections full of studying/working/sleeping viewers. Channels in this space often run multiple 24/7 live streams simultaneously.

### Phases

**Phase 1 — Wide Survey (faceless channels across niches)**

Cross-niche scan of faceless YouTube channels to establish baselines: which niches exist, what revenue ranges they operate in, what the content production models look like. Niches to cover:

- Ambience / background sound (lo-fi, rain, fireplace, nature sounds, ASMR-adjacent)
- Motivational / stoic clips (voiceover over stock footage)
- AI-narrated explainers (science, history, philosophy, true crime)
- Compilation channels (fail compilations, satisfying videos, oddly satisfying)
- Faceless tutorial / how-to (software tutorials with screen capture, cooking with overhead cam only)
- Meditation / sleep / wellness
- Kids content (nursery rhymes, sensory videos — high view counts, unique monetization rules)
- Finance / business (animated charts + AI voiceover)

Per niche: estimated channel count, median view counts, estimated CPM range, content production cost, barrier to entry, saturation assessment, top 3-5 exemplar channels with estimated monthly revenue.

**Phase 2 — Deep Dive: Cozy Ambience / Lo-Fi / Soundscape Niche**

Focused analysis of the specific category the user identified. Sample channel archetypes:

- Lo-fi hip hop streams (e.g., Lofi Girl and competitors)
- Coffee shop / jazz ambience (8+ hour videos of ambient cafe sounds)
- Nature soundscapes (rain on window, ocean waves, forest birdsong, 8–12 hour loops)
- Seasonal ambience (Christmas fireplace, autumn coffee shop, Halloween storm)
- Study / focus / pomodoro timers with ambient background
- Sleep music / white noise / brown noise (often 8–12 hours)
- Fantasy / RPG ambience (tavern sounds, wizard study, medieval village)

Deep-dive analysis per sub-niche:

- **Revenue estimation** — views × estimated CPM ($2–$8 range for ambience, verify with available data), plus Super Chat/Thanks for live streams, channel memberships, affiliate links, playlist/publishing royalties
- **TAM calculation** — total views across the niche, extrapolated revenue range, growth trajectory (YouTube search trends, upload volume over time)
- **Unit economics** — content production cost (stock footage licensing, music licensing or AI generation, editing time), hosting/running costs for 24/7 streams, break-even timeline for a new channel
- **Competitive landscape** — top 10–15 channels by estimated revenue, what differentiates them (branding, music curation, visual style, upload consistency), who is growing vs. stagnating
- **Platform dynamics** — YouTube algorithm treatment of long-duration content, monetization eligibility (4K watch hours threshold is trivially met by this format), Content ID and copyright risk for music-based channels, recent policy changes affecting ambient content

### Deliverables

- **Phase 1 report** — faceless channel landscape: niche taxonomy, revenue ranges, entry barriers, exemplar channels across all 8 niches
- **Phase 2 report** — deep-dive on cozy ambience / lo-fi / soundscape niche: revenue estimates per sub-niche, TAM, unit economics, competitive landscape, platform risk factors
- **Opportunity map** — specific, ranked revenue generation ideas derived from the research:
  - New channel concepts (underserved sub-niche × format combinations)
  - Adjacent revenue models (licensing ambient tracks to apps/platforms, white-label ambient music for businesses, playlist curation services)
  - AI-enabled production advantages (AI-generated ambient music, procedural video generation, automated multi-platform distribution)
  - Platform arbitrage (YouTube → Spotify playlists, YouTube → sleep/meditation apps, YouTube → in-store ambient systems)
- **Example channel P&L** — pro forma for launching a new channel in the highest-opportunity sub-niche, with startup costs, timeline to monetization, and month-12 revenue projection

### Success criteria

- [ ] Phase 1 covers at least 6 of the 8 target niches with data-backed revenue estimates
- [ ] At least 3 exemplar channels per niche with estimated monthly revenue ranges
- [ ] Phase 2 deep-dive analyzes at least 4 of the 7 ambience sub-niches
- [ ] TAM estimate for the cozy ambience niche backed by observable data (view counts, channel counts, trend data)
- [ ] Revenue estimates per channel are transparent about methodology (CPM assumptions sourced, view-count methodology explained, known limitations called out)
- [ ] Opportunity map contains at least 8 specific, ranked ideas — not generic "make a channel" suggestions but concrete sub-niche × format × revenue model combinations
- [ ] Example channel P&L has realistic startup costs (tooling, assets, hosting) and month-12 revenue projection with pessimistic/base/optimistic scenarios
- [ ] Final report is actionable: someone with production capability could use it to pick an opportunity and start executing

### Agent roles

- **CEO** — decomposes milestone into Phase 1 and Phase 2 issues, assigns to Researcher, reviews intermediate findings, adjusts scope based on early data, synthesizes final opportunity map from Researcher + Writer output
- **Researcher** — scrapes YouTube channel data (view counts, upload frequency, subscriber growth), gathers CPM intelligence by niche (ad buyer data, creator disclosures, industry reports), profiles exemplar channels, estimates revenue, maps competitive landscape
- **Writer** — produces Phase 1 and Phase 2 reports from Researcher data, formats channel comparison tables, writes the opportunity map in actionable language, builds the example channel P&L
- **Data** (optional, M4.1) — automated scraping of YouTube channel metadata at scale, trend analysis using YouTube Data API, view-count time series for growth trajectory analysis

### Paperclip structure

- **Goal**: "YouTube Revenue Intelligence" — understand the faceless content economy
- **Projects**:
  - "Faceless Channel Survey" — Phase 1 wide scan across niches
  - "Ambience Niche Deep-Dive" — Phase 2 focused analysis of cozy lo-fi / soundscape / ambience content
  - "Revenue Opportunity Map" — synthesis of findings into actionable opportunities
- **Issues**: 
  - Research issues per niche (Phase 1: 8 niche research tasks, can run in parallel)
  - Research issues per sub-niche (Phase 2: 7 sub-niche deep-dives, can run in parallel after Phase 1)
  - Synthesis issues (cross-niche comparison report, TAM calculation, opportunity ranking, P&L model)
  - Review issue (CEO validates findings, sends back gaps)

### Risks and unknowns

- **CPM opacity** — YouTube doesn't publish per-video CPM; estimates come from ad buyer benchmarks, creator self-disclosure, and industry surveys. Revenue numbers will be ranges, not precise figures.
- **Channel revenue attribution** — high-view-count channels may have additional revenue (sponsorships, Patreon, merch) not visible from YouTube data alone. Estimates will be conservative.
- **Content ID / copyright** — music-based channels live in a complex copyright environment. Some channels license music legitimately; others operate in gray areas. This affects startup risk for new channels.
- **YouTube algorithm shifts** — historical performance doesn't guarantee future results. Platform changes (e.g., mid-roll ad policy updates, monetization threshold changes) can reshape niche economics overnight.

### Status

Not started. Depends on M1 (artifact store v2) and M0.1 (subsystems wired). Researcher needs web scraping capabilities (T2–T3) and YouTube Data API tooling for Phase 1/2 scale.
