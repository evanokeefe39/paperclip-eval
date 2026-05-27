import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Blocklist {
  strict: string[];
  soft: string[];
  alternatives: Record<string, string>;
}

export interface BurstinessResult {
  coefficient: number;
  sentenceLengths: number[];
  mean: number;
  sd: number;
}

export interface ExcessWordHit {
  word: string;
  count: number;
  tier: "strict" | "soft";
}

export interface ExcessWordResult {
  score: number;
  hits: ExcessWordHit[];
}

export interface EmDashResult {
  density: number;
  count: number;
  perThousand: number;
}

export interface ActiveVoiceResult {
  ratio: number;
  passiveCount: number;
  totalCount: number;
}

export interface ReadabilityResult {
  grade: number;
  ease: number;
}

export interface RuleOfThreeResult {
  ratio: number;
  tripletLists: number;
  totalLists: number;
}

export interface StyleViolation {
  metric: string;
  actual: number | string;
  target: number | string;
  severity: "error" | "warning";
}

export interface FullAnalysis {
  pass: boolean;
  metrics: Record<string, unknown>;
  violations: StyleViolation[];
}

export interface StyleProfile {
  tone?: Record<string, number>;
  readability?: { target_grade?: number; max_grade?: number };
  rhythm?: {
    burstiness_target?: number;
    min_sentence_words?: number;
    max_sentence_words?: number;
  };
  voice?: { active_ratio?: number };
  vocabulary?: {
    blocklist_strict?: string[];
    blocklist_soft?: string[];
    preferred_alternatives?: Record<string, string>;
  };
  structure?: {
    max_em_dashes_per_1000?: number;
    max_semicolons_per_1000?: number;
    rule_of_three_cap?: number;
    no_compulsive_summary?: boolean;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "ave", "blvd",
  "dept", "est", "inc", "corp", "ltd", "co", "vs", "etc", "approx",
  "govt", "org", "assn", "bros", "no", "vol", "rev", "gen", "sgt",
  "cpl", "pvt", "cmdr", "lt", "col", "capt", "maj", "adm",
]);

function isAbbreviation(word: string): boolean {
  return ABBREVIATIONS.has(word.replace(/\.$/, "").toLowerCase());
}

function isDecimalNumber(before: string, after: string): boolean {
  return /\d$/.test(before) && /^\d/.test(after);
}

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function stripPunctuation(word: string): string {
  return word.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
}

function countSyllables(word: string): number {
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

  // Silent e at end
  if (w.endsWith("e") && count > 1) count--;
  // -le at end after consonant
  if (w.endsWith("le") && w.length > 2 && !vowels.has(w[w.length - 3])) count++;

  return Math.max(count, 1);
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

// Detect if a word is inside quotes by checking surrounding text context
function isInsideQuotes(text: string, wordStart: number): boolean {
  let doubleQuoteCount = 0;
  let singleQuoteCount = 0;
  for (let i = 0; i < wordStart; i++) {
    if (text[i] === '"' || text[i] === '“' || text[i] === '”') doubleQuoteCount++;
    if (text[i] === "'" || text[i] === '‘' || text[i] === '’') singleQuoteCount++;
  }
  return (doubleQuoteCount % 2 === 1) || (singleQuoteCount % 2 === 1);
}

function isProperNoun(text: string, wordStart: number): boolean {
  if (wordStart === 0) return false;
  const charBefore = text.slice(Math.max(0, wordStart - 3), wordStart);
  // Mid-sentence = preceded by space (not sentence start)
  if (/[.!?]\s*$/.test(charBefore)) return false;
  const word = text.slice(wordStart).match(/^[A-Za-z]+/);
  if (!word) return false;
  return word[0][0] === word[0][0].toUpperCase() && word[0][0] !== word[0][0].toLowerCase();
}

// ---------------------------------------------------------------------------
// Irregular past participles for passive voice detection
// ---------------------------------------------------------------------------

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

function isPastParticiple(word: string): boolean {
  const lower = word.toLowerCase();
  if (IRREGULAR_PARTICIPLES.has(lower)) return true;
  if (lower.endsWith("ed")) return true;
  if (lower.endsWith("en") && lower.length > 3) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = "";

  for (let i = 0; i < text.length; i++) {
    current += text[i];

    if (text[i] === "." || text[i] === "!" || text[i] === "?") {
      const nextChar = text[i + 1] || "";
      const isEnd = /\s/.test(nextChar) || i === text.length - 1;

      if (!isEnd) continue;

      // Check for abbreviation
      const wordBefore = current.trimEnd().split(/\s+/).pop() || "";
      if (text[i] === "." && isAbbreviation(wordBefore)) continue;

      // Check for decimal number
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

export function computeBurstiness(text: string): BurstinessResult {
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

export function computeExcessWordScore(text: string, blocklist: Blocklist): ExcessWordResult {
  const words = tokenize(text);
  const totalWords = words.length;
  if (totalWords === 0) return { score: 0, hits: [] };

  const hitMap = new Map<string, { count: number; tier: "strict" | "soft" }>();
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

  const hits: ExcessWordHit[] = [];
  let totalHits = 0;
  for (const [word, data] of hitMap) {
    hits.push({ word, count: data.count, tier: data.tier });
    totalHits += data.count;
  }

  return {
    score: totalHits / totalWords,
    hits,
  };
}

export function computeEmDashDensity(text: string): EmDashResult {
  const words = tokenize(text);
  const totalWords = words.length;

  let count = 0;
  // Count em dashes (—)
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "—") count++;
  }
  // Count double hyphens (--)
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === "-" && text[i + 1] === "-" && (i === 0 || text[i - 1] !== "-") && (i + 2 >= text.length || text[i + 2] !== "-")) {
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

export function computeSentenceLengthSD(text: string): number {
  const sentences = splitSentences(text);
  if (sentences.length < 2) return 0;
  const lengths = sentences.map((s) => tokenize(s).length);
  return stdev(lengths);
}

export function computeActiveVoiceRatio(text: string): ActiveVoiceResult {
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
      // Also check with adverb in between: "was quickly taken"
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

export function computeReadabilityGrade(text: string): ReadabilityResult {
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

  // Flesch-Kincaid Grade Level
  const grade = 0.39 * avgWordsPerSentence + 11.8 * avgSyllablesPerWord - 15.59;

  // Flesch Reading Ease
  const ease = 206.835 - 1.015 * avgWordsPerSentence - 84.6 * avgSyllablesPerWord;

  return {
    grade: Math.round(grade * 100) / 100,
    ease: Math.round(ease * 100) / 100,
  };
}

export function computeTypeTokenRatio(text: string): number {
  const words = tokenize(text).map((w) => stripPunctuation(w).toLowerCase()).filter(Boolean);
  if (words.length === 0) return 0;
  const unique = new Set(words);
  return unique.size / words.length;
}

export function computeRuleOfThreeRatio(text: string): RuleOfThreeResult {
  let totalLists = 0;
  let tripletLists = 0;

  // Detect markdown lists (consecutive lines starting with - or *)
  const lines = text.split("\n");
  let listLength = 0;
  for (let i = 0; i <= lines.length; i++) {
    const line = lines[i]?.trim() || "";
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

  // Detect comma-separated inline lists: "X, Y, and Z" or "X, Y, Z"
  const commaListPattern = /\b(\w+(?:\s+\w+)?),\s+(\w+(?:\s+\w+)?),?\s+(?:and|or)\s+(\w+(?:\s+\w+)?)\b/gi;
  let match;
  while ((match = commaListPattern.exec(text)) !== null) {
    totalLists++;
    tripletLists++;
  }

  // Comma lists with more items: "A, B, C, D"
  const longCommaPattern = /(?:\b\w+(?:\s+\w+)?,\s*){3,}\w+(?:\s+\w+)?/g;
  while ((match = longCommaPattern.exec(text)) !== null) {
    const items = match[0].split(",").filter((s) => s.trim());
    if (items.length > 3) {
      totalLists++;
      // Not a triplet — more than 3
    }
  }

  return {
    ratio: totalLists > 0 ? tripletLists / totalLists : 0,
    tripletLists,
    totalLists,
  };
}

// AI tell patterns
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

export function detectAITellPatterns(text: string): Array<{ pattern: string; index: number }> {
  const found: Array<{ pattern: string; index: number }> = [];
  for (const pat of AI_TELL_PATTERNS) {
    const match = pat.exec(text);
    if (match) {
      found.push({ pattern: match[0], index: match.index });
    }
  }
  return found;
}

export function loadBlocklist(path: string): Blocklist {
  const raw = fs.readFileSync(path, "utf8");
  return JSON.parse(raw) as Blocklist;
}

export function runFullAnalysis(text: string, profile: StyleProfile, blocklist?: Blocklist): FullAnalysis {
  const bl: Blocklist = blocklist ?? {
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

  const violations: StyleViolation[] = [];

  // Excess word score
  const excessTarget = 0.005;
  if (excessWords.score > excessTarget) {
    violations.push({
      metric: "excess_word_score",
      actual: Math.round(excessWords.score * 10000) / 10000,
      target: excessTarget,
      severity: "error",
    });
  }

  // Burstiness
  const bTarget = profile.rhythm?.burstiness_target ?? 0.55;
  if (burstiness.coefficient >= 0 && Math.abs(burstiness.coefficient - bTarget) > 0.15) {
    violations.push({
      metric: "burstiness",
      actual: Math.round(burstiness.coefficient * 100) / 100,
      target: `${bTarget} ± 0.15`,
      severity: "warning",
    });
  }

  // Em dash density
  const emDashCap = profile.structure?.max_em_dashes_per_1000 ?? 3;
  if (emDash.perThousand > emDashCap) {
    violations.push({
      metric: "em_dash_density",
      actual: Math.round(emDash.perThousand * 100) / 100,
      target: `< ${emDashCap} per 1000`,
      severity: "error",
    });
  }

  // Sentence length SD floor
  if (sentenceSD > 0 && sentenceSD < 5) {
    violations.push({
      metric: "sentence_length_sd",
      actual: Math.round(sentenceSD * 100) / 100,
      target: "> 5",
      severity: "warning",
    });
  }

  // Active voice ratio
  const activeTarget = profile.voice?.active_ratio ?? 0.85;
  if (activeVoice.ratio < activeTarget) {
    violations.push({
      metric: "active_voice_ratio",
      actual: Math.round(activeVoice.ratio * 100) / 100,
      target: `>= ${activeTarget}`,
      severity: "warning",
    });
  }

  // Readability grade
  const maxGrade = profile.readability?.max_grade ?? 14;
  if (readability.grade > maxGrade) {
    violations.push({
      metric: "readability_grade",
      actual: readability.grade,
      target: `<= ${maxGrade}`,
      severity: "warning",
    });
  }

  // Rule of Three cap
  const r3Cap = profile.structure?.rule_of_three_cap ?? 0.3;
  if (ruleOfThree.totalLists > 0 && ruleOfThree.ratio > r3Cap) {
    violations.push({
      metric: "rule_of_three",
      actual: Math.round(ruleOfThree.ratio * 100) / 100,
      target: `< ${r3Cap}`,
      severity: "warning",
    });
  }

  // AI tell patterns
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
