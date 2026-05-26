import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync } from "node:child_process";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "spike_python",
    label: "Spike Python",
    description:
      "Run a Python snippet via subprocess. Used to verify child_process works in Pi extensions.",
    promptSnippet: "Run Python code to verify subprocess execution works.",
    parameters: Type.Object({
      code: Type.String({ description: "Python code to execute" }),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const stdout = execFileSync("python3", ["-c", params.code], {
          encoding: "utf-8",
          timeout: 30000,
        });
        return {
          content: [{ type: "text" as const, text: stdout }],
          details: {},
        };
      } catch (err: any) {
        const message = err.stderr || err.message || String(err);
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          details: {},
        };
      }
    },
  });
}
