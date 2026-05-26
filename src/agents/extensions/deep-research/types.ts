export interface ExaResult {
  title: string;
  url: string;
  text?: string;
  highlights?: string[];
  score: number;
}

export interface RankedSnippet extends ExaResult {
  exa_score: number;
  heuristic_score: number;
  combined_score: number;
}

export interface SubQuery {
  id: string;
  query: string;
  rationale: string;
}

export interface Entity {
  name: string;
  type: string;
  normalized?: string;
}

export interface Finding {
  id: string;
  session_id: string;
  timestamp: string;
  claim: string;
  claim_preview: string;
  confidence: number;
  source_url: string;
  source_title: string;
  verbatim_quote: string;
  full_chunk: string;
  page_snapshot_path: string;
  sub_query: string;
  sub_query_id: string;
  topic_tags: string[];
  entities: Entity[];
  related_findings: string[];
  contradicts: string[];
}

export interface IndexEntry {
  id: string;
  claim_preview: string;
  confidence: number;
  source_url: string;
  session_id: string;
  timestamp: string;
  topic_tags: string[];
  entities: Entity[];
}

export interface SessionMeta {
  session_id: string;
  query: string;
  sub_queries: SubQuery[];
  started_at: string;
  completed_at: string;
  total_findings: number;
  total_sources: number;
  iterations: number;
  config: Record<string, unknown>;
}

export interface SubQuerySummary {
  sub_query_id: string;
  query: string;
  key_claims: string[];
  coverage: string;
  gaps: string[];
  finding_count: number;
  source_count: number;
}

export interface SweepResult {
  sub_query: SubQuery;
  findings: Finding[];
  summary: SubQuerySummary;
  sources_used: { url: string; title: string }[];
}

export interface EngineState {
  sweepResults: Map<string, SweepResult>;
  allFindings: Finding[];
  searchCache: import("./cache.js").LRUCache<ExaResult[]>;
  fetchCache: Map<string, { title: string; content: string }>;
  startedAt: string;
  iteration: number;
}

export interface ReflectDecision {
  continue: boolean;
  reason: string;
  new_sub_queries: SubQuery[];
}

export interface ResearchResult {
  sessionId: string;
  summary: string;
  findingCount: number;
  interrupted?: boolean;
}

export interface FetchedPage {
  url: string;
  title: string;
  content: string;
}

export interface PageChunks {
  url: string;
  title: string;
  chunks: string[];
}

export interface LLMConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  maxRetries: number;
  timeoutMs: number;
}
