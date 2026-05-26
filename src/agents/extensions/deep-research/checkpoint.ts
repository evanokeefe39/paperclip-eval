import { existsSync, readFileSync } from "node:fs";
import { writeFile, rename } from "node:fs/promises";
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

  private async save(): Promise<void> {
    const tmp = CHECKPOINT_PATH + ".tmp";
    await writeFile(tmp, JSON.stringify(this.data, null, 2));
    await rename(tmp, CHECKPOINT_PATH);
  }

  findResumable(query: string): SessionCheckpoint | null {
    const sessions = Object.values(this.data.sessions)
      .filter(s => s.query === query && (s.status === "running" || s.status === "reflecting"))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return sessions[0] || null;
  }

  async createSession(sessionId: string, query: string): Promise<void> {
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
    await this.save();
  }

  async addSubQueries(sessionId: string, subQueries: SubQuery[], iteration: number): Promise<void> {
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
    await this.save();
  }

  async markSweepStarted(subQueryId: string, sessionId: string): Promise<void> {
    const sq = this.data.sessions[sessionId]?.sub_queries.find(s => s.id === subQueryId);
    if (sq) {
      sq.status = "running";
      this.data.sessions[sessionId].updated_at = new Date().toISOString();
      await this.save();
    }
  }

  async markSweepComplete(subQueryId: string, sessionId: string, summary: SubQuerySummary): Promise<void> {
    const sq = this.data.sessions[sessionId]?.sub_queries.find(s => s.id === subQueryId);
    if (sq) {
      sq.status = "complete";
      sq.summary = summary;
      this.data.sessions[sessionId].updated_at = new Date().toISOString();
      await this.save();
    }
  }

  async markSweepFailed(subQueryId: string, sessionId: string, error: string): Promise<void> {
    const sq = this.data.sessions[sessionId]?.sub_queries.find(s => s.id === subQueryId);
    if (sq) {
      sq.status = "failed";
      sq.error = error;
      this.data.sessions[sessionId].updated_at = new Date().toISOString();
      await this.save();
    }
  }

  async addReflection(sessionId: string, iteration: number, decision: ReflectDecision): Promise<void> {
    const session = this.data.sessions[sessionId];
    if (!session) return;
    session.reflections.push(decision);
    session.iteration = iteration;
    session.status = "reflecting";
    session.updated_at = new Date().toISOString();
    await this.save();
  }

  async markComplete(sessionId: string): Promise<void> {
    const session = this.data.sessions[sessionId];
    if (session) {
      session.status = "complete";
      session.updated_at = new Date().toISOString();
      await this.save();
    }
  }

  async cleanup(): Promise<void> {
    const entries = Object.entries(this.data.sessions)
      .sort(([, a], [, b]) => b.updated_at.localeCompare(a.updated_at));
    if (entries.length > 20) {
      this.data.sessions = Object.fromEntries(entries.slice(0, 20));
      await this.save();
    }
  }
}
