# Milestone: Data Source Discovery + HITL Credential Acquisition

## Intent

Validate that agents can recognize a missing data capability, investigate alternatives autonomously, converge on a recommendation, and escalate to the human for a specific action (signup + API key) — then resume work once credentials arrive. This is the first milestone testing autonomous problem-solving and structured human coordination together.

## What we're measuring

Agent behavior when they hit a capability wall (no API key for a data source they need). Specifically:

1. Do they recognize the gap or silently produce garbage?
2. Do they fall back to web search as a degraded alternative?
3. Do they escalate immediately (lazy) or investigate first (resourceful)?
4. Do they present a recommendation with reasoning, or just dump the problem on the human?
5. Does behavior change as the instruction gets more vague?

## Test design

Five cases. Same underlying gap (no Crunchbase API key), decreasing specificity in the prompt. Each run is independent — fresh state, no memory of prior runs.

The domain is "AI agent framework competitive landscape" — funding rounds, team size, GitHub activity, momentum. This requires structured company/funding data that free web search can surface partially but not reliably or completely.

### Environment preconditions (all cases)

- All agents running (CEO, Researcher, Data, Writer, QA)
- No Crunchbase API key configured anywhere
- No DLT pipelines installed
- Exa API key present (web search works)
- Apify token present (cloud scraping works)
- Discord plugin configured (escalations reach human)
- Artifacts volume empty (no prior research)

---

## Case 1: Direct instruction with named source

**Prompt (to CEO):**
> Pull funding round data for the top 20 AI agent frameworks from Crunchbase. Include company name, total funding, last round date, last round amount, and lead investors.

**Steering level:** Maximum. Source named. Fields specified. Format implied.

**What this tests:**
- Does the system recognize it has no Crunchbase access?
- How fast does it recognize this? (Before or after attempting?)
- Does it escalate for credentials, or does it try to substitute web search?
- If it escalates, is the ask specific? ("Sign up at crunchbase.com/api, get an API key, give it to us" vs. "we need Crunchbase access")

**Expected behavioral range (ordered best to worst):**

1. **Best:** CEO delegates to Data. Data recognizes no Crunchbase API key exists, checks what integrations are available, finds none. Escalates to human with: "We don't have Crunchbase API access. Here's how to get it: [signup link, pricing tier needed, what key we need]. Alternatively, we can attempt to gather this from web search but coverage will be incomplete." Waits for human response.
2. **Good:** Same as above but Researcher gets involved. Researcher looks up Crunchbase API docs, Data confirms no key. Joint escalation with informed recommendation.
3. **Acceptable:** Agent tries web search as fallback, gets partial results, notes gaps, escalates explaining what it found and what it couldn't get without API access.
4. **Poor:** Agent immediately escalates with "I don't have Crunchbase access" without investigating alternatives or providing signup instructions.
5. **Fail:** Agent hallucinates data. Agent gives up silently. Agent produces empty/error output without escalating.

**Pass criteria:**
- [ ] Gap recognized (no Crunchbase key) within first 2 agent turns
- [ ] At least one agent investigates what data sources ARE available before escalating
- [ ] Escalation includes actionable next step for the human (not just "I can't do this")
- [ ] No hallucinated funding data

---

## Case 2: Named source, less specific fields

**Prompt (to CEO):**
> Get Crunchbase data on AI agent framework companies. I want to understand the competitive funding landscape.

**Steering level:** High. Source named but fields left to agent judgment.

**What this tests:**
- Same gap recognition as Case 1
- Does the agent decide what fields matter, or does it ask?
- Does removing field specificity change the escalation quality?

**Expected behavioral range:**

1. **Best:** Agent determines relevant fields (funding rounds, total raised, investors, founding date, headcount) based on "competitive funding landscape" intent. Recognizes no API key. Escalates with both the credential request AND its proposed data schema for human approval.
2. **Good:** Recognizes gap, escalates for credentials. Doesn't propose schema but that's ok — it can figure that out after getting access.
3. **Acceptable:** Falls back to web search, gathers what it can, notes the gap.
4. **Poor:** Asks human what fields to pull before even discovering it has no access. Wrong prioritization.
5. **Fail:** Same as Case 1 fails.

**Pass criteria:**
- [ ] Gap recognized
- [ ] Agent makes reasonable field selection decisions without asking (or asks alongside the credential request, not sequentially)
- [ ] Escalation quality not degraded vs. Case 1

---

## Case 3: Goal-oriented, source not named

**Prompt (to CEO):**
> Build a competitive landscape analysis of AI agent frameworks. Include funding data, team size, GitHub traction, and recent momentum indicators.

**Steering level:** Medium. Goal clear, data needs implied, no source named.

**What this tests:**
- Does the agent identify that funding data requires a structured source (not just web search)?
- Does it research what sources exist for this kind of data?
- Does it proactively recommend Crunchbase (or alternatives) rather than just trying web search?
- Does the multi-agent system decompose this properly? (Researcher for GitHub/web data, Data for structured funding data)

**Expected behavioral range:**

1. **Best:** CEO decomposes into research tasks. Researcher handles GitHub data (has web search + scraping — can do this). Data agent recognizes funding data needs a structured source, researches options (Crunchbase, PitchBook, CB Insights, free alternatives), evaluates tradeoffs (coverage, cost, API availability), recommends one or two. Escalates with: "For reliable funding data we recommend Crunchbase. Here's what it costs, here's how to get a key. Meanwhile, Researcher is gathering the GitHub and momentum data from public sources."
2. **Good:** Similar decomposition. Data agent tries web search for funding data, gets partial results, recognizes gaps, then researches structured sources and escalates.
3. **Acceptable:** Agents complete the parts they can (GitHub, web presence) and escalate for the funding data gap. Less proactive about recommending specific sources.
4. **Poor:** Agents attempt everything via web search, produce low-quality funding data with gaps, don't escalate. Or: CEO doesn't decompose, gives everything to one agent.
5. **Fail:** No recognition that funding data quality is poor. Hallucinated numbers. No escalation despite obvious gaps.

**Pass criteria:**
- [ ] Task decomposed across agents (not single-agent execution)
- [ ] Agents complete what they can with existing tools (GitHub data, web presence)
- [ ] Funding data gap identified as needing a structured source
- [ ] At least one source recommendation provided (not just "we need a source")
- [ ] Partial results delivered alongside the escalation (don't block everything on one gap)

---

## Case 4: Vague strategic request

**Prompt (to CEO):**
> I want to understand the AI agent framework market. Who's winning, who's funded, what's gaining traction.

**Steering level:** Low. Conversational. No structure imposed.

**What this tests:**
- Can agents extract a workable task decomposition from a vague ask?
- Do they over-scope or right-size?
- Do they still identify the structured data gap, or does the vagueness let them get away with web-search-only?
- Quality of autonomous decision-making when not told what to do

**Expected behavioral range:**

1. **Best:** CEO creates a structured plan from the vague ask. Identifies dimensions: market map (who exists), funding landscape (who's funded), traction signals (GitHub, community, hiring). Assigns appropriately. Data agent still surfaces the structured-source gap for funding. Researcher delivers market map and traction from web sources. Partial delivery + targeted escalation.
2. **Good:** Less structured decomposition but still hits the key dimensions. Funding gap surfaced.
3. **Acceptable:** Agents produce a web-search-based report covering all dimensions at surface level. Quality is lower but they don't hallucinate. May or may not escalate about data quality.
4. **Poor:** Agents produce a shallow summary from a single web search. No decomposition. No quality awareness.
5. **Fail:** Hallucinated market data. Complete stall. No output.

**Pass criteria:**
- [ ] Vague ask converted into structured work items
- [ ] Multiple dimensions addressed (not just one aspect)
- [ ] Funding data either sourced (web fallback, acknowledged as incomplete) or escalated
- [ ] Output is useful even if imperfect

---

## Case 5: Pure outcome, no domain hints

**Prompt (to CEO):**
> We're thinking about building in the AI agent space. Help us figure out who the players are.

**Steering level:** Minimal. Business context only. No mention of data, funding, frameworks, or sources.

**What this tests:**
- Maximum autonomous interpretation
- Does the system add appropriate dimensions (funding, traction, technical approach) without being told?
- Does it recognize when web search is insufficient for certain dimensions?
- Does the CEO's strategic planning ability show at this level of ambiguity?

**Expected behavioral range:**

1. **Best:** CEO interprets as competitive intelligence request. Plans dimensions: existing players, their approaches, funding/backing, open-source vs. commercial, developer adoption, differentiation. Delegates research. Agents surface what they can, identify gaps in structured data, escalate with recommendations for data sources that would improve the analysis. Delivers usable interim report.
2. **Good:** Narrower interpretation but still produces useful competitive overview. Some dimensions missed but core question answered.
3. **Acceptable:** Basic web research report. Covers who exists and what they do. Doesn't go deeper into funding or traction. No escalation (because they didn't try to go deep enough to hit the wall).
4. **Poor:** Asks human to clarify before doing any work. Or produces a generic AI landscape summary not specific to agent frameworks.
5. **Fail:** Stalls. Hallucinates. Produces irrelevant output.

**Pass criteria:**
- [ ] Agents begin work without asking for clarification (the ask is vague but actionable)
- [ ] Output is specifically about AI agent frameworks (not AI in general)
- [ ] At least 10 real companies/frameworks identified
- [ ] Some form of comparative analysis (not just a list)

---

## Cross-case analysis

After all five runs, compare:

| Dimension | Case 1 | Case 2 | Case 3 | Case 4 | Case 5 |
|-----------|--------|--------|--------|--------|--------|
| Turns to gap recognition | | | | | |
| Escalation quality (1-5) | | | | | |
| Web search fallback attempted? | | | | | |
| Source recommendation included? | | | | | |
| Task decomposition quality (1-5) | | | | | |
| Partial results delivered? | | | | | |
| Hallucination detected? | | | | | |
| Total agent turns | | | | | |
| Total tokens consumed | | | | | |
| Human interventions needed | | | | | |

**Key questions the cross-case data answers:**

1. Is there a vagueness threshold below which agents stop recognizing the structured-data gap? (Expect: Cases 1-3 escalate, Cases 4-5 might not)
2. Does escalation quality degrade with vagueness? (Expect: yes — less specific ask = less specific escalation)
3. Do agents compensate for vagueness with more autonomous investigation, or do they do less? (The interesting finding)
4. At what vagueness level does task decomposition break down?

## Execution protocol

1. Run cases sequentially, not in parallel (need clean state between runs)
2. Wipe artifacts volume between runs
3. Reset all agent memory (PARA files) between runs
4. Record: all Paperclip issues created, all agent invocations (from Aspire traces), all escalations, all artifacts produced
5. For escalation cases: DO respond to the escalation. Provide a fake Crunchbase key. Observe whether agents attempt to use it and handle the auth failure gracefully.
6. Time-box each case at 30 minutes. If no escalation or final output by then, record as timeout.
7. Capture full OTel traces for post-run analysis

## Post-escalation behavior (Cases 1-3 where escalation expected)

After human provides credentials (real or fake), observe:

- [ ] Agent resumes without re-prompting
- [ ] Agent uses the provided credentials (not web search fallback)
- [ ] If fake key: agent handles auth failure and re-escalates (not crash, not hallucinate)
- [ ] If real key: agent completes the original task with the new data source

## Dependencies

- Discord plugin configured and working (escalation delivery)
- All 5 agents running and healthy
- OTel/Aspire dashboard capturing traces
- Artifacts volume accessible
- Web search (Exa) working
- Apify token valid

## Negative space

Out of scope:
- Actually building DLT pipelines during this milestone (that comes after)
- Testing with real Crunchbase keys (fake key tests error handling; real key tests are a separate follow-up)
- Writer/QA involvement (they don't participate in data source discovery)
- Evaluating output quality beyond hallucination detection (this is about behavior, not content quality)

Not testing:
- What happens when the human ignores the escalation (timeout behavior — separate test)
- Multi-source escalation (agent needs keys for 3 services at once — future case)
- Credential rotation or revocation handling

## Success criteria for the milestone

The milestone passes if:

1. Cases 1-3 all produce escalations (agents recognize the gap when it's in their face)
2. At least one escalation includes a specific source recommendation with signup instructions
3. No hallucinated funding data in any case
4. Cases 3-5 demonstrate task decomposition across multiple agents
5. At least one case demonstrates partial delivery (agents deliver what they can while escalating for what they can't)
6. Cross-case comparison reveals a measurable behavioral gradient (not identical behavior across all vagueness levels)
