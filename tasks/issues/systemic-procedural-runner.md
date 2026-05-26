# Systemic: Test runner is procedural, not data-driven

**Type:** Design flaw
**Severity:** Medium — root cause of issues ebay-t3-not-tested, t4-apify-untested, contributes to yelp-selectors-stale
**Component:** tests/scraping/real-world-tests.sh

## Description

Each of the 15 site tests is a handcrafted bash function. Functions differ in which tiers they run, how they classify results, what delays they use, and how they report. Site metadata (URL, selectors, tier flags, risk level, expected outcomes) is embedded in code and duplicated between the campaign plan doc and the test script.

## Consequences

1. **Coverage gaps** — adding a tier to a site means editing a function body (eBay T3 missed)
2. **No pre-flight validation** — runner can't check tier prerequisites because it has no metadata to check against (Apify token missing went unnoticed until runtime)
3. **Selector updates require code edits** — stale selectors are buried in function bodies, not visible in a config table
4. **Inconsistent test shapes** — some functions run all tiers, some skip tiers, with no clear rationale in the code
5. **Campaign plan drift** — prose plan says one thing, code does another, neither is authoritative

## Design fix

Replace 15 bespoke functions with:
1. A site config table (JSON array or CSV) declaring: name, URL, selectors, tier flags, risk tier, Apify actor ID, expected outcomes
2. A generic runner (~50 lines) that iterates the table
3. Pre-flight readiness check that validates tier capabilities against what the config table requires

See implementation plan: tasks/plans/scrape-stack-redesign.md
