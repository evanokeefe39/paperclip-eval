# DataDome (Etsy) and aggressive PerimeterX (Walmart) defeat all local tiers

**Severity:** Info (known limitation, not a bug)
**Component:** src/agents/extensions/web-scrape.ts (tier escalation logic)
**Found:** 2026-05-26 real-world scraping campaign
**Systemic root:** Architectural ceiling of the fetch-and-extract paradigm (not a defect)

## Observation

Two anti-bot systems completely defeat our local 3-tier stack:

### DataDome (Etsy)
- T1: BLOCK
- T2: EMPTY
- T3: EMPTY

### PerimeterX aggressive config (Walmart)
- T1: EMPTY
- T3: EMPTY

Note: PerimeterX on Booking.com and Zillow did NOT block T3. Only Walmart's aggressive config blocked it.

## Five Whys

```
Problem: Etsy and Walmart block all local tiers including T3 browser
Why 1: Anti-detection fingerprinting in scrapling isn't enough for these sites
Why 2: DataDome and aggressive PerimeterX analyze behavior patterns — mouse events,
       scroll timing, request cadence, JS execution order — not just fingerprints
Why 3: Our T3 does "navigate, wait for selector, extract." Zero behavioral
       simulation — no scrolling, no mouse movement, no dwell time
Why 4: The tier model escalates along one axis only: stealth of the HTTP client.
       It has no axis for behavioral realism
Why 5: This is the fundamental boundary of a "fetch and extract" paradigm.
       Defeating intent-based anti-bot requires a "browse and extract" paradigm —
       simulating a user session, not just a user request. That is what T4 (Apify
       with residential proxies and per-site actors) exists for
```

**Root cause:** Known architectural ceiling. Not a bug. T4 exists precisely for sites beyond local capability. The actionable question is whether the agent can detect these sites early and skip straight to T4 without wasting requests and risking IP reputation.

## Actionable improvement

Add fast-fail detection to the scraping extension: when T1 returns a known challenge page signature (DataDome JS challenge, PerimeterX captcha page), skip T2/T3 and advise the agent to use T4 directly. This is a heuristic on the response HTML, not a hardcoded site list.

After fetch-parse decoupling, the single cheerio parser can inspect fetched HTML for challenge page signatures before attempting extraction, making this detection natural.

## Sites confirmed T4-only

- Etsy (DataDome)
- Walmart (PerimeterX aggressive)
- Google Maps (full SPA, custom Google protection)
