# Cheerio global install not resolvable in data container

**Severity:** Medium (fixed with workaround, proper fix pending)
**Component:** src/agents/data/Dockerfile, tests/scraping/real-world-tests.sh
**Found:** 2026-05-26 real-world scraping campaign
**Systemic root:** Standalone build hygiene issue (not linked to systemic design problems)

## Problem

Cheerio installed globally via `npm install -g cheerio` in the data Dockerfile is not resolvable by `require("cheerio")` from Node scripts running in `/app`. All T1 tests failed with `Cannot find module 'cheerio'`.

## Five Whys

```
Problem: require("cheerio") fails inside data container
Why 1: Cheerio installed globally, Node can't resolve from /app working dir
Why 2: Dockerfile uses npm install -g to match Pi CLI's global install pattern
Why 3: No dependency management strategy for the container — global npm, pip,
       and apt packages all mixed without resolution rules
Why 4: Container serves three runtimes: Pi agent (Node), T1 scraper (Node/cheerio),
       T2/T3 scrapers (Python/scrapling). Each has different module resolution
Why 5: The container is a monolith. One image carries the agent runtime, two
       languages, three parsers, a browser, and the test harness's inline scripts.
       No separation between agent deps and scraping tool deps
```

**Root cause:** Ad-hoc dependency management in a multi-runtime container. Not a deep design issue — straightforward fix via ENV NODE_PATH or local install. The fetch-parse decoupling fix (systemic issue A) will simplify this further by removing the need for inline cheerio scripts in the test runner.

## Current workaround

Test runner uses absolute path: `require("/usr/local/lib/node_modules/cheerio")`. Brittle — breaks if global prefix changes.

## Proper fix

Add to data and researcher Dockerfiles:

```dockerfile
ENV NODE_PATH=/usr/local/lib/node_modules
```

## Affected files

- tests/scraping/real-world-tests.sh (line 54 — workaround applied)
- src/agents/data/Dockerfile (fix needed)
- src/agents/researcher/Dockerfile (same pattern, same risk)
