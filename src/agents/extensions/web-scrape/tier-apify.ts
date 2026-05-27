import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export function register(pi: ExtensionAPI, apifyToken: string): void {
  // ---- scrape_apify: run an Apify actor ----

  pi.registerTool({
    name: "scrape_apify",
    label: "Apify Actor",
    description:
      "Run an Apify actor to scrape data. Apify provides hundreds of pre-built scrapers for major sites (Amazon, Google, YouTube, LinkedIn, etc). Provide the actor ID and input configuration. If the run completes within 30s, returns results directly; otherwise returns a run ID to check later with scrape_status.",
    promptSnippet:
      "Run an Apify scraping actor. Use list_actors to find the right actor first.",
    parameters: Type.Object({
      actor_id: Type.String({
        description: 'Apify actor ID (e.g. "apify/web-scraper")',
      }),
      actor_input: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Actor-specific input configuration",
        })
      ),
      url: Type.Optional(
        Type.String({
          description:
            "Convenience — if provided, merged into actor_input as startUrls",
        })
      ),
      max_results: Type.Optional(
        Type.Number({
          description: "Max items to return from dataset (default 100)",
        })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        if (!apifyToken) {
          return {
            content: [
              {
                type: "text" as const,
                text: "APIFY_API_TOKEN is not set. Export it as an environment variable to use Apify tools.",
              },
            ],
            details: { error: "missing_token", tier: "apify" },
          };
        }

        const maxResults = params.max_results ?? 100;
        const input: Record<string, unknown> = {
          ...(params.actor_input ?? {}),
        };

        if (params.url) {
          if (!input.startUrls || !Array.isArray(input.startUrls)) {
            input.startUrls = [];
          }
          (input.startUrls as { url: string }[]).push({ url: params.url });
        }

        const runRes = await fetch(
          `https://api.apify.com/v2/acts/${encodeURIComponent(params.actor_id)}/runs?token=${apifyToken}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
            signal,
          }
        );

        if (!runRes.ok) {
          const errText = await runRes.text().catch(() => "");
          return {
            content: [
              {
                type: "text" as const,
                text: `Apify API error ${runRes.status}: ${errText}`,
              },
            ],
            details: {
              actorId: params.actor_id,
              error: `HTTP ${runRes.status}`,
              tier: "apify",
            },
          };
        }

        const runData = (await runRes.json()) as {
          data: {
            id: string;
            status: string;
            defaultDatasetId: string;
          };
        };
        const runId = runData.data.id;
        const datasetId = runData.data.defaultDatasetId;

        const pollStart = Date.now();
        const POLL_TIMEOUT_MS = 30_000;
        const POLL_INTERVAL_MS = 2_000;
        let status = runData.data.status;

        while (
          Date.now() - pollStart < POLL_TIMEOUT_MS &&
          status !== "SUCCEEDED" &&
          status !== "FAILED" &&
          status !== "ABORTED" &&
          status !== "TIMED-OUT"
        ) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          try {
            const statusRes = await fetch(
              `https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`,
              { signal }
            );
            if (statusRes.ok) {
              const statusData = (await statusRes.json()) as {
                data: { status: string };
              };
              status = statusData.data.status;
            }
          } catch {
            // Ignore poll errors, continue waiting
          }
        }

        if (status === "SUCCEEDED") {
          const countRes = await fetch(
            `https://api.apify.com/v2/datasets/${datasetId}?token=${apifyToken}`,
            { signal }
          );
          let itemCount = 0;
          if (countRes.ok) {
            const countData = (await countRes.json()) as {
              data: { itemCount?: number };
            };
            itemCount = countData.data.itemCount ?? 0;
          }

          return {
            content: [
              {
                type: "text" as const,
                text: [
                  "## Apify Actor Completed\n",
                  `**Actor:** ${params.actor_id}`,
                  `**Run ID:** ${runId}`,
                  `**Dataset ID:** ${datasetId}`,
                  `**Items available:** ${itemCount}\n`,
                  "Use `apify_save_dataset` to stream results to a local file, then read the file.",
                ].join("\n"),
              },
            ],
            details: {
              actorId: params.actor_id,
              runId,
              datasetId,
              status: "SUCCEEDED",
              itemCount,
              tier: "apify",
            },
          };
        }

        if (status === "FAILED" || status === "ABORTED" || status === "TIMED-OUT") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Apify actor run ${status.toLowerCase()}. Actor: ${params.actor_id}, Run ID: ${runId}. Check Apify console for details.`,
              },
            ],
            details: {
              actorId: params.actor_id,
              runId,
              status,
              tier: "apify",
            },
          };
        }

        const lines: string[] = [];
        lines.push("## Apify Actor Started\n");
        lines.push(`**Actor:** ${params.actor_id}`);
        lines.push(`**Run ID:** ${runId}`);
        lines.push(`**Status:** ${status} (still running)\n`);
        lines.push(
          "The run is still in progress. Use `scrape_status` with this run ID to check results later."
        );

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            actorId: params.actor_id,
            runId,
            datasetId,
            status,
            tier: "apify",
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Apify scrape failed: ${msg}`,
            },
          ],
          details: {
            actorId: params.actor_id,
            error: msg,
            tier: "apify",
          },
        };
      }
    },
  });

  // ---- list_actors: search Apify store ----

  pi.registerTool({
    name: "list_actors",
    label: "List Apify Actors",
    description:
      "Search the Apify actor store to find pre-built scrapers. Returns actor names, descriptions, and usage stats. Use this to discover the right actor before running scrape_apify.",
    promptSnippet: "Search Apify store for pre-built scraping actors.",
    parameters: Type.Object({
      query: Type.String({ description: "Search terms" }),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        if (!apifyToken) {
          return {
            content: [
              {
                type: "text" as const,
                text: "APIFY_API_TOKEN is not set. Export it as an environment variable to use Apify tools.",
              },
            ],
            details: { error: "missing_token", tier: "apify" },
          };
        }

        const res = await fetch(
          `https://api.apify.com/v2/store?token=${apifyToken}&search=${encodeURIComponent(params.query)}&limit=5`,
          { signal }
        );

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          return {
            content: [
              {
                type: "text" as const,
                text: `Apify store search failed (${res.status}): ${errText}`,
              },
            ],
            details: { error: `HTTP ${res.status}`, tier: "apify" },
          };
        }

        const data = (await res.json()) as {
          data: {
            items: {
              name: string;
              username: string;
              title?: string;
              description?: string;
              stats?: {
                totalRuns?: number;
                totalUsers?: number;
              };
            }[];
          };
        };

        const actors = data.data?.items ?? [];
        if (actors.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No Apify actors found for query: "${params.query}"`,
              },
            ],
            details: { query: params.query, count: 0, tier: "apify" },
          };
        }

        const lines: string[] = [];
        lines.push(`## Apify Actors matching "${params.query}"\n`);

        for (const actor of actors) {
          const fullId = `${actor.username}/${actor.name}`;
          lines.push(`### ${actor.title || actor.name}`);
          lines.push(`**ID:** \`${fullId}\``);
          if (actor.description) {
            lines.push(
              `**Description:** ${actor.description.slice(0, 200)}`
            );
          }
          if (actor.stats) {
            const runs = actor.stats.totalRuns ?? 0;
            const users = actor.stats.totalUsers ?? 0;
            lines.push(`**Usage:** ${runs} runs, ${users} users`);
          }
          lines.push("");
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            query: params.query,
            count: actors.length,
            tier: "apify",
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Apify store search failed: ${msg}`,
            },
          ],
          details: { query: params.query, error: msg, tier: "apify" },
        };
      }
    },
  });

  // ---- apify_save_dataset: stream dataset to local file ----

  pi.registerTool({
    name: "apify_save_dataset",
    label: "Save Apify Dataset",
    description:
      "Stream an Apify dataset to a local JSON file. Use this after scrape_apify or scrape_status returns a dataset ID. The data is written directly to disk — it never enters your context window. Then read the file with normal file tools.",
    promptSnippet:
      "Save an Apify dataset to a local file. Use after scrape_apify returns a datasetId.",
    parameters: Type.Object({
      dataset_id: Type.String({
        description: "Apify dataset ID (returned by scrape_apify or scrape_status)",
      }),
      output_path: Type.String({
        description: "Local file path to write JSON results (e.g. /artifacts/run-1/instagram.json)",
      }),
      max_results: Type.Optional(
        Type.Number({
          description: "Max items to save (default 100)",
        })
      ),
      format: Type.Optional(
        Type.Union(
          [Type.Literal("json"), Type.Literal("jsonl")],
          { description: "Output format: json (array, default) or jsonl (one JSON object per line)" }
        )
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        if (!apifyToken) {
          return {
            content: [
              {
                type: "text" as const,
                text: "APIFY_API_TOKEN is not set.",
              },
            ],
            details: { error: "missing_token", tier: "apify" },
          };
        }

        const limit = params.max_results ?? 100;
        const fmt = params.format ?? "json";
        const { writeFileSync, mkdirSync } = require("node:fs");
        const { dirname } = require("node:path");

        mkdirSync(dirname(params.output_path), { recursive: true });

        const res = await fetch(
          `https://api.apify.com/v2/datasets/${params.dataset_id}/items?token=${apifyToken}&limit=${limit}`,
        );

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to fetch dataset (${res.status}): ${errText}`,
              },
            ],
            details: {
              datasetId: params.dataset_id,
              error: `HTTP ${res.status}`,
              tier: "apify",
            },
          };
        }

        const items = (await res.json()) as Record<string, unknown>[];

        let content: string;
        if (fmt === "jsonl") {
          content = items.map((item) => JSON.stringify(item)).join("\n") + "\n";
        } else {
          content = JSON.stringify(items, null, 2);
        }

        writeFileSync(params.output_path, content, "utf-8");

        const bytes = Buffer.byteLength(content, "utf-8");

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `Dataset saved to ${params.output_path}`,
                `Items: ${items.length}, Size: ${bytes} bytes, Format: ${fmt}`,
                `Read the file to inspect the data.`,
              ].join("\n"),
            },
          ],
          details: {
            datasetId: params.dataset_id,
            outputPath: params.output_path,
            itemCount: items.length,
            bytes,
            format: fmt,
            tier: "apify",
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to save dataset: ${msg}`,
            },
          ],
          details: {
            datasetId: params.dataset_id,
            error: msg,
            tier: "apify",
          },
        };
      }
    },
  });

  // ---- scrape_status: check Apify run status ----

  pi.registerTool({
    name: "scrape_status",
    label: "Apify Run Status",
    description:
      "Check the status of an Apify actor run and retrieve results if completed. Use after scrape_apify returns a run ID for a long-running job.",
    promptSnippet: "Check status of an Apify run and get results if ready.",
    parameters: Type.Object({
      job_id: Type.String({ description: "Apify run ID" }),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        if (!apifyToken) {
          return {
            content: [
              {
                type: "text" as const,
                text: "APIFY_API_TOKEN is not set. Export it as an environment variable to use Apify tools.",
              },
            ],
            details: { error: "missing_token", tier: "apify" },
          };
        }

        const statusRes = await fetch(
          `https://api.apify.com/v2/actor-runs/${params.job_id}?token=${apifyToken}`,
          { signal }
        );

        if (!statusRes.ok) {
          const errText = await statusRes.text().catch(() => "");
          return {
            content: [
              {
                type: "text" as const,
                text: `Failed to check run status (${statusRes.status}): ${errText}`,
              },
            ],
            details: {
              jobId: params.job_id,
              error: `HTTP ${statusRes.status}`,
              tier: "apify",
            },
          };
        }

        const runData = (await statusRes.json()) as {
          data: {
            id: string;
            status: string;
            defaultDatasetId: string;
            startedAt?: string;
            finishedAt?: string;
          };
        };

        const run = runData.data;
        const lines: string[] = [];
        lines.push("## Apify Run Status\n");
        lines.push(`**Run ID:** ${run.id}`);
        lines.push(`**Status:** ${run.status}`);
        if (run.startedAt) lines.push(`**Started:** ${run.startedAt}`);
        if (run.finishedAt) lines.push(`**Finished:** ${run.finishedAt}`);

        if (run.status === "SUCCEEDED" && run.defaultDatasetId) {
          const countRes = await fetch(
            `https://api.apify.com/v2/datasets/${run.defaultDatasetId}?token=${apifyToken}`,
            { signal }
          );
          let itemCount = 0;
          if (countRes.ok) {
            const countData = (await countRes.json()) as {
              data: { itemCount?: number };
            };
            itemCount = countData.data.itemCount ?? 0;
          }

          lines.push(`**Dataset ID:** ${run.defaultDatasetId}`);
          lines.push(`**Items available:** ${itemCount}\n`);
          lines.push(
            "Use `apify_save_dataset` to stream results to a local file, then read the file."
          );

          return {
            content: [{ type: "text" as const, text: lines.join("\n") }],
            details: {
              jobId: params.job_id,
              status: run.status,
              datasetId: run.defaultDatasetId,
              itemCount,
              tier: "apify",
            },
          };
        }

        if (
          run.status !== "SUCCEEDED" &&
          run.status !== "FAILED" &&
          run.status !== "ABORTED" &&
          run.status !== "TIMED-OUT"
        ) {
          lines.push(
            "\nThe run is still in progress. Check again later."
          );
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: {
            jobId: params.job_id,
            status: run.status,
            tier: "apify",
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: `Apify status check failed: ${msg}`,
            },
          ],
          details: { jobId: params.job_id, error: msg, tier: "apify" },
        };
      }
    },
  });
}
