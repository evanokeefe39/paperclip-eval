import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import registerLint from "./lint.ts";
import registerProfile from "./profile.ts";

export default function (pi: ExtensionAPI) {
  registerLint(pi);
  registerProfile(pi);
}
