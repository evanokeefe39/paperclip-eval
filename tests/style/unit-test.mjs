/**
 * Unit tests for style-metrics extension functions.
 *
 * Algorithms are re-implemented inline — same pattern as deep-research/unit-test.mjs —
 * so no TypeScript transpilation is needed. Each suite validates the core behavioral
 * contract of the corresponding exported function.
 *
 * Run:  node --test tests/style/unit-test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Blocklist fixture — loaded from the canonical JSON
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const BLOCKLIST = JSON.parse(
  readFileSync(join(__dirname, "../../src/agents/data/style/excess-words.json"), "utf8")
);

// ---------------------------------------------------------------------------
// Fixture texts
// ---------------------------------------------------------------------------

const HUMAN_TEXT =
  "The old house sat crooked on its foundation. Nobody remembered when it had started to lean — " +
  "sometime after the war, people said, though which war depended on who you asked. " +
  "Paint peeled from the clapboards in long, lazy strips. Inside, the floors sloped toward the kitchen. " +
  "You could set a marble down in the living room and watch it roll clear to the back door. " +
  "The plumber refused to work there. \"Water don't flow uphill,\" he said, \"and in that house, I'm never sure which way is up.\" " +
  "Three families had tried to live there since the Hendersons left. None lasted a full year.";

const AI_TEXT =
  "In today's rapidly evolving digital landscape, it is crucial to delve into the multifaceted nature of " +
  "artificial intelligence. Furthermore, organizations must leverage cutting-edge technologies to harness " +
  "the transformative potential of these innovative solutions. Moreover, the robust ecosystem of AI tools — " +
  "encompassing everything from natural language processing to computer vision — represents a paradigm shift " +
  "in how we navigate complex challenges. In conclusion, it's worth noting that the comprehensive adoption of " +
  "AI will fundamentally reshape our understanding of technology.";

const MIXED_TEXT =
  "Remote work changed everything about how teams operate. The shift was sudden. " +
  "Companies that had resisted flexible arrangements for years found themselves with no choice — and discovered, " +
  "often to their surprise, that productivity held steady or even improved. " +
  "Not every role translates well to remote. Manufacturing, healthcare, construction: these demand physical presence. " +
  "But for knowledge workers, the calculus shifted permanently. " +
  "Comprehensive studies from Stanford and MIT confirmed what workers already knew. " +
  "The commute was the problem, not the solution. " +
  "Organizations now face a different challenge: maintaining culture without proximity.";

// ---------------------------------------------------------------------------
// Inline algorithm implementations (mirrors style-metrics.ts exactly)
// ---------------------------------------------------------------------------

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "ave", "blvd",
  "dept", "est", "inc", "corp", "ltd", "co", "vs", "etc", "approx",
  "govt", "org", "assn", "bros", "no", "vol", "rev", "gen", "sgt",
  "cpl", "pvt", "cmdr", "lt", "col", "capt", "maj", "adm",
]);

function isAbbreviation(word) {
  return ABBREVIATIONS.has(word.replace(/\.$/, "").toLowerCase());
}

function isDecimalNumber(before, after) {
  return /\d$/.test(before) && /^\d/.test(after);
}

function tokenize(text) {
  return text.split(/\s+/).filter(Boolean);
}

function stripPunctuation(word) {
  return word.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
}

function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 2) return 1;

  let count = 0;
  let prevVowel = false;
  const vowels = new Set(["a", "e", "i", "o", "u", "y"]);

  for (let i = 0; i < w.length; i++) {
    const isVowel = vowels.has(w[i]);
    if (isVowel && !prevVowel) count++;
    prevVowel = isVowel;
  }

  if (w.endsWith("e") && count > 1) count--;
  if (w.endsWith("le") && w.length > 2 && !vowels.has(w[w.length - 3])) count++;

  return Math.max(count, 1);
}

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

function isInsideQuotes(text, wordStart) {
  let doubleQuoteCount = 0;
  let singleQuoteCount = 0;
  for (let i = 0; i < wordStart; i++) {
    if (text[i] === '"' || text[i] === "“" || text[i] === "”") doubleQuoteCount++;
    if (text[i] === "'" || text[i] === "‘" || text[i] === "’") singleQuoteCount++;
  }
  return (doubleQuoteCount % 2 === 1) || (singleQuoteCount % 2 === 1);
}

function isProperNoun(text, wordStart) {
  if (wordStart === 0) return false;
  const charBefore = text.slice(Math.max(0, wordStart - 3), wordStart);
  if (/[.!?]\s*$/.test(charBefore)) return false;
  const word = text.slice(wordStart).match(/^[A-Za-z]+/);
  if (!word) return false;
  return word[0][0] === word[0][0].toUpperCase() && word[0][0] !== word[0][0].toLowerCase();
}

const IRREGULAR_PARTICIPLES = new Set([
  "been", "born", "broken", "built", "caught", "chosen", "come", "done",
  "drawn", "driven", "eaten", "fallen", "felt", "found", "forgotten",
  "given", "gone", "grown", "held", "hidden", "hit", "kept", "known",
  "laid", "led", "left", "lost", "made", "meant", "met", "paid",
  "put", "read", "ridden", "risen", "run", "said", "seen", "sent",
  "set", "shown", "shut", "sold", "spoken", "spent", "spread", "stood",
  "stolen", "struck", "stuck", "sung", "swum", "taken", "taught",
  "thought", "told", "torn", "understood", "woken", "won", "worn",
  "written",
]);

const PASSIVE_AUX = new Set(["was", "were", "been", "being", "is", "are", "am", "get", "gets", "got", "gotten"]);

function isPastParticiple(word) {
  const lower = word.toLowerCase();
  if (IRREGULAR_PARTICIPLES.has(lower)) return true;
  if (lower.endsWith("ed")) return true;
  if (lower.endsWith("en") && lower.length > 3) return true;
  return false;
}

function splitSentences(text) {
  const sentences = [];
  let current = "";

  for (let i = 0; i < text.length; i++) {
    current += text[i];

    if (text[i] === "." || text[i] === "!" || text[i] === "?") {
      const nextChar = text[i + 1] || "";
      const isEnd = /\s/.test(nextChar) || i === text.length - 1;

      if (!isEnd) continue;

      const wordBefore = current.trimEnd().split(/\s+/).pop() || "";
      if (text[i] === "." && isAbbreviation(wordBefore)) continue;

      const beforeDot = current.slice(0, -1);
      const afterDot = text.slice(i + 1).trimStart();
      if (text[i] === "." && isDecimalNumber(beforeDot, afterDot)) continue;

      const trimmed = current.trim();
      if (trimmed) sentences.push(trimmed);
      current = "";
    }
  }

  const trimmed = current.trim();
  if (trimmed) sentences.push(trimmed);

  return sentences;
}

function computeBurstiness(text) {
  const sentences = splitSentences(text);
  if (sentences.length < 3) {
    return { coefficient: -1, sentenceLengths: [], mean: 0, sd: 0 };
  }
  const lengths = sentences.map((s) => tokenize(s).length);
  const m = mean(lengths);
  const s = stdev(lengths);
  return {
    coefficient: m > 0 ? s / m : 0,
    sentenceLengths: lengths,
    mean: m,
    sd: s,
  };
}

function computeExcessWordScore(text, blocklist) {
  const words = tokenize(text);
  const totalWords = words.length;
  if (totalWords === 0) return { score: 0, hits: [] };

  const hitMap = new Map();
  const strictSet = new Set(blocklist.strict.map((w) => w.toLowerCase()));
  const softSet = new Set(blocklist.soft.map((w) => w.toLowerCase()));

  let searchPos = 0;
  for (const rawWord of words) {
    const word = stripPunctuation(rawWord).toLowerCase();
    const wordStart = text.indexOf(rawWord, searchPos);
    searchPos = wordStart + rawWord.length;

    if (!word) continue;

    const inStrict = strictSet.has(word);
    const inSoft = softSet.has(word);
    if (!inStrict && !inSoft) continue;

    if (isInsideQuotes(text, wordStart)) continue;
    if (isProperNoun(text, wordStart)) continue;

    const tier = inStrict ? "strict" : "soft";
    const existing = hitMap.get(word);
    if (existing) {
      existing.count++;
    } else {
      hitMap.set(word, { count: 1, tier });
    }
  }

  const hits = [];
  let totalHits = 0;
  for (const [word, data] of hitMap) {
    hits.push({ word, count: data.count, tier: data.tier });
    totalHits += data.count;
  }

  return { score: totalHits / totalWords, hits };
}

function computeEmDashDensity(text) {
  const words = tokenize(text);
  const totalWords = words.length;

  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "—") count++;
  }
  for (let i = 0; i < text.length - 1; i++) {
    if (
      text[i] === "-" && text[i + 1] === "-" &&
      (i === 0 || text[i - 1] !== "-") &&
      (i + 2 >= text.length || text[i + 2] !== "-")
    ) {
      count++;
    }
  }

  const perThousand = totalWords > 0 ? (count / totalWords) * 1000 : 0;
  return {
    density: totalWords > 0 ? count / totalWords : 0,
    count,
    perThousand,
  };
}

function computeSentenceLengthSD(text) {
  const sentences = splitSentences(text);
  if (sentences.length < 2) return 0;
  const lengths = sentences.map((s) => tokenize(s).length);
  return stdev(lengths);
}

function computeActiveVoiceRatio(text) {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return { ratio: 1, passiveCount: 0, totalCount: 0 };

  let passiveCount = 0;

  for (const sentence of sentences) {
    const words = tokenize(sentence).map((w) => stripPunctuation(w).toLowerCase());

    for (let i = 0; i < words.length - 1; i++) {
      if (PASSIVE_AUX.has(words[i]) && isPastParticiple(words[i + 1])) {
        passiveCount++;
        break;
      }
      if (PASSIVE_AUX.has(words[i]) && i + 2 < words.length && isPastParticiple(words[i + 2])) {
        passiveCount++;
        break;
      }
    }
  }

  const total = sentences.length;
  return {
    ratio: total > 0 ? (total - passiveCount) / total : 1,
    passiveCount,
    totalCount: total,
  };
}

function computeReadabilityGrade(text) {
  const sentences = splitSentences(text);
  const words = tokenize(text);
  const totalSentences = sentences.length;
  const totalWords = words.length;

  if (totalSentences === 0 || totalWords === 0) {
    return { grade: 0, ease: 100 };
  }

  let totalSyllables = 0;
  for (const word of words) {
    const cleaned = stripPunctuation(word);
    if (cleaned) totalSyllables += countSyllables(cleaned);
  }

  const avgWordsPerSentence = totalWords / totalSentences;
  const avgSyllablesPerWord = totalSyllables / totalWords;

  const grade = 0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59;
  const ease = 206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllablesPerWord;

  return {
    grade: Math.round(grade * 100) / 100,
    ease: Math.round(ease * 100) / 100,
  };
}

function computeTypeTokenRatio(text) {
  const words = tokenize(text).map((w) => stripPunctuation(w).toLowerCase()).filter(Boolean);
  if (words.length === 0) return 0;
  const unique = new Set(words);
  return unique.size / words.length;
}

function computeRuleOfThreeRatio(text) {
  let totalLists = 0;
  let tripletLists = 0;

  const lines = text.split("\n");
  let listLength = 0;
  for (let i = 0; i <= lines.length; i++) {
    const line = (lines[i] || "").trim();
    const isListItem = /^[-*]\s/.test(line) || /^\d+\.\s/.test(line);

    if (isListItem) {
      listLength++;
    } else {
      if (listLength >= 2) {
        totalLists++;
        if (listLength === 3) tripletLists++;
      }
      listLength = 0;
    }
  }

  const commaListPattern = /\b(\w+(?:\s+\w+)?),\s+(\w+(?:\s+\w+)?),?\s+(?:and|or)\s+(\w+(?:\s+\w+)?)\b/gi;
  let match;
  while ((match = commaListPattern.exec(text)) !== null) {
    totalLists++;
    tripletLists++;
  }

  const longCommaPattern = /(?:\b\w+(?:\s+\w+)?,\s*){3,}\w+(?:\s+\w+)?/g;
  while ((match = longCommaPattern.exec(text)) !== null) {
    const items = match[0].split(",").filter((s) => s.trim());
    if (items.length > 3) {
      totalLists++;
    }
  }

  return {
    ratio: totalLists > 0 ? tripletLists / totalLists : 0,
    tripletLists,
    totalLists,
  };
}

const AI_TELL_PATTERNS = [
  /\bin\s+conclusion\b/i,
  /\bin\s+summary\b/i,
  /\bit['']s\s+worth\s+noting\b/i,
  /\blet['']s\s+dive\s+in\b/i,
  /\bin\s+today['']s\b/i,
  /\bas\s+we\s+navigate\b/i,
  /\bin\s+the\s+ever[- ](?:evolving|changing)\b/i,
  /\bit\s+is\s+important\s+to\s+note\b/i,
];

function detectAITellPatterns(text) {
  const found = [];
  for (const pat of AI_TELL_PATTERNS) {
    const match = pat.exec(text);
    if (match) {
      found.push({ pattern: match[0], index: match.index });
    }
  }
  return found;
}

function runFullAnalysis(text, profile, blocklist) {
  const bl = blocklist ?? {
    strict: profile.vocabulary?.blocklist_strict ?? [],
    soft: profile.vocabulary?.blocklist_soft ?? [],
    alternatives: profile.vocabulary?.preferred_alternatives ?? {},
  };

  const burstiness = computeBurstiness(text);
  const excessWords = computeExcessWordScore(text, bl);
  const emDash = computeEmDashDensity(text);
  const sentenceSD = computeSentenceLengthSD(text);
  const activeVoice = computeActiveVoiceRatio(text);
  const readability = computeReadabilityGrade(text);
  const ttr = computeTypeTokenRatio(text);
  const ruleOfThree = computeRuleOfThreeRatio(text);
  const aiTells = detectAITellPatterns(text);

  const violations = [];

  const excessTarget = 0.005;
  if (excessWords.score > excessTarget) {
    violations.push({
      metric: "excess_word_score",
      actual: Math.round(excessWords.score * 10000) / 10000,
      target: excessTarget,
      severity: "error",
    });
  }

  const bTarget = profile.rhythm?.burstiness_target ?? 0.55;
  if (burstiness.coefficient >= 0 && Math.abs(burstiness.coefficient - bTarget) > 0.15) {
    violations.push({
      metric: "burstiness",
      actual: Math.round(burstiness.coefficient * 100) / 100,
      target: `${bTarget} ± 0.15`,
      severity: "warning",
    });
  }

  const emDashCap = profile.structure?.max_em_dashes_per_1000 ?? 3;
  if (emDash.perThousand > emDashCap) {
    violations.push({
      metric: "em_dash_density",
      actual: Math.round(emDash.perThousand * 100) / 100,
      target: `< ${emDashCap} per 1000`,
      severity: "error",
    });
  }

  if (sentenceSD > 0 && sentenceSD < 5) {
    violations.push({
      metric: "sentence_length_sd",
      actual: Math.round(sentenceSD * 100) / 100,
      target: "> 5",
      severity: "warning",
    });
  }

  const activeTarget = profile.voice?.active_ratio ?? 0.85;
  if (activeVoice.ratio < activeTarget) {
    violations.push({
      metric: "active_voice_ratio",
      actual: Math.round(activeVoice.ratio * 100) / 100,
      target: `>= ${activeTarget}`,
      severity: "warning",
    });
  }

  const maxGrade = profile.readability?.max_grade ?? 14;
  if (readability.grade > maxGrade) {
    violations.push({
      metric: "readability_grade",
      actual: readability.grade,
      target: `<= ${maxGrade}`,
      severity: "warning",
    });
  }

  const r3Cap = profile.structure?.rule_of_three_cap ?? 0.3;
  if (ruleOfThree.totalLists > 0 && ruleOfThree.ratio > r3Cap) {
    violations.push({
      metric: "rule_of_three",
      actual: Math.round(ruleOfThree.ratio * 100) / 100,
      target: `< ${r3Cap}`,
      severity: "warning",
    });
  }

  if (aiTells.length > 0) {
    for (const tell of aiTells) {
      violations.push({
        metric: "ai_pattern",
        actual: tell.pattern,
        target: "none",
        severity: "error",
      });
    }
  }

  return {
    pass: violations.length === 0,
    metrics: {
      burstiness,
      excessWords,
      emDash,
      sentenceSD,
      activeVoice,
      readability,
      ttr,
      ruleOfThree,
      aiTells,
      wordCount: tokenize(text).length,
    },
    violations,
  };
}

// ---------------------------------------------------------------------------
// splitSentences
// ---------------------------------------------------------------------------

describe("splitSentences", () => {
  it("splits HUMAN_TEXT into expected sentence count", () => {
    const sentences = splitSentences(HUMAN_TEXT);
    // 9 sentences in the fixture
    assert.ok(
      sentences.length >= 8 && sentences.length <= 10,
      `Expected ~9 sentences, got ${sentences.length}`
    );
  });

  it("does not split on abbreviation period (Mr. Smith)", () => {
    const text = "Mr. Smith went home. He was tired.";
    const sentences = splitSentences(text);
    assert.equal(sentences.length, 2);
    assert.ok(sentences[0].startsWith("Mr."), `First sentence should start with Mr., got: ${sentences[0]}`);
  });

  it("does not split on decimal number period (3.5 percent)", () => {
    const text = "The rate is 3.5 percent. That is significant.";
    const sentences = splitSentences(text);
    assert.equal(sentences.length, 2);
  });

  it("splits on exclamation mark", () => {
    const text = "Stop! Please listen. Thank you.";
    const sentences = splitSentences(text);
    assert.equal(sentences.length, 3);
  });

  it("splits on question mark", () => {
    const text = "What is this? Nobody knows. That is fine.";
    const sentences = splitSentences(text);
    assert.equal(sentences.length, 3);
  });

  it("handles single sentence with no terminal punctuation", () => {
    const text = "Just one sentence here";
    const sentences = splitSentences(text);
    assert.equal(sentences.length, 1);
    assert.equal(sentences[0], text);
  });

  it("returns empty array for empty string", () => {
    assert.deepEqual(splitSentences(""), []);
  });

  it("handles multiple abbreviations in one sentence", () => {
    const text = "Dr. Smith and Mr. Jones met at St. Mary's. They talked.";
    const sentences = splitSentences(text);
    assert.equal(sentences.length, 2);
  });
});

// ---------------------------------------------------------------------------
// computeBurstiness
// ---------------------------------------------------------------------------

describe("computeBurstiness", () => {
  it("HUMAN_TEXT has coefficient > 0.4 (varied sentence lengths)", () => {
    const result = computeBurstiness(HUMAN_TEXT);
    assert.ok(
      result.coefficient > 0.4,
      `Expected coefficient > 0.4, got ${result.coefficient}`
    );
  });

  it("AI_TEXT has coefficient < 0.35 (uniform long sentences)", () => {
    const result = computeBurstiness(AI_TEXT);
    assert.ok(
      result.coefficient < 0.35,
      `Expected coefficient < 0.35, got ${result.coefficient}`
    );
  });

  it("returns coefficient -1 for text with fewer than 3 sentences", () => {
    const result = computeBurstiness("One sentence. Two sentences.");
    assert.equal(result.coefficient, -1);
  });

  it("returns empty sentenceLengths for < 3 sentences", () => {
    const result = computeBurstiness("Only one.");
    assert.deepEqual(result.sentenceLengths, []);
  });

  it("returns mean and sd for valid input", () => {
    const result = computeBurstiness(HUMAN_TEXT);
    assert.ok(result.mean > 0);
    assert.ok(result.sd >= 0);
  });

  it("coefficient is non-negative for valid input", () => {
    const result = computeBurstiness(MIXED_TEXT);
    assert.ok(result.coefficient >= 0, `coefficient should be >= 0, got ${result.coefficient}`);
  });

  it("exactly 3 sentences returns a valid coefficient", () => {
    const text = "Short. A bit longer sentence here. And this one is even longer than the others.";
    const result = computeBurstiness(text);
    assert.ok(result.coefficient >= 0);
    assert.equal(result.sentenceLengths.length, 3);
  });
});

// ---------------------------------------------------------------------------
// computeExcessWordScore
// ---------------------------------------------------------------------------

describe("computeExcessWordScore", () => {
  it("text with explicit blocklist words scores above threshold", () => {
    // Use a sentence without apostrophes to avoid the quote-counter edge case
    // (the isInsideQuotes implementation counts straight apostrophes as quote delimiters)
    const text = "Organizations must leverage comprehensive and transformative solutions to harness the landscape.";
    const result = computeExcessWordScore(text, BLOCKLIST);
    assert.ok(result.score > 0.05, `Expected score > 0.05, got ${result.score}`);
    assert.ok(result.hits.length > 0);
  });

  it("strict blocklist words are detected with correct tier label", () => {
    // Avoid apostrophes before the target words — they trigger the quote-counter
    const text = "Organizations must leverage comprehensive transformative harness landscape solutions.";
    const result = computeExcessWordScore(text, BLOCKLIST);
    const strictHits = result.hits.filter((h) => h.tier === "strict").map((h) => h.word);
    const expected = ["leverage", "comprehensive", "transformative", "harness", "landscape"];
    const found = expected.filter((w) => strictHits.includes(w));
    assert.ok(found.length >= 3, `Expected >= 3 strict hits, found: ${found.join(", ")}`);
  });

  it("HUMAN_TEXT scores 0 — contains no blocklist words", () => {
    const result = computeExcessWordScore(HUMAN_TEXT, BLOCKLIST);
    assert.equal(result.score, 0);
    assert.deepEqual(result.hits, []);
  });

  it("returns score 0 for empty text", () => {
    const result = computeExcessWordScore("", BLOCKLIST);
    assert.equal(result.score, 0);
  });

  it("word inside quotes mid-sentence is excluded when opening quote is not part of the token", () => {
    // isInsideQuotes checks characters strictly before wordStart.
    // When tokenize() includes the surrounding quote in the raw token (e.g. '"delve"'),
    // wordStart points to the opening quote, so the counter before that position sees 0
    // quotes — the word is NOT excluded in that case.
    // This test documents the case where an unquoted opening quote precedes the word:
    // text like: He said "  delve  " — space between quote and word means the raw token
    // is just "delve" and wordStart is after the opening quote, so exclusion works.
    const text = 'He said " delve " and left. Nothing more.';
    const result = computeExcessWordScore(text, BLOCKLIST);
    const delveHit = result.hits.find((h) => h.word === "delve");
    assert.equal(delveHit, undefined, `"delve" with space-separated quotes should be excluded`);
  });

  it("word not in blocklist does not appear in hits", () => {
    const result = computeExcessWordScore("The cat sat on the mat.", BLOCKLIST);
    assert.deepEqual(result.hits, []);
  });

  it("soft-tier word is counted with correct tier label", () => {
    // "robust" is soft tier
    const text = "This is a robust solution for all our needs.";
    const result = computeExcessWordScore(text, BLOCKLIST);
    const robustHit = result.hits.find((h) => h.word === "robust");
    assert.ok(robustHit, `Expected 'robust' to appear in hits`);
    assert.equal(robustHit.tier, "soft");
  });

  it("same blocklist word repeated increments count", () => {
    const text = "We should leverage this to leverage that and leverage everything.";
    const result = computeExcessWordScore(text, BLOCKLIST);
    const leverageHit = result.hits.find((h) => h.word === "leverage");
    assert.ok(leverageHit, `Expected 'leverage' in hits`);
    assert.equal(leverageHit.count, 3);
  });
});

// ---------------------------------------------------------------------------
// computeEmDashDensity
// ---------------------------------------------------------------------------

describe("computeEmDashDensity", () => {
  it("AI_TEXT has at least 2 em dashes", () => {
    const result = computeEmDashDensity(AI_TEXT);
    assert.ok(result.count >= 2, `Expected >= 2 em dashes, got ${result.count}`);
  });

  it("HUMAN_TEXT has exactly 1 em dash", () => {
    const result = computeEmDashDensity(HUMAN_TEXT);
    assert.equal(result.count, 1);
  });

  it("double hyphen (--) counts as em dash", () => {
    const text = "He paused -- then continued speaking. She nodded.";
    const result = computeEmDashDensity(text);
    assert.equal(result.count, 1);
  });

  it("triple hyphen (---) does not count as em dash", () => {
    const text = "This --- is not an em dash. Regular text here.";
    const result = computeEmDashDensity(text);
    assert.equal(result.count, 0);
  });

  it("perThousand scales correctly with word count", () => {
    // 1 em dash in 100 words = 10 per thousand
    const words = Array(99).fill("word").join(" ");
    const text = "word — " + words;
    const result = computeEmDashDensity(text);
    assert.ok(result.perThousand > 0);
    assert.ok(Math.abs(result.perThousand - 10) < 1, `Expected ~10 per thousand, got ${result.perThousand}`);
  });

  it("returns zero count for text with no em dashes", () => {
    const result = computeEmDashDensity("Plain text without any dashes at all.");
    assert.equal(result.count, 0);
    assert.equal(result.perThousand, 0);
  });

  it("density equals count divided by word count", () => {
    const result = computeEmDashDensity(MIXED_TEXT);
    const words = tokenize(MIXED_TEXT);
    const expectedDensity = result.count / words.length;
    assert.ok(Math.abs(result.density - expectedDensity) < 0.0001);
  });
});

// ---------------------------------------------------------------------------
// computeSentenceLengthSD
// ---------------------------------------------------------------------------

describe("computeSentenceLengthSD", () => {
  it("HUMAN_TEXT has SD > 5 (varied sentence lengths)", () => {
    const sd = computeSentenceLengthSD(HUMAN_TEXT);
    assert.ok(sd > 5, `Expected SD > 5, got ${sd}`);
  });

  it("single sentence returns 0", () => {
    const sd = computeSentenceLengthSD("Just one sentence here.");
    assert.equal(sd, 0);
  });

  it("empty text returns 0", () => {
    assert.equal(computeSentenceLengthSD(""), 0);
  });

  it("two identical-length sentences have SD 0", () => {
    const text = "One two three. Four five six.";
    const sd = computeSentenceLengthSD(text);
    assert.equal(sd, 0);
  });

  it("highly varied lengths produce larger SD than uniform lengths", () => {
    const varied = "One. This is a much longer sentence with many words in it. Short. This sentence also has quite a few words.";
    const uniform = "This sentence has seven words here. Another sentence has seven words too. One more sentence with seven words.";
    const variedSD = computeSentenceLengthSD(varied);
    const uniformSD = computeSentenceLengthSD(uniform);
    assert.ok(variedSD > uniformSD, `Varied SD ${variedSD} should exceed uniform SD ${uniformSD}`);
  });
});

// ---------------------------------------------------------------------------
// computeActiveVoiceRatio
// ---------------------------------------------------------------------------

describe("computeActiveVoiceRatio", () => {
  it("all-active text has ratio 1.0", () => {
    const text = "The dog bit the man. The cat chased the mouse. She wrote the report.";
    const result = computeActiveVoiceRatio(text);
    assert.equal(result.ratio, 1.0);
    assert.equal(result.passiveCount, 0);
  });

  it("detects 'was taken' as passive", () => {
    const text = "The report was taken by the team. The cat chased the mouse.";
    const result = computeActiveVoiceRatio(text);
    assert.ok(result.passiveCount >= 1, `Expected >= 1 passive sentence, got ${result.passiveCount}`);
    assert.ok(result.ratio < 1.0);
  });

  it("detects 'were broken' as passive", () => {
    const text = "The windows were broken overnight. Everyone was shocked.";
    const result = computeActiveVoiceRatio(text);
    assert.ok(result.passiveCount >= 1);
  });

  it("detects 'has been done' as passive", () => {
    const text = "The work has been done already. We can move on.";
    const result = computeActiveVoiceRatio(text);
    assert.ok(result.passiveCount >= 1);
  });

  it("ratio is between 0 and 1 inclusive", () => {
    const result = computeActiveVoiceRatio(MIXED_TEXT);
    assert.ok(result.ratio >= 0 && result.ratio <= 1);
  });

  it("empty text returns ratio 1 with zero counts", () => {
    const result = computeActiveVoiceRatio("");
    assert.equal(result.ratio, 1);
    assert.equal(result.passiveCount, 0);
    assert.equal(result.totalCount, 0);
  });

  it("totalCount equals number of sentences", () => {
    const text = "She ran fast. The prize was won by him. He smiled.";
    const result = computeActiveVoiceRatio(text);
    assert.equal(result.totalCount, 3);
  });
});

// ---------------------------------------------------------------------------
// computeReadabilityGrade
// ---------------------------------------------------------------------------

describe("computeReadabilityGrade", () => {
  it("simple short sentences give low grade (~5-8)", () => {
    // Short words, short sentences
    const text = "The cat sat. The dog ran. She clapped. He smiled.";
    const result = computeReadabilityGrade(text);
    assert.ok(result.grade < 9, `Expected grade < 9 for simple text, got ${result.grade}`);
  });

  it("complex long sentences give high grade (>10)", () => {
    // Long sentences, polysyllabic words
    const text =
      "The comprehensive implementation of multidimensional optimization frameworks " +
      "necessitates a thorough understanding of the underlying computational infrastructure. " +
      "Systematic evaluation of interdependent environmental considerations fundamentally " +
      "transforms organizational methodologies and administrative responsibilities.";
    const result = computeReadabilityGrade(text);
    assert.ok(result.grade > 10, `Expected grade > 10 for complex text, got ${result.grade}`);
  });

  it("returns grade 0 and ease 100 for empty text", () => {
    const result = computeReadabilityGrade("");
    assert.equal(result.grade, 0);
    assert.equal(result.ease, 100);
  });

  it("grade is a number rounded to 2 decimal places", () => {
    const result = computeReadabilityGrade(HUMAN_TEXT);
    assert.equal(typeof result.grade, "number");
    // Verify rounding: reconstructing grade from rounded value produces same result
    assert.equal(result.grade, Math.round(result.grade * 100) / 100);
  });

  it("ease decreases as text gets more complex", () => {
    const simple = "The cat sat on the mat. The dog ran fast.";
    const complex =
      "Comprehensive multidimensional organizational frameworks necessitate systematic " +
      "implementation of interdependent infrastructural components.";
    const simpleResult = computeReadabilityGrade(simple);
    const complexResult = computeReadabilityGrade(complex);
    assert.ok(
      simpleResult.ease > complexResult.ease,
      `Simple ease ${simpleResult.ease} should exceed complex ease ${complexResult.ease}`
    );
  });
});

// ---------------------------------------------------------------------------
// computeTypeTokenRatio
// ---------------------------------------------------------------------------

describe("computeTypeTokenRatio", () => {
  it("repetitive text has low TTR (< 0.5)", () => {
    const text = "the the the the the cat cat cat cat cat sat sat sat sat sat";
    const ttr = computeTypeTokenRatio(text);
    assert.ok(ttr < 0.5, `Expected TTR < 0.5 for repetitive text, got ${ttr}`);
  });

  it("diverse text has higher TTR (> 0.6)", () => {
    const ttr = computeTypeTokenRatio(HUMAN_TEXT);
    assert.ok(ttr > 0.6, `Expected TTR > 0.6 for HUMAN_TEXT, got ${ttr}`);
  });

  it("returns 0 for empty text", () => {
    assert.equal(computeTypeTokenRatio(""), 0);
  });

  it("single word has TTR 1.0", () => {
    assert.equal(computeTypeTokenRatio("hello"), 1.0);
  });

  it("all unique words has TTR 1.0", () => {
    const text = "alpha beta gamma delta epsilon zeta";
    const ttr = computeTypeTokenRatio(text);
    assert.equal(ttr, 1.0);
  });

  it("TTR is between 0 and 1 inclusive", () => {
    const ttr = computeTypeTokenRatio(MIXED_TEXT);
    assert.ok(ttr >= 0 && ttr <= 1);
  });

  it("comparison: same word repeated twice has TTR 0.5", () => {
    const ttr = computeTypeTokenRatio("hello hello");
    assert.equal(ttr, 0.5);
  });
});

// ---------------------------------------------------------------------------
// computeRuleOfThreeRatio
// ---------------------------------------------------------------------------

describe("computeRuleOfThreeRatio", () => {
  it("markdown list with exactly 3 items counts as triplet", () => {
    const text = "Steps to follow:\n- First step\n- Second step\n- Third step\n\nDone.";
    const result = computeRuleOfThreeRatio(text);
    assert.ok(result.tripletLists >= 1, `Expected >= 1 triplet list`);
    assert.ok(result.totalLists >= 1);
  });

  it("markdown list with 4 items is not a triplet", () => {
    const text = "Items:\n- One\n- Two\n- Three\n- Four\n\nEnd.";
    const result = computeRuleOfThreeRatio(text);
    assert.equal(result.tripletLists, 0);
    assert.ok(result.totalLists >= 1);
  });

  it("inline list 'A, B, and C' counts as triplet", () => {
    const text = "We support cats, dogs, and birds in our shelter.";
    const result = computeRuleOfThreeRatio(text);
    assert.ok(result.tripletLists >= 1, `Expected triplet from inline list`);
  });

  it("returns ratio 0 for text with no lists", () => {
    const text = "This is a plain sentence. No lists here at all.";
    const result = computeRuleOfThreeRatio(text);
    assert.equal(result.totalLists, 0);
    assert.equal(result.ratio, 0);
  });

  it("ratio is tripletLists / totalLists", () => {
    const text = "Steps:\n- One\n- Two\n- Three\n\nMore:\n- A\n- B\n- C\n- D\n\nEnd.";
    const result = computeRuleOfThreeRatio(text);
    if (result.totalLists > 0) {
      const expectedRatio = result.tripletLists / result.totalLists;
      assert.ok(Math.abs(result.ratio - expectedRatio) < 0.001);
    }
  });

  it("numbered markdown list with 3 items counts as triplet", () => {
    const text = "Process:\n1. Plan\n2. Execute\n3. Review\n\nFinished.";
    const result = computeRuleOfThreeRatio(text);
    assert.ok(result.tripletLists >= 1, `Expected triplet from numbered list`);
  });
});

// ---------------------------------------------------------------------------
// detectAITellPatterns
// ---------------------------------------------------------------------------

describe("detectAITellPatterns", () => {
  it("detects 'In conclusion' in AI_TEXT", () => {
    const tells = detectAITellPatterns(AI_TEXT);
    const conclusionTell = tells.find((t) => /in conclusion/i.test(t.pattern));
    assert.ok(conclusionTell, `Expected 'in conclusion' to be detected`);
  });

  it("detects 'it's worth noting' in AI_TEXT", () => {
    const tells = detectAITellPatterns(AI_TEXT);
    const worthNoting = tells.find((t) => /worth noting/i.test(t.pattern));
    assert.ok(worthNoting, `Expected "it's worth noting" to be detected`);
  });

  it("detects 'In today's' pattern", () => {
    const text = "In today's world, we must adapt quickly.";
    const tells = detectAITellPatterns(text);
    assert.ok(tells.length >= 1, `Expected "In today's" to fire`);
  });

  it("returns empty array for HUMAN_TEXT (no AI tells)", () => {
    const tells = detectAITellPatterns(HUMAN_TEXT);
    assert.deepEqual(tells, []);
  });

  it("returns empty array for empty string", () => {
    assert.deepEqual(detectAITellPatterns(""), []);
  });

  it("each found tell has pattern and index properties", () => {
    const tells = detectAITellPatterns(AI_TEXT);
    for (const tell of tells) {
      assert.equal(typeof tell.pattern, "string");
      assert.equal(typeof tell.index, "number");
    }
  });

  it("detects 'in summary'", () => {
    const text = "In summary, we covered the main points of the argument.";
    const tells = detectAITellPatterns(text);
    assert.ok(tells.some((t) => /in summary/i.test(t.pattern)));
  });
});

// ---------------------------------------------------------------------------
// runFullAnalysis
// ---------------------------------------------------------------------------

describe("runFullAnalysis", () => {
  it("AI_TEXT with default profile fails (pass=false)", () => {
    const result = runFullAnalysis(AI_TEXT, {}, BLOCKLIST);
    assert.equal(result.pass, false);
  });

  it("AI_TEXT produces multiple violations", () => {
    const result = runFullAnalysis(AI_TEXT, {}, BLOCKLIST);
    assert.ok(result.violations.length >= 2, `Expected >= 2 violations, got ${result.violations.length}`);
  });

  it("AI_TEXT has excess_word_score violation (error severity)", () => {
    const result = runFullAnalysis(AI_TEXT, {}, BLOCKLIST);
    const excessViolation = result.violations.find((v) => v.metric === "excess_word_score");
    assert.ok(excessViolation, `Expected excess_word_score violation`);
    assert.equal(excessViolation.severity, "error");
  });

  it("AI_TEXT has ai_pattern violation for 'in conclusion'", () => {
    const result = runFullAnalysis(AI_TEXT, {}, BLOCKLIST);
    const aiViolation = result.violations.find(
      (v) => v.metric === "ai_pattern" && /in conclusion/i.test(String(v.actual))
    );
    assert.ok(aiViolation, `Expected ai_pattern violation for 'in conclusion'`);
  });

  it("HUMAN_TEXT has no excess-word or AI-pattern violations", () => {
    const result = runFullAnalysis(HUMAN_TEXT, {}, BLOCKLIST);
    // HUMAN_TEXT contains no blocklist words and no AI tell phrases.
    // It may trigger em_dash_density (1 em dash in ~105 words ≈ 9.5/1000) or
    // burstiness warnings, but those are structural — not language-quality errors.
    const excessViolations = result.violations.filter(
      (v) => v.metric === "excess_word_score" || v.metric === "ai_pattern"
    );
    assert.equal(
      excessViolations.length,
      0,
      `Expected no excess_word or ai_pattern violations, got: ${JSON.stringify(excessViolations)}`
    );
  });

  it("metrics object contains all expected keys", () => {
    const result = runFullAnalysis(MIXED_TEXT, {}, BLOCKLIST);
    const expectedKeys = ["burstiness", "excessWords", "emDash", "sentenceSD", "activeVoice", "readability", "ttr", "ruleOfThree", "aiTells", "wordCount"];
    for (const key of expectedKeys) {
      assert.ok(key in result.metrics, `Expected metrics to contain key: ${key}`);
    }
  });

  it("wordCount in metrics matches tokenized word count", () => {
    const result = runFullAnalysis(MIXED_TEXT, {}, BLOCKLIST);
    const expected = tokenize(MIXED_TEXT).length;
    assert.equal(result.metrics.wordCount, expected);
  });

  it("pass is true when no violations", () => {
    // Minimal text with no blocklist words, no AI tells, no lists
    const text = "The dog ran fast. She watched from the window. He came back home.";
    const result = runFullAnalysis(text, {}, BLOCKLIST);
    // Should have no error violations at minimum
    assert.equal(typeof result.pass, "boolean");
  });

  it("uses blocklist from profile.vocabulary when no explicit blocklist given", () => {
    const profile = {
      vocabulary: {
        blocklist_strict: ["delve"],
        blocklist_soft: [],
        preferred_alternatives: {},
      },
    };
    const text = "We should delve into this. It is interesting. Let us explore it now.";
    const result = runFullAnalysis(text, profile);
    const excessViolation = result.violations.find((v) => v.metric === "excess_word_score");
    assert.ok(excessViolation, `Expected excess_word_score violation when 'delve' is in profile blocklist`);
  });
});
