#!/usr/bin/env node
/**
 * Integration tests for style-profile.ts and style-lint.ts extensions.
 *
 * Strategy: style-metrics.ts is imported directly via --experimental-strip-types
 * (no external deps). The extension entry points (style-profile.ts, style-lint.ts)
 * depend on typebox and @mariozechner/pi-coding-agent which are only available
 * inside Docker containers, so their execute logic is exercised by calling
 * style-metrics functions directly and replicating the thin filesystem layer
 * in test helpers — identical pattern to tests/deep-research/unit-test.mjs.
 *
 * File paths: data files are read from src/agents/data/style/ (the host path for
 * what is /app/data/style/ inside containers).
 *
 * Run:
 *   node --experimental-strip-types --test tests/style/integration-test.mjs
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

// ---------------------------------------------------------------------------
// Resolve paths relative to repo root (works regardless of cwd)
// ---------------------------------------------------------------------------

const __filename = url.fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(__filename), "../..");
const DATA_DIR = path.join(REPO_ROOT, "src/agents/data/style");
const DEFAULT_PROFILE_PATH = path.join(DATA_DIR, "default-profile.json");
const EXCESS_WORDS_PATH = path.join(DATA_DIR, "excess-words.json");

// ---------------------------------------------------------------------------
// Import style-metrics.ts directly (zero external deps, strip-types works)
// ---------------------------------------------------------------------------

const metrics = await import(
  url.pathToFileURL(path.join(REPO_ROOT, "src/agents/extensions/style-metrics.ts")).href
);

const {
  runFullAnalysis,
  loadBlocklist,
  detectAITellPatterns,
  computeBurstiness,
  computeTypeTokenRatio,
  computeActiveVoiceRatio,
  computeReadabilityGrade,
  computeSentenceLengthSD,
  computeEmDashDensity,
} = metrics;

// ---------------------------------------------------------------------------
// Fixture texts
// ---------------------------------------------------------------------------

const AI_TEXT =
  "In today's rapidly evolving digital landscape, it is crucial to delve into the multifaceted nature of artificial intelligence. Furthermore, organizations must leverage cutting-edge technologies to harness the transformative potential of these innovative solutions. Moreover, the robust ecosystem of AI tools — encompassing everything from natural language processing to computer vision — represents a paradigm shift in how we navigate complex challenges. In conclusion, it's worth noting that the comprehensive adoption of AI will fundamentally reshape our understanding of technology.";

const HUMAN_TEXT =
  "The old house sat crooked on its foundation. Nobody remembered when it had started to lean — sometime after the war, people said, though which war depended on who you asked. Paint peeled from the clapboards in long, lazy strips. Inside, the floors sloped toward the kitchen. You could set a marble down in the living room and watch it roll clear to the back door. The plumber refused to work there. \"Water don't flow uphill,\" he said, \"and in that house, I'm never sure which way is up.\" Three families had tried to live there since the Hendersons left. None lasted a full year.";

// ---------------------------------------------------------------------------
// Helpers — mirror the thin fs layer that the extension execute functions use
// ---------------------------------------------------------------------------

/**
 * Load a StyleProfile from a JSON file path. Falls back to default if:
 * - file not found
 * - file is not valid JSON
 * - parsed value is not an object
 * - required fields are missing
 *
 * Returns { profile, warnings }
 */
const REQUIRED_PROFILE_FIELDS = ["tone", "readability", "rhythm", "voice", "vocabulary"];

function loadProfileWithFallback(profilePath) {
  const warnings = [];

  if (!fs.existsSync(profilePath)) {
    warnings.push(`File not found: ${profilePath}. Using default profile.`);
    const raw = fs.readFileSync(DEFAULT_PROFILE_PATH, "utf8");
    return { profile: JSON.parse(raw), warnings };
  }

  let raw;
  try {
    raw = fs.readFileSync(profilePath, "utf8");
  } catch (err) {
    warnings.push(`Could not read ${profilePath}: ${err.message}. Using default profile.`);
    const defRaw = fs.readFileSync(DEFAULT_PROFILE_PATH, "utf8");
    return { profile: JSON.parse(defRaw), warnings };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.push(`${profilePath} is not valid JSON. Using default profile.`);
    const defRaw = fs.readFileSync(DEFAULT_PROFILE_PATH, "utf8");
    return { profile: JSON.parse(defRaw), warnings };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    warnings.push(`${profilePath} is not a JSON object. Using default profile.`);
    const defRaw = fs.readFileSync(DEFAULT_PROFILE_PATH, "utf8");
    return { profile: JSON.parse(defRaw), warnings };
  }

  const missingFields = REQUIRED_PROFILE_FIELDS.filter((f) => !(f in parsed));
  if (missingFields.length > 0) {
    warnings.push(
      `Profile missing required fields: ${missingFields.join(", ")}. Falling back to default profile.`
    );
    const defRaw = fs.readFileSync(DEFAULT_PROFILE_PATH, "utf8");
    return { profile: JSON.parse(defRaw), warnings };
  }

  return { profile: parsed, warnings };
}

/**
 * Build a get_style_instructions string from a profile + optional platform/formula.
 * Mirrors the generate logic in style-profile.ts execute, using the real data files.
 */
function buildStyleInstructions(profile, { platform, formula } = {}) {
  const parts = [];

  // Tone
  const tone = profile.tone;
  if (tone && typeof tone === "object") {
    const toneLines = [];
    const describe = (val) => (val <= 0.3 ? "low" : val <= 0.6 ? "moderate" : "high");

    if (typeof tone.formality === "number") {
      const level = describe(tone.formality);
      const descriptor =
        level === "low" ? "conversational and informal" :
        level === "high" ? "formal and professional" :
        "business-casual";
      toneLines.push(`Tone is ${descriptor} (formality ${level}).`);
    }
    if (typeof tone.enthusiasm === "number") {
      const level = describe(tone.enthusiasm);
      if (level !== "moderate") {
        toneLines.push(
          `Enthusiasm is ${level} — ${level === "high" ? "bring energy and conviction" : "stay measured and factual"}.`
        );
      }
    }
    if (typeof tone.humor === "number" && tone.humor > 0.3) {
      toneLines.push(`Humor is ${describe(tone.humor)} — light wit is welcome, not forced.`);
    }
    if (typeof tone.irreverence === "number" && tone.irreverence > 0.3) {
      toneLines.push(`Irreverence is ${describe(tone.irreverence)} — challenge conventions where appropriate.`);
    }
    if (toneLines.length > 0) parts.push("TONE\n" + toneLines.join(" "));
  }

  // Vocabulary
  const vocab = profile.vocabulary;
  if (vocab) {
    const vocabLines = [];
    if (vocab.blocklist_strict?.length > 0)
      vocabLines.push(`Never use: ${vocab.blocklist_strict.slice(0, 12).join(", ")}.`);
    if (vocab.blocklist_soft?.length > 0)
      vocabLines.push(`Avoid unless necessary: ${vocab.blocklist_soft.slice(0, 8).join(", ")}.`);
    if (vocab.preferred_alternatives && Object.keys(vocab.preferred_alternatives).length > 0) {
      const pairs = Object.entries(vocab.preferred_alternatives)
        .slice(0, 6)
        .map(([k, v]) => `${k} → ${v}`)
        .join(", ");
      vocabLines.push(`Prefer simpler alternatives: ${pairs}.`);
    }
    if (vocabLines.length > 0) parts.push("VOCABULARY\n" + vocabLines.join(" "));
  }

  // Rhythm
  const rhythm = profile.rhythm;
  const readability = profile.readability;
  const rhythmLines = [];
  if (rhythm?.burstiness_target != null)
    rhythmLines.push(`Vary sentence length deliberately. Target burstiness coefficient ~${rhythm.burstiness_target} (mix short punchy sentences with longer ones — never three consecutive sentences of similar length).`);
  if (rhythm?.min_sentence_words != null && rhythm?.max_sentence_words != null)
    rhythmLines.push(`Sentence length range: ${rhythm.min_sentence_words}–${rhythm.max_sentence_words} words. Sentence length standard deviation should exceed 5 words.`);
  if (readability?.target_grade != null)
    rhythmLines.push(`Target Flesch-Kincaid grade ${readability.target_grade}${readability.max_grade != null ? `, max ${readability.max_grade}` : ""}.`);
  rhythmLines.push("Vary paragraph length. Avoid uniform blocks of identical-length paragraphs.");
  if (rhythmLines.length > 0) parts.push("RHYTHM\n" + rhythmLines.join(" "));

  // Structure
  const structure = profile.structure;
  const voice = profile.voice;
  const structureLines = [];
  if (structure?.max_em_dashes_per_1000 != null)
    structureLines.push(`Em dash cap: < ${structure.max_em_dashes_per_1000} per 1000 words.`);
  if (voice?.active_ratio != null)
    structureLines.push(`Active voice in at least ${Math.round(voice.active_ratio * 100)}% of sentences.`);
  if (structure?.no_compulsive_summary)
    structureLines.push('Do not end with "In conclusion", "In summary", or equivalent compulsive summary phrases.');
  structureLines.push('No AI tells: avoid "Let\'s dive in", "It\'s worth noting", "In today\'s landscape", "As we navigate".');
  if (structure?.rule_of_three_cap != null)
    structureLines.push(`Triplet lists (X, Y, and Z) should be no more than ${Math.round(structure.rule_of_three_cap * 100)}% of all lists.`);
  if (structureLines.length > 0) parts.push("STRUCTURE\n" + structureLines.join(" "));

  // Platform
  if (platform) {
    const platformsPath = path.join(DATA_DIR, "platforms.json");
    let platformConfig = null;
    if (fs.existsSync(platformsPath)) {
      try {
        const allPlatforms = JSON.parse(fs.readFileSync(platformsPath, "utf8"));
        platformConfig = allPlatforms[platform.toLowerCase()] ?? null;
      } catch {
        // Fall through to built-in
      }
    }

    const platformLines = [];
    if (platformConfig) {
      const label = platformConfig.label ?? platform;
      platformLines.push(`Platform: ${label}.`);
      if (platformConfig.char_limit) platformLines.push(`Character limit: ${platformConfig.char_limit} per unit.`);
      if (Array.isArray(platformConfig.rules)) platformLines.push(...platformConfig.rules.slice(0, 5));
      else if (typeof platformConfig.structure === "string") platformLines.push(platformConfig.structure);
      if (typeof platformConfig.tone === "string") platformLines.push(`Platform tone: ${platformConfig.tone}.`);
    } else {
      const builtIn = {
        twitter: [
          "Max 280 characters per post. Use thread format for longer content.",
          "Hook in the first post: bold claim, question, or striking stat.",
          "Punchy, opinionated, conversational. Sentence fragments normal.",
          "Zero to two hashtags maximum.",
        ],
        linkedin: [
          "Hook-first: two-line opener visible before 'see more'.",
          "One to two sentences per paragraph. Line breaks between paragraphs.",
          "Business casual tone. End with a CTA or engagement question.",
          "3000 character limit for posts.",
        ],
        blog: [
          "H2/H3 headings every 200–300 words for scannability.",
          "800–2000 words. Conversational authority. Link sources inline.",
          "Opening hook within first 100 words.",
        ],
        whitepaper: [
          "Formal, evidence-driven. Executive summary required.",
          "Numbered sections. Citations in APA unless specified otherwise.",
          "3000–10000 words.",
        ],
        email: [
          "Front-load the ask within the first two sentences.",
          "Subject line: 6–10 words, specific.",
          "Use bullets if three or more points. Match formality to relationship.",
        ],
      };
      const fallback = builtIn[platform.toLowerCase()];
      if (fallback) {
        platformLines.push(`Platform: ${platform}.`, ...fallback);
      } else {
        platformLines.push(`Platform: ${platform} (no specific rules available).`);
      }
    }
    if (platformLines.length > 0) parts.push("PLATFORM\n" + platformLines.join(" "));
  }

  // Formula
  if (formula) {
    const formulasPath = path.join(DATA_DIR, "formulas.json");
    let formulaConfig = null;
    if (fs.existsSync(formulasPath)) {
      try {
        const allFormulas = JSON.parse(fs.readFileSync(formulasPath, "utf8"));
        formulaConfig = allFormulas.find(
          (f) => f !== null && f.name.toLowerCase() === formula.toLowerCase()
        ) ?? null;
      } catch {
        // Fall through to built-in
      }
    }

    const formulaLines = [];
    if (formulaConfig) {
      formulaLines.push(`Structure (${formulaConfig.label}):`);
      for (const step of formulaConfig.steps) {
        const constraint = step.constraints ? ` [${step.constraints}]` : "";
        formulaLines.push(`${step.name}: ${step.purpose}${constraint}.`);
      }
    } else {
      const builtIn = {
        aida: ["Attention: hook that stops the reader.", "Interest: expand with relevant info, build curiosity.", "Desire: connect to reader's needs, paint the outcome.", "Action: clear CTA with low friction."],
        pas: ["Problem: name the pain point directly.", "Agitate: amplify consequences of inaction.", "Solution: present the fix with proof."],
        bab: ["Before: current painful state.", "After: desired future state.", "Bridge: how to get there."],
        fab: ["Features: what it does (technical).", "Advantages: why that matters (comparative).", "Benefits: what the reader gains."],
        "4ps": ["Promise: bold claim or outcome.", "Picture: vivid scenario of success.", "Proof: evidence, testimonials, data.", "Push: urgency plus CTA."],
      };
      const fallback = builtIn[formula.toLowerCase()];
      if (fallback) {
        formulaLines.push(`Structure (${formula.toUpperCase()}):`, ...fallback);
      } else {
        formulaLines.push(`Formula: ${formula} (no specific structure available).`);
      }
    }
    if (formulaLines.length > 0) parts.push("FORMULA\n" + formulaLines.join(" "));
  }

  // Few-shot samples
  const samples = profile.few_shot_samples;
  if (Array.isArray(samples) && samples.length > 0) {
    parts.push(
      "FEW-SHOT REFERENCE\n" +
        "Use the following excerpts as style references. Match their voice, rhythm, and sentence structure closely:\n" +
        samples.map((s, i) => `[Sample ${i + 1}]\n${s}`).join("\n\n")
    );
  }

  return parts.join("\n\n");
}

/**
 * Apply mechanical fixes to text given a violations array.
 * Mirrors fix_violations execute logic from style-lint.ts.
 */
function applyFixes(text, violations, blocklist, emDashCap = 3) {
  const changes = [];

  // --- AI tell patterns ---
  const AI_TELLS = [
    { pattern: /\bIn\s+conclusion,\s*/gi, replacement: "" },
    { pattern: /\bIn\s+summary,\s*/gi, replacement: "" },
    { pattern: /\bIt['']s\s+worth\s+noting\s+that\s*/gi, replacement: "" },
    { pattern: /\bLet['']s\s+dive\s+in\.?\s*/gi, replacement: "" },
    { pattern: /\bIn\s+today['']s\s+\w+,\s*/gi, replacement: "" },
  ];

  const hasAiViolations = violations.some((v) => v.type === "ai_pattern");
  if (hasAiViolations) {
    for (const { pattern, replacement } of AI_TELLS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const original = match[0];
        let rep = replacement;
        if (rep === "" && match.index > 0) {
          const before = text.slice(0, match.index);
          const isSentenceStart = /(?:^|[.!?]\s*)$/.test(before.trimEnd());
          if (isSentenceStart) {
            const afterIdx = match.index + original.length;
            if (afterIdx < text.length) {
              text =
                text.slice(0, match.index) +
                text.slice(afterIdx, afterIdx + 1).toUpperCase() +
                text.slice(afterIdx + 1);
            }
          }
        }
        changes.push({ type: "ai_pattern", original, replacement: rep, position: match.index });
        text = text.slice(0, match.index) + rep + text.slice(match.index + original.length);
        pattern.lastIndex = 0;
      }
    }
  }

  // --- excess_word replacements ---
  function matchCase(original, replacement) {
    if (original === original.toUpperCase()) return replacement.toUpperCase();
    if (original[0] === original[0].toUpperCase()) {
      return replacement[0].toUpperCase() + replacement.slice(1);
    }
    return replacement;
  }

  function replaceWordBoundary(text, word, replacement) {
    const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    const match = pattern.exec(text);
    if (!match) return { result: text, changed: false, position: -1 };
    const original = match[0];
    const fixed = matchCase(original, replacement);
    const result = text.slice(0, match.index) + fixed + text.slice(match.index + original.length);
    return { result, changed: true, position: match.index };
  }

  for (const v of violations) {
    if (v.type !== "excess_word") continue;

    let word = null;
    const locMatch = v.location?.match(/^word:\s*"([^"]+)"/);
    if (locMatch) {
      word = locMatch[1];
    } else if (v.detail) {
      const detailMatch = v.detail.match(/Found '([^']+)'/);
      if (detailMatch) word = detailMatch[1];
    }
    if (!word) continue;

    let replaceCount = 1;
    const countMatch = v.location?.match(/\((\d+)x\)/);
    if (countMatch) replaceCount = parseInt(countMatch[1], 10);

    let replacement = null;
    if (blocklist?.alternatives) replacement = blocklist.alternatives[word.toLowerCase()] ?? null;
    if (!replacement && v.suggestion) {
      const suggMatch = v.suggestion.match(/Replace with '([^']+)'/);
      if (suggMatch) replacement = suggMatch[1];
    }
    if (!replacement) continue;

    for (let i = 0; i < replaceCount; i++) {
      const { result, changed, position } = replaceWordBoundary(text, word, replacement);
      if (!changed) break;
      changes.push({ type: "excess_word", original: word, replacement, position });
      text = result;
    }
  }

  // --- em dash reduction ---
  const emViolations = violations.filter((v) => v.type === "em_dash");
  if (emViolations.length > 0) {
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const currentEmDashCount = (text.match(/—|--/g) ?? []).length;
    const allowedCount = Math.floor((wordCount / 1000) * emDashCap);
    const excessCount = Math.max(0, currentEmDashCount - allowedCount);

    if (excessCount > 0) {
      const emDashPositions = [];
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "—") {
          emDashPositions.push(i);
        } else if (
          text[i] === "-" && text[i + 1] === "-" &&
          (i === 0 || text[i - 1] !== "-") &&
          (i + 2 >= text.length || text[i + 2] !== "-")
        ) {
          emDashPositions.push(i);
        }
      }

      const toReplace = emDashPositions.slice(-excessCount);
      toReplace.sort((a, b) => b - a);

      for (const pos of toReplace) {
        const dashLen = text[pos] === "—" ? 1 : 2;
        const afterActual = text.slice(pos + dashLen).trimStart();
        const firstCharAfter = afterActual[0] ?? "";
        const sub = /[A-Z]/.test(firstCharAfter) ? ". " : ", ";

        const startPos = text[pos - 1] === " " ? pos - 1 : pos;
        const endPos = text[pos + dashLen] === " " ? pos + dashLen + 1 : pos + dashLen;
        const originalSpanned = text.slice(startPos, endPos);
        const replacementSpanned = sub.trim() === "." ? ". " : ", ";

        changes.push({ type: "em_dash", original: originalSpanned, replacement: replacementSpanned, position: startPos });
        text = text.slice(0, startPos) + replacementSpanned + text.slice(endPos);
      }
    }
  }

  return { modified_text: text, changes };
}

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

let TMP_DIR;

before(() => {
  TMP_DIR = fs.mkdtempSync(path.join(REPO_ROOT, "tests/style/.tmp-"));
});

after(() => {
  if (TMP_DIR && fs.existsSync(TMP_DIR)) {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

// ============================================================================
// style-profile: load_style_profile
// ============================================================================

describe("load_style_profile", () => {
  it("loads a valid profile JSON and returns all required fields", () => {
    const profilePath = path.join(TMP_DIR, "brand.json");
    const profile = JSON.parse(fs.readFileSync(DEFAULT_PROFILE_PATH, "utf8"));
    // Customise slightly so we can verify it's not the default
    profile.name = "brand-voice-test";
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), "utf8");

    const { profile: loaded, warnings } = loadProfileWithFallback(profilePath);

    assert.equal(warnings.length, 0, "no warnings expected for valid profile");
    assert.equal(loaded.name, "brand-voice-test");
    for (const field of REQUIRED_PROFILE_FIELDS) {
      assert.ok(field in loaded, `loaded profile should have field: ${field}`);
    }
  });

  it("falls back to default profile when file does not exist", () => {
    const { profile, warnings } = loadProfileWithFallback(
      path.join(TMP_DIR, "nonexistent-profile.json")
    );

    assert.ok(warnings.length > 0, "should emit a warning");
    assert.ok(warnings[0].includes("not found") || warnings[0].includes("Using default"), "warning should mention fallback");
    for (const field of REQUIRED_PROFILE_FIELDS) {
      assert.ok(field in profile, `default profile should have field: ${field}`);
    }
  });

  it("falls back to default profile when file contains malformed JSON", () => {
    const badPath = path.join(TMP_DIR, "malformed.json");
    fs.writeFileSync(badPath, "{ this is not json }", "utf8");

    const { profile, warnings } = loadProfileWithFallback(badPath);

    assert.ok(warnings.length > 0, "should emit a warning");
    assert.ok(warnings[0].includes("not valid JSON") || warnings[0].includes("Using default"), "warning should mention JSON parse failure");
    for (const field of REQUIRED_PROFILE_FIELDS) {
      assert.ok(field in profile, `default profile should have field: ${field}`);
    }
  });

  it("falls back when required fields are missing", () => {
    const partialPath = path.join(TMP_DIR, "partial.json");
    // Only has tone, missing the rest
    fs.writeFileSync(partialPath, JSON.stringify({ tone: { formality: 0.5 } }), "utf8");

    const { profile, warnings } = loadProfileWithFallback(partialPath);

    assert.ok(warnings.length > 0, "should emit a warning");
    assert.ok(warnings[0].includes("missing required fields"), "warning should name missing fields");
    for (const field of REQUIRED_PROFILE_FIELDS) {
      assert.ok(field in profile, `fallback profile should have all required fields`);
    }
  });
});

// ============================================================================
// style-profile: analyze_writing_samples
// ============================================================================

describe("analyze_writing_samples", () => {
  it("computes all required profile fields from three .md fixture files", () => {
    const samplesDir = path.join(TMP_DIR, "samples");
    fs.mkdirSync(samplesDir);

    // Write three distinct prose samples with enough content for metrics
    fs.writeFileSync(
      path.join(samplesDir, "sample1.md"),
      `The train pulled in at six minutes past midnight, twenty minutes late.
The platform was empty except for a porter wrestling a trolley with a stuck wheel.
Rain had been falling since afternoon.
Nobody complained about the delay. There was nobody to complain to.

${AI_TEXT}
`,
      "utf8"
    );

    fs.writeFileSync(
      path.join(samplesDir, "sample2.md"),
      `${HUMAN_TEXT}

She had been working the counter at the diner for eleven years when the new owner arrived.
He introduced himself as Gerald. No last name, just Gerald.
He wore a tie every day, even in August.
The staff took this as a bad sign.
They were right.
`,
      "utf8"
    );

    fs.writeFileSync(
      path.join(samplesDir, "sample3.md"),
      `Every tool has a theory of the world built into its design.
A hammer assumes things need hitting. A calendar assumes time is divisible into uniform units.
The trouble starts when the tool's theory and reality diverge.
Most people never notice this.
They just hit harder.
`,
      "utf8"
    );

    // Run analysis on the samples — mirrors the core of analyze_writing_samples execute
    const entries = fs.readdirSync(samplesDir);
    const mdFiles = entries.filter((e) => e.endsWith(".md"));
    assert.equal(mdFiles.length, 3, "should find 3 .md files");

    const fileMetrics = [];
    for (const filename of mdFiles) {
      const filePath = path.join(samplesDir, filename);
      const text = fs.readFileSync(filePath, "utf8");
      if (!text.trim()) continue;

      const burst = computeBurstiness(text);
      const ttr = computeTypeTokenRatio(text);
      const voice = computeActiveVoiceRatio(text);
      const readability = computeReadabilityGrade(text);
      const sentSD = computeSentenceLengthSD(text);
      const wordCount = text.split(/\s+/).filter(Boolean).length;

      fileMetrics.push({
        file: filename,
        burstiness: burst.coefficient >= 0 ? burst.coefficient : 0,
        ttr,
        activeVoiceRatio: voice.ratio,
        readabilityGrade: readability.grade,
        sentenceLengthSD: sentSD,
        wordCount,
      });
    }

    assert.equal(fileMetrics.length, 3, "should have metrics for all 3 files");

    for (const fm of fileMetrics) {
      assert.ok(fm.burstiness >= 0 && fm.burstiness <= 1, `burstiness in [0,1] for ${fm.file}: ${fm.burstiness}`);
      assert.ok(fm.ttr > 0 && fm.ttr <= 1, `TTR in (0,1] for ${fm.file}: ${fm.ttr}`);
      assert.ok(fm.activeVoiceRatio >= 0 && fm.activeVoiceRatio <= 1, `active ratio in [0,1] for ${fm.file}: ${fm.activeVoiceRatio}`);
      assert.ok(fm.readabilityGrade >= 0 && fm.readabilityGrade <= 20, `grade in [0,20] for ${fm.file}: ${fm.readabilityGrade}`);
    }
  });

  it("computes sane aggregate metric ranges for human-style prose", () => {
    const text = HUMAN_TEXT;
    const burst = computeBurstiness(text);
    const ttr = computeTypeTokenRatio(text);
    const voice = computeActiveVoiceRatio(text);
    const grade = computeReadabilityGrade(text);

    // Human text has high TTR (varied vocabulary)
    assert.ok(ttr > 0.5, `human text TTR should be > 0.5, got ${ttr}`);

    // Active voice should dominate in narrative prose
    assert.ok(voice.ratio > 0.5, `active voice ratio > 0.5, got ${voice.ratio}`);

    // Grade should be in a reasonable range for readable prose
    assert.ok(grade.grade >= 3 && grade.grade <= 15, `readability grade in [3,15], got ${grade.grade}`);

    // Burstiness: coefficient is non-negative (text has enough sentences)
    if (burst.coefficient >= 0) {
      assert.ok(burst.coefficient >= 0 && burst.coefficient <= 1.5, `burstiness in sane range, got ${burst.coefficient}`);
    }
  });
});

// ============================================================================
// style-profile: get_style_instructions
// ============================================================================

describe("get_style_instructions", () => {
  let defaultProfile;

  before(() => {
    defaultProfile = JSON.parse(fs.readFileSync(DEFAULT_PROFILE_PATH, "utf8"));
  });

  it("returns an instruction block under 2000 characters for the default profile", () => {
    const instructions = buildStyleInstructions(defaultProfile);

    assert.ok(instructions.length > 0, "instructions should be non-empty");
    assert.ok(
      instructions.length < 2000,
      `instructions should be under 2000 chars, got ${instructions.length}`
    );
  });

  it("includes tone, rhythm, vocabulary, and structure sections", () => {
    const instructions = buildStyleInstructions(defaultProfile);

    assert.ok(instructions.includes("TONE"), "should include TONE section");
    assert.ok(instructions.includes("RHYTHM"), "should include RHYTHM section");
    assert.ok(instructions.includes("VOCABULARY"), "should include VOCABULARY section");
    assert.ok(instructions.includes("STRUCTURE"), "should include STRUCTURE section");
  });

  it("mentions char limit or thread format for platform=twitter", () => {
    const instructions = buildStyleInstructions(defaultProfile, { platform: "twitter" });

    assert.ok(instructions.includes("PLATFORM"), "should include PLATFORM section");
    const lower = instructions.toLowerCase();
    assert.ok(
      lower.includes("280") || lower.includes("thread") || lower.includes("char"),
      `twitter platform instructions should mention char limit or thread format: ${instructions}`
    );
  });

  it("mentions attention/interest/desire/action for formula=aida", () => {
    const instructions = buildStyleInstructions(defaultProfile, { formula: "aida" });

    assert.ok(instructions.includes("FORMULA"), "should include FORMULA section");
    const lower = instructions.toLowerCase();
    assert.ok(lower.includes("attention"), "aida should mention attention");
    assert.ok(lower.includes("interest"), "aida should mention interest");
    assert.ok(lower.includes("desire") || lower.includes("des"), "aida should mention desire");
    assert.ok(lower.includes("action"), "aida should mention action");
  });

  it("includes few-shot samples in output when profile has them", () => {
    const profileWithSamples = {
      ...defaultProfile,
      few_shot_samples: ["The old house sat crooked on its foundation.", "Paint peeled from the clapboards."],
    };
    const instructions = buildStyleInstructions(profileWithSamples);

    assert.ok(instructions.includes("FEW-SHOT REFERENCE"), "should include FEW-SHOT REFERENCE section");
    assert.ok(instructions.includes("[Sample 1]"), "should label first sample");
    assert.ok(instructions.includes("[Sample 2]"), "should label second sample");
  });
});

// ============================================================================
// style-lint: validate_style
// ============================================================================

describe("validate_style — validate_style logic via runFullAnalysis", () => {
  let defaultProfile;
  let blocklist;

  before(() => {
    defaultProfile = JSON.parse(fs.readFileSync(DEFAULT_PROFILE_PATH, "utf8"));
    try {
      blocklist = loadBlocklist(EXCESS_WORDS_PATH);
    } catch {
      // Fall back to profile vocabulary
      blocklist = undefined;
    }
  });

  it("clean human text passes style validation", () => {
    const analysis = runFullAnalysis(HUMAN_TEXT, defaultProfile, blocklist);

    assert.ok(typeof analysis.pass === "boolean", "pass should be boolean");
    // Human text is not guaranteed to pass every metric, but it should have
    // no excess_word or ai_pattern violations (no blocklist words, no AI tells)
    const excessViolations = analysis.violations.filter((v) => v.metric === "excess_word_score");
    const aiViolations = analysis.violations.filter((v) => v.metric === "ai_pattern");

    assert.equal(excessViolations.length, 0, "clean human text should have no excess_word violations");
    assert.equal(aiViolations.length, 0, "clean human text should have no ai_pattern violations");
  });

  it("AI-heavy text fails with excess_word and ai_pattern violations", () => {
    const analysis = runFullAnalysis(AI_TEXT, defaultProfile, blocklist);

    assert.equal(analysis.pass, false, "AI text should not pass");

    const types = new Set(analysis.violations.map((v) => v.metric));

    // AI text contains 'delve', 'multifaceted', 'leverage', 'harness', etc. — must trigger excess_word_score
    assert.ok(types.has("excess_word_score"), `violations should include excess_word_score, got: ${[...types].join(", ")}`);

    // AI text contains 'In today's', 'In conclusion', etc. — must trigger ai_pattern
    assert.ok(types.has("ai_pattern"), `violations should include ai_pattern, got: ${[...types].join(", ")}`);
  });

  it("AI violation details include recognisable AI tell phrases", () => {
    const analysis = runFullAnalysis(AI_TEXT, defaultProfile, blocklist);

    const aiViolations = analysis.violations.filter((v) => v.metric === "ai_pattern");
    assert.ok(aiViolations.length > 0, "should have at least one ai_pattern violation");

    // Each actual value should be the matched phrase text
    for (const v of aiViolations) {
      assert.ok(typeof v.actual === "string" && v.actual.length > 0, `ai_pattern violation.actual should be non-empty string, got: ${v.actual}`);
    }
  });

  it("excess_word hits include words from the AI_TEXT blocklist", () => {
    const analysis = runFullAnalysis(AI_TEXT, defaultProfile, blocklist);
    const bl = blocklist ?? {
      strict: defaultProfile.vocabulary?.blocklist_strict ?? [],
      soft: defaultProfile.vocabulary?.blocklist_soft ?? [],
      alternatives: defaultProfile.vocabulary?.preferred_alternatives ?? {},
    };
    const strictWords = new Set(bl.strict.map((w) => w.toLowerCase()));
    const softWords = new Set(bl.soft.map((w) => w.toLowerCase()));

    const excessViolation = analysis.violations.find((v) => v.metric === "excess_word_score");
    assert.ok(excessViolation, "should have excess_word_score violation");

    // Verify the raw metrics contain hits from the blocklist
    const mRaw = analysis.metrics;
    const excessRaw = mRaw.excessWords;
    assert.ok(excessRaw.hits.length > 0, "should have at least one excess word hit");

    for (const hit of excessRaw.hits) {
      const inStrict = strictWords.has(hit.word.toLowerCase());
      const inSoft = softWords.has(hit.word.toLowerCase());
      assert.ok(inStrict || inSoft, `hit word '${hit.word}' should be in strict or soft blocklist`);
    }
  });
});

// ============================================================================
// style-lint: fix_violations
// ============================================================================

describe("fix_violations", () => {
  let defaultProfile;
  let blocklist;

  before(() => {
    defaultProfile = JSON.parse(fs.readFileSync(DEFAULT_PROFILE_PATH, "utf8"));
    try {
      blocklist = loadBlocklist(EXCESS_WORDS_PATH);
    } catch {
      blocklist = undefined;
    }
  });

  /**
   * Build violations array from analysis — same shape that validate_style returns.
   * Expanded per-hit for excess_word (mirrors style-lint.ts execute logic).
   */
  function buildViolationsArray(analysis, bl) {
    const violations = [];
    const mRaw = analysis.metrics;
    const excessRaw = mRaw.excessWords;

    for (const v of analysis.violations) {
      if (v.metric === "excess_word_score") {
        const hits = excessRaw?.hits ?? [];
        for (const hit of hits) {
          const alternative = bl?.alternatives?.[hit.word];
          violations.push({
            type: "excess_word",
            location: `word: "${hit.word}" (${hit.count}x)`,
            detail: `Found '${hit.word}' (${hit.tier})`,
            suggestion: alternative ? `Replace with '${alternative}'` : `Remove or rephrase`,
          });
        }
        continue;
      }
      if (v.metric === "em_dash_density") {
        violations.push({ type: "em_dash", detail: `${v.actual} per 1000 words, cap is ${v.target}`, suggestion: "Replace some em dashes with commas or periods" });
        continue;
      }
      if (v.metric === "ai_pattern") {
        violations.push({ type: "ai_pattern", detail: `Found AI tell: '${v.actual}'`, suggestion: "Remove the phrase entirely" });
        continue;
      }
      violations.push({ type: v.metric, detail: `actual: ${v.actual}, target: ${v.target}`, suggestion: "Adjust to meet the target" });
    }

    return violations;
  }

  it("replaces 'delve' with an alternative from the blocklist", () => {
    const bl = blocklist ?? {
      strict: defaultProfile.vocabulary?.blocklist_strict ?? [],
      soft: defaultProfile.vocabulary?.blocklist_soft ?? [],
      alternatives: defaultProfile.vocabulary?.preferred_alternatives ?? {},
    };

    // Text that contains 'delve' — a blocklist_strict word
    const text = "We need to delve into the data before making a decision.";
    const analysis = runFullAnalysis(text, defaultProfile, blocklist);
    const violations = buildViolationsArray(analysis, bl);

    const excessViolation = violations.find((v) => v.type === "excess_word" && v.location?.includes("delve"));
    assert.ok(excessViolation, "should have an excess_word violation for 'delve'");

    const { modified_text, changes } = applyFixes(text, violations, bl, defaultProfile.structure?.max_em_dashes_per_1000 ?? 3);

    assert.ok(!modified_text.toLowerCase().includes("delve"), "modified text should not contain 'delve'");
    const delveChange = changes.find((c) => c.type === "excess_word" && c.original.toLowerCase() === "delve");
    assert.ok(delveChange, "changes should record the 'delve' replacement");
    assert.ok(delveChange.replacement.length > 0, "replacement should be non-empty");
  });

  it("removes 'In conclusion' pattern from AI text", () => {
    const text = "In conclusion, it's worth noting that everything will change.";
    const analysis = runFullAnalysis(text, defaultProfile, blocklist);
    const bl = blocklist ?? {
      strict: defaultProfile.vocabulary?.blocklist_strict ?? [],
      soft: defaultProfile.vocabulary?.blocklist_soft ?? [],
      alternatives: defaultProfile.vocabulary?.preferred_alternatives ?? {},
    };
    const violations = buildViolationsArray(analysis, bl);

    const aiViolations = violations.filter((v) => v.type === "ai_pattern");
    assert.ok(aiViolations.length > 0, "should detect ai_pattern violations");

    const { modified_text, changes } = applyFixes(text, violations, bl);

    // "In conclusion, " should be stripped
    assert.ok(
      !modified_text.toLowerCase().startsWith("in conclusion"),
      `modified text should not start with 'In conclusion': ${modified_text}`
    );
    const aiChange = changes.find((c) => c.type === "ai_pattern");
    assert.ok(aiChange, "changes should record the ai_pattern fix");
  });

  it("modified text has fewer violations than the original AI text", () => {
    const bl = blocklist ?? {
      strict: defaultProfile.vocabulary?.blocklist_strict ?? [],
      soft: defaultProfile.vocabulary?.blocklist_soft ?? [],
      alternatives: defaultProfile.vocabulary?.preferred_alternatives ?? {},
    };

    const originalAnalysis = runFullAnalysis(AI_TEXT, defaultProfile, blocklist);
    const violations = buildViolationsArray(originalAnalysis, bl);

    const { modified_text } = applyFixes(AI_TEXT, violations, bl, defaultProfile.structure?.max_em_dashes_per_1000 ?? 3);

    const fixedAnalysis = runFullAnalysis(modified_text, defaultProfile, blocklist);

    // Count mechanical violation types (excess_word, ai_pattern, em_dash)
    const mechanicalTypes = new Set(["excess_word_score", "ai_pattern", "em_dash_density"]);
    const originalMechanical = originalAnalysis.violations.filter((v) => mechanicalTypes.has(v.metric)).length;
    const fixedMechanical = fixedAnalysis.violations.filter((v) => mechanicalTypes.has(v.metric)).length;

    assert.ok(
      fixedMechanical < originalMechanical,
      `fixed text should have fewer mechanical violations than original (${fixedMechanical} < ${originalMechanical})`
    );
  });
});

// ============================================================================
// Integration flow: load → instructions → validate → fix → re-validate
// ============================================================================

describe("integration flow", () => {
  it("end-to-end: default profile → instructions → validate AI text → fix → fewer violations", () => {
    // Step 1: Load default profile
    const { profile, warnings } = loadProfileWithFallback(DEFAULT_PROFILE_PATH);
    assert.equal(warnings.length, 0, "loading the default profile directly should produce no warnings");
    for (const field of REQUIRED_PROFILE_FIELDS) {
      assert.ok(field in profile, `profile has required field: ${field}`);
    }

    // Step 2: Get style instructions
    const instructions = buildStyleInstructions(profile);
    assert.ok(instructions.length > 0, "instructions are non-empty");
    assert.ok(instructions.length < 2000, "instructions are under 2000 chars");

    // Step 3: Validate AI text
    let blocklist;
    try {
      blocklist = loadBlocklist(EXCESS_WORDS_PATH);
    } catch {
      blocklist = undefined;
    }
    const bl = blocklist ?? {
      strict: profile.vocabulary?.blocklist_strict ?? [],
      soft: profile.vocabulary?.blocklist_soft ?? [],
      alternatives: profile.vocabulary?.preferred_alternatives ?? {},
    };

    const originalAnalysis = runFullAnalysis(AI_TEXT, profile, blocklist);
    assert.equal(originalAnalysis.pass, false, "AI text should fail validation");

    // Step 4: Build violations and fix
    function buildViolationsArray(analysis) {
      const violations = [];
      const excessRaw = analysis.metrics.excessWords;
      for (const v of analysis.violations) {
        if (v.metric === "excess_word_score") {
          for (const hit of (excessRaw?.hits ?? [])) {
            const alternative = bl?.alternatives?.[hit.word];
            violations.push({ type: "excess_word", location: `word: "${hit.word}" (${hit.count}x)`, detail: `Found '${hit.word}' (${hit.tier})`, suggestion: alternative ? `Replace with '${alternative}'` : "Remove or rephrase" });
          }
          continue;
        }
        if (v.metric === "em_dash_density") {
          violations.push({ type: "em_dash", detail: `${v.actual} per 1000 words`, suggestion: "Replace some em dashes" });
          continue;
        }
        if (v.metric === "ai_pattern") {
          violations.push({ type: "ai_pattern", detail: `Found AI tell: '${v.actual}'`, suggestion: "Remove the phrase entirely" });
          continue;
        }
        violations.push({ type: v.metric, detail: `actual: ${v.actual}`, suggestion: "Adjust" });
      }
      return violations;
    }

    const violations = buildViolationsArray(originalAnalysis);
    const { modified_text } = applyFixes(AI_TEXT, violations, bl, profile.structure?.max_em_dashes_per_1000 ?? 3);

    // Step 5: Re-validate
    const fixedAnalysis = runFullAnalysis(modified_text, profile, blocklist);

    const mechanicalTypes = new Set(["excess_word_score", "ai_pattern", "em_dash_density"]);
    const beforeCount = originalAnalysis.violations.filter((v) => mechanicalTypes.has(v.metric)).length;
    const afterCount = fixedAnalysis.violations.filter((v) => mechanicalTypes.has(v.metric)).length;

    assert.ok(
      afterCount < beforeCount,
      `after fixing, mechanical violations should be fewer (${afterCount} < ${beforeCount})`
    );
  });
});
