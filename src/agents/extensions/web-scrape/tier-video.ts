import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { RateLimiter } from "./rate-limiter.js";

interface VideoDeps {
  groqApiKey: string;
  nimApiKey: string;
  nimLimiter: RateLimiter;
}

export function register(pi: ExtensionAPI, deps: VideoDeps): void {
  const { groqApiKey, nimApiKey, nimLimiter } = deps;

  // ---- transcribe_audio: Groq Whisper transcription ----

  if (groqApiKey) {
    pi.registerTool({
      name: "transcribe_audio",
      label: "Audio Transcriber",
      description:
        "Transcribe audio from a video URL using Groq Whisper. Downloads the video, extracts audio with ffmpeg, and returns the transcript text. Best for Instagram reels and other videos without native subtitles.",
      promptSnippet:
        "Transcribe speech from a video URL. Requires ffmpeg in the container.",
      parameters: Type.Object({
        video_url: Type.String({ description: "URL to video file (MP4)" }),
        language: Type.Optional(
          Type.String({ description: 'Language code (default "en")' })
        ),
      }),
      async execute(_toolCallId, params, signal) {
        const { writeFileSync, unlinkSync, readFileSync } = require("node:fs");
        const { execFileSync: execSync } = require("node:child_process");
        const { join } = require("node:path");
        const os = require("node:os");
        const tmpDir = os.tmpdir();
        const ts = Date.now();
        const videoPath = join(tmpDir, `whisper-${ts}.mp4`);
        const audioPath = join(tmpDir, `whisper-${ts}.mp3`);

        try {
          const videoRes = await fetch(params.video_url, { signal });
          if (!videoRes.ok) {
            return {
              content: [{ type: "text" as const, text: `Failed to download video: HTTP ${videoRes.status}` }],
              details: { error: `HTTP ${videoRes.status}`, tool: "transcribe_audio" },
            };
          }
          const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
          writeFileSync(videoPath, videoBuffer);

          try {
            execSync("ffmpeg", [
              "-i", videoPath,
              "-vn",
              "-acodec", "libmp3lame",
              "-q:a", "4",
              "-y",
              audioPath,
            ], { timeout: 60_000 });
          } catch (ffErr) {
            const msg = ffErr instanceof Error ? ffErr.message : String(ffErr);
            return {
              content: [{ type: "text" as const, text: `ffmpeg audio extraction failed: ${msg}` }],
              details: { error: msg, tool: "transcribe_audio" },
            };
          }

          const audioData = readFileSync(audioPath);
          const formData = new FormData();
          formData.append("file", new Blob([audioData], { type: "audio/mpeg" }), "audio.mp3");
          formData.append("model", "whisper-large-v3-turbo");
          formData.append("language", params.language ?? "en");
          formData.append("response_format", "text");

          const groqRes = await fetch(
            "https://api.groq.com/openai/v1/audio/transcriptions",
            {
              method: "POST",
              headers: { Authorization: `Bearer ${groqApiKey}` },
              body: formData,
              signal,
            }
          );

          const remaining = groqRes.headers.get("x-ratelimit-remaining-requests");
          if (remaining && parseInt(remaining, 10) < 5) {
            console.warn(`[transcribe_audio] Groq rate limit warning: ${remaining} requests remaining`);
          }

          if (groqRes.status === 429) {
            const resetAfter = groqRes.headers.get("x-ratelimit-reset-requests") || "60s";
            const waitMs = parseFloat(resetAfter) * 1000 || 60_000;
            await new Promise((r) => setTimeout(r, Math.min(waitMs, 120_000)));
            const retryRes = await fetch(
              "https://api.groq.com/openai/v1/audio/transcriptions",
              {
                method: "POST",
                headers: { Authorization: `Bearer ${groqApiKey}` },
                body: formData,
                signal,
              }
            );
            if (!retryRes.ok) {
              const errText = await retryRes.text().catch(() => "");
              return {
                content: [{ type: "text" as const, text: `Groq Whisper failed after retry (${retryRes.status}): ${errText}` }],
                details: { error: `HTTP ${retryRes.status}`, tool: "transcribe_audio" },
              };
            }
            const transcript = await retryRes.text();
            return {
              content: [{ type: "text" as const, text: `## Audio Transcript\n\n${transcript.trim()}` }],
              details: { tool: "transcribe_audio", chars: transcript.length, retried: true },
            };
          }

          if (!groqRes.ok) {
            const errText = await groqRes.text().catch(() => "");
            return {
              content: [{ type: "text" as const, text: `Groq Whisper error (${groqRes.status}): ${errText}` }],
              details: { error: `HTTP ${groqRes.status}`, tool: "transcribe_audio" },
            };
          }

          const transcript = await groqRes.text();
          return {
            content: [{ type: "text" as const, text: `## Audio Transcript\n\n${transcript.trim()}` }],
            details: { tool: "transcribe_audio", chars: transcript.length },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Transcription failed: ${msg}` }],
            details: { error: msg, tool: "transcribe_audio" },
          };
        } finally {
          try { unlinkSync(videoPath); } catch {}
          try { unlinkSync(audioPath); } catch {}
        }
      },
    });
  }

  // ---- analyze_video: NIM Nemotron video analysis ----

  if (nimApiKey) {
    pi.registerTool({
      name: "analyze_video",
      label: "Video Analyzer",
      description:
        "Analyze video content using NVIDIA NIM Nemotron vision model. Returns structured JSON with summary, topics, on-screen text, tone, speakers, transcript summary, and visual details. Video must be at a publicly accessible URL.",
      promptSnippet:
        "Analyze video content visually — extracts text, speakers, topics, and visual details.",
      parameters: Type.Object({
        video_url: Type.String({ description: "Publicly accessible URL to MP4 video" }),
        focus: Type.Optional(
          Type.String({
            description: 'Optional focus area (e.g. "product placement", "branding")',
          })
        ),
      }),
      async execute(_toolCallId, params, signal) {
        try {
          const headRes = await fetch(params.video_url, { method: "HEAD", signal });
          if (!headRes.ok) {
            return {
              content: [{ type: "text" as const, text: `Video URL not accessible: HTTP ${headRes.status}` }],
              details: { error: `HTTP ${headRes.status}`, tool: "analyze_video" },
            };
          }

          await nimLimiter.acquire();

          const focusLine = params.focus
            ? `\nFocus especially on: ${params.focus}`
            : "";

          const body = {
            model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "video_url",
                    video_url: { url: params.video_url },
                  },
                  {
                    type: "text",
                    text: `Return ONLY a JSON object analyzing this video:
{
  "summary": "2-3 sentence summary",
  "topics": ["topic1", "topic2"],
  "on_screen_text": ["text1", "text2"],
  "tone": "one word",
  "speakers": [{"name": "...", "said": "brief quote"}],
  "transcript_summary": "key points from speech",
  "visual_details": "products, branding, demos, graphics not in subtitles"
}
No markdown, no explanation, just the JSON.${focusLine}`,
                  },
                ],
              },
            ],
            max_tokens: 2048,
            temperature: 0.1,
          };

          const startTime = Date.now();
          const res = await fetch(
            "https://integrate.api.nvidia.com/v1/chat/completions",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${nimApiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
              signal: signal || AbortSignal.timeout(120_000),
            }
          );

          const elapsed = Date.now() - startTime;

          if (!res.ok) {
            const errText = await res.text().catch(() => "");
            return {
              content: [{ type: "text" as const, text: `NIM video analysis error (${res.status}): ${errText}` }],
              details: { error: `HTTP ${res.status}`, tool: "analyze_video", elapsed },
            };
          }

          const data = await res.json() as {
            choices?: { message?: { content?: string } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          };

          const reply = data.choices?.[0]?.message?.content || "";
          const usage = data.usage;

          let analysis: Record<string, unknown> | null = null;
          try {
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              analysis = JSON.parse(jsonMatch[0]);
            }
          } catch {}

          const lines: string[] = [];
          lines.push("## Video Analysis\n");
          lines.push(`**Video:** ${params.video_url}`);
          lines.push(`**Elapsed:** ${(elapsed / 1000).toFixed(1)}s`);
          if (usage) {
            lines.push(`**Tokens:** ${usage.prompt_tokens} in / ${usage.completion_tokens} out`);
          }
          lines.push("");

          if (analysis) {
            lines.push("```json");
            lines.push(JSON.stringify(analysis, null, 2));
            lines.push("```");
          } else {
            lines.push("### Raw Response\n");
            lines.push(reply);
          }

          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
            details: {
              tool: "analyze_video",
              elapsed,
              usage,
              parsed: !!analysis,
              analysis: analysis || reply,
            },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Video analysis failed: ${msg}` }],
            details: { error: msg, tool: "analyze_video" },
          };
        }
      },
    });
  }

  // ---- enrich_video: composite pipeline ----

  if (groqApiKey || nimApiKey) {
    pi.registerTool({
      name: "enrich_video",
      label: "Video Enricher",
      description:
        "Full video content extraction pipeline. Combines audio transcription (Groq Whisper) and visual analysis (NIM Nemotron) into a single enriched result. For Instagram reels without subtitles, transcribes audio first. For TikTok/YouTube with existing subtitles, pass them via subtitle_text to skip transcription.",
      promptSnippet:
        "One-shot video enrichment: transcript + visual analysis combined.",
      parameters: Type.Object({
        video_url: Type.String({ description: "Publicly accessible URL to MP4 video" }),
        platform: Type.Union(
          [Type.Literal("tiktok"), Type.Literal("youtube"), Type.Literal("instagram")],
          { description: "Source platform" }
        ),
        subtitle_text: Type.Optional(
          Type.String({ description: "Pre-existing subtitle/transcript text (from Apify)" })
        ),
        focus: Type.Optional(
          Type.String({ description: "Optional focus area for visual analysis" })
        ),
      }),
      async execute(toolCallId, params, signal) {
        const results: Record<string, unknown> = {
          video_url: params.video_url,
          platform: params.platform,
        };
        const errors: string[] = [];

        if (params.subtitle_text) {
          results.transcript = params.subtitle_text;
          results.transcript_source = "apify_subtitles";
        } else if (params.platform === "instagram" && groqApiKey) {
          try {
            const { writeFileSync, unlinkSync, readFileSync } = require("node:fs");
            const { execFileSync: execSync } = require("node:child_process");
            const { join } = require("node:path");
            const os = require("node:os");
            const tmpDir = os.tmpdir();
            const ts = Date.now();
            const videoPath = join(tmpDir, `enrich-${ts}.mp4`);
            const audioPath = join(tmpDir, `enrich-${ts}.mp3`);

            try {
              const videoRes = await fetch(params.video_url, { signal });
              if (videoRes.ok) {
                const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
                writeFileSync(videoPath, videoBuffer);

                execSync("ffmpeg", [
                  "-i", videoPath, "-vn", "-acodec", "libmp3lame",
                  "-q:a", "4", "-y", audioPath,
                ], { timeout: 60_000 });

                const audioData = readFileSync(audioPath);
                const formData = new FormData();
                formData.append("file", new Blob([audioData], { type: "audio/mpeg" }), "audio.mp3");
                formData.append("model", "whisper-large-v3-turbo");
                formData.append("language", "en");
                formData.append("response_format", "text");

                const groqRes = await fetch(
                  "https://api.groq.com/openai/v1/audio/transcriptions",
                  {
                    method: "POST",
                    headers: { Authorization: `Bearer ${groqApiKey}` },
                    body: formData,
                    signal,
                  }
                );

                if (groqRes.ok) {
                  results.transcript = (await groqRes.text()).trim();
                  results.transcript_source = "groq_whisper";
                } else {
                  errors.push(`Groq transcription failed: HTTP ${groqRes.status}`);
                }
              } else {
                errors.push(`Video download failed: HTTP ${videoRes.status}`);
              }
            } finally {
              try { unlinkSync(videoPath); } catch {}
              try { unlinkSync(audioPath); } catch {}
            }
          } catch (err) {
            errors.push(`Transcription error: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else if (!params.subtitle_text) {
          results.transcript = null;
          results.transcript_source = "none";
        }

        if (nimApiKey) {
          try {
            await nimLimiter.acquire();

            const focusLine = params.focus ? `\nFocus especially on: ${params.focus}` : "";
            const nimBody = {
              model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "video_url", video_url: { url: params.video_url } },
                    {
                      type: "text",
                      text: `Return ONLY a JSON object analyzing this video:
{
  "summary": "2-3 sentence summary",
  "topics": ["topic1", "topic2"],
  "on_screen_text": ["text1", "text2"],
  "tone": "one word",
  "speakers": [{"name": "...", "said": "brief quote"}],
  "transcript_summary": "key points from speech",
  "visual_details": "products, branding, demos, graphics not in subtitles"
}
No markdown, no explanation, just the JSON.${focusLine}`,
                    },
                  ],
                },
              ],
              max_tokens: 2048,
              temperature: 0.1,
            };

            const res = await fetch(
              "https://integrate.api.nvidia.com/v1/chat/completions",
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${nimApiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(nimBody),
                signal: signal || AbortSignal.timeout(120_000),
              }
            );

            if (res.ok) {
              const data = await res.json() as {
                choices?: { message?: { content?: string } }[];
                usage?: Record<string, number>;
              };
              const reply = data.choices?.[0]?.message?.content || "";
              try {
                const jsonMatch = reply.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                  results.visual_analysis = JSON.parse(jsonMatch[0]);
                } else {
                  results.visual_analysis = reply;
                }
              } catch {
                results.visual_analysis = reply;
              }
              results.usage = data.usage;
            } else {
              errors.push(`NIM analysis failed: HTTP ${res.status}`);
            }
          } catch (err) {
            errors.push(`NIM error: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          errors.push("NVIDIA_NIM_API_KEY not set — visual analysis skipped");
        }

        if (errors.length > 0) {
          results.errors = errors;
        }

        const lines: string[] = [];
        lines.push("## Enriched Video Content\n");
        lines.push(`**Platform:** ${params.platform}`);
        lines.push(`**Video:** ${params.video_url}`);
        if (results.transcript_source) {
          lines.push(`**Transcript source:** ${results.transcript_source}`);
        }
        lines.push("");
        lines.push("```json");
        lines.push(JSON.stringify(results, null, 2));
        lines.push("```");

        if (errors.length > 0) {
          lines.push("\n### Warnings\n");
          for (const e of errors) lines.push(`- ${e}`);
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: results,
        };
      },
    });
  }
}
