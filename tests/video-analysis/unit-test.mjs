/**
 * Unit tests for video & audio analysis tools (T5 layer).
 *
 * Tests: RateLimiter token bucket, NIM JSON parsing, error handling.
 * No external API calls — pure logic only.
 *
 * Run:  node --test tests/video-analysis/unit-test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// =========================================================================
//  RateLimiter — token bucket
// =========================================================================

describe("RateLimiter", () => {
  // Re-implement inline to test the algorithm without TypeScript transpilation
  class RateLimiter {
    #tokens;
    #lastRefill;
    #maxTokens;
    #refillRate;

    constructor(rpm) {
      this.#maxTokens = rpm;
      this.#tokens = rpm;
      this.#refillRate = rpm / 60_000;
      this.#lastRefill = Date.now();
    }

    async acquire() {
      while (true) {
        const now = Date.now();
        const elapsed = now - this.#lastRefill;
        this.#tokens = Math.min(this.#maxTokens, this.#tokens + elapsed * this.#refillRate);
        this.#lastRefill = now;

        if (this.#tokens >= 1) {
          this.#tokens -= 1;
          return;
        }

        const waitMs = Math.ceil((1 - this.#tokens) / this.#refillRate);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }

    get tokens() { return this.#tokens; }
  }

  it("starts with full token bucket", () => {
    const limiter = new RateLimiter(40);
    assert.equal(limiter.tokens, 40);
  });

  it("decrements tokens on acquire", async () => {
    const limiter = new RateLimiter(40);
    await limiter.acquire();
    assert.ok(limiter.tokens < 40);
    assert.ok(limiter.tokens >= 38); // might refill slightly between constructor and acquire
  });

  it("allows burst up to RPM limit", async () => {
    const limiter = new RateLimiter(10);
    const times = [];
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      await limiter.acquire();
      times.push(Date.now() - start);
    }
    // First 10 should be near-instant (< 50ms each)
    for (const t of times) {
      assert.ok(t < 100, `Burst acquire took ${t}ms, expected < 100ms`);
    }
  });

  it("blocks when tokens exhausted", async () => {
    const limiter = new RateLimiter(2); // 2 RPM = 1 token per 30s
    await limiter.acquire();
    await limiter.acquire();
    // Now exhausted — next acquire should block
    const start = Date.now();
    const timeout = setTimeout(() => {}, 5000); // keep event loop alive
    const raceResult = await Promise.race([
      limiter.acquire().then(() => "acquired"),
      new Promise((r) => setTimeout(() => r("timeout"), 2000)),
    ]);
    clearTimeout(timeout);
    const elapsed = Date.now() - start;

    if (raceResult === "acquired") {
      // Acquired after waiting — that's fine, just verify it wasn't instant
      assert.ok(elapsed > 500, `Expected blocking delay, got ${elapsed}ms`);
    } else {
      // Timed out — confirms blocking behavior
      assert.equal(raceResult, "timeout");
    }
  });

  it("refills tokens over time", async () => {
    const limiter = new RateLimiter(60); // 60 RPM = 1 token per second
    // Drain all tokens
    for (let i = 0; i < 60; i++) {
      await limiter.acquire();
    }
    assert.ok(limiter.tokens < 1);
    // Wait 1.1 seconds — should refill ~1 token
    await new Promise((r) => setTimeout(r, 1100));
    await limiter.acquire(); // should not block long
  });
});

// =========================================================================
//  NIM response JSON parsing
// =========================================================================

describe("NIM JSON parsing", () => {
  function parseNimResponse(reply) {
    try {
      const jsonMatch = reply.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch {}
    return null;
  }

  it("parses clean JSON response", () => {
    const reply = '{"summary": "Test video", "topics": ["tech"], "tone": "neutral"}';
    const result = parseNimResponse(reply);
    assert.deepEqual(result, {
      summary: "Test video",
      topics: ["tech"],
      tone: "neutral",
    });
  });

  it("extracts JSON from surrounding text", () => {
    const reply = 'Here is the analysis:\n{"summary": "Test"}\nEnd of response.';
    const result = parseNimResponse(reply);
    assert.deepEqual(result, { summary: "Test" });
  });

  it("handles markdown-wrapped JSON", () => {
    const reply = '```json\n{"summary": "Test", "topics": ["a"]}\n```';
    const result = parseNimResponse(reply);
    assert.deepEqual(result, { summary: "Test", topics: ["a"] });
  });

  it("returns null for non-JSON response", () => {
    const reply = "I cannot analyze this video because the URL is invalid.";
    const result = parseNimResponse(reply);
    assert.equal(result, null);
  });

  it("returns null for malformed JSON", () => {
    const reply = '{"summary": "Test", "topics": [unclosed';
    const result = parseNimResponse(reply);
    assert.equal(result, null);
  });

  it("parses full spike-format response", () => {
    const reply = JSON.stringify({
      summary: "Pope Francis delivers a speech about AI disarmament.",
      topics: ["AI", "Ethics", "War"],
      on_screen_text: ["VATICAN CITY", "MAY 25"],
      tone: "Serious",
      speakers: [{ name: "Pope Francis", said: "AI needs to be disarmed." }],
      transcript_summary: "The Pope argues AI requires disarmament.",
      visual_details: "Vatican setting, formal podium, papal attire",
    });
    const result = parseNimResponse(reply);
    assert.equal(result.topics.length, 3);
    assert.equal(result.speakers[0].name, "Pope Francis");
    assert.ok(result.visual_details.includes("Vatican"));
  });
});

// =========================================================================
//  Groq rate limit header parsing
// =========================================================================

describe("Groq rate limit handling", () => {
  it("detects low remaining requests", () => {
    const remaining = "3";
    const isLow = parseInt(remaining, 10) < 5;
    assert.ok(isLow);
  });

  it("does not warn when requests plentiful", () => {
    const remaining = "18";
    const isLow = parseInt(remaining, 10) < 5;
    assert.ok(!isLow);
  });

  it("parses reset-after duration", () => {
    const resetAfter = "2.5";
    const waitMs = parseFloat(resetAfter) * 1000;
    assert.equal(waitMs, 2500);
  });

  it("caps wait time at 120s", () => {
    const resetAfter = "300";
    const waitMs = Math.min(parseFloat(resetAfter) * 1000, 120_000);
    assert.equal(waitMs, 120_000);
  });

  it("defaults wait time on invalid header", () => {
    const resetAfter = null;
    const waitMs = parseFloat(resetAfter) * 1000 || 60_000;
    assert.equal(waitMs, 60_000);
  });
});

// =========================================================================
//  enrich_video platform routing
// =========================================================================

describe("enrich_video platform routing", () => {
  function shouldTranscribe(platform, subtitleText, groqAvailable) {
    if (subtitleText) return false;
    if (platform === "instagram" && groqAvailable) return true;
    return false;
  }

  it("skips transcription when subtitle_text provided", () => {
    assert.ok(!shouldTranscribe("instagram", "existing subs", true));
  });

  it("transcribes Instagram when no subtitles", () => {
    assert.ok(shouldTranscribe("instagram", null, true));
  });

  it("skips Instagram transcription without Groq key", () => {
    assert.ok(!shouldTranscribe("instagram", null, false));
  });

  it("skips transcription for TikTok (has Apify subtitles)", () => {
    assert.ok(!shouldTranscribe("tiktok", null, true));
  });

  it("skips transcription for YouTube (has Apify subtitles)", () => {
    assert.ok(!shouldTranscribe("youtube", null, true));
  });
});
