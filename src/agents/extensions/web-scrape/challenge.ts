import type { ChallengeResult } from "./types.js";

export function detectChallenge(html: string): ChallengeResult {
  const lower = html.toLowerCase();

  if (
    lower.includes("<title>just a moment...</title>") ||
    lower.includes("cf-browser-verification") ||
    lower.includes("cf-challenge-running") ||
    lower.includes("cloudflare") && lower.includes("ray id")
  ) {
    return {
      isChallenge: true,
      vendor: "cloudflare",
      signature: "Cloudflare browser verification / challenge page",
    };
  }

  if (
    lower.includes("<title>datadome</title>") ||
    lower.includes("dd.js") ||
    lower.includes("window._ddc") ||
    lower.includes("geo.captcha-delivery.com")
  ) {
    return {
      isChallenge: true,
      vendor: "datadome",
      signature: "DataDome captcha / challenge",
    };
  }

  if (
    lower.includes("_px") && lower.includes("captcha") ||
    lower.includes("captcha.px-cdn.net") ||
    lower.includes("perimeterx")
  ) {
    return {
      isChallenge: true,
      vendor: "perimeterx",
      signature: "PerimeterX bot detection",
    };
  }

  if (
    lower.includes("aws-waf-token") ||
    lower.includes("awswaf") ||
    (lower.includes("captcha") && lower.includes("aws"))
  ) {
    return {
      isChallenge: true,
      vendor: "aws_waf",
      signature: "AWS WAF challenge",
    };
  }

  const challengeSignals = [
    "verify you are human",
    "checking your browser",
    "please complete the security check",
    "access denied",
    "enable javascript and cookies",
  ];
  for (const sig of challengeSignals) {
    if (lower.includes(sig)) {
      return {
        isChallenge: true,
        vendor: "unknown",
        signature: sig,
      };
    }
  }

  return { isChallenge: false };
}
