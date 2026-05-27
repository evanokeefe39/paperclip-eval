# Milestone: YouTube Revenue vs Effort Analysis by Content Style

## Intent

Validate that agents can autonomously research, structure, and deliver a comparative analysis of YouTube content styles ranked by revenue potential against production effort. The output should be actionable for someone deciding what type of YouTube channel to start, while also mapping the broader market landscape (who's making money, how, and why).

This is the first milestone testing agents against a multi-dimensional research problem where no single authoritative data source exists. Revenue data is fragmented across creator self-reports, analytics platforms, CPM databases, and sponsor rate cards. Effort data is largely qualitative. Agents must synthesize across source types, not just pull from one API.

## What we're measuring

Agent behavior when the task requires:

1. Defining a taxonomy from scratch (what are the "styles" of YouTube content?)
2. Gathering quantitative data from heterogeneous, imperfect sources
3. Estimating effort using qualitative signals (production complexity, frequency, team size)
4. Cross-referencing revenue and effort into a comparative framework
5. Producing actionable recommendations, not just raw data

Specific behavioral questions:

- Do agents define a useful content taxonomy or use a shallow one (e.g., just "long" vs "short")?
- Do they discover and evaluate multiple data sources, or stop at the first one?
- Do they distinguish between revenue streams (AdSense CPM, sponsorships, affiliate, merch, memberships)?
- Do they account for Shorts vs long-form economics (Shorts Fund vs RPM vs ad revenue)?
- Do they escalate when data quality is too low to draw conclusions, or present garbage confidently?
- Do they decompose effort meaningfully (scripting, filming, editing, posting frequency, equipment)?

## Content style dimensions agents should discover

Not prescribed to agents — this is the evaluator's checklist for assessing taxonomy quality.

Expected content styles (agents should identify most of these):

| Style | Example channels | Key characteristics |
|-------|-----------------|---------------------|
| Faceless compilation | Bright Side, Top 10s | Stock footage, TTS or VO, high volume |
| Faceless tutorial/explainer | Ali Abdaal-style but no face, slideshow | Screen recording, voiceover |
| Talking head | MKBHD, Graham Stephan | Single camera, personality-driven |
| Highly produced | Veritasium, Johnny Harris | Research-heavy, motion graphics, travel |
| Vlog / daily | Casey Neistat style | Daily/frequent, personal, low edit |
| Gaming | PewDiePie, Markiplier | Screen capture + facecam, commentary |
| Podcast/interview | Lex Fridman, Joe Rogan | Multi-camera, long-form conversation |
| Shorts-first | Short-native creators | Vertical, <60s, high volume, repurposed |
| Reaction/commentary | MrBeast reaction channels | Low original footage, commentary overlay |
| Educational/course-style | 3Blue1Brown, Fireship | Deep topic, custom visuals, lower frequency |
| Product review | LTT, Unbox Therapy | Product-focused, sponsor-heavy |
| Music/entertainment | T-Series, Cocomelon | Music, animation, kids content |

## Revenue dimensions agents should investigate

| Revenue stream | Data availability | Notes |
|---------------|------------------|-------|
| AdSense RPM/CPM by niche | Medium — SocialBlade, creator reports, niche CPM databases | Ranges widely: $2-50 CPM depending on niche |
| YouTube Shorts revenue | Low — new program, sparse public data | Changed from Shorts Fund to revenue sharing Feb 2023 |
| Sponsorship rates | Medium — creator interviews, sponsorship marketplaces | Typically 2-5x AdSense for mid-tier creators |
| Affiliate revenue | Low — rarely disclosed | Highly variable by niche (finance/tech highest) |
| Memberships/Super Chat | Low | Platform-dependent, audience-size dependent |
| Merch/products | Low | Mostly top-tier creators |
| Course/info product | Medium — landing pages, income reports | Education niche dominates |

## Effort dimensions agents should investigate

| Effort factor | How to assess |
|--------------|---------------|
| Scripting/research time | Per-video hours, varies by depth |
| Filming complexity | Equipment needs, locations, talent |
| Editing time | Per-minute-of-output, effects complexity |
| Posting frequency | Videos/week sustainable for the style |
| Team size | Solo viable? Need editor? Need researcher? |
| Equipment cost | Camera, mic, lighting, software, studio |
| Startup ramp | Time to first monetization, subscriber threshold |
| Skill requirements | Writing, on-camera, editing, design, coding |

## Test cases

Three cases testing different prompt specificity levels. Same underlying task, decreasing guidance.

### Environment preconditions (all cases)

- All agents running (CEO, Researcher, Data, Writer)
- Exa API key present (web search works)
- Apify token present (scraping works)
- No SocialBlade API key configured
- No VidIQ/TubeBuddy API key configured
- Discord plugin configured (escalations reach human)
- Artifacts volume empty

---

### Case 1: Structured brief

**Prompt (to CEO):**
> Analyze YouTube content styles by revenue potential and effort required. I want a comparison matrix covering at least 8 distinct content styles (e.g., faceless, talking head, highly produced, Shorts, gaming, educational). For each style: estimated revenue range (all streams, not just AdSense), production effort breakdown (time, cost, team), and example channels. Include both long-form and Shorts economics. Output as a structured report with a recommendation section for someone deciding what type of channel to start.

**Steering level:** High. Output format specified. Dimensions named. Goal stated.

**What this tests:**
- Task decomposition (revenue research vs effort research vs channel examples)
- Multi-agent coordination (Researcher for web data, Data for structured scraping, Writer for synthesis)
- Whether agents discover free/low-cost data sources vs immediately escalating for paid APIs
- Output quality and actionability

**Pass criteria:**
- [ ] At least 8 content styles compared
- [ ] Revenue estimates include at least 2 streams beyond AdSense
- [ ] Effort breakdown is per-style, not generic
- [ ] Shorts economics addressed separately from long-form
- [ ] Example channels cited for each style (real channels, not hallucinated)
- [ ] Data sources documented (where did the numbers come from?)
- [ ] Recommendation section present with reasoning

---

### Case 2: Goal-oriented

**Prompt (to CEO):**
> I'm considering starting a YouTube channel. Help me understand which types of videos make the most money relative to how much work they take to produce. Cover the full spectrum from low-effort Shorts to high-production documentaries.

**Steering level:** Medium. Goal clear, dimensions implied, format left to agents.

**What this tests:**
- Whether agents define the content taxonomy themselves
- Whether they identify effort as a key dimension without being told the specific factors
- Whether the output is structured for decision-making or just a research dump

**Pass criteria:**
- [ ] Agents define a content style taxonomy (not just "long vs short")
- [ ] Revenue-to-effort ratio is the organizing principle (not just revenue alone)
- [ ] At least 6 styles compared
- [ ] Practical recommendations included (not just data)
- [ ] No hallucinated revenue figures

---

### Case 3: Vague ask

**Prompt (to CEO):**
> How much money do different styles of YouTube videos and Shorts actually make? What's worth the effort?

**Steering level:** Low. Conversational. Two questions, no structure imposed.

**What this tests:**
- Maximum autonomous structuring of a vague ask
- Whether agents recognize "worth the effort" implies an effort analysis, not just revenue
- Whether they produce something useful vs a shallow blog-post-quality summary

**Pass criteria:**
- [ ] Agents interpret "worth the effort" as requiring effort analysis (not just revenue ranking)
- [ ] Output is more than a listicle — has comparative structure
- [ ] At least 5 content styles addressed
- [ ] Both Shorts and long-form covered (user mentioned both)
- [ ] Some form of ROI framing (revenue per hour of effort, or similar)

---

## Data source evaluation (cross-case)

After all runs, assess what data sources agents discovered and used:

| Source | Free? | Agents found it? | Agents used it? | Quality assessment |
|--------|-------|-------------------|-----------------|-------------------|
| SocialBlade (web) | Partial | | | |
| Creator income reports/interviews | Yes | | | |
| YouTube CPM databases (various) | Yes | | | |
| Sponsorship rate cards (influencermarketinghub etc.) | Yes | | | |
| VidIQ/TubeBuddy (free tier) | Partial | | | |
| YouTube Analytics API | Free | | | |
| Apify YouTube scraper | Low cost | | | |
| Glassdoor/salary data for production roles | Yes | | | |
| Equipment cost databases | Yes | | | |

**Key question:** Did agents proactively seek out free/low-cost data sources, or did they stop at web search summaries?

## Cross-case analysis

| Dimension | Case 1 | Case 2 | Case 3 |
|-----------|--------|--------|--------|
| Content styles identified (count) | | | |
| Revenue streams covered (count) | | | |
| Effort factors analyzed (count) | | | |
| Data sources used (count) | | | |
| Task decomposition quality (1-5) | | | |
| Multi-agent coordination (1-5) | | | |
| Output actionability (1-5) | | | |
| Hallucination detected? | | | |
| Escalations triggered | | | |
| Total agent turns | | | |
| Total tokens consumed | | | |

## Execution protocol

1. Run cases sequentially — fresh state between runs
2. Wipe artifacts volume between runs
3. Reset all agent memory (PARA files) between runs
4. Record: all Paperclip issues created, all agent invocations (from Aspire traces), all escalations, all artifacts produced
5. If agents escalate for a paid API key (SocialBlade, VidIQ): note the escalation quality, then tell them to proceed with free alternatives only. Observe whether they adapt.
6. Time-box each case at 45 minutes (longer than milestone 1 — more research surface area)
7. Capture full OTel traces for post-run analysis

## Post-escalation behavior

If agents escalate for paid data sources:

- [ ] Escalation is specific (names the source, explains what it would provide, gives signup info)
- [ ] Agent continues with free alternatives after being told to use free sources only
- [ ] Quality of free-source output is noted vs what paid would have provided
- [ ] Agent doesn't stall waiting for credentials it was told it won't get

## Dependencies

- All agents running and healthy (CEO, Researcher, Data, Writer minimum — QA optional)
- Web search (Exa) working
- Apify token valid (for YouTube channel scraping if agents attempt it)
- Discord plugin configured (escalation delivery)
- OTel/Aspire dashboard capturing traces
- Artifacts volume accessible

## Negative space

Out of scope:
- Actually starting a YouTube channel
- Creating content or scripts
- Setting up YouTube Analytics API access during the eval
- Comparing YouTube to other platforms (TikTok, Instagram monetization)
- Historical trend analysis (how revenue has changed over years)

Not testing:
- Video production by agents (they research, not create)
- Real-time data accuracy (revenue estimates are inherently approximate)
- Publisher agent involvement (no publishing in this milestone)

## Success criteria for the milestone

The milestone passes if:

1. All three cases produce a structured comparison of at least 5 content styles
2. At least one case produces revenue estimates from 3+ distinct sources (not just one blog post)
3. Effort analysis goes beyond "high/medium/low" — includes at least 3 specific effort factors per style
4. No hallucinated channel names or revenue figures that can be disproven
5. At least one case demonstrates multi-agent decomposition (Researcher + Data working different angles)
6. Agents discover and use at least 3 free data sources across all cases
7. Output from at least one case is genuinely useful for someone deciding what channel to start (evaluator judgment)
8. Cross-case comparison shows behavioral gradient — more structured prompt produces more structured output, but even the vague case produces something useful
