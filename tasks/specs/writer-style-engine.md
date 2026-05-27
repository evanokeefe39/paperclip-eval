# Writer Style Engine — Spec

## Intent

Give the Writer agent fine-grained control over tone, voice, style, and format so that output reads as human-authored, platform-appropriate, and brand-consistent. Eliminate AI writing tells. Enable style cloning from sample documents.

## Context Package

### Relevant existing code

- `src/agents/writer/AGENTS.md` — current system prompt (pipeline only, no style control)
- `src/agents/writer/.pi/agent/config.yml` — model roles
- `src/agents/extensions/` — extension pattern (TypeScript, Pi tool registration)
- `tasks/plans/writer-agent-design.md` — pipeline architecture (PLAN/EXPAND/STITCH/POLISH)

### Architectural constraints

- Writer runs in Docker, Node 22, Pi RPC mode
- No web access — all style data must be pre-loaded or computed locally
- Extensions are TypeScript files loaded via `-e` flag in bridge.mjs
- Artifacts at `/artifacts/` for inter-agent file sharing
- Free-tier LLM providers only (DeepSeek, MiniMax, Groq, Nvidia, OpenRouter)
- Vale is a Go binary — can be installed in container at build time

### Prior decisions

- Document pipeline is skeleton-based: PLAN → EXPAND → STITCH → POLISH
- One document per invocation, checkpoint-based resumability
- `doc_style` parameter already exists (summary/briefing/report/deep-dive)
- Intel quality handled upstream by Researcher (ADMIRALTY grades)

### Anti-patterns to avoid

- No Anthropic models or packages
- No npm framework dependencies in bridge (zero-dep design)
- No over-engineering — extensions can have deps, bridge cannot
- No interactive CLI tools in containers

## Behavioral Contracts

### Style Profile Loading

GIVEN a task payload containing `style_profile` path (e.g. `/artifacts/styles/brand-voice.json`)
WHEN Writer begins PLAN step
THEN load profile and apply all constraints to skeleton objectives and section guidelines

GIVEN no `style_profile` in payload
WHEN Writer begins PLAN step
THEN use default neutral-professional profile (built-in fallback)

### Tone Axis Control

GIVEN a style profile with tone axes (formal/casual, serious/funny, enthusiastic/matter-of-fact, respectful/irreverent)
WHEN generating any prose section
THEN output must score within one step of target on each axis (validated by self-assessment)

### AI Tell Avoidance

GIVEN the excess word blocklist is loaded
WHEN generating prose
THEN zero occurrences of tier-1 blocked words (delve, tapestry, multifaceted, leverage, utilize, harness, furthermore, moreover)
AND em dash count per 1000 words < 3
AND no "In conclusion" / "It's worth noting" / "Let's dive in" patterns
AND sentence length standard deviation > 5 words (burstiness floor)

### Burstiness Target

GIVEN a burstiness target in the style profile (default: 0.55)
WHEN POLISH step runs validation
THEN computed burstiness coefficient (sigma/mu of sentence word counts) is within 0.15 of target

### Platform Format

GIVEN `platform` field in task payload (linkedin, twitter, blog, whitepaper, email)
WHEN generating content
THEN apply platform-specific constraints:
- twitter: max 280 chars per post, thread format if multi-post, punchy/opinionated
- linkedin: hook-first, 1-2 sentence paragraphs, business-casual, CTA
- blog: scannable headings, 800-2000 words, conversational authority
- whitepaper: formal, evidence-driven, citations required, 3000-10000 words
- email: front-load ask, scannable, match relationship formality

### Copywriting Formula

GIVEN `copy_formula` field in task payload (aida, pas, bab, fab, 4ps)
WHEN generating marketing/persuasive content
THEN structure follows the named formula:
- AIDA: Attention → Interest → Desire → Action
- PAS: Problem → Agitate → Solution
- BAB: Before → After → Bridge
- FAB: Features → Advantages → Benefits
- 4Ps: Promise → Picture → Proof → Push

### Citation Style

GIVEN `citation_style` field in style profile (apa, mla, chicago, harvard, ieee, vancouver)
WHEN citing sources in content
THEN format all citations and references according to the named style guide

### Style Cloning

GIVEN writing samples at `/artifacts/styles/samples/{profile-name}/*.md`
WHEN `analyze_writing_samples` tool is called
THEN compute: sentence length distribution, vocabulary richness (TTR), punctuation frequency map, paragraph length variance, active/passive ratio, readability grade
AND output structured style profile JSON

GIVEN a cloned style profile with few-shot examples
WHEN generating prose
THEN include 1-2 sample excerpts in section expansion prompt as style reference

### Post-Generation Validation

GIVEN completed prose output
WHEN POLISH step runs
THEN compute style metrics and compare against profile targets:
- Excess word score (blocklist hits / total words) < 0.005
- Burstiness within 0.15 of target
- Em dash density < 3 per 1000 words
- Sentence length SD > 5 words
- No structural AI tells (Rule of Three lists > 30% of all lists, uniform paragraph length)

GIVEN validation fails
WHEN specific violations identified
THEN re-expand only the failing sections with explicit correction instructions (not full rewrite)

## Edge Case Inventory

1. Style profile missing required fields — fall back to defaults for missing fields, log warning
2. Conflicting instructions (e.g. formal tone + twitter platform) — platform constraints win
3. Source material too short for target burstiness — relax burstiness floor to 0.35
4. Copywriting formula + long-form doc_style — formula applies to intro/conclusion only, body is standard
5. Blocklist word appears in a proper noun or direct quote — exclude from count
6. Style samples contain non-English text — skip TTR computation, use other metrics only
7. Vale rules file missing at container start — skip Vale validation, rely on built-in metrics only
8. Cloned profile targets burstiness > 0.85 — cap at 0.85 (beyond this reads as incoherent)

## Definition of Done

- [ ] Style profile JSON schema defined and documented
- [ ] `style-profile.ts` extension registers `analyze_writing_samples` and `load_style_profile` tools
- [ ] `style-lint.ts` extension registers `validate_style` tool
- [ ] Blocklist loaded from `/app/data/excess-words.json` (sourced from berenslab dataset)
- [ ] AGENTS.md updated with style-aware PLAN/EXPAND/STITCH/POLISH instructions
- [ ] Copywriting formula catalog in `/app/data/formulas.json`
- [ ] Platform format templates in `/app/data/platforms.json`
- [ ] Vale installed in Writer Dockerfile, brand rules in `/app/vale/`
- [ ] Burstiness, excess-word, em-dash metrics computed correctly (unit tests)
- [ ] End-to-end: task with style profile produces compliant output
- [ ] End-to-end: task with `platform: twitter` produces thread-formatted output
- [ ] End-to-end: analyze_writing_samples produces valid profile from 5 sample docs
- [ ] Reasoning trace written
- [ ] Assumption log written

## Negative Space

What must not change:
- Pipeline architecture (PLAN/EXPAND/STITCH/POLISH) stays intact
- Checkpoint/manifest system unchanged
- Intel quality handling (ADMIRALTY grades) unchanged
- Inter-agent artifact protocol unchanged
- Bridge.mjs stays zero-dep

What is out of scope:
- Fine-tuning models on writing samples (few-shot only)
- Real-time style detection during generation (post-hoc validation only)
- Content publishing (Publisher agent's job)
- Fact-checking (Researcher's job)
- Multi-language support (English only for now)

What decisions are reserved for human review:
- Which Vale rule sets to adopt (Microsoft? Elastic? Custom?)
- Exact blocklist thresholds (how aggressively to filter)
- Whether to add TinyStyler model (800M params, requires Python runtime)

## Open Questions

(empty — all resolved in spec or deferred to human review section)

---

## Style Profile Schema

```json
{
  "name": "brand-voice-acme",
  "version": 1,
  "tone": {
    "formality": 0.7,
    "humor": 0.1,
    "enthusiasm": 0.5,
    "irreverence": 0.2
  },
  "readability": {
    "target_grade": 10,
    "max_grade": 14
  },
  "rhythm": {
    "burstiness_target": 0.55,
    "min_sentence_words": 3,
    "max_sentence_words": 45,
    "paragraph_length_variance": "high"
  },
  "voice": {
    "active_ratio": 0.85,
    "contractions": true,
    "first_person": false,
    "sentence_fragments": true
  },
  "vocabulary": {
    "blocklist_strict": ["delve", "tapestry", "multifaceted", "utilize", "harness", "leverage", "furthermore", "moreover"],
    "blocklist_soft": ["innovative", "cutting-edge", "seamless", "robust", "holistic", "paradigm", "synergy", "journey"],
    "preferred_alternatives": {
      "utilize": "use",
      "leverage": "use",
      "facilitate": "help",
      "innovative": "new",
      "robust": "strong",
      "comprehensive": "full",
      "streamline": "simplify"
    }
  },
  "structure": {
    "max_em_dashes_per_1000": 3,
    "max_semicolons_per_1000": 2,
    "rule_of_three_cap": 0.3,
    "no_compulsive_summary": true,
    "no_present_participial_excess": true
  },
  "platform": null,
  "citation_style": null,
  "copy_formula": null,
  "few_shot_samples": []
}
```

## Copywriting Formula Catalog

### AIDA (Attention-Interest-Desire-Action)
- Attention: hook that stops the scroll / grabs focus
- Interest: expand with relevant information, build curiosity
- Desire: connect to reader's needs, paint outcome
- Action: clear CTA with low friction

### PAS (Problem-Agitate-Solution)
- Problem: name the pain point directly
- Agitate: amplify consequences of inaction
- Solution: present the fix with proof

### BAB (Before-After-Bridge)
- Before: current painful state
- After: desired future state
- Bridge: how to get there (your product/service)

### FAB (Features-Advantages-Benefits)
- Features: what it does (technical)
- Advantages: why that matters (comparative)
- Benefits: what the reader gains (emotional/practical)

### 4Ps (Promise-Picture-Proof-Push)
- Promise: bold claim or outcome
- Picture: vivid scenario of success
- Proof: evidence, testimonials, data
- Push: urgency + CTA

## Platform Format Reference

### Twitter/X
- 280 char limit per post
- Thread format: numbered or unnumbered continuation
- Hook in first post (question, bold claim, stat)
- No hashtag spam (0-2 max)
- Conversational, opinionated, punchy
- Sentence fragments normal

### LinkedIn
- Hook-first (2-line opener visible before "see more")
- Short paragraphs (1-2 sentences)
- Line breaks between paragraphs
- Business casual tone
- End with CTA or question to drive comments
- 3000 char limit (post), emojis sparingly OK

### Blog
- Scannable: H2/H3 headings every 200-300 words
- 800-2000 words typical
- Conversational authority
- Links to sources inline
- Meta description (155 chars) as separate output
- Opening hook within first 100 words

### Whitepaper
- Formal academic-adjacent tone
- Executive summary required
- Data tables, charts referenced
- Citations in chosen style (APA default)
- 3000-10000 words
- Numbered sections

### Email
- Subject line: 6-10 words, specific
- Front-load the ask (first 2 sentences)
- Scannable body (bullets if > 3 points)
- Formality matches relationship
- Sign-off appropriate to context

## Metrics Computation Reference

### Burstiness
```
sentences = split_on_sentence_boundaries(text)
lengths = [word_count(s) for s in sentences]
burstiness = stdev(lengths) / mean(lengths)
```
Human range: 0.55-0.85. AI default: 0.20-0.35.

### Excess Word Score
```
hits = count(word in text for word in blocklist_strict + blocklist_soft)
score = hits / total_word_count
```
Target: < 0.005 (less than 1 flagged word per 200)

### Em Dash Density
```
em_dashes = count("—" in text) + count("--" in text)
density = em_dashes / (total_word_count / 1000)
```
Target: < 3 per 1000 words

### Sentence Length SD
```
sd = stdev([word_count(s) for s in sentences])
```
Floor: > 5 words SD (AI typically produces SD of 2-3)

### Active Voice Ratio
Heuristic: sentences containing "was/were/been/being + past participle" pattern count as passive.
Target: per style profile (default 0.85)

## Sources

- [berenslab/llm-excess-vocab](https://github.com/berenslab/llm-excess-vocab) — quantitative word frequency data
- [brandonwise/humanizer](https://github.com/brandonwise/humanizer) — npm AI pattern scorer
- [Vale](https://github.com/errata-ai/vale) — style-as-code prose linter
- [CoppieGPT](https://github.com/WynterJones/CoppieGPT) — 232 copywriting formula catalog
- [Nielsen Norman Group](https://www.nngroup.com/articles/tone-of-voice-dimensions/) — 4-axis tone framework
- [Kobak et al. 2025](https://www.science.org/doi/10.1126/sciadv.adt3813) — LLM vocabulary excess in publications
- [TinyStyler](https://github.com/zacharyhorvitz/TinyStyler) — style transfer model (reference only)
- [LangChain Social Media Agent](https://github.com/langchain-ai/social-media-agent) — platform-specific drafting architecture
- [social-media-kit](https://github.com/terrytangyuan/social-media-kit) — platform formatting utilities
