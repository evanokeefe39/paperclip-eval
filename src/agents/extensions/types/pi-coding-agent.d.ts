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

  interface ToolCallEvent {
    toolName: string;
    toolCallId: string;
    input: Record<string, unknown>;
  }

  interface ExtensionContext {
    ui: { confirm(title: string, message: string): Promise<boolean> };
  }

  type ToolCallHandler = (
    event: ToolCallEvent,
    ctx: ExtensionContext
  ) => Promise<{ block: true; reason?: string } | undefined | void>;

  interface ExtensionAPI {
    registerTool(tool: ToolRegistration): void;
    on(event: "tool_call", handler: ToolCallHandler): void;
    on(event: string, handler: (...args: any[]) => any): void;
  }
}
