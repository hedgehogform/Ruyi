import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { toolLogger } from "../logger";
import { Memory, Conversation } from "../db/models";

// Tool definitions
export const memoryStoreDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "memory_store",
    description:
      "Store information to remember for later. Use this when a user asks you to remember something, save a note, or store information. Memories persist across conversations and bot restarts. You can store global memories (accessible by everyone) or user-specific memories.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["save", "get", "delete", "list"],
          description:
            "The action to perform: 'save' to store a memory, 'get' to retrieve a specific memory, 'delete' to remove a memory, 'list' to show all memories",
        },
        key: {
          type: ["string", "null"],
          description:
            "A short identifier/name for the memory (e.g., 'favorite_color', 'birthday', 'project_deadline'). Required for save, get, delete.",
        },
        value: {
          type: ["string", "null"],
          description: "The information to remember. Required for save action.",
        },
        scope: {
          type: "string",
          enum: ["global", "user"],
          description:
            "Where to store the memory: 'global' for server-wide memories anyone can access, 'user' for memories specific to the current user. Defaults to 'user'.",
        },
        username: {
          type: ["string", "null"],
          description:
            "The username for user-scoped memories. Will be provided automatically.",
        },
      },
      required: ["action", "key", "value", "scope", "username"],
      additionalProperties: false,
    },
  },
};

export const memoryRecallDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "memory_recall",
    description:
      "Recall all stored memories for context. Use this at the start of conversations or when you need to remember what you know about a user or topic. Returns a summary of all relevant memories.",
    parameters: {
      type: "object",
      properties: {
        username: {
          type: ["string", "null"],
          description: "The username to recall memories for.",
        },
        include_global: {
          type: "boolean",
          description: "Whether to include global memories. Defaults to true.",
        },
      },
      required: ["username", "include_global"],
      additionalProperties: false,
    },
  },
};

export const searchMemoryDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_memory",
    description:
      "Search through stored memories by keyword. Use this to find specific information you've remembered about users or topics.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to find in memory keys and values.",
        },
        username: {
          type: ["string", "null"],
          description: "Filter by specific username, or null to search all.",
        },
        scope: {
          type: ["string", "null"],
          description: "Filter by scope: 'global', 'user', or null for both.",
        },
      },
      required: ["query", "username", "scope"],
      additionalProperties: false,
    },
  },
};

export const searchConversationDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_conversation",
    description:
      "Search through past conversation history stored in the database. Use this to recall what was discussed previously, find specific topics, or remember context from past interactions.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to find in conversation messages.",
        },
        author: {
          type: ["string", "null"],
          description: "Filter by message author (username), or null for all.",
        },
        channel_id: {
          type: ["string", "null"],
          description: "Filter by specific channel ID, or null for all channels.",
        },
        limit: {
          type: ["number", "null"],
          description: "Maximum number of results to return. Default 20, max 50.",
        },
      },
      required: ["query", "author", "channel_id", "limit"],
      additionalProperties: false,
    },
  },
};

// Truncate value if too long
function truncateValue(value: string, maxLength = 500): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 3) + "...";
}

// Individual action handlers
async function handleSave(
  key: string,
  value: string,
  scope: "global" | "user",
  username: string | null
): Promise<string> {
  const truncatedValue = truncateValue(value);

  if (scope === "user" && !username) {
    return JSON.stringify({ error: "Username required for user-scoped memories" });
  }

  // Enforce limits: 50 global, 30 per user
  const limit = scope === "global" ? 50 : 30;
  const query = scope === "global" ? { scope: "global" } : { scope: "user", username };
  const count = await Memory.countDocuments(query);

  if (count >= limit) {
    // Delete oldest memory to make room
    const oldest = await Memory.findOne(query).sort({ updatedAt: 1 });
    if (oldest) await oldest.deleteOne();
  }

  await Memory.updateOne(
    { key, scope, username: scope === "global" ? null : username },
    {
      key,
      value: truncatedValue,
      scope,
      username: scope === "global" ? null : username,
      createdBy: username ?? "unknown",
    },
    { upsert: true }
  );

  return JSON.stringify({
    success: true,
    message: `Remembered "${key}" for ${scope === "global" ? "everyone" : username}`,
  });
}

async function handleGet(
  key: string,
  scope: "global" | "user",
  username: string | null
): Promise<string> {
  const query = scope === "global" ? { key, scope: "global" } : { key, scope: "user", username };
  const item = await Memory.findOne(query);

  if (!item) {
    return JSON.stringify({ found: false, message: `No memory found for "${key}"` });
  }

  return JSON.stringify({
    found: true,
    key: item.key,
    value: item.value,
    createdBy: item.createdBy,
    createdAt: item.createdAt,
  });
}

async function handleDelete(
  key: string,
  scope: "global" | "user",
  username: string | null
): Promise<string> {
  const query = scope === "global" ? { key, scope: "global" } : { key, scope: "user", username };
  const result = await Memory.deleteOne(query);

  if (result.deletedCount > 0) {
    return JSON.stringify({ success: true, message: `Forgot "${key}"` });
  }
  return JSON.stringify({ success: false, message: `No memory found for "${key}"` });
}

async function handleList(username: string | null): Promise<string> {
  const memories: { scope: string; key: string; value: string; createdBy: string }[] = [];

  // Get global memories
  const globalMemories = await Memory.find({ scope: "global" });
  for (const m of globalMemories) {
    memories.push({ scope: "global", key: m.key, value: m.value, createdBy: m.createdBy });
  }

  // Get user memories
  if (username) {
    const userMemories = await Memory.find({ scope: "user", username });
    for (const m of userMemories) {
      memories.push({ scope: "user", key: m.key, value: m.value, createdBy: m.createdBy });
    }
  }

  return JSON.stringify({ count: memories.length, memories });
}

// Memory store operations
export async function memoryStoreOperation(
  action: "save" | "get" | "delete" | "list",
  key: string | null,
  value: string | null,
  scope: "global" | "user",
  username: string | null
): Promise<string> {
  toolLogger.info({ action, key, scope, username }, "Memory store operation");

  try {
    switch (action) {
      case "save":
        if (!key || !value) {
          return JSON.stringify({ error: "Key and value are required for save" });
        }
        return await handleSave(key, value, scope, username);

      case "get":
        if (!key) {
          return JSON.stringify({ error: "Key is required for get" });
        }
        return await handleGet(key, scope, username);

      case "delete":
        if (!key) {
          return JSON.stringify({ error: "Key is required for delete" });
        }
        return await handleDelete(key, scope, username);

      case "list":
        return await handleList(username);

      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    toolLogger.error({ error: errorMessage }, "Memory store operation failed");
    return JSON.stringify({ error: errorMessage });
  }
}

interface MemoryItem {
  key: string;
  value: string;
}

interface CollectResult {
  lines: string[];
  totalLength: number;
}

// Collect memories into formatted lines with length limit
function collectMemories(
  items: MemoryItem[],
  header: string,
  currentLength: number,
  maxLength: number,
): CollectResult {
  const lines: string[] = [];
  let totalLength = currentLength;

  if (items.length === 0) {
    return { lines, totalLength };
  }

  lines.push(header);
  for (const m of items) {
    const line = `• ${m.key}: ${m.value}`;
    if (totalLength + line.length > maxLength) {
      lines.push("... (truncated)");
      break;
    }
    lines.push(line);
    totalLength += line.length;
  }

  return { lines, totalLength };
}

export async function memoryRecall(
  username: string | null,
  includeGlobal = true,
): Promise<string> {
  toolLogger.info({ username, includeGlobal }, "Recalling memories");

  const maxTotalLength = 2000;
  const allLines: string[] = [];
  let currentLength = 0;

  if (includeGlobal) {
    const globalMemories = await Memory.find({ scope: "global" });
    const result = collectMemories(globalMemories, "=== Global Memories ===", currentLength, maxTotalLength);
    allLines.push(...result.lines);
    currentLength = result.totalLength;
  }

  if (username) {
    const userMemories = await Memory.find({ scope: "user", username });
    const result = collectMemories(userMemories, `=== Memories about ${username} ===`, currentLength, maxTotalLength);
    allLines.push(...result.lines);
  }

  if (allLines.length === 0) {
    return JSON.stringify({ hasMemories: false, message: "No memories stored yet." });
  }

  return JSON.stringify({ hasMemories: true, summary: allLines.join("\n") });
}

// Search memories by keyword
export async function searchMemory(
  query: string,
  username: string | null,
  scope: "global" | "user" | null,
): Promise<string> {
  toolLogger.info({ query, username, scope }, "Searching memories");

  try {
    const regex = new RegExp(query, "i");
    const filter: Record<string, unknown> = {
      $or: [{ key: regex }, { value: regex }],
    };

    if (scope) filter.scope = scope;
    if (username) filter.username = username;

    const results = await Memory.find(filter).limit(20).sort({ updatedAt: -1 });

    if (results.length === 0) {
      return JSON.stringify({ found: false, message: `No memories found matching "${query}"` });
    }

    const memories = results.map((m) => ({
      key: m.key,
      value: m.value,
      scope: m.scope,
      username: m.username,
      createdBy: m.createdBy,
    }));

    return JSON.stringify({ found: true, count: memories.length, memories });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    toolLogger.error({ error: errorMessage }, "Memory search failed");
    return JSON.stringify({ error: errorMessage });
  }
}

interface ConversationMatch {
  channelId: string;
  author: string;
  content: string;
  isBot: boolean;
  timestamp: Date;
}

// Check if a message matches search criteria
function messageMatchesCriteria(
  content: string,
  msgAuthor: string,
  queryRegex: RegExp,
  authorFilter: string | null,
): boolean {
  const contentMatches = queryRegex.test(content);
  const authorMatches = !authorFilter || new RegExp(authorFilter, "i").test(msgAuthor);
  return contentMatches && authorMatches;
}

// Truncate content if too long
function truncateContent(content: string, maxLen = 200): string {
  return content.length > maxLen ? content.slice(0, maxLen - 3) + "..." : content;
}

// Extract matching messages from conversations
function extractMatchingMessages(
  conversations: Array<{ channelId: string; messages: Array<{ author: string; content: string; isBot: boolean; timestamp: Date }> }>,
  queryRegex: RegExp,
  authorFilter: string | null,
): ConversationMatch[] {
  const matches: ConversationMatch[] = [];

  for (const conv of conversations) {
    for (const msg of conv.messages) {
      if (messageMatchesCriteria(msg.content, msg.author, queryRegex, authorFilter)) {
        matches.push({
          channelId: conv.channelId,
          author: msg.author,
          content: truncateContent(msg.content),
          isBot: msg.isBot,
          timestamp: msg.timestamp,
        });
      }
    }
  }

  return matches;
}

// Search conversation history
export async function searchConversation(
  query: string,
  author: string | null,
  channelId: string | null,
  limit: number | null,
): Promise<string> {
  toolLogger.info({ query, author, channelId, limit }, "Searching conversations");

  try {
    const maxLimit = Math.min(limit ?? 20, 50);
    const regex = new RegExp(query, "i");

    const filter: Record<string, unknown> = {};
    if (channelId) filter.channelId = channelId;

    const conversations = await Conversation.find(filter).lean();
    const matchingMessages = extractMatchingMessages(conversations, regex, author);

    // Sort by timestamp descending and limit
    matchingMessages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const results = matchingMessages.slice(0, maxLimit);

    if (results.length === 0) {
      return JSON.stringify({ found: false, message: `No conversation history found matching "${query}"` });
    }

    return JSON.stringify({ found: true, count: results.length, messages: results });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    toolLogger.error({ error: errorMessage }, "Conversation search failed");
    return JSON.stringify({ error: errorMessage });
  }
}
