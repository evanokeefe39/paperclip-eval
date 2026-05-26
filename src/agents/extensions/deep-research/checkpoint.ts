import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import type { SubQuery, SubQuerySummary, ReflectDecision } from "./types.js";

const CHECKPOINT_PATH = "/workspace/.research-checkpoint.json";

export interface SubQueryCheckpoint {
  id: string;
  query: string;
  rationale: string;
  iteration: number;
  status: "pending" | "running" | "complete" | "failed";
  summary?: SubQuerySummary;
  error?: string;
}

export interface SessionCheckpoint {
  session_id: string;
  query: string;
  status: "running" | "reflecting" | "complete" | "failed";
  iteration: number;
  sub_queries: SubQueryCheckpoint[];
  reflections: ReflectDecision[];
  created_at: string;
  updated_at: string;
}

interface CheckpointFile {
  sessions: Record<string, SessionCheckpoint>;
}

export class Checkpoint {
  private data: CheckpointFile;

  constructor() {
    if (existsSync(CHECKPOINT_PATH)) {
      this.data = JSON.parse(readFileSync(CHECKPOINT_PATH, "utf-8"));
    } else {
      this.data = { sessions: {} };
    }
  }

  private save(): void {
    const tmp = CHECKPOINT_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, CHECKPOINT_PATH);
  }

  findResumable(query: string): SessionCheckpoint | null {
    const sessions = Object.values(this.data.sessions)
      .filter(s => s.query === query && (s.status === "running" || s.status === "reflecting"))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return sessions[0] || null;
  }

  createSession(sessionId: string, query: string): void {
    this.data.sessions[sessionId] = {
      session_id: sessionId,
      query,
      status: "running",
      iteration: 0,
      sub_queries: [],
      reflections: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.save();
  }

  addSubQueries(sessionId: string, subQueries: SubQuery[], iteration: number): void {
    const session = this.data.sessions[sessionId];
    if (!session) return;
    for (const sq of subQueries) {
      if (session.sub_queries.some(existing => existing.id === sq.id)) continue;
      session.sub_queries.push({
        id: sq.id,
        query: sq.query,
        rationale: sq.rationale,
        iteration,
        status: "pending",
      });
    }
    session.updated_at = new Date().toISOString();
    this.save();
  }

  markSweepStarted(subQueryId: string, sessionId: string): void {
    const sq = this.data.sessions[sessionId]?.sub_queries.find(s => s.id === subQueryId);
    if (sq) {
      sq.status = "running";
      this.data.sessions[sessionId].updated_at = new Date().toISOString();
      this.save();
    }
  }

  markSweepComplete(subQueryId: string, sessionId: string, summary: SubQuerySummary): void {
    const sq = this.data.sessions[sessionId]?.sub_queries.find(s => s.id === subQueryId);
    if (sq) {
      sq.status = "complete";
      sq.summary = summary;
      this.data.sessions[sessionId].updated_at = new Date().toISOString();
      this.save();
    }
  }

  markSweepFailed(subQueryId: string, sessionId: string, error: string): void {
    const sq = this.data.sessions[sessionId]?.sub_queries.find(s => s.id === subQueryId);
    if (sq) {
      sq.status = "failed";
      sq.error = error;
      this.data.sessions[sessionId].updated_at = new Date().toISOString();
      this.save();
    }
  }

  addReflection(sessionId: string, iteration: number, decision: ReflectDecision): void {
    const session = this.data.sessions[sessionId];
    if (!session) return;
    session.reflections.push(decision);
    session.iteration = iteration;
    session.status = "reflecting";
    session.updated_at = new Date().toISOString();
    this.save();
  }

  markComplete(sessionId: string): void {
    const session = this.data.sessions[sessionId];
    if (session) {
      session.status = "complete";
      session.updated_at = new Date().toISOString();
      this.save();
    }
  }

  cleanup(): void {
    const entries = Object.entries(this.data.sessions)
      .sort(([, a], [, b]) => b.updated_at.localeCompare(a.updated_at));
    if (entries.length > 20) {
      this.data.sessions = Object.fromEntries(entries.slice(0, 20));
      this.save();
    }
  }
}
