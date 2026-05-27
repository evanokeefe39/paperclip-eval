import { readFileSync, writeFileSync } from "fs";

// Read API key directly from .env file
const envFile = readFileSync("C:/Users/evano/repos/paperclip-eval/.env", "utf8");
const API_KEY = envFile.match(/NVIDIA_NIM_API_KEY=(.+)/)?.[1]?.trim();
if (!API_KEY) { console.error("No NVIDIA_NIM_API_KEY in .env"); process.exit(1); }

const MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const BASE_URL = "https://integrate.api.nvidia.com/v1";

const VIDEO_URL =
  "https://api.apify.com/v2/key-value-stores/i3u0wh6guXXuV0khk/records/video-cnn-20260525141037-7643831428689546510.mp4";

console.log(`Model: ${MODEL}`);
console.log(`Video: CNN TikTok (53s, 5.2M plays) via URL on NIM`);
console.log(`Key: ${API_KEY.slice(0, 12)}...`);
console.log("Sending...\n");

const body = {
  model: MODEL,
  messages: [
    {
      role: "user",
      content: [
        {
          type: "video_url",
          video_url: { url: VIDEO_URL },
        },
        {
          type: "text",
          text: `Return ONLY a JSON object analyzing this video: {"summary": "...", "topics": [...], "on_screen_text": [...], "tone": "...", "speakers": [{"name":"...","said":"..."}], "transcript_summary": "..."}. No markdown, no explanation.`,
        },
      ],
    },
  ],
  max_tokens: 2048,
  temperature: 0.1,
};

const start = Date.now();
const res = await fetch(`${BASE_URL}/chat/completions`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(120_000),
});

const elapsed = ((Date.now() - start) / 1000).toFixed(1);

if (!res.ok) {
  const err = await res.text();
  console.error(`ERROR ${res.status} (${elapsed}s): ${err}`);
  process.exit(1);
}

const data = await res.json();
const reply = data.choices?.[0]?.message?.content;
const usage = data.usage;

console.log(`--- Response (${elapsed}s) ---`);
console.log(reply);
console.log(`\n--- Usage ---`);
console.log(`Input tokens: ${usage?.prompt_tokens}`);
console.log(`Output tokens: ${usage?.completion_tokens}`);
console.log(`Total tokens: ${usage?.total_tokens}`);

try {
  const parsed = JSON.parse(reply);
  writeFileSync(
    "C:/Users/evano/repos/paperclip-eval/spike/video-analysis/response.json",
    JSON.stringify({ analysis: parsed, usage, elapsed_s: parseFloat(elapsed), model: MODEL }, null, 2)
  );
  console.log("\nSaved to response.json");
} catch {
  writeFileSync(
    "C:/Users/evano/repos/paperclip-eval/spike/video-analysis/response.json",
    JSON.stringify({ raw: reply, usage, elapsed_s: parseFloat(elapsed), model: MODEL }, null, 2)
  );
  console.log("\nSaved raw response to response.json (not valid JSON)");
}
