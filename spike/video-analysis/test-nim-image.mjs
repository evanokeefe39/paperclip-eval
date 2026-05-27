import { readFileSync, writeFileSync } from "fs";

const API_KEY = process.env.NVIDIA_NIM_API_KEY;
const BASE_URL = "https://integrate.api.nvidia.com/v1";

// Download a known good JPEG
const imgUrl = "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png";
const imgRes = await fetch(imgUrl);
const imgBuf = Buffer.from(await imgRes.arrayBuffer());
const mime = imgRes.headers.get("content-type") || "image/png";
const b64 = imgBuf.toString("base64");
console.log(`Image: ${(imgBuf.length / 1024).toFixed(0)}KB, mime: ${mime}, b64 len: ${b64.length}`);

// Verify it's actually an image
const header = imgBuf.slice(0, 4).toString("hex");
console.log(`File header: ${header} (PNG=89504e47, JPEG=ffd8ffe0)`);

// Try both models
for (const model of [
  "nvidia/nemotron-nano-12b-v2-vl",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning",
]) {
  console.log(`\n--- ${model} ---`);
  const body = {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:${mime};base64,${b64}` },
          },
          { type: "text", text: "What do you see?" },
        ],
      },
    ],
    max_tokens: 256,
    temperature: 0.2,
  };

  const start = Date.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  if (!res.ok) {
    const err = await res.text();
    console.log(`ERROR ${res.status} (${elapsed}s): ${err.slice(0, 200)}`);
  } else {
    const data = await res.json();
    console.log(`OK (${elapsed}s): ${data.choices?.[0]?.message?.content?.slice(0, 200)}`);
    console.log(`Usage: ${JSON.stringify(data.usage)}`);
  }
}
