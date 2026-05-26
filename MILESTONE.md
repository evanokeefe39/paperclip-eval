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

- [ ] CEO creates sub-issues and delegates without manual intervention
- [ ] Researcher completes Instagram and TikTok research via Paperclip tools
- [ ] Writer synthesizes final report from Researcher output
- [ ] All status transitions happen through Paperclip (checkout → in_progress → done)
- [ ] Agents follow Paperclip skill conventions (heartbeat procedure, comments, status updates)

### Blockers found during execution

- Paperclip hostname rejection for Docker-internal requests (`tasks/issues/paperclip-hostname-rejection.md`) — workaround applied
- `wakeOnDemand` not auto-invoking agents on issue assignment (`tasks/issues/wake-on-demand-not-triggering.md`) — under investigation
- Paperclip skills not yet injected into HTTP adapter agents — in progress (bridge.mjs skill loading added)

### Status

In progress. CEO has created EVA-1 (parent) with sub-issues EVA-2 (IG research), EVA-3 (TikTok research), EVA-4 (report synthesis). Agents registered, API key auth working. Skills injection in progress.

---

## M1: Social Media Trend Analysis for the Developer Space

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
