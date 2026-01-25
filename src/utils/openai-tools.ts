import { z, type ZodType } from "zod";

// Base tool definition interface - uses generic for type safety
export interface ToolDefinition<T = unknown> {
  name: string;
  description: string;
  inputSchema: ZodType<T>;
  execute: (input: T) => Promise<unknown>;
}

// Runtime tool interface - looser typing for collections of mixed tools
export interface RuntimeTool {
  name: string;
  description: string;
  inputSchema: ZodType;
  execute: (input: unknown) => Promise<unknown>;
}

// OpenAI function tool format
export interface OpenAIFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

// Helper to create a tool (similar to OpenRouter's tool() helper)
export function tool<T>(definition: ToolDefinition<T>): RuntimeTool {
  return definition as RuntimeTool;
}

// Convert our tool definitions to OpenAI function calling format
// Uses Zod v4's native toJSONSchema
export function toOpenAITools(
  tools: readonly RuntimeTool[],
): OpenAIFunctionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: z.toJSONSchema(t.inputSchema) as Record<string, unknown>,
      strict: false,
    },
  }));
}

// Find and execute a tool by name
export async function executeTool(
  tools: readonly RuntimeTool[],
  name: string,
  argsJson: string,
): Promise<string> {
  const foundTool = tools.find((t) => t.name === name);
  if (!foundTool) {
    return JSON.stringify({ error: `Tool "${name}" not found` });
  }

  try {
    const args: unknown = JSON.parse(argsJson);
    const validatedArgs = foundTool.inputSchema.parse(args);
    const result = await foundTool.execute(validatedArgs);
    return JSON.stringify(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return JSON.stringify({ error: message });
  }
}
