# Writer Style Engine — Implementation Plan (Dependency Waves)

Spec: `tasks/specs/writer-style-engine.md`

Each wave is a set of parallel tasks with no internal dependencies. Waves execute sequentially — wave N+1 starts only after wave N is complete. Each task within a wave is scoped for one Claude Code agent in a worktree.

---

## Wave 0 — Data Files (3 parallel agents)

No code dependencies. Pure content curation. All output lands in `src/agents/data/style/`.

### Agent 0A: Word Blocklist + Alternatives

Create `src/agents/data/style/excess-words.json`:
```json
{
  "strict": ["delve", "tapestry", "multifaceted", "utilize", "harness", "leverage", "furthermore", "moreover"],
  "soft": ["innovative", "cutting-edge", "seamless", "robust", "holistic", "paradigm", ...],
  "alternatives": { "utilize": "use", "leverage": "use", "facilitate": "help", ... }
}
```
Source tier-1 from berenslab/llm-excess-vocab top-48x words. Soft list ~50 words from the categorized lists in the spec (inflated adjectives, filler nouns, vague verbs, formal transitions, hype phrases). Alternatives map for every strict + soft word that has an obvious plain-English substitute.

Files: `src/agents/data/style/excess-words.json`

### Agent 0B: Formulas + Platforms + Citations

Create three files:

`src/agents/data/style/formulas.json` — 5 copywriting formulas (AIDA, PAS, BAB, FAB, 4Ps). Each entry:
```json
{
  "name": "aida",
  "label": "AIDA",
  "steps": [
    { "name": "attention", "purpose": "Hook that stops the scroll", "constraints": "1-2 sentences max, lead with surprising stat or bold claim" },
    ...
  ],
  "best_for": ["ads", "landing pages", "email subject lines"]
}
```

`src/agents/data/style/platforms.json` — 5 platforms (twitter, linkedin, blog, whitepaper, email). Each entry: char limits, structure rules, tone defaults, paragraph constraints, CTA conventions. Use platform reference from spec.

`src/agents/data/style/citation-styles.json` — 6 styles (apa, mla, chicago, harvard, ieee, vancouver). Each entry: inline format template, bibliography format template, ordering rules, field requirements, when-to-use hint.

Files: `src/agents/data/style/formulas.json`, `src/agents/data/style/platforms.json`, `src/agents/data/style/citation-styles.json`

### Agent 0C: Default Style Profile

Create `src/agents/data/style/default-profile.json` — full schema from spec. Neutral-professional voice. This is the fallback when no style_profile specified in task payload.

Use exact schema from spec's "Style Profile Schema" section. Set tone axes to: formality 0.7, humor 0.1, enthusiasm 0.4, irreverence 0.1. Readability grade 10. Burstiness 0.55. Active ratio 0.85. Contractions true, first person false, fragments true.

Files: `src/agents/data/style/default-profile.json`

---

## Wave 1 — Metrics Library (1 agent)

Depends on: Wave 0 (needs excess-words.json schema to know blocklist format)

### Agent 1A: style-metrics.ts

Create `src/agents/extensions/style-metrics.ts`. Pure computation module, no Pi tool registration. Exports functions only — will be imported by extensions in Wave 2.

Functions to implement:

- `splitSentences(text: string): string[]` — split on `.!?` followed by whitespace or end. Handle abbreviations (Mr., Dr., U.S.) and decimal numbers. This is the foundation for all other metrics.
- `computeBurstiness(text): { coefficient: number, sentenceLengths: number[], mean: number, sd: number }` — sigma/mu of sentence word counts. Return -1 for <3 sentences.
- `computeExcessWordScore(text, blocklist): { score: number, hits: Array<{word, count, tier}> }` — count blocklist hits / total words. Exclude words inside quotes and proper nouns (capitalized mid-sentence).
- `computeEmDashDensity(text): { density: number, count: number, perThousand: number }` — count `—` and `--`, normalize per 1000 words.
- `computeSentenceLengthSD(text): number` — stdev of sentence word counts. Return 0 for <2 sentences.
- `computeActiveVoiceRatio(text): { ratio: number, passiveCount: number, totalCount: number }` — detect passive via `was|were|been|being|is|are` + past participle pattern (word ending in -ed, -en, -t, or irregular list).
- `computeReadabilityGrade(text): { grade: number, ease: number }` — Flesch-Kincaid grade + Flesch Reading Ease. Count syllables via vowel-group heuristic.
- `computeTypeTokenRatio(text): number` — unique lowercase words / total words.
- `computeRuleOfThreeRatio(text): { ratio: number, tripletLists: number, totalLists: number }` — find markdown lists and comma-separated lists, count those with exactly 3 items vs total.
- `runFullAnalysis(text, profile): { pass: boolean, metrics: Record<string, any>, violations: Array<{metric, actual, target, severity}> }` — run all metrics, compare against profile targets, return structured report.

Pattern: follow same module style as other extensions (TypeScript, node:fs imports, no external deps). Export all functions for direct import.

Reference files:
- `src/agents/extensions/artifacts.ts` — extension file pattern
- `src/agents/data/style/excess-words.json` — blocklist format (from Wave 0)
- `tasks/specs/writer-style-engine.md` — metric formulas and thresholds

Files: `src/agents/extensions/style-metrics.ts`

---

## Wave 2 — Pi Extensions (2 parallel agents)

Depends on: Wave 1 (both extensions import style-metrics.ts)

### Agent 2A: style-profile.ts

Create `src/agents/extensions/style-profile.ts`. Pi extension registering 3 tools.

**`load_style_profile`** — params: `{ path: string }`. Read JSON from path (typically `/artifacts/styles/X.json`). Validate required fields exist (tone, readability, rhythm, voice, vocabulary). On missing/invalid, read `/app/data/style/default-profile.json` and log warning. Return parsed profile object.

**`analyze_writing_samples`** — params: `{ samples_dir: string, output_path?: string }`. Read all `.md` files from directory. For each file, run metrics from style-metrics.ts. Aggregate across files: median sentence length, mean burstiness, mean TTR, overall active voice ratio, readability grade, punctuation frequency map. Extract 2 most representative paragraphs (closest to median metrics) as few-shot samples. Build style profile JSON. If output_path given, write to that path. Return profile.

**`get_style_instructions`** — params: `{ profile: object, platform?: string, formula?: string }`. Load platform config from `/app/data/style/platforms.json` if platform specified. Load formula from `/app/data/style/formulas.json` if specified. Generate concise prose instruction block (<500 tokens) combining: tone guidance from profile axes, vocabulary do/don't from blocklist + alternatives, rhythm targets (burstiness, sentence length range), structural rules (em dash cap, no compulsive summaries, vary paragraph length), platform constraints if applicable, formula structure if applicable. Return string for injection into LLM prompts.

Reference files:
- `src/agents/extensions/artifacts.ts` — Pi extension registration pattern (`export default function(api: ExtensionAPI)`)
- `src/agents/extensions/style-metrics.ts` — import metrics functions (from Wave 1)
- `src/agents/data/style/` — all data files (from Wave 0)
- `tasks/specs/writer-style-engine.md` — profile schema, platform reference

Files: `src/agents/extensions/style-profile.ts`

### Agent 2B: style-lint.ts

Create `src/agents/extensions/style-lint.ts`. Pi extension registering 2-3 tools.

**`validate_style`** — params: `{ text: string, profile_path?: string }`. Load profile (or use default). Run `runFullAnalysis` from style-metrics.ts. Additionally check: no "In conclusion" / "In summary" / "It's worth noting" / "Let's dive in" patterns. Check Rule of Three ratio. Build structured report: `{ pass: boolean, metrics: {...}, violations: [{type, location, detail, suggestion}] }`. Violation types: `excess_word`, `em_dash`, `low_burstiness`, `passive_voice`, `readability`, `ai_pattern`, `rule_of_three`.

**`fix_violations`** — params: `{ text: string, violations: array }`. Apply mechanical fixes only (no LLM): replace blocklist words using alternatives map, remove excess em dashes (replace with comma or period), strip "In conclusion" patterns. Return modified text + list of changes made. Does NOT fix burstiness or structural issues (those need LLM re-expansion).

**`vale_lint`** (conditional) — params: `{ text: string }`. Only register if Vale binary exists at `/usr/local/bin/vale`. Write text to temp file, run `vale --output=JSON <tmpfile>`, parse output, merge into standard violation format. Clean up temp file.

Reference files:
- `src/agents/extensions/style-metrics.ts` — import `runFullAnalysis` (from Wave 1)
- `src/agents/extensions/web-scrape.ts` — conditional tool registration pattern (check deps before registering)
- `src/agents/data/style/excess-words.json` — alternatives map for fix_violations
- `tasks/specs/writer-style-engine.md` — validation thresholds, violation types

Files: `src/agents/extensions/style-lint.ts`

---

## Wave 3 — AGENTS.md + Dockerfile (2 parallel agents)

Depends on: Wave 2 (needs to know tool names and params from extensions)

### Agent 3A: AGENTS.md Rewrite

Update `src/agents/writer/AGENTS.md`. Keep existing pipeline structure (PLAN/EXPAND/STITCH/POLISH). Add style engine integration points.

Changes:

1. Add **Step 0.5 — STYLE RESOLUTION** between Resume Check and PLAN:
   - If task payload has `style_profile` path, call `load_style_profile`
   - If task payload has `platform`, note platform constraints
   - If task payload has `copy_formula`, note formula structure
   - Call `get_style_instructions` with resolved profile + platform + formula
   - Store instruction block for injection into later steps

2. Update **PLAN** — add to skeleton objectives: tone target per section, word count target, style notes. When `copy_formula` specified, map formula steps to section structure.

3. Update **EXPAND** — each subagent prompt gets the style instruction block from Step 0.5. If profile has `few_shot_samples`, include 1-2 in each section prompt. Add explicit negative instructions: "Do not use these words: [strict blocklist]. Do not start with 'In today's...' or end with 'In conclusion'. Vary sentence length between 3-45 words. Use contractions. No em dashes."

4. Update **POLISH** — after formatting check, call `validate_style`. If violations found, call `fix_violations` for mechanical fixes. If structural violations remain (low burstiness, uniform paragraphs), re-expand only the failing sections with correction instructions.

5. Add **AI Tell Avoidance** section — explicit rules the agent must internalize. List tier-1 blocked words. List banned patterns. Burstiness floor. Em dash cap.

6. Add **Platform Formats** section — 1-paragraph reference for each platform.

7. Add **Copy Formulas** section — when to apply, how formulas map to document structure.

8. Add **Style Cloning** section — when task includes `action: "analyze_style"`, run `analyze_writing_samples` instead of document pipeline.

Keep the doc_style interpretation table. Keep intel quality handling. Keep manifest schema. Keep constraints section. The pipeline stages stay the same — style engine hooks into them, doesn't replace them.

Reference files:
- `src/agents/writer/AGENTS.md` — current content (read it fully before editing)
- `tasks/specs/writer-style-engine.md` — behavioral contracts, platform reference, formula catalog, blocklist
- `src/agents/extensions/style-profile.ts` — tool names and params (from Wave 2A)
- `src/agents/extensions/style-lint.ts` — tool names and params (from Wave 2B)

Files: `src/agents/writer/AGENTS.md`

### Agent 3B: Bespoke Dockerfile + Vale

Create `src/agents/writer/Dockerfile` (bespoke, pattern from `src/agents/researcher/Dockerfile`).

Base: `node:22-slim`. Install git. No python needed (writer doesn't scrape).

Add Vale installation:
```dockerfile
RUN curl -sfL https://github.com/errata-ai/vale/releases/download/v3.11.2/vale_3.11.2_Linux_64-bit.tar.gz | tar xz -C /usr/local/bin vale
```
(Check latest Vale release version. Single binary, no deps.)

COPY paths (hardcoded to writer/, not using AGENT_NAME arg):
- `bridge.mjs` → `/app/`
- `extensions/` → `/app/extensions/`
- `skills/` → `/app/skills/`
- `data/style/` → `/app/data/style/`
- `writer/.pi/agent/config.yml` → `/root/.pi/agent/`
- `writer/.pi/agent/models.json` → `/root/.pi/agent/`
- `writer/.pi/agent/settings.json` → `/root/.pi/agent/`
- `writer/.pi/agent/auth.json` → `/root/.pi/agent/`
- `writer/AGENTS.md` → `/app/AGENTS.md`

Create Vale config:
- `src/agents/vale/.vale.ini` — minimal config pointing to `styles/` dir
- `src/agents/vale/styles/Paperclip/ExcessWords.yml` — Vale rule checking for strict blocklist words
- `src/agents/vale/styles/Paperclip/EmDash.yml` — Vale rule flagging em dash overuse
- `src/agents/vale/styles/Paperclip/AIPatterns.yml` — Vale rule for "In conclusion", "It's worth noting", etc.

COPY `vale/` → `/app/vale/` in Dockerfile.

Update `docker-compose.yml`: change writer service from shared image to bespoke build:
```yaml
writer:
  build:
    context: src/agents
    dockerfile: writer/Dockerfile
```

Pi extensions install same as researcher: `RUN pi extensions install npm:shitty-extensions npm:@ifi/pi-extension-subagents npm:pi-otel || true`

Reference files:
- `src/agents/researcher/Dockerfile` — bespoke Dockerfile pattern
- `src/agents/data/Dockerfile` — heavy bespoke Dockerfile pattern
- `docker-compose.yml` — current writer service definition
- `src/agents/data/style/excess-words.json` — word list for Vale rules (from Wave 0)

Files: `src/agents/writer/Dockerfile`, `src/agents/vale/.vale.ini`, `src/agents/vale/styles/Paperclip/ExcessWords.yml`, `src/agents/vale/styles/Paperclip/EmDash.yml`, `src/agents/vale/styles/Paperclip/AIPatterns.yml`, `docker-compose.yml` (edit only writer service)

---

## Wave 4 — Tests (2 parallel agents)

Depends on: Wave 2 (extensions must exist to test), Wave 3A (AGENTS.md for E2E context)

### Agent 4A: Unit Tests

Create `tests/style/unit-test.mjs`. Node test runner (`node --test`), zero external deps.

Test suites:

**style-metrics.ts tests:**
- `computeBurstiness` — known human text (SD ~8, coefficient ~0.6), known AI text (SD ~2, coefficient ~0.15), edge cases (<3 sentences returns -1, single long sentence)
- `computeExcessWordScore` — text with 0 hits, text with 5 strict hits, text with words in quotes (excluded), mixed strict+soft
- `computeEmDashDensity` — text with 0 em dashes, text with 5 `—`, text with `--` (both counted)
- `computeSentenceLengthSD` — uniform sentences (low SD), varied sentences (high SD), single sentence (returns 0)
- `computeActiveVoiceRatio` — all active, all passive, mixed 80/20
- `computeReadabilityGrade` — simple text (grade ~5), complex text (grade ~14), known Flesch-Kincaid reference sentences
- `computeTypeTokenRatio` — repetitive text (low), diverse text (high)
- `computeRuleOfThreeRatio` — markdown lists with 2/3/4 items, comma lists
- `runFullAnalysis` — pass case (all metrics within targets), fail case (3 violations)

**Fixture texts** (inline in test file):
- `HUMAN_TEXT` — paragraph from a real essay with varied sentence length, no AI tells
- `AI_TEXT` — paragraph with uniform sentences, em dashes, "delve", "furthermore", "In conclusion"
- `MIXED_TEXT` — mostly clean but 2 blocklist words and slightly low burstiness

Reference files:
- `tests/deep-research/` — existing unit test pattern with node --test
- `src/agents/extensions/style-metrics.ts` — functions under test (from Wave 1)
- `src/agents/data/style/excess-words.json` — blocklist format (from Wave 0)
- `src/agents/data/style/default-profile.json` — profile format (from Wave 0)

Files: `tests/style/unit-test.mjs`

### Agent 4B: Integration + Extension Tests

Create `tests/style/integration-test.mjs`. Tests that exercise the full extension tool flow.

Test suites:

**style-profile.ts tests:**
- `load_style_profile` — valid profile loads correctly, missing file falls back to default, malformed JSON falls back to default with warning
- `analyze_writing_samples` — create temp dir with 3 fixture .md files, run analysis, verify output has all required profile fields, verify few_shot_samples extracted, verify metrics are sane ranges
- `get_style_instructions` — default profile produces instruction block <500 tokens, platform=twitter adds char limit mention, formula=aida adds 4-step structure mention

**style-lint.ts tests:**
- `validate_style` — clean text passes, AI-heavy text fails with specific violation types, verify violation locations are accurate
- `fix_violations` — excess word violations get replaced (delve→explore), em dash violations get replaced with commas, "In conclusion" patterns removed. Verify text still makes grammatical sense after fixes.

**Integration flow:**
- Load default profile → get style instructions → validate AI text → get violations → fix mechanical violations → re-validate → fewer violations

Reference files:
- `tests/paperclip-tools/unit-test.mjs` — integration test pattern
- `src/agents/extensions/style-profile.ts` — tools under test (from Wave 2A)
- `src/agents/extensions/style-lint.ts` — tools under test (from Wave 2B)

Files: `tests/style/integration-test.mjs`

---

## Wave 5 — Wire + Validate (1 agent, sequential)

Depends on: all prior waves

### Agent 5A: Integration + E2E Validation

Not parallelizable — touches running system.

1. Verify `docker compose build writer` succeeds with bespoke Dockerfile
2. Verify Vale binary works: `docker compose run --rm writer vale --version`
3. Verify extensions load: `docker compose run --rm writer pi --mode json -e /app/extensions/style-metrics.ts -e /app/extensions/style-profile.ts -e /app/extensions/style-lint.ts -p "list tools"`
4. Run unit tests: `node --test tests/style/unit-test.mjs`
5. Run integration tests: `node --test tests/style/integration-test.mjs`
6. Create E2E test script `tests/e2e/e2e-10-writer-style.sh`:
   - Place fixture style profile in `/artifacts/styles/test-profile.json`
   - Invoke Writer with `style_profile` + `platform: blog` in task payload
   - Verify output contains no tier-1 blocklist words
   - Verify burstiness > 0.35
   - Verify em dash density < 5 per 1000

Files: `tests/e2e/e2e-10-writer-style.sh`, fixes to any files broken during integration

---

## Summary

| Wave | Agents | What | Depends on |
|------|--------|------|-----------|
| 0 | 3 parallel | Data files (blocklist, formulas, platforms, citations, default profile) | nothing |
| 1 | 1 | style-metrics.ts (pure computation library) | Wave 0 |
| 2 | 2 parallel | style-profile.ts + style-lint.ts (Pi extensions) | Wave 1 |
| 3 | 2 parallel | AGENTS.md rewrite + Dockerfile/Vale/compose | Wave 2 |
| 4 | 2 parallel | Unit tests + integration tests | Wave 2 |
| 5 | 1 | Wire up, build, run all tests, E2E | Waves 3+4 |

Total: 5 waves, 11 agent tasks, max 3 concurrent per wave.
