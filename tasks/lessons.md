# Lessons Learned

Patterns and corrections from implementation cycles. Review before starting work.

---

## 2026-05-26: Stale container images mask code changes

**What happened:** Python fetch scripts were updated in the repo (fetch-only pattern) but the Docker container still had the old selector-based versions. Tests ran against stale code for an entire campaign, producing misleading TIMEOUT results.

**Root cause:** `docker compose up -d` reuses existing images. Script changes require `docker compose build <service>` then `up -d`.

**Rule:** After changing any file that gets COPY'd into a Docker image, rebuild the affected container before testing. Don't trust "the code is updated" until you verify inside the container.

---

## 2026-05-26: Shell ARG_MAX limit on large HTML piping

**What happened:** Test runner's `cheerio_parse()` passed full HTML as a CLI argument to jq (`--arg html "$html"`) and then to node (`-- "$parse_input"`). Pages over ~128KB exceeded the OS argument length limit, causing "Argument list too long" errors. Small pages (HN, 35KB) worked; large pages (Reddit, 190KB) silently failed.

**Root cause:** Linux ARG_MAX limits CLI argument size. Passing large data as program arguments instead of piping through stdin.

**Rule:** Never pass HTML or other large data as CLI arguments. Always pipe through stdin. Use `jq` with `.field` on stdin instead of `--arg field "$variable"` for large values.

---

## 2026-05-26: Python fetch scripts must report HTTP errors

**What happened:** scrape_stealth.py and scrape_browser.py returned `errors: []` even on 403 responses. The test classifier saw zero errors + zero items and classified as EMPTY instead of BLOCK, hiding the real cause (Cloudflare rejection).

**Root cause:** Scripts only caught exceptions, not HTTP-level failures. A 403 with a body is not an exception — it's a successful HTTP response with an error status.

**Rule:** Fetch scripts must append `HTTP {status_code}` to the errors array for any status >= 400. The downstream classifier relies on error strings containing "403" or "blocked" to distinguish BLOCK from EMPTY.

---

## 2026-05-26: Anti-bot ceiling is behavioral, not technical

**What happened:** Sites protected by DataDome (Etsy), aggressive PerimeterX (Walmart), and Cloudflare Turnstile (Yelp) block all three self-hosted tiers including headless Chromium (T3). Scrapling's stealth patches (UA spoofing, webdriver flag removal, navigator property masking) are insufficient.

**Root cause:** These anti-bot systems analyze behavioral signals — mouse movement patterns, scroll behavior, timing between actions, viewport interactions — not just browser fingerprints. A headless browser that loads a page and immediately reads the DOM exhibits no human behavior.

**Implication:** The T3 ceiling is architectural, not fixable by configuration. Two paths forward: (1) T4 Apify for commercial anti-detection, (2) behavioral simulation with Playwright stealth plugins (production investment, not eval-stage). For eval, T4 is the answer.

---

## 2026-05-26: Selector staleness is a maintenance tax

**What happened:** eBay T3 renders the page successfully (HTML returned, no challenge) but `.s-item` matches nothing. The selector worked previously but eBay changed their DOM. No automated detection caught this.

**Implication:** Every selector in sites.json is a maintenance liability. Sites redesign their DOM regularly. Need a strategy for detecting stale selectors (periodic campaigns, or alert when a previously-PASS site returns EMPTY).
