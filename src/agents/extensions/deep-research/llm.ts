import type { LLMConfig } from "./types.js";
import type { Config } from "./config.js";
import { PROVIDERS } from "./config.js";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function buildLLMConfig(config: Config): LLMConfig {
  const providerInfo = PROVIDERS[config.llm_provider] || PROVIDERS.deepseek;
  return {
    provider: config.llm_provider,
    model: config.llm_model,
    apiKey: config.llm_api_key,
    baseUrl: config.llm_base_url || providerInfo.baseUrl,
    maxRetries: config.max_retries,
    timeoutMs: config.llm_timeout_ms,
  };
}

export async function structuredCall<T>(
  llmConfig: LLMConfig,
  systemPrompt: string,
  userContent: string,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; attempt < llmConfig.maxRetries; attempt++) {
    const res = await fetch(`${llmConfig.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llmConfig.apiKey}`,
      },
      body: JSON.stringify({
        model: llmConfig.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
      signal: AbortSignal.any([
        AbortSignal.timeout(llmConfig.timeoutMs),
        ...(signal ? [signal] : []),
      ]),
    });

    if (res.ok) {
      const data = await res.json();
      return JSON.parse(data.choices[0].message.content) as T;
    }

    if (res.status === 429) {
      // Exponential backoff with jitter to avoid thundering herd on rate limits
      await sleep(1000 * Math.pow(2, attempt) * (0.5 + Math.random()));
      continue;
    }

    throw new Error(`LLM API ${res.status}: ${await res.text()}`);
  }
  throw new Error(`LLM call failed after ${llmConfig.maxRetries} attempts`);
}
