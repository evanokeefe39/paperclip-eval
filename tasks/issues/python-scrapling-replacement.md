# Replace Python scrapling with Node-native alternatives

## Problem

web-scrape.ts extension shells out to Python scripts (`scrape_stealth.py`, `scrape_browser.py`) for T2/T3 fetch. This adds Python runtime to every scraping-capable image, duplicates scripts across agent directories, and creates a fragile coupling via hardcoded container paths.

## Current state

- `src/agents/researcher/scripts/scrape_stealth.py` — T2 fetch (Scrapling Fetcher)
- `src/agents/data/scripts/scrape_stealth.py` — identical copy
- `src/agents/data/scripts/scrape_browser.py` — T3 fetch (Scrapling DynamicFetcher)
- Extension at `src/agents/extensions/web-scrape.ts` calls these via `pythonFetch()`
- Python + scrapling adds ~400MB to researcher image, more to data image

## Alternatives to test

### T2 (stealth HTTP)

- `curl-impersonate` Node bindings — TLS fingerprint mimicry without Python
- `got-scraping` — anti-detection HTTP client (Node native)
- Enhanced fetch headers + TLS config in Node (T1 already does basic version)

### T3 (browser rendering)

- Playwright Node API — direct replacement for Scrapling DynamicFetcher
- Puppeteer with stealth plugin

## Acceptance criteria

- Run each alternative against `tests/scraping/sites.json` test matrix
- Compare detection rates vs current scrapling results
- Measure image size delta (Python removal savings vs new dep size)
- Confirm challenge detection still works (extension handles this in Node already)

## Blocked by

Nothing — can test independently. Refactor after validation.
