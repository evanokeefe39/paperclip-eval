# T4 (Apify) untested — APIFY_API_TOKEN not set

**Severity:** Medium
**Component:** tests/scraping/real-world-tests.sh, .env
**Found:** 2026-05-26 real-world scraping campaign
**Systemic root:** Procedural test runner (missing readiness check)

## Problem

All T4 tests skipped because APIFY_API_TOKEN env var not set. Cannot validate:
- Google Maps actor (compass/crawler-google-places) — best Apify actor, 413K users
- Etsy — whether any Apify actor defeats DataDome
- Walmart — whether Apify handles aggressive PerimeterX
- Yelp — whether Apify actors work as alternative

## Five Whys

```
Problem: All T4 tests silently skipped
Why 1: APIFY_API_TOKEN not in .env
Why 2: No pre-flight validation warns about missing optional tier capabilities
Why 3: Campaign runner treats absent token as silent SKIP per-site rather than
       a prominent upfront WARNING about degraded coverage
Why 4: The procedural runner has no metadata layer. A data-driven runner would
       declare tier dependencies per site and validate all required tokens at startup,
       printing a clear "T4 disabled: APIFY_API_TOKEN missing — 4 sites will SKIP T4"
Why 5: (stops here — primarily a config/UX gap, not deep design)
```

**Root cause:** Missing readiness check at startup. Linked to the procedural runner — a data-driven runner naturally validates tier prerequisites against the site config table before starting.

## Fix

1. Set APIFY_API_TOKEN in `.env`
2. Re-run Phase 4: `bash tests/scraping/real-world-tests.sh phase4`
3. Data-driven runner redesign will add upfront tier readiness validation

## Cost estimate

Single-run T4 tests should cost under $0.50 total across all sites.
