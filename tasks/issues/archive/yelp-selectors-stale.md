# Yelp selectors stale — all tiers fail

**Severity:** Medium
**Component:** tests/scraping/real-world-tests.sh (test_yelp), tasks/plans/real-world-scrape-campaign.md
**Found:** 2026-05-26 real-world scraping campaign
**Systemic roots:** Fetch-parse coupling + procedural test runner

## Problem

Yelp fails at all three local tiers:
- T1: BLOCK (403 or challenge page)
- T2: EMPTY (page loads, selectors miss)
- T3: EMPTY (browser renders, selectors miss)

## Five Whys

```
Problem: All three tiers return EMPTY or BLOCK on Yelp
Why 1: CSS selectors [data-testid='serp-ia-card'] don't match current Yelp DOM
Why 2: Yelp changed markup since selectors were written (deploys ~weekly)
Why 3: Selectors are hardcoded strings authored by inspecting DOM at one point
       in time. No validation that they still match
Why 4: The system cannot distinguish "selector is stale" from "site blocked us"
       from "parser doesn't support this selector." All return EMPTY
Why 5: The system has no observability. When extraction returns zero items, there
       is no diagnostic path — no raw HTML dump, no selector match count, no
       indication of what the page actually contained. The agent hits a wall and
       can only report "nothing found"
```

**Root cause:** Two systemic issues converge here.

First, the fetch-parse coupling means T2/T3 could have fetched valid HTML but their lxml parser normalized the DOM differently than the browser where selectors were authored. Without raw HTML access, we can't tell if the selectors are stale or if the parser is diverging.

Second, the procedural test runner embeds selectors in function bodies. A data-driven runner would make stale selectors visible (all site config in one table) and make selector updates a one-line change instead of a code edit.

## Investigation plan

1. Load Yelp search in a real browser, inspect current DOM
2. Update selectors
3. After fetch-parse decoupling: re-test with cheerio parsing on T2/T3-fetched HTML to determine if this was a parser issue or a genuine selector staleness issue

## Notes

Yelp API costs $500+/month for volume access. If T2 or T3 works with correct selectors, this is a high-value self-scrape target.
