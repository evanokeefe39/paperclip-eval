# Social Media Research Workflow — Faceless Tech Channels

## Status: Planning

## Objective

Build structured intelligence database of faceless tech channels on Instagram and TikTok.
Understand what works (content formats, posting cadence, engagement patterns, niche selection)
to inform content strategy — either replication or collaboration/advertising opportunities.

## What Good Looks Like

1. Curated list of 50-100 faceless tech channels across both platforms, categorized by niche
2. Per-channel profile: follower count, engagement rate, posting frequency, content format (carousel, reel, static), niche tags, monetization signals
3. Niche analysis: which tech topics have best engagement-to-competition ratio
4. Content pattern report: what formats, hooks, and topics perform best in each niche
5. Actionable brief: recommended niches, content formats, and posting strategy based on data

## Niche Taxonomy

- AI/ML (tools, news, tutorials)
- Cybersecurity (news, tips, breaches)
- Sector investment/finance (fintech, crypto, VC)
- Tech news/opinion (industry commentary)
- Tech lifestyle/entrepreneurship
- Vendor-specific (Claude Code, Codex, OpenAI, Anthropic, etc.)

## Agents Required

| Agent | Role | Docker Status |
|-------|------|---------------|
| CEO | Orchestrate workflow, delegate tasks, synthesize | Running (8081) |
| Researcher | Find channels, deep-research niches, analyze trends | Running (8082) |
| Data | Scrape profiles, extract metrics, structure data | Running (8083) |
| Writer | Compile reports, strategy briefs | Needs wiring |
| Coder | Excluded for now (complex to manage) | N/A |
| QA | Not needed yet (research phase, not publishing) | N/A |
| Publisher | Not needed yet | N/A |

## Paperclip Structure

### Project: Faceless Tech Channel Research
Research and catalog faceless tech content channels on Instagram and TikTok to inform content strategy.

### Goal 1: Channel Discovery & Cataloging
Outcome: Structured database of faceless tech channels with metadata.

| Issue | Agent | Description |
|-------|-------|-------------|
| Discover Instagram faceless tech channels | Researcher | Deep-research to find channels across all niche categories. Output: channel list with handles, niche tags, follower counts. All findings scored with ADMIRALTY grades (source reliability A-F + credibility 1-6) |
| Discover TikTok faceless tech channels | Researcher | Same for TikTok. Different platform dynamics — short-form video focus. All findings scored with ADMIRALTY grades |
| Scrape channel profiles & metrics | Data | For discovered channels, scrape public profile data: bio, follower/following counts, post count, recent post engagement |
| Build channel database | Data | Structure all collected data into normalized format in /artifacts. Cross-reference channels active on both platforms |

### Goal 2: Pattern Analysis & Strategy
Outcome: Actionable content strategy brief.

| Issue | Agent | Description |
|-------|-------|-------------|
| Analyze content formats by niche | Researcher | What content types (reels, carousels, static) perform best in each niche? What hooks and formats are common? |
| Analyze engagement patterns | Data | Compute engagement rates, posting frequency correlations, growth signals from scraped data |
| Compile niche viability report | Writer | Synthesize research into ranked niche recommendations with engagement-to-competition ratios |
| Write content strategy brief | Writer | Final deliverable: recommended niches, formats, cadence, and example content angles |

## Prerequisites

- [x] Writer agent wired into docker-compose (port 8084, deepseek-chat, 600s timeout)
- [x] Writer agent design finalized (skeleton-of-thought pipeline, checkpoint resumability)
- [ ] Paperclip project/goals/issues created
- [ ] Test run: CEO delegates simple research task through full pipeline
- [x] E2E test script: tests/e2e/e2e-10-social-research.sh

## Technical Debt (do after e2e passes)

- [ ] Refactor web-scrape.ts into web-scrape/ directory (1200+ lines, 7 tools — split like deep-research/)
  - deps.ts, challenge.ts, parse.ts
  - tools/: scrape-static, scrape-stealth, scrape-browser, scrape-apify, apify-dataset, apify-status, apify-actors
- [ ] Bridge BRIDGE_TIMEOUT_MS should be per-agent in docker-compose (done: researcher/data/writer at 600s)
