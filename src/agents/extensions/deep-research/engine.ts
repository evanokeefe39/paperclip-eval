import { randomUUID } from "node:crypto";
import type {
  SubQuery,
  EngineState,
  ReflectDecision,
  ResearchResult,
} from "./types.js";
import type { Config } from "./config.js";
import { buildLLMConfig, structuredCall } from "./llm.js";
import { PLAN_PROMPT, REFLECT_PROMPT } from "./prompts.js";
import { initSession, writeSessionMeta, buildSessionSummary } from "./store.js";
import { Checkpoint } from "./checkpoint.js";
import { executeSweep } from "./sweep.js";
import { LRUCache } from "./cache.js";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface PlanResponse {
  sub_queries: { query: string; rationale: string }[];
}

async function planSubQueries(
  query: string,
  config: Config,
  signal?: AbortSignal,
): Promise<SubQuery[]> {
  const llmConfig = buildLLMConfig(config);
  const result = await structuredCall<PlanResponse>(
    llmConfig,
    PLAN_PROMPT,
    query,
    signal,
  );

  return (result.sub_queries || [])
    .slice(0, config.max_sub_queries)
    .map(sq => ({
      id: randomUUID(),
      query: sq.query,
      rationale: sq.rationale,
    }));
}

async function reflect(
  query: string,
  summaries: string[],
  iteration: number,
  config: Config,
  signal?: AbortSignal,
): Promise<ReflectDecision> {
  const llmConfig = buildLLMConfig(config);
  const userContent = [
    `Original query: ${query}`,
    `Iteration: ${iteration + 1}/${config.max_iterations}`,
    "",
    "Sweep summaries:",
    ...summaries.map((s, i) => `${i + 1}. ${s}`),
  ].join("\n");

  const result = await structuredCall<ReflectDecision>(
    llmConfig,
    REFLECT_PROMPT,
    userContent,
    signal,
  );

  const newSubQueries = (result.new_sub_queries || []).map(sq => ({
    id: randomUUID(),
    query: sq.query,
    rationale: sq.rationale,
  }));

  return {
    continue: result.continue ?? false,
    reason: result.reason || "",
    new_sub_queries: newSubQueries,
  };
}

async function deepResearch(
  query: string,
  config: Config,
  signal?: AbortSignal,
): Promise<ResearchResult> {
  const checkpoint = new Checkpoint();
  const existing = checkpoint.findResumable(query);

  let sessionId: string;
  let allSubQueries: SubQuery[];
  let startIteration: number;
  const state: EngineState = {
    sweepResults: new Map(),
    allFindings: [],
    searchCache: new LRUCache(),
    fetchCache: new Map(),
    startedAt: new Date().toISOString(),
    iteration: 0,
  };

  if (existing) {
    sessionId = existing.session_id;
    startIteration = existing.iteration;
    allSubQueries = existing.sub_queries.map(sq => ({
      id: sq.id,
      query: sq.query,
      rationale: sq.rationale,
    }));
    state.startedAt = existing.created_at;
  } else {
    sessionId = randomUUID();
    checkpoint.createSession(sessionId, query);
    initSession(sessionId, query, config);

    allSubQueries = await planSubQueries(query, config, signal);
    checkpoint.addSubQueries(sessionId, allSubQueries, 0);
    startIteration = 0;
  }

  let iteration = startIteration;
  let pending = allSubQueries.filter(sq => {
    if (!existing) return true;
    const cp = existing.sub_queries.find(s => s.id === sq.id);
    return !cp || cp.status !== "complete";
  });

  while (iteration < config.max_iterations && pending.length > 0) {
    const results = await Promise.allSettled(
      pending.map(async sq => {
        checkpoint.markSweepStarted(sq.id, sessionId);
        try {
          const result = await executeSweep(sq, query, sessionId, config, state, signal);
          checkpoint.markSweepComplete(sq.id, sessionId, result.summary);
          return result;
        } catch (err) {
          checkpoint.markSweepFailed(sq.id, sessionId, err instanceof Error ? err.message : String(err));
          throw err;
        }
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        state.sweepResults.set(r.value.sub_query.id, r.value);
        state.allFindings.push(...r.value.findings);
      }
    }

    const summaries = [...state.sweepResults.values()].map(r => r.summary.coverage);
    const decision = await reflect(query, summaries, iteration, config, signal);
    checkpoint.addReflection(sessionId, iteration, decision);

    if (!decision.continue || decision.new_sub_queries.length === 0) break;

    checkpoint.addSubQueries(sessionId, decision.new_sub_queries, iteration + 1);
    pending = decision.new_sub_queries;
    iteration++;
    state.iteration = iteration;
  }

  checkpoint.markComplete(sessionId);
  checkpoint.cleanup();

  const summary = buildSessionSummary(query, state, sessionId, config);
  writeSessionMeta(sessionId, query, allSubQueries, config, state);

  return { sessionId, summary, findingCount: state.allFindings.length };
}

function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("econnrefused") ||
    msg.includes("fetch failed") ||
    msg.includes("socket hang up") ||
    msg.includes("503") ||
    msg.includes("429") ||
    msg.includes("network")
  );
}

const MAX_TOP_RETRIES = 2;

export async function deepResearchWithRetry(
  query: string,
  config: Config,
  signal?: AbortSignal,
): Promise<ResearchResult> {
  for (let attempt = 0; attempt <= MAX_TOP_RETRIES; attempt++) {
    try {
      return await deepResearch(query, config, signal);
    } catch (err) {
      const transient = isTransient(err);
      const retriable = attempt < MAX_TOP_RETRIES && transient;

      if (retriable) {
        await sleep(5000 * (attempt + 1));
        continue;
      }

      const checkpoint = new Checkpoint();
      const session = checkpoint.findResumable(query);
      const completedCount = session
        ? session.sub_queries.filter(sq => sq.status === "complete").length
        : 0;

      return {
        sessionId: session?.session_id || "unknown",
        summary: [
          "## Research Interrupted",
          `Error: ${err instanceof Error ? err.message : String(err)}`,
          `Completed sweeps: ${completedCount}`,
          "Partial findings saved to checkpoint.",
          transient
            ? "Transient error — resume with deep_research_resume or re-submit same query."
            : "Non-transient error — investigate before retrying.",
        ].join("\n"),
        findingCount: 0,
        interrupted: true,
      };
    }
  }
  throw new Error("unreachable");
}
