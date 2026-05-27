import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  computeBurstiness,
  computeTypeTokenRatio,
  computeActiveVoiceRatio,
  computeReadabilityGrade,
  computeSentenceLengthSD,
  computeEmDashDensity,
} from "./style-metrics.ts";
import type { StyleProfile } from "./style-metrics.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DATA_DIR = "/app/data/style";
const DEFAULT_PROFILE_PATH = path.join(DATA_DIR, "default-profile.json");
const PLATFORMS_PATH = path.join(DATA_DIR, "platforms.json");
const FORMULAS_PATH = path.join(DATA_DIR, "formulas.json");

// Required top-level keys for a valid style profile
const REQUIRED_PROFILE_FIELDS = ["tone", "readability", "rhythm", "voice", "vocabulary"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadDefaultProfile(): StyleProfile {
  const raw = fs.readFileSync(DEFAULT_PROFILE_PATH, "utf8");
  return JSON.parse(raw) as StyleProfile;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Extract raw paragraphs from markdown text: non-empty blocks separated by
 * blank lines, each at least 20 words.
 */
function extractParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => {
      if (!p) return false;
      // Skip pure headings and list-only blocks
      const firstLine = p.split("\n")[0];
      if (/^#{1,6}\s/.test(firstLine)) return false;
      const wordCount = p.split(/\s+/).filter(Boolean).length;
      return wordCount >= 20;
    });
}

/**
 * Count punctuation frequency per 1000 words for the set of tracked marks.
 */
function punctuationFrequencyMap(text: string): Record<string, number> {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words === 0) return {};
  const marks: Record<string, string> = {
    ".": "period",
    ",": "comma",
    ";": "semicolon",
    ":": "colon",
    "!": "exclamation",
    "?": "question",
    "—": "em_dash",
  };
  const result: Record<string, number> = {};
  for (const [char, label] of Object.entries(marks)) {
    let count = 0;
    for (const ch of text) {
      if (ch === char) count++;
    }
    result[label] = Math.round(((count / words) * 1000) * 100) / 100;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {

  // --------------------------------------------------------------------------
  // load_style_profile
  // --------------------------------------------------------------------------
  pi.registerTool({
    name: "load_style_profile",
    label: "Load Style Profile",
    description:
      "Load a style profile JSON from the given path. Validates required fields. Falls back to the default profile if the file is missing or invalid. Returns the parsed profile as formatted JSON.",
    parameters: Type.Object({
      path: Type.String({
        description: "Absolute path to the style profile JSON, e.g. /artifacts/styles/brand-voice.json",
      }),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        let profile: StyleProfile;
        let warnings: string[] = [];

        // Attempt to load the requested file
        if (fs.existsSync(params.path)) {
          let raw: string;
          try {
            raw = fs.readFileSync(params.path, "utf8");
          } catch (readErr: unknown) {
            const msg = readErr instanceof Error ? readErr.message : String(readErr);
            warnings.push(`Could not read ${params.path}: ${msg}. Using default profile.`);
            profile = loadDefaultProfile();
            const out = warnings.map((w) => `WARNING: ${w}`).join("\n") + "\n\n" + JSON.stringify(profile, null, 2);
            return { content: [{ type: "text" as const, text: out }] };
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            warnings.push(`${params.path} is not valid JSON. Using default profile.`);
            profile = loadDefaultProfile();
            const out = warnings.map((w) => `WARNING: ${w}`).join("\n") + "\n\n" + JSON.stringify(profile, null, 2);
            return { content: [{ type: "text" as const, text: out }] };
          }

          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            warnings.push(`${params.path} is not a JSON object. Using default profile.`);
            profile = loadDefaultProfile();
          } else {
            const obj = parsed as Record<string, unknown>;
            const missingFields = REQUIRED_PROFILE_FIELDS.filter((f) => !(f in obj));
            if (missingFields.length > 0) {
              warnings.push(
                `Profile missing required fields: ${missingFields.join(", ")}. Falling back to default profile.`
              );
              profile = loadDefaultProfile();
            } else {
              profile = parsed as StyleProfile;
            }
          }
        } else {
          warnings.push(`File not found: ${params.path}. Using default profile.`);
          profile = loadDefaultProfile();
        }

        const lines: string[] = [];
        for (const w of warnings) {
          lines.push(`WARNING: ${w}`);
        }
        if (lines.length > 0) lines.push("");
        lines.push(JSON.stringify(profile, null, 2));

        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });

  // --------------------------------------------------------------------------
  // analyze_writing_samples
  // --------------------------------------------------------------------------
  pi.registerTool({
    name: "analyze_writing_samples",
    label: "Analyze Writing Samples",
    description:
      "Analyze .md files in samples_dir to produce a style profile. Computes burstiness, TTR, active voice ratio, readability grade, sentence length SD, em dash density, and punctuation frequency. Extracts 2 representative paragraphs. Writes the profile to output_path if given.",
    parameters: Type.Object({
      samples_dir: Type.String({
        description: "Directory containing .md sample files to analyze",
      }),
      output_path: Type.Optional(
        Type.String({
          description: "If provided, write the computed profile JSON to this path",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        if (!fs.existsSync(params.samples_dir)) {
          return {
            content: [{ type: "text" as const, text: `Error: samples_dir not found: ${params.samples_dir}` }],
          };
        }

        const entries = fs.readdirSync(params.samples_dir);
        const mdFiles = entries.filter((e) => e.endsWith(".md"));

        if (mdFiles.length === 0) {
          return {
            content: [{ type: "text" as const, text: `Error: no .md files found in ${params.samples_dir}` }],
          };
        }

        // Per-file metrics
        interface FileMetrics {
          file: string;
          burstiness: number;
          ttr: number;
          activeVoiceRatio: number;
          readabilityGrade: number;
          sentenceLengthSD: number;
          emDashPerThousand: number;
          wordCount: number;
          punctFreq: Record<string, number>;
          paragraphs: string[];
        }

        const fileMetrics: FileMetrics[] = [];

        for (const filename of mdFiles) {
          const filePath = path.join(params.samples_dir, filename);
          let text: string;
          try {
            text = fs.readFileSync(filePath, "utf8");
          } catch {
            continue;
          }

          if (!text.trim()) continue;

          const burst = computeBurstiness(text);
          const ttr = computeTypeTokenRatio(text);
          const voice = computeActiveVoiceRatio(text);
          const readability = computeReadabilityGrade(text);
          const sentSD = computeSentenceLengthSD(text);
          const emDash = computeEmDashDensity(text);
          const punctFreq = punctuationFrequencyMap(text);
          const paragraphs = extractParagraphs(text);
          const wordCount = text.split(/\s+/).filter(Boolean).length;

          fileMetrics.push({
            file: filename,
            burstiness: burst.coefficient >= 0 ? burst.coefficient : 0,
            ttr,
            activeVoiceRatio: voice.ratio,
            readabilityGrade: readability.grade,
            sentenceLengthSD: sentSD,
            emDashPerThousand: emDash.perThousand,
            wordCount,
            punctFreq,
            paragraphs,
          });
        }

        if (fileMetrics.length === 0) {
          return {
            content: [{ type: "text" as const, text: "Error: no readable .md files found in samples_dir" }],
          };
        }

        // Aggregate metrics across files
        const burstinessValues = fileMetrics.map((f) => f.burstiness);
        const ttrValues = fileMetrics.map((f) => f.ttr);
        const activeVoiceValues = fileMetrics.map((f) => f.activeVoiceRatio);
        const gradeValues = fileMetrics.map((f) => f.readabilityGrade);
        const emDashValues = fileMetrics.map((f) => f.emDashPerThousand);

        const medianSentLengths = fileMetrics.flatMap((f) => {
          // Approximate median sentence length per file from SD and mean
          // We don't have per-sentence data here, so we use SD as a proxy
          return [f.sentenceLengthSD];
        });

        const aggBurstiness = mean(burstinessValues);
        const aggTTR = mean(ttrValues);
        const aggActiveVoice = mean(activeVoiceValues);
        const aggGrade = mean(gradeValues);

        // Aggregate punctuation frequency map (mean across files)
        const punctKeys = Object.keys(fileMetrics[0].punctFreq);
        const aggPunctFreq: Record<string, number> = {};
        for (const k of punctKeys) {
          const vals = fileMetrics.map((f) => f.punctFreq[k] ?? 0);
          aggPunctFreq[k] = Math.round(mean(vals) * 100) / 100;
        }

        // Select 2 representative paragraphs (closest to the aggregate metrics)
        // Score each paragraph by distance from aggregate on available metrics
        interface ScoredParagraph {
          text: string;
          distance: number;
        }

        const candidates: ScoredParagraph[] = [];

        for (const fm of fileMetrics) {
          for (const para of fm.paragraphs) {
            if (para.length < 60) continue;
            const pBurst = computeBurstiness(para);
            const pTTR = computeTypeTokenRatio(para);
            const pVoice = computeActiveVoiceRatio(para);
            const pGrade = computeReadabilityGrade(para);

            const bVal = pBurst.coefficient >= 0 ? pBurst.coefficient : aggBurstiness;

            // Euclidean distance across normalised axes (each metric 0-1 or capped)
            const dBurst = Math.abs(bVal - aggBurstiness);
            const dTTR = Math.abs(pTTR - aggTTR);
            const dVoice = Math.abs(pVoice.ratio - aggActiveVoice);
            const dGrade = Math.abs(pGrade.grade - aggGrade) / 20; // normalise grade ~0-20

            const distance = Math.sqrt(dBurst ** 2 + dTTR ** 2 + dVoice ** 2 + dGrade ** 2);
            candidates.push({ text: para, distance });
          }
        }

        // Sort ascending by distance, take top 2 that aren't near-duplicates
        candidates.sort((a, b) => a.distance - b.distance);

        const fewShotSamples: string[] = [];
        for (const c of candidates) {
          if (fewShotSamples.length >= 2) break;
          // Avoid near-duplicates: skip if very similar to an already selected sample
          const isDuplicate = fewShotSamples.some(
            (s) => s.slice(0, 80) === c.text.slice(0, 80)
          );
          if (!isDuplicate) {
            fewShotSamples.push(c.text);
          }
        }

        // Build the style profile from computed metrics
        // Cap burstiness target at 0.85 (beyond this reads incoherent — see edge case #8)
        const burstinessTarget = Math.min(aggBurstiness > 0 ? aggBurstiness : 0.55, 0.85);

        const computedProfile: StyleProfile = {
          name: "computed-from-samples",
          version: 1,
          tone: {
            formality: 0.5,
            humor: 0.1,
            enthusiasm: 0.5,
            irreverence: 0.2,
          },
          readability: {
            target_grade: Math.round(aggGrade * 10) / 10,
            max_grade: Math.ceil(aggGrade) + 2,
          },
          rhythm: {
            burstiness_target: Math.round(burstinessTarget * 100) / 100,
            min_sentence_words: 3,
            max_sentence_words: 45,
          },
          voice: {
            active_ratio: Math.round(aggActiveVoice * 100) / 100,
          },
          vocabulary: {
            blocklist_strict: [],
            blocklist_soft: [],
            preferred_alternatives: {},
          },
          structure: {
            max_em_dashes_per_1000: 3,
            max_semicolons_per_1000: 2,
            rule_of_three_cap: 0.3,
            no_compulsive_summary: true,
          },
          computed_metrics: {
            type_token_ratio: Math.round(aggTTR * 1000) / 1000,
            punctuation_frequency_per_1000: aggPunctFreq,
            files_analyzed: fileMetrics.length,
          },
          few_shot_samples: fewShotSamples,
        };

        // Write profile to output_path if provided
        if (params.output_path) {
          try {
            fs.mkdirSync(path.dirname(params.output_path), { recursive: true });
            fs.writeFileSync(params.output_path, JSON.stringify(computedProfile, null, 2), "utf8");
          } catch (writeErr: unknown) {
            const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
            const profileJson = JSON.stringify(computedProfile, null, 2);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `WARNING: Could not write to ${params.output_path}: ${msg}\n\n${profileJson}`,
                },
              ],
            };
          }
        }

        const outputLines: string[] = [];
        if (params.output_path) {
          outputLines.push(`Profile written to: ${params.output_path}`);
          outputLines.push(`Files analyzed: ${fileMetrics.length}`);
          outputLines.push("");
        }
        outputLines.push(JSON.stringify(computedProfile, null, 2));

        return { content: [{ type: "text" as const, text: outputLines.join("\n") }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });

  // --------------------------------------------------------------------------
  // get_style_instructions
  // --------------------------------------------------------------------------
  pi.registerTool({
    name: "get_style_instructions",
    label: "Get Style Instructions",
    description:
      "Generate a concise prose instruction block (~300 words) from a style profile, optional platform config, and optional copywriting formula. Suitable for injecting into an LLM system prompt.",
    parameters: Type.Object({
      profile: Type.Object(
        {},
        {
          description: "The style profile object (e.g. from load_style_profile)",
          additionalProperties: true,
        }
      ),
      platform: Type.Optional(
        Type.String({
          description: "Platform name, e.g. linkedin, twitter, blog, whitepaper, email",
        })
      ),
      formula: Type.Optional(
        Type.String({
          description: "Copywriting formula name, e.g. aida, pas, bab, fab, 4ps",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        const profile = params.profile as StyleProfile;
        const parts: string[] = [];

        // ---- Tone guidance ----
        const tone = profile.tone as Record<string, number> | undefined;
        if (tone && typeof tone === "object") {
          const toneLines: string[] = [];

          const describe = (val: number): string => {
            if (val <= 0.3) return "low";
            if (val <= 0.6) return "moderate";
            return "high";
          };

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
              toneLines.push(`Enthusiasm is ${level} — ${level === "high" ? "bring energy and conviction" : "stay measured and factual"}.`);
            }
          }
          if (typeof tone.humor === "number" && tone.humor > 0.3) {
            toneLines.push(`Humor is ${describe(tone.humor)} — light wit is welcome, not forced.`);
          }
          if (typeof tone.irreverence === "number" && tone.irreverence > 0.3) {
            toneLines.push(`Irreverence is ${describe(tone.irreverence)} — challenge conventions where appropriate.`);
          }

          if (toneLines.length > 0) {
            parts.push("TONE\n" + toneLines.join(" "));
          }
        }

        // ---- Vocabulary ----
        const vocab = profile.vocabulary as {
          blocklist_strict?: string[];
          blocklist_soft?: string[];
          preferred_alternatives?: Record<string, string>;
        } | undefined;

        if (vocab) {
          const vocabLines: string[] = [];
          if (vocab.blocklist_strict && vocab.blocklist_strict.length > 0) {
            vocabLines.push(`Never use: ${vocab.blocklist_strict.slice(0, 12).join(", ")}.`);
          }
          if (vocab.blocklist_soft && vocab.blocklist_soft.length > 0) {
            vocabLines.push(`Avoid unless necessary: ${vocab.blocklist_soft.slice(0, 8).join(", ")}.`);
          }
          if (vocab.preferred_alternatives && Object.keys(vocab.preferred_alternatives).length > 0) {
            const pairs = Object.entries(vocab.preferred_alternatives).slice(0, 6)
              .map(([k, v]) => `${k} → ${v}`)
              .join(", ");
            vocabLines.push(`Prefer simpler alternatives: ${pairs}.`);
          }
          if (vocabLines.length > 0) {
            parts.push("VOCABULARY\n" + vocabLines.join(" "));
          }
        }

        // ---- Rhythm ----
        const rhythm = profile.rhythm as {
          burstiness_target?: number;
          min_sentence_words?: number;
          max_sentence_words?: number;
        } | undefined;

        const readability = profile.readability as {
          target_grade?: number;
          max_grade?: number;
        } | undefined;

        const rhythmLines: string[] = [];
        if (rhythm?.burstiness_target != null) {
          rhythmLines.push(
            `Vary sentence length deliberately. Target burstiness coefficient ~${rhythm.burstiness_target} (mix short punchy sentences with longer ones — never three consecutive sentences of similar length).`
          );
        }
        if (rhythm?.min_sentence_words != null && rhythm?.max_sentence_words != null) {
          rhythmLines.push(
            `Sentence length range: ${rhythm.min_sentence_words}–${rhythm.max_sentence_words} words. Sentence length standard deviation should exceed 5 words.`
          );
        }
        if (readability?.target_grade != null) {
          rhythmLines.push(
            `Target Flesch-Kincaid grade ${readability.target_grade}${readability.max_grade != null ? `, max ${readability.max_grade}` : ""}.`
          );
        }
        rhythmLines.push("Vary paragraph length. Avoid uniform blocks of identical-length paragraphs.");
        if (rhythmLines.length > 0) {
          parts.push("RHYTHM\n" + rhythmLines.join(" "));
        }

        // ---- Structure rules ----
        const structure = profile.structure as {
          max_em_dashes_per_1000?: number;
          no_compulsive_summary?: boolean;
          rule_of_three_cap?: number;
        } | undefined;

        const voice = profile.voice as {
          active_ratio?: number;
        } | undefined;

        const structureLines: string[] = [];
        if (structure?.max_em_dashes_per_1000 != null) {
          structureLines.push(`Em dash cap: < ${structure.max_em_dashes_per_1000} per 1000 words.`);
        }
        if (voice?.active_ratio != null) {
          structureLines.push(`Active voice in at least ${Math.round(voice.active_ratio * 100)}% of sentences.`);
        }
        if (structure?.no_compulsive_summary) {
          structureLines.push('Do not end with "In conclusion", "In summary", or equivalent compulsive summary phrases.');
        }
        structureLines.push(
          'No AI tells: avoid "Let\'s dive in", "It\'s worth noting", "In today\'s landscape", "As we navigate".'
        );
        if (structure?.rule_of_three_cap != null) {
          structureLines.push(
            `Triplet lists (X, Y, and Z) should be no more than ${Math.round(structure.rule_of_three_cap * 100)}% of all lists.`
          );
        }
        if (structureLines.length > 0) {
          parts.push("STRUCTURE\n" + structureLines.join(" "));
        }

        // ---- Platform constraints ----
        if (params.platform) {
          let platformConfig: Record<string, unknown> | null = null;
          if (fs.existsSync(PLATFORMS_PATH)) {
            try {
              const raw = fs.readFileSync(PLATFORMS_PATH, "utf8");
              const allPlatforms = JSON.parse(raw) as Record<string, Record<string, unknown>>;
              const key = params.platform.toLowerCase();
              platformConfig = allPlatforms[key] ?? null;
            } catch {
              // Platforms file unreadable — skip silently
            }
          }

          const platformLines: string[] = [];
          if (platformConfig) {
            const label = (platformConfig.label as string) ?? params.platform;
            platformLines.push(`Platform: ${label}.`);
            if (platformConfig.char_limit) {
              platformLines.push(`Character limit: ${platformConfig.char_limit} per unit.`);
            }
            if (Array.isArray(platformConfig.rules)) {
              const rules = (platformConfig.rules as string[]).slice(0, 5);
              platformLines.push(...rules);
            } else if (typeof platformConfig.structure === "string") {
              platformLines.push(platformConfig.structure);
            }
            if (typeof platformConfig.tone === "string") {
              platformLines.push(`Platform tone: ${platformConfig.tone}.`);
            }
          } else {
            // Built-in fallbacks for common platforms
            const builtIn: Record<string, string[]> = {
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
            const fallback = builtIn[params.platform.toLowerCase()];
            if (fallback) {
              platformLines.push(`Platform: ${params.platform}.`, ...fallback);
            } else {
              platformLines.push(`Platform: ${params.platform} (no specific rules available).`);
            }
          }

          if (platformLines.length > 0) {
            parts.push("PLATFORM\n" + platformLines.join(" "));
          }
        }

        // ---- Formula structure ----
        if (params.formula) {
          let formulaConfig: { name: string; label: string; steps: Array<{ name: string; purpose: string; constraints?: string }> } | null = null;
          if (fs.existsSync(FORMULAS_PATH)) {
            try {
              const raw = fs.readFileSync(FORMULAS_PATH, "utf8");
              const allFormulas = JSON.parse(raw) as Array<typeof formulaConfig>;
              formulaConfig = allFormulas.find(
                (f) => f !== null && f.name.toLowerCase() === params.formula!.toLowerCase()
              ) ?? null;
            } catch {
              // Formulas file unreadable — fall through to built-in
            }
          }

          const formulaLines: string[] = [];
          if (formulaConfig) {
            formulaLines.push(`Structure (${formulaConfig.label}):`);
            for (const step of formulaConfig.steps) {
              const constraint = step.constraints ? ` [${step.constraints}]` : "";
              formulaLines.push(`${step.name}: ${step.purpose}${constraint}.`);
            }
          } else {
            // Built-in formula fallbacks
            const builtIn: Record<string, string[]> = {
              aida: ["Attention: hook that stops the reader.", "Interest: expand with relevant info, build curiosity.", "Desire: connect to reader's needs, paint the outcome.", "Action: clear CTA with low friction."],
              pas: ["Problem: name the pain point directly.", "Agitate: amplify consequences of inaction.", "Solution: present the fix with proof."],
              bab: ["Before: current painful state.", "After: desired future state.", "Bridge: how to get there."],
              fab: ["Features: what it does (technical).", "Advantages: why that matters (comparative).", "Benefits: what the reader gains."],
              "4ps": ["Promise: bold claim or outcome.", "Picture: vivid scenario of success.", "Proof: evidence, testimonials, data.", "Push: urgency plus CTA."],
            };
            const fallback = builtIn[params.formula.toLowerCase()];
            if (fallback) {
              formulaLines.push(`Structure (${params.formula.toUpperCase()}):`, ...fallback);
            } else {
              formulaLines.push(`Formula: ${params.formula} (no specific structure available).`);
            }
          }

          if (formulaLines.length > 0) {
            parts.push("FORMULA\n" + formulaLines.join(" "));
          }
        }

        // ---- Few-shot samples ----
        const samples = profile.few_shot_samples as string[] | undefined;
        if (Array.isArray(samples) && samples.length > 0) {
          parts.push(
            "FEW-SHOT REFERENCE\n" +
              "Use the following excerpts as style references. Match their voice, rhythm, and sentence structure closely:\n" +
              samples.map((s, i) => `[Sample ${i + 1}]\n${s}`).join("\n\n")
          );
        }

        const instructions = parts.join("\n\n");
        return { content: [{ type: "text" as const, text: instructions }] };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });
}
