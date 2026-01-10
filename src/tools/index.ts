import type { ChatCompletionTool } from "openai/resources/chat/completions";

// Re-export context management
export { setToolContext } from "./types";

// Import tool definitions and implementations
import { searchMessagesDefinition, searchMessages } from "./searchMessages";
import { channelInfoDefinition, getChannelInfo } from "./channelInfo";
import { serverInfoDefinition, getServerInfo } from "./serverInfo";
import { userInfoDefinition, getUserInfo } from "./userInfo";
import { manageRoleDefinition, manageRole } from "./manageRole";
import { fetchDefinition, getFetchData } from "./fetch";
import { calculatorDefinition, calculate } from "./calculator";
import {
  memoryStoreDefinition,
  memoryRecallDefinition,
  memoryStoreOperation,
  memoryRecall,
} from "./memory";

// Collect all tool definitions
export const toolDefinitions: ChatCompletionTool[] = [
  searchMessagesDefinition,
  channelInfoDefinition,
  serverInfoDefinition,
  userInfoDefinition,
  manageRoleDefinition,
  fetchDefinition,
  calculatorDefinition,
  memoryStoreDefinition,
  memoryRecallDefinition,
];

// Execute a tool by name
export async function executeTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  switch (name) {
    case "search_messages":
      return await searchMessages(
        args.query as string,
        (args.limit as number) || 50
      );
    case "get_channel_info":
      return getChannelInfo();
    case "get_server_info":
      return await getServerInfo();
    case "get_user_info":
      return await getUserInfo(args.username as string);
    case "manage_role":
      return await manageRole(
        args.action as "create" | "edit" | "assign" | "remove",
        args.role_name as string,
        args.new_name as string | undefined,
        args.color as string | undefined,
        args.username as string | undefined
      );
    case "fetch":
      return await getFetchData(args.urls as string[], args.priority as number);
    case "calculator":
      return calculate(args.expression as string);
    case "memory_store":
      return memoryStoreOperation(
        args.action as "save" | "get" | "delete" | "list",
        args.key as string | null,
        args.value as string | null,
        (args.scope as "global" | "user") || "user",
        args.username as string | null
      );
    case "memory_recall":
      return memoryRecall(
        args.username as string | null,
        args.include_global !== false
      );
    default:
      return JSON.stringify({ error: "Unknown tool: " + name });
  }
}
