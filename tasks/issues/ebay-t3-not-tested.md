# eBay T3 (browser) not tested in campaign

**Severity:** Low
**Component:** tests/scraping/real-world-tests.sh (test_ebay)
**Found:** 2026-05-26 real-world scraping campaign
**Systemic root:** Procedural test runner (see tasks/issues/systemic-procedural-runner.md)

## Problem

eBay test only ran T1 and T2. T3 (browser) was skipped. Results:
- T1: BLOCK
- T2: EMPTY
- T3: SKIP

eBay was hypothesized as a self-scrape win site (Apify actors rated below 3.1 stars). Without T3 data, we can't confirm whether our browser tier handles eBay.

## Five Whys

```
Problem: test_ebay() doesn't run T3
Why 1: Function was written to only run T1 and T2 for eBay
Why 2: Campaign plan classified eBay as Level 2 (expect T1/T2 sufficient)
Why 3: Each site test is a handcrafted function with its own tier selection logic
Why 4: There is no standard test shape — each function decides which tiers to run
       based on a human judgment call frozen in code
Why 5: Site metadata (URL, selectors, expected tiers, risk level) is spread across
       the campaign plan doc (prose) and the test script (code). Neither is the
       single source of truth and they drift independently
```

**Root cause:** Procedural test runner. With a data-driven runner, adding T3 to eBay is flipping a column value in a config row, not editing a function body.

## Notes

eBay is reportedly scraper-tolerant at low volume. T3 with proper wait_for selector likely passes. Fix is subsumed by the data-driven runner redesign.
