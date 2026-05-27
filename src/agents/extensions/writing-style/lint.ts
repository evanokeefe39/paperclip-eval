import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  runFullAnalysis,
  loadBlocklist,
  detectAITellPatterns,
  type Blocklist,
  type StyleProfile,
} from "./metrics.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PROFILE_PATH = "/app/data/style/default-profile.json";
const DEFAULT_BLOCKLIST_PATH = "/app/data/style/excess-words.json";
const VALE_BINARY = "/usr/local/bin/vale";
const VALE_CONFIG = "/root/.pi/agent/extensions/writing-style/vale/.vale.ini";

// ---------------------------------------------------------------------------
// Dependency detection — run at module load time
// ---------------------------------------------------------------------------

function hasVale(): boolean {
  try {
    execFileSync(VALE_BINARY, ["--version"], { encoding: "utf-8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Violation type used in fix_violations input
// ---------------------------------------------------------------------------

interface LintViolation {
  type: string;
  location?: string;
  detail?: string;
  suggestion?: string;
}

// ---------------------------------------------------------------------------
// Capitalization helper — match original word's case pattern
// ---------------------------------------------------------------------------

function matchCase(original: string, replacement: string): string {
  if (original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] === original[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

// ---------------------------------------------------------------------------
// Word boundary replace — replace first occurrence respecting word boundaries
// ---------------------------------------------------------------------------

function replaceWordBoundary(
  text: string,
  word: string,
  replacement: string
): { result: string; changed: boolean; position: number } {
  // Case-insensitive word boundary search
  const pattern = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const match = pattern.exec(text);
  if (!match) {
    return { result: text, changed: false, position: -1 };
  }
  const original = match[0];
  const fixed = matchCase(original, replacement);
  const result = text.slice(0, match.index) + fixed + text.slice(match.index + original.length);
  return { result, changed: true, position: match.index };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // =========================================================================
  // Tool 1: validate_style
  // =========================================================================

  pi.registerTool({
    name: "validate_style",
    label: "Validate Style",
    description:
      "Analyse a piece of text against the writer style profile. Reports word count, burstiness, excess-word score, em-dash density, active voice ratio, readability grade, and type-token ratio. Flags violations and AI tell patterns. Returns a structured JSON report.",
    promptSnippet: "Check text against style rules. Returns pass/fail with detailed violations.",
    parameters: Type.Object({
      text: Type.String({ description: "Text to analyse" }),
      profile_path: Type.Optional(
        Type.String({
          description:
            "Path to a JSON StyleProfile file. Defaults to /app/data/style/default-profile.json",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        // Load profile
        const profilePath = params.profile_path ?? DEFAULT_PROFILE_PATH;
        let profile: StyleProfile;
        try {
          const raw = fs.readFileSync(profilePath, "utf8");
          profile = JSON.parse(raw) as StyleProfile;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to load style profile from ${profilePath}: ${msg}`,
              },
            ],
          };
        }

        // Load blocklist
        let blocklist: Blocklist | undefined;
        try {
          blocklist = loadBlocklist(DEFAULT_BLOCKLIST_PATH);
        } catch {
          // Blocklist is optional — runFullAnalysis falls back to profile vocabulary
        }

        // Run analysis
        const analysis = runFullAnalysis(params.text, profile, blocklist);

        // Word count (re-derive from metrics to avoid reimporting tokenize)
        const wordCount = (analysis.metrics as Record<string, unknown>).wordCount as number ?? 0;

        // Extract flat metric values for report
        const mRaw = analysis.metrics as Record<string, unknown>;
        const burstRaw = mRaw.burstiness as { coefficient: number } | undefined;
        const excessRaw = mRaw.excessWords as { score: number; hits: Array<{ word: string; count: number; tier: string }> } | undefined;
        const emRaw = mRaw.emDash as { perThousand: number } | undefined;
        const sdRaw = mRaw.sentenceSD as number | undefined;
        const avRaw = mRaw.activeVoice as { ratio: number } | undefined;
        const readRaw = mRaw.readability as { grade: number } | undefined;
        const ttrRaw = mRaw.ttr as number | undefined;

        const metricsFlat = {
          burstiness: burstRaw != null ? Math.round((burstRaw.coefficient ?? 0) * 1000) / 1000 : null,
          excess_word_score: excessRaw != null ? Math.round((excessRaw.score ?? 0) * 10000) / 10000 : null,
          em_dash_density: emRaw != null ? Math.round((emRaw.perThousand ?? 0) * 100) / 100 : null,
          sentence_length_sd: sdRaw != null ? Math.round(sdRaw * 100) / 100 : null,
          active_voice_ratio: avRaw != null ? Math.round((avRaw.ratio ?? 0) * 100) / 100 : null,
          readability_grade: readRaw != null ? readRaw.grade : null,
          type_token_ratio: ttrRaw != null ? Math.round(ttrRaw * 100) / 100 : null,
        };

        // Build violations array with enriched detail
        const violations: object[] = [];

        for (const v of analysis.violations) {
          if (v.metric === "excess_word_score") {
            // Expand per-word violations from the hits list
            const hits = excessRaw?.hits ?? [];
            for (const hit of hits) {
              const alternative = blocklist?.alternatives?.[hit.word];
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
            violations.push({
              type: "em_dash",
              detail: `${metricsFlat.em_dash_density} per 1000 words, cap is ${v.target}`,
              suggestion: "Replace some em dashes with commas or periods",
            });
            continue;
          }

          if (v.metric === "ai_pattern") {
            violations.push({
              type: "ai_pattern",
              detail: `Found AI tell: '${v.actual}'`,
              suggestion: "Remove the phrase entirely",
            });
            continue;
          }

          if (v.metric === "burstiness") {
            violations.push({
              type: "burstiness",
              detail: `Burstiness coefficient ${v.actual}, target ${v.target}`,
              suggestion:
                v.actual < 0.4
                  ? "Vary sentence length more — mix short punchy sentences with longer ones"
                  : "Even out sentence length — too many very short or very long sentences",
            });
            continue;
          }

          if (v.metric === "sentence_length_sd") {
            violations.push({
              type: "sentence_length_sd",
              detail: `Sentence length standard deviation ${v.actual}, target ${v.target}`,
              suggestion: "Vary sentence length more to improve rhythm",
            });
            continue;
          }

          if (v.metric === "active_voice_ratio") {
            violations.push({
              type: "active_voice",
              detail: `Active voice ratio ${v.actual}, target ${v.target}`,
              suggestion: "Rewrite passive constructions in active voice",
            });
            continue;
          }

          if (v.metric === "readability_grade") {
            violations.push({
              type: "readability",
              detail: `Flesch-Kincaid grade level ${v.actual}, target ${v.target}`,
              suggestion: "Shorten sentences and use simpler words to reduce reading level",
            });
            continue;
          }

          if (v.metric === "rule_of_three") {
            violations.push({
              type: "rule_of_three",
              detail: `Triplet list ratio ${v.actual}, target ${v.target}`,
              suggestion: "Vary list lengths — not every list should have exactly three items",
            });
            continue;
          }

          // Fallback for any future metrics
          violations.push({
            type: v.metric,
            detail: `actual: ${v.actual}, target: ${v.target}`,
            suggestion: `Adjust to meet the target`,
          });
        }

        const report = {
          pass: analysis.pass,
          word_count: wordCount,
          metrics: metricsFlat,
          violations,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(report, null, 2),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `validate_style failed: ${msg}`,
            },
          ],
        };
      }
    },
  });

  // =========================================================================
  // Tool 2: fix_violations
  // =========================================================================

  pi.registerTool({
    name: "fix_violations",
    label: "Fix Style Violations",
    description:
      "Apply mechanical fixes to text based on violations reported by validate_style. Handles excess_word replacements (word boundary aware, case preserving), em_dash reduction, and AI tell pattern removal. Does NOT fix burstiness or structural issues — those require LLM rewriting.",
    promptSnippet:
      "Apply mechanical style fixes: replace excess words, reduce em dashes, strip AI tell phrases.",
    parameters: Type.Object({
      text: Type.String({ description: "Text to fix" }),
      violations: Type.Array(
        Type.Object(
          {
            type: Type.String({ description: "Violation type from validate_style" }),
            location: Type.Optional(Type.String()),
            detail: Type.Optional(Type.String()),
            suggestion: Type.Optional(Type.String()),
          },
          { additionalProperties: true }
        ),
        { description: "Violations array from validate_style output" }
      ),
    }),
    async execute(_toolCallId, params, _signal) {
      try {
        // Load blocklist for alternative lookups
        let blocklist: Blocklist | undefined;
        try {
          blocklist = loadBlocklist(DEFAULT_BLOCKLIST_PATH);
        } catch {
          // Operate without alternatives if file is missing
        }

        let text = params.text;
        const changes: Array<{
          type: string;
          original: string;
          replacement: string;
          position: number;
        }> = [];

        // Track em dash cap — derive from profile if possible, otherwise default
        let emDashCap = 3;
        try {
          const raw = fs.readFileSync(DEFAULT_PROFILE_PATH, "utf8");
          const profile = JSON.parse(raw) as StyleProfile;
          emDashCap = profile.structure?.max_em_dashes_per_1000 ?? 3;
        } catch {
          // Use default
        }

        // ---- AI tell patterns ----
        // Fixed patterns to strip. Order matters — longer phrases first to avoid partial matches.
        const AI_TELLS: Array<{ pattern: RegExp; replacement: string }> = [
          {
            // "In conclusion, " — remove phrase, capitalise next word
            pattern: /\bIn\s+conclusion,\s*/gi,
            replacement: "",
          },
          {
            // "In summary, "
            pattern: /\bIn\s+summary,\s*/gi,
            replacement: "",
          },
          {
            // "It's worth noting that "
            pattern: /\bIt['']s\s+worth\s+noting\s+that\s*/gi,
            replacement: "",
          },
          {
            // "Let's dive in." — remove entire sentence (with trailing whitespace)
            pattern: /\bLet['']s\s+dive\s+in\.?\s*/gi,
            replacement: "",
          },
          {
            // "In today's <word>, " — e.g. "In today's world, "
            pattern: /\bIn\s+today['']s\s+\w+,\s*/gi,
            replacement: "",
          },
        ];

        const aiViolationTypes = new Set(
          params.violations.filter((v) => v.type === "ai_pattern").map((v) => v.type)
        );

        if (aiViolationTypes.size > 0) {
          for (const { pattern, replacement } of AI_TELLS) {
            let match: RegExpExecArray | null;
            // Reset lastIndex in case of /g flag
            pattern.lastIndex = 0;
            while ((match = pattern.exec(text)) !== null) {
              const original = match[0];
              // After removal capitalise the following character if it was sentence-start context
              let rep = replacement;
              if (rep === "" && match.index === 0) {
                // Nothing to capitalise — text starts here
              } else if (rep === "" && match.index > 0) {
                // The word after may need capitalising if phrase started a sentence
                const before = text.slice(0, match.index);
                const isSentenceStart = /(?:^|[.!?]\s*)$/.test(before.trimEnd());
                if (isSentenceStart) {
                  // Capitalise first char after removal
                  const afterIdx = match.index + original.length;
                  if (afterIdx < text.length) {
                    rep = "";
                    text =
                      text.slice(0, match.index) +
                      text.slice(afterIdx, afterIdx + 1).toUpperCase() +
                      text.slice(afterIdx + 1);
                  }
                }
              }

              changes.push({
                type: "ai_pattern",
                original,
                replacement: rep,
                position: match.index,
              });

              text = text.slice(0, match.index) + rep + text.slice(match.index + original.length);
              // Reset because indices have shifted
              pattern.lastIndex = 0;
            }
          }
        }

        // ---- excess_word replacements ----
        for (const v of params.violations) {
          if (v.type !== "excess_word") continue;

          // Extract the word from location: `word: "delve" (2x)` or detail: `Found 'delve' (strict)`
          let word: string | null = null;

          const locMatch = v.location?.match(/^word:\s*"([^"]+)"/);
          if (locMatch) {
            word = locMatch[1];
          } else if (v.detail) {
            const detailMatch = v.detail.match(/Found '([^']+)'/);
            if (detailMatch) word = detailMatch[1];
          }

          if (!word) continue;

          // How many times to replace — default once; derive count from location "(Nx)"
          let replaceCount = 1;
          const countMatch = v.location?.match(/\((\d+)x\)/);
          if (countMatch) replaceCount = parseInt(countMatch[1], 10);

          // Find replacement from blocklist or suggestion field
          let replacement: string | null = null;
          if (blocklist?.alternatives) {
            replacement = blocklist.alternatives[word.toLowerCase()] ?? null;
          }
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

        // ---- em dash reduction ----
        const emViolations = params.violations.filter((v) => v.type === "em_dash");
        if (emViolations.length > 0) {
          // Count current em dashes
          const wordCount = text.split(/\s+/).filter(Boolean).length;
          const currentEmDashCount = (text.match(/—|--/g) ?? []).length;
          const allowedCount = Math.floor((wordCount / 1000) * emDashCap);
          const excessCount = Math.max(0, currentEmDashCount - allowedCount);

          if (excessCount > 0) {
            // Replace excess em dashes from the end of the text, working backwards
            // Strategy: find all em dash positions, sort descending, replace the last N
            const emDashPositions: number[] = [];
            for (let i = 0; i < text.length; i++) {
              if (text[i] === "—") {
                emDashPositions.push(i);
              } else if (text[i] === "-" && text[i + 1] === "-" &&
                (i === 0 || text[i - 1] !== "-") &&
                (i + 2 >= text.length || text[i + 2] !== "-")) {
                emDashPositions.push(i);
              }
            }

            // Take last `excessCount` positions (from end of document)
            const toReplace = emDashPositions.slice(-excessCount);
            // Sort descending so index shifts don't affect earlier positions
            toReplace.sort((a, b) => b - a);

            for (const pos of toReplace) {
              // Determine context: is this between two clauses within a sentence,
              // or between sentence-ending and a new sentence?
              // Heuristic: if the text before the dash ends with a complete sentence cue
              // (capital letter after or period before), use period; else use comma.
              const before = text.slice(0, pos).trimEnd();
              const after = text.slice(pos + 1).trimStart();

              // Double hyphen is two chars
              const dashLen = text[pos] === "—" ? 1 : 2;
              const afterActual = text.slice(pos + dashLen).trimStart();
              const firstCharAfter = afterActual[0] ?? "";

              let sub: string;
              if (/[A-Z]/.test(firstCharAfter)) {
                // Next fragment starts with capital — treat as sentence boundary
                sub = ". ";
              } else {
                // Within a sentence — replace with comma
                sub = ", ";
              }

              const original = text.slice(pos, pos + dashLen);
              // Trim surrounding spaces that were part of the em dash construct
              // Common pattern: " — " → replace the whole unit
              const startPos = text[pos - 1] === " " ? pos - 1 : pos;
              const endPos = text[pos + dashLen] === " " ? pos + dashLen + 1 : pos + dashLen;
              const originalSpanned = text.slice(startPos, endPos);
              const replacementSpanned = sub.trim() === "." ? ". " : ", ";

              changes.push({
                type: "em_dash",
                original: originalSpanned,
                replacement: replacementSpanned,
                position: startPos,
              });

              text = text.slice(0, startPos) + replacementSpanned + text.slice(endPos);
            }
          }
        }

        const result = {
          modified_text: text,
          changes,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `fix_violations failed: ${msg}`,
            },
          ],
        };
      }
    },
  });

  // =========================================================================
  // Tool 3: vale_lint (conditional — only register if Vale binary is present)
  // =========================================================================

  if (hasVale()) {
    pi.registerTool({
      name: "vale_lint",
      label: "Vale Lint",
      description:
        "Run Vale prose linter against a piece of text. Returns violations in a standard format. Requires Vale to be installed at /usr/local/bin/vale and a Vale config at /app/vale/.vale.ini.",
      promptSnippet: "Run Vale prose linter on text. Returns violations with location and suggestion.",
      parameters: Type.Object({
        text: Type.String({ description: "Text to lint with Vale" }),
      }),
      async execute(_toolCallId, params, _signal) {
        const tmpFile = `/tmp/vale-lint-${Date.now()}.md`;
        try {
          fs.writeFileSync(tmpFile, params.text, "utf8");

          let raw: string;
          try {
            raw = execFileSync(
              VALE_BINARY,
              ["--config", VALE_CONFIG, "--output=JSON", tmpFile],
              { encoding: "utf-8", timeout: 30_000 }
            );
          } catch (execErr) {
            // Vale exits non-zero when violations are found — stdout is still valid JSON
            const e = execErr as { stdout?: string; stderr?: string; message?: string };
            if (e.stdout) {
              raw = e.stdout;
            } else {
              throw new Error(e.message ?? String(execErr));
            }
          }

          // Vale JSON output: { "<filepath>": [ { Line, Span, Severity, Message, Check, Link } ] }
          let parsed: Record<string, Array<{
            Line: number;
            Span: [number, number];
            Severity: string;
            Message: string;
            Check: string;
            Link?: string;
          }>>;
          try {
            parsed = JSON.parse(raw);
          } catch {
            throw new Error(`Vale produced non-JSON output: ${raw.slice(0, 500)}`);
          }

          const violations: Array<{
            type: string;
            location: string;
            detail: string;
            suggestion: string;
          }> = [];

          for (const [, fileViolations] of Object.entries(parsed)) {
            for (const item of fileViolations) {
              violations.push({
                type: "vale",
                location: `line ${item.Line}, col ${item.Span[0]}-${item.Span[1]}`,
                detail: `[${item.Check}] ${item.Message}`,
                suggestion: item.Link ? `See ${item.Link}` : "Review and revise",
              });
            }
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(violations, null, 2),
              },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: `vale_lint failed: ${msg}`,
              },
            ],
          };
        } finally {
          try {
            fs.unlinkSync(tmpFile);
          } catch {
            // Ignore cleanup errors
          }
        }
      },
    });
  }
}
