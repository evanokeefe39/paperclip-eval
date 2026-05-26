declare module "@mariozechner/pi-coding-agent" {
  import type { TObject, TSchema } from "typebox";

  interface ToolRegistration {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    parameters: TSchema;
    execute(
      toolCallId: string,
      params: any,
      signal?: AbortSignal
    ): Promise<any>;
  }

  interface ExtensionAPI {
    registerTool(tool: ToolRegistration): void;
  }
}
