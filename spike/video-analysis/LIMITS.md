# Video & Audio Analysis — Provider Limits and Cost Reference

Last verified: 2026-05-27

## Pipeline Overview

```
Apify (TikTok/YouTube/Instagram scrape + native subtitles)
  ├── TikTok:    $0.004/result, subtitles free (toggle shouldDownloadSubtitles)
  ├── YouTube:   $0.003/video,  subtitles free (toggle downloadSubtitles)
  └── Instagram: $0.0023/reel,  transcript $0.041/min (expensive — use Groq instead)
        │
        ▼
Groq Whisper (Instagram reel audio transcription — free tier)
  └── Extract audio from downloaded reel → Whisper → transcript text
        │
        ▼
NVIDIA NIM Nemotron 3 Nano Omni (video analysis — free tier)
  └── Apify video URL → visual analysis JSON (on-screen text, speakers, visuals)
```

## NVIDIA NIM Free Tier

**Model:** nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
**Endpoint:** https://integrate.api.nvidia.com/v1/chat/completions
**Auth:** Bearer token (nvapi-... key from build.nvidia.com)

| Metric | Value | Source |
|---|---|---|
| RPM | 40 requests/minute | Forums, docs |
| Daily cap | None documented | No evidence of daily limit |
| Monthly cap | None documented | RPM is the only gate |
| Token limit | None documented | No per-token billing on free tier |
| Credit system | Phased out ~2025 | Was 1,000 credits, now RPM-only |
| Video input | URL-based only | base64 returns 401 on hosted endpoint |
| Video format | MP4 | Confirmed working |
| Rate limit headers | Not exposed | No x-ratelimit-* headers returned |

**Per-video consumption (from spike test):**
- Input tokens: ~9,200 (53s video)
- Output tokens: ~1,800
- Latency: ~20 seconds
- Cost: $0

**Throughput at 40 RPM (sequential, 20s/video):**
- Effective: ~3 videos/minute (limited by response time, not RPM)
- 100 videos: ~35 minutes
- Parallelism possible but response time is the bottleneck

**Throughput at 40 RPM (parallel):**
- Can fire 40 concurrent requests
- Each takes ~20s, so batch of 40 completes in ~20s
- 100 videos: 3 batches × 20s = ~60 seconds theoretical
- Realistic with overhead: ~3-5 minutes

**Upgrade path:** Apply at NVIDIA Developer Forums for 200 RPM

### NIM Gotchas
- No rate limit headers → must implement client-side rate limiting
- Video must be at a publicly accessible URL (Apify KVS URLs work)
- `reasoning` parameter causes repetition loops — use structured JSON prompts
- `source .env` in bash doesn't pass env vars to Node reliably — read .env directly in scripts

## Groq Whisper Free Tier

**Model:** whisper-large-v3-turbo
**Endpoint:** https://api.groq.com/openai/v1/audio/transcriptions
**Auth:** Bearer token (gsk_... key)

| Metric | Value | Source |
|---|---|---|
| RPM | 20 requests/minute | Groq docs |
| Daily requests | 2,000/day | Groq docs |
| Audio per hour | 7,200 seconds (2 hours) | Groq docs |
| Speed | 216x realtime (60min in 16s) | Groq blog |
| Paid price | $0.04/hour | If free tier exceeded |
| File size limit | 25MB | Groq docs |
| Rate limit headers | Yes (x-ratelimit-*) | Confirmed |

**For 34 Instagram reels (~1 min avg):**
- Total audio: ~34 minutes
- Requests: 34 (well under 2,000/day)
- Audio: 2,040 seconds (under 7,200/hr)
- Time: 34 reels at 216x → ~10 seconds total processing
- Cost: $0

## Apify Actor Costs (Bronze Tier)

### TikTok Data Extractor (clockworks/free-tiktok-scraper)
| Event | Cost |
|---|---|
| Result (per video) | $0.004 |
| Subtitles toggle | Free (no extra charge) |
| Video download toggle | Free (no extra charge) |

### YouTube Scraper (streamers/youtube-scraper)
| Event | Cost |
|---|---|
| Video (per result) | $0.003 |
| Subtitles toggle | Free (no extra charge) |
| Date range filter | $0.001 extra |

### Instagram Reel Scraper (apify/instagram-reel-scraper)
| Event | Cost |
|---|---|
| Reel (per result) | $0.0023 |
| Actor start | $0.001 flat |
| Transcript add-on | $0.041/started minute |
| Video download add-on | $0.015/started MB |
| Shares count add-on | $0.006/reel |

### Instagram Scraper (apify/instagram-scraper) — for non-reel content
| Event | Cost |
|---|---|
| Result (per item) | ~$0.004 |
| No transcript support | — |

## Cost Summary: 100 Videos

| Component | Count | Unit Cost | Total |
|---|---|---|---|
| TikTok scrape + subtitles | 33 | $0.004 | $0.13 |
| YouTube scrape + subtitles | 33 | $0.003 | $0.10 |
| Instagram reel scrape (no transcript) | 34 | $0.0023 | $0.08 |
| Instagram audio transcript (Groq) | 34 | $0 | $0.00 |
| Video analysis (NIM) | 100 | $0 | $0.00 |
| **Total** | | | **$0.31** |

## Bottleneck Phases

The pipeline hits different ceilings at different scales. Three resources gate throughput:

```
Phase 1: Apify-bound    (1–500 videos)     Apify actor runtime is the bottleneck
Phase 2: NIM-bound       (500–5,000 videos) NIM 40 RPM / 20s latency is the bottleneck
Phase 3: Groq-bound      (2,000+ IG reels)  Groq 2,000 req/day hard cap
```

### Phase 1: Apify-bound (1–500 videos)

NIM and Groq both finish faster than Apify scraping.

| Resource | Rate | 100 videos | 500 videos |
|---|---|---|---|
| Apify scrape | ~30s per actor run, parallel | ~3 min | ~10 min |
| NIM analysis | 40 RPM, ~20s each, batched | ~5 min | ~25 min |
| Groq transcription | 20 RPM, <1s each | ~10s | ~50s |
| **Wall clock** | | **~8 min** | **~30 min** |

Bottleneck: Apify actor execution time (scraping + downloading videos/subtitles).

### Phase 2: NIM-bound (500–5,000 videos)

NIM becomes the slowest step. At 40 RPM with 20s latency:

| Concurrency | Effective rate | 1,000 videos | 5,000 videos |
|---|---|---|---|
| Sequential | ~3/min | ~5.5 hrs | ~28 hrs |
| 10 parallel | ~30/min | ~33 min | ~2.8 hrs |
| 40 parallel (max RPM) | ~120/min (theoretical) | ~8 min | ~42 min |

Reality check: 40 parallel requests each taking 20s = 40 completions per 20s = 120/min.
But NIM may throttle or degrade under 40 concurrent video requests. Safe estimate: 20 parallel.

| Concurrency | Effective rate | 1,000 videos | 5,000 videos |
|---|---|---|---|
| 20 parallel (safe) | ~60/min | ~17 min | ~83 min |

Bottleneck: NIM 40 RPM rate limit.
Mitigation: Request 200 RPM upgrade → 5x throughput.

### Phase 3: Groq-bound (2,000+ Instagram reels/day)

Groq Whisper free tier hard caps at 2,000 requests/day. Only applies to Instagram reels
(TikTok and YouTube get transcripts from Apify for free).

| IG reels/day | Groq requests | Status |
|---|---|---|
| 100 | 100 | Well within limit |
| 1,000 | 1,000 | Fine |
| 2,000 | 2,000 | At cap |
| 3,000 | 2,000 + 1,000 overflow | Need fallback |

Overflow options:
1. NIM Parakeet (free, untested, same 40 RPM pool)
2. Mistral Voxtral ($0.003/min — 1,000 reels × 1min = $3.00)
3. Second Groq account (if ToS allows)

### Daily Maximums (single account, free tier)

| Resource | Hard limit | Effective daily max |
|---|---|---|
| NIM video analysis | 40 RPM, no daily cap | ~86,400 videos (theoretical at 1/s) |
| NIM video analysis | 20 parallel, 20s each | ~5,760 videos/day (realistic) |
| Groq IG transcription | 2,000 req/day | 2,000 reels/day |
| Groq audio per hour | 7,200 seconds/hr | ~120 min/hr → ~2,880 min/day |
| Apify (budget-gated) | Depends on $ | $5 free tier → ~1,400 videos |

**Practical daily max on free tiers: ~1,400 videos** (Apify $5/month free tier is the real ceiling).

With $10/month Apify: ~3,200 videos/day.
With $50/month Apify: ~16,000 videos/day (NIM becomes bottleneck, request 200 RPM).

## Cost Curve

| Videos/month | Apify | NIM | Groq | Total | $/video |
|---|---|---|---|---|---|
| 100 | $0.31 | $0 | $0 | **$0.31** | $0.003 |
| 500 | $1.55 | $0 | $0 | **$1.55** | $0.003 |
| 1,000 | $3.10 | $0 | $0 | **$3.10** | $0.003 |
| 5,000 | $15.50 | $0 | $0 | **$15.50** | $0.003 |
| 10,000 | $31.00 | $0 | $0* | **$31.00** | $0.003 |
| 50,000 | $155.00 | $0 | $3.00** | **$158.00** | $0.003 |

*Assumes IG reels ≤33% of total and ≤2,000/day.
**At 50K, IG reels exceed free Groq tier — Voxtral fallback at $0.003/min.

Cost is almost entirely Apify. NIM and Groq are free rounding errors.

### Breakpoints Where Free Tiers Run Out

| Threshold | What breaks | Fix | Added cost |
|---|---|---|---|
| >2,000 IG reels/day | Groq daily cap | Voxtral fallback | $0.003/min |
| >5,760 videos/day | NIM throughput | 200 RPM upgrade | $0 (apply) |
| >$5/month Apify | Apify free tier | Upgrade plan | $49/month Personal |
| >40 RPM sustained | NIM rate limit | OpenRouter fallback | $1 deposit + free |

## Provider Priority (video analysis)

1. NVIDIA NIM (free, proven, URL-based video)
2. OpenRouter Nemotron :free (fallback, requires $1 deposit for video)
3. DeepSeek V4 Flash (quality fallback, $0.14/M input tokens)

## Provider Priority (audio transcription)

1. Groq Whisper (free tier, 2,000 req/day)
2. NVIDIA NIM Parakeet (free tier, untested)
3. Mistral Voxtral ($0.003/min, cheap fallback)
