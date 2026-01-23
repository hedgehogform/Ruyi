// Re-export context management
export { setToolContext } from "../utils/types";

// Re-export all tools
export { calculatorTool } from "./calc";
export { channelInfoTool } from "./channel";
export { serverInfoTool } from "./server";
export { userInfoTool } from "./user";
export { manageRoleTool } from "./role";
export { reactionTool } from "./reaction";
export { pinTool } from "./pin";
export { searchMessagesTool, deleteMessagesTool } from "./message";
export { embedTool } from "./embed";
export { generateImageTool } from "./image";
export { fetchTool } from "./web";
export { memoryStoreTool, memoryRecallTool, searchMemoryTool, searchConversationTool } from "./memory";
export { auditLogTool } from "./audit";
export { lastfmTool } from "./lastfm";

// Import for array export
import { calculatorTool } from "./calc";
import { channelInfoTool } from "./channel";
import { serverInfoTool } from "./server";
import { userInfoTool } from "./user";
import { manageRoleTool } from "./role";
import { reactionTool } from "./reaction";
import { pinTool } from "./pin";
import { searchMessagesTool, deleteMessagesTool } from "./message";
import { embedTool } from "./embed";
import { generateImageTool } from "./image";
import { fetchTool } from "./web";
import { memoryStoreTool, memoryRecallTool, searchMemoryTool, searchConversationTool } from "./memory";
import { auditLogTool } from "./audit";
import { lastfmTool } from "./lastfm";

// Export all tools as an array for use with OpenRouter SDK
export const allTools = [
  calculatorTool,
  channelInfoTool,
  serverInfoTool,
  userInfoTool,
  manageRoleTool,
  reactionTool,
  pinTool,
  searchMessagesTool,
  deleteMessagesTool,
  embedTool,
  generateImageTool,
  fetchTool,
  memoryStoreTool,
  memoryRecallTool,
  searchMemoryTool,
  searchConversationTool,
  auditLogTool,
  lastfmTool,
] as const;
