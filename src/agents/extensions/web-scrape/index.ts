import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { hasCheerio, hasScraplingFetcher, hasScraplingBrowser } from "./deps.js";
import { RateLimiter } from "./rate-limiter.js";
import { register as registerStatic } from "./tier-static.js";
import { register as registerStealth } from "./tier-stealth.js";
import { register as registerBrowser } from "./tier-browser.js";
import { register as registerApify } from "./tier-apify.js";
import { register as registerVideo } from "./tier-video.js";

export default function (pi: ExtensionAPI) {
  const cheerioAvailable = hasCheerio();
  const scraplingFetcherAvailable = hasScraplingFetcher();
  const scraplingBrowserAvailable = hasScraplingBrowser();

  if (cheerioAvailable) {
    registerStatic(pi);
  }

  if (scraplingFetcherAvailable && cheerioAvailable) {
    registerStealth(pi);
  }

  if (scraplingBrowserAvailable && cheerioAvailable) {
    registerBrowser(pi);
  }

  const apifyToken = process.env.APIFY_API_TOKEN || "";
  registerApify(pi, apifyToken);

  const groqApiKey = process.env.GROQ_API_KEY || "";
  const nimApiKey = process.env.NVIDIA_NIM_API_KEY || "";
  const nimLimiter = new RateLimiter(40);
  registerVideo(pi, { groqApiKey, nimApiKey, nimLimiter });
}
