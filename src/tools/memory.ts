import { tool } from "../utils/openai-tools";
import { z } from "zod";
import { toolLogger } from "../logger";
import { Memory, Conversation } from "../db/models";
import { getToolContext } from "../utils/types";

// Get the actual Discord username from context - don't trust model's username parameter
function getContextUsername(): string | null {
  const ctx = getToolContext();
  return ctx.message?.author.username ?? null;
}

function truncateValue(value: string, maxLength = 500): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 3) + "...";
}

export const memoryStoreTool = tool({
  name: "memory_store",
  description:
    "Store information to remember for later. Use this when a user asks you to remember something, save a note, or store information. The username is automatically detected from the message context.",
  inputSchema: z.object({
    action: z
      .enum(["save", "get", "delete", "list"])
      .describe("The action to perform."),
    key: z
      .string()
      .nullable()
      .describe(
        "A short identifier/name for the memory (e.g. 'name', 'lastfm_username').",
      ),
    value: z
      .string()
      .nullable()
      .describe("The information to remember (e.g. 'Alexander', 'shadow123')."),
    scope: z
      .enum(["global", "user"])
      .describe(
        "Where to store the memory. Use 'user' for personal info about the current user.",
      ),
  }),
  execute: async ({ action, key, value, scope }) => {
    // Always get username from context - don't trust model parameter
    const username = getContextUsername();
    toolLogger.info({ action, key, scope, username }, "Memory store operation");

    try {
      switch (action) {
        case "save": {
          if (!key || !value) {
            return { error: "Key and value are required for save" };
          }
          if (scope === "user" && !username) {
            return { error: "Username required for user-scoped memories" };
          }

          const truncatedValue = truncateValue(value);
          const limit = scope === "global" ? 50 : 30;
          const query =
            scope === "global"
              ? { scope: "global" }
              : { scope: "user", username };
          const count = await Memory.countDocuments(query);

          if (count >= limit) {
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
            { upsert: true },
          );

          return {
            success: true,
            message: `Remembered "${key}" for ${scope === "global" ? "everyone" : username}`,
          };
        }

        case "get": {
          if (!key) {
            return { error: "Key is required for get" };
          }
          const query =
            scope === "global"
              ? { key, scope: "global" }
              : { key, scope: "user", username };
          const item = await Memory.findOne(query);

          if (!item) {
            return { found: false, message: `No memory found for "${key}"` };
          }

          return {
            found: true,
            key: item.key,
            value: item.value,
            createdBy: item.createdBy,
            createdAt: item.createdAt,
          };
        }

        case "delete": {
          if (!key) {
            return { error: "Key is required for delete" };
          }
          const query =
            scope === "global"
              ? { key, scope: "global" }
              : { key, scope: "user", username };
          const result = await Memory.deleteOne(query);

          if (result.deletedCount > 0) {
            return { success: true, message: `Forgot "${key}"` };
          }
          return { success: false, message: `No memory found for "${key}"` };
        }

        case "list": {
          const memories: {
            scope: string;
            key: string;
            value: string;
            createdBy: string;
          }[] = [];

          const globalMemories = await Memory.find({ scope: "global" });
          for (const m of globalMemories) {
            memories.push({
              scope: "global",
              key: m.key,
              value: m.value,
              createdBy: m.createdBy,
            });
          }

          if (username) {
            const userMemories = await Memory.find({ scope: "user", username });
            for (const m of userMemories) {
              memories.push({
                scope: "user",
                key: m.key,
                value: m.value,
                createdBy: m.createdBy,
              });
            }
          }

          return { count: memories.length, memories };
        }

        default:
          return { error: `Unknown action: ${action}` };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      toolLogger.error(
        { error: errorMessage },
        "Memory store operation failed",
      );
      return { error: errorMessage };
    }
  },
});

export const memoryRecallTool = tool({
  name: "memory_recall",
  description:
    "Recall all stored memories for the current user. Use this when you need to remember what you know about the user. Username is automatically detected.",
  inputSchema: z.object({
    include_global: z.boolean().describe("Whether to include global memories."),
  }),
  execute: async ({ include_global }) => {
    // Always get username from context
    const username = getContextUsername();
    toolLogger.info({ username, include_global }, "Recalling memories");

    const maxTotalLength = 2000;
    const allLines: string[] = [];
    let currentLength = 0;

    if (include_global) {
      const globalMemories = await Memory.find({ scope: "global" });
      if (globalMemories.length > 0) {
        allLines.push("=== Global Memories ===");
        for (const m of globalMemories) {
          const line = `• ${m.key}: ${m.value}`;
          if (currentLength + line.length > maxTotalLength) {
            allLines.push("... (truncated)");
            break;
          }
          allLines.push(line);
          currentLength += line.length;
        }
      }
    }

    if (username) {
      const userMemories = await Memory.find({ scope: "user", username });
      if (userMemories.length > 0) {
        allLines.push(`=== Memories about ${username} ===`);
        for (const m of userMemories) {
          const line = `• ${m.key}: ${m.value}`;
          if (currentLength + line.length > maxTotalLength) {
            allLines.push("... (truncated)");
            break;
          }
          allLines.push(line);
          currentLength += line.length;
        }
      }
    }

    if (allLines.length === 0) {
      return { hasMemories: false, message: "No memories stored yet." };
    }

    const result = { hasMemories: true, summary: allLines.join("\n") };
    toolLogger.info({ result }, "Memory recall result");
    return result;
  },
});

export const searchMemoryTool = tool({
  name: "search_memory",
  description:
    "Search through stored memories by keyword. Searches current user's memories by default.",
  inputSchema: z.object({
    query: z
      .string()
      .describe("Search query to find in memory keys and values."),
    scope: z
      .enum(["global", "user", "all"])
      .nullable()
      .describe(
        "Filter by scope: 'user' for current user only, 'global' for global only, 'all' or null for both.",
      ),
  }),
  execute: async ({ query, scope }) => {
    const username = getContextUsername();
    toolLogger.info({ query, username, scope }, "Searching memories");

    try {
      const regex = new RegExp(query, "i");
      const filter: Record<string, unknown> = {
        $or: [{ key: regex }, { value: regex }],
      };

      if (scope === "global") {
        filter.scope = "global";
      } else if (scope === "user") {
        filter.scope = "user";
        filter.username = username;
      }
      // scope === "all" or null: no additional filter

      const results = await Memory.find(filter)
        .limit(20)
        .sort({ updatedAt: -1 });

      if (results.length === 0) {
        return {
          found: false,
          message: `No memories found matching "${query}"`,
        };
      }

      const memories = results.map((m) => ({
        key: m.key,
        value: m.value,
        scope: m.scope,
        username: m.username,
        createdBy: m.createdBy,
      }));

      return { found: true, count: memories.length, memories };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      toolLogger.error({ error: errorMessage }, "Memory search failed");
      return { error: errorMessage };
    }
  },
});

interface ConversationMatch {
  channelId: string;
  author: string;
  content: string;
  isBot: boolean;
  timestamp: Date;
}

function messageMatchesCriteria(
  content: string,
  msgAuthor: string,
  queryRegex: RegExp,
  authorFilter: string | null,
): boolean {
  const contentMatches = queryRegex.test(content);
  const authorMatches =
    !authorFilter || new RegExp(authorFilter, "i").test(msgAuthor);
  return contentMatches && authorMatches;
}

function truncateContent(content: string, maxLen = 200): string {
  return content.length > maxLen
    ? content.slice(0, maxLen - 3) + "..."
    : content;
}

function extractMatchingMessages(
  conversations: Array<{
    channelId: string;
    messages: Array<{
      author: string;
      content: string;
      isBot: boolean;
      timestamp: Date;
    }>;
  }>,
  queryRegex: RegExp,
  authorFilter: string | null,
): ConversationMatch[] {
  const matches: ConversationMatch[] = [];

  for (const conv of conversations) {
    for (const msg of conv.messages) {
      if (
        messageMatchesCriteria(
          msg.content,
          msg.author,
          queryRegex,
          authorFilter,
        )
      ) {
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

export const searchConversationTool = tool({
  name: "search_conversation",
  description:
    "Search through past conversation history stored in the database. Use this to recall what was discussed previously.",
  inputSchema: z.object({
    query: z
      .string()
      .describe("Search query to find in conversation messages."),
    author: z.string().nullable().describe("Filter by message author."),
    channel_id: z
      .string()
      .nullable()
      .describe("Filter by specific channel ID."),
    limit: z
      .number()
      .nullable()
      .describe("Maximum results to return (default 20, max 50)."),
  }),
  execute: async ({ query, author, channel_id, limit }) => {
    toolLogger.info(
      { query, author, channel_id, limit },
      "Searching conversations",
    );

    try {
      const maxLimit = Math.min(limit ?? 20, 50);
      const regex = new RegExp(query, "i");

      const filter: Record<string, unknown> = {};
      if (channel_id) filter.channelId = channel_id;

      const conversations = await Conversation.find(filter).lean();
      const matchingMessages = extractMatchingMessages(
        conversations,
        regex,
        author,
      );

      matchingMessages.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
      const results = matchingMessages.slice(0, maxLimit);

      if (results.length === 0) {
        return {
          found: false,
          message: `No conversation history found matching "${query}"`,
        };
      }

      return { found: true, count: results.length, messages: results };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      toolLogger.error({ error: errorMessage }, "Conversation search failed");
      return { error: errorMessage };
    }
  },
});
