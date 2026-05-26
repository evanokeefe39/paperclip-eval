export interface Config {
  llm_provider: string;
  llm_model: string;
  llm_api_key: string;
  llm_base_url: string;
  max_retries: number;
  llm_timeout_ms: number;
  max_iterations: number;
  max_sub_queries: number;
  snippet_results_per_query: number;
  heuristic_keep_ratio: number;
  top_k_for_extraction: number;
  chunk_size: number;
  chunk_overlap: number;
  max_chunks_per_page: number;
  max_findings_per_sweep: number;
  max_findings_in_summary: number;
  artifacts_base: string;
  exa_api_key: string;
}

export const PROVIDERS: Record<string, { baseUrl: string; envKey: string }> = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", envKey: "DEEPSEEK_API_KEY" },
  groq: { baseUrl: "https://api.groq.com/openai/v1", envKey: "GROQ_API_KEY" },
  cerebras: { baseUrl: "https://api.cerebras.ai/v1", envKey: "CEREBRAS_API_KEY" },
};

const provider = process.env.RESEARCH_LLM_PROVIDER || "deepseek";
const providerInfo = PROVIDERS[provider] || PROVIDERS.deepseek;

export const DEFAULT_CONFIG: Config = {
  llm_provider: provider,
  llm_model: process.env.RESEARCH_LLM_MODEL || "deepseek-chat",
  llm_api_key: process.env[providerInfo.envKey] || "",
  llm_base_url: providerInfo.baseUrl,
  max_retries: 5,
  llm_timeout_ms: 30_000,
  max_iterations: 3,
  max_sub_queries: 6,
  snippet_results_per_query: 200,
  heuristic_keep_ratio: 0.2,
  top_k_for_extraction: 8,
  chunk_size: 1500,
  chunk_overlap: 200,
  max_chunks_per_page: 10,
  max_findings_per_sweep: 30,
  max_findings_in_summary: 15,
  artifacts_base: "/artifacts/research",
  exa_api_key: process.env.EXA_API_KEY || "",
};
