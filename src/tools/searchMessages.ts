import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { toolLogger } from "../logger";
import { getToolContext } from "./types";

export const searchMessagesDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_messages",
    description:
      "Search for messages in the current Discord channel. Returns message IDs, content, reactions, and URLs. Use the returned message ID with manage_reaction to add/remove reactions.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: ["string", "null"],
          description:
            "Text to search for in message content. Leave null to get recent messages without filtering by content.",
        },
        author: {
          type: ["string", "null"],
          description:
            "Filter by author username or display name. Leave null to search all authors.",
        },
        limit: {
          type: ["number", "null"],
          description:
            "Maximum number of messages to return (1-50, default 10).",
        },
        include_reactions: {
          type: ["boolean", "null"],
          description:
            "Whether to include reaction details for each message. Default true.",
        },
      },
      required: ["query", "author", "limit", "include_reactions"],
      additionalProperties: false,
    },
  },
};

interface ReactionInfo {
  emoji: string;
  count: number;
}

interface FoundMessage {
  id: string;
  author: string;
  content: string;
  timestamp: number;
  url: string;
  reactions?: ReactionInfo[];
}

export async function searchMessages(
  query: string | null,
  author: string | null,
  limit: number | null,
  includeReactions: boolean | null = true
): Promise<string> {
  const ctx = getToolContext();

  if (!ctx.channel) {
    toolLogger.warn("No channel context available for search_messages");
    return JSON.stringify({ error: "No channel context available" });
  }

  const channel = ctx.channel;
  if (!("messages" in channel)) {
    return JSON.stringify({ error: "Cannot search messages in this channel type" });
  }

  const searchLimit = Math.min(Math.max(limit ?? 10, 1), 50);
  const showReactions = includeReactions !== false;

  try {
    // Fetch more messages than needed to allow filtering
    const fetchLimit = query || author ? Math.min(searchLimit * 5, 100) : searchLimit;
    const messages = await channel.messages.fetch({ limit: fetchLimit });

    let filtered = [...messages.values()];

    // Filter by author if specified
    if (author) {
      const authorLower = author.toLowerCase();
      filtered = filtered.filter(
        (m) =>
          m.author.username.toLowerCase().includes(authorLower) ||
          m.author.displayName.toLowerCase().includes(authorLower)
      );
    }

    // Filter by content if specified
    if (query) {
      const queryLower = query.toLowerCase();
      filtered = filtered.filter((m) =>
        m.content.toLowerCase().includes(queryLower)
      );
    }

    // Take only the requested limit and build results
    const results: FoundMessage[] = filtered.slice(0, searchLimit).map((m) => {
      const result: FoundMessage = {
        id: m.id,
        author: m.author.displayName,
        content: m.content.slice(0, 200) + (m.content.length > 200 ? "..." : ""),
        timestamp: Math.floor(m.createdTimestamp / 1000),
        url: m.url,
      };

      // Include reactions if requested
      if (showReactions && m.reactions.cache.size > 0) {
        result.reactions = m.reactions.cache.map((r) => ({
          emoji: r.emoji.toString(),
          count: r.count,
        }));
      }

      return result;
    });

    toolLogger.info(
      { query, author, found: results.length },
      "Message search complete"
    );

    return JSON.stringify({
      messages: results,
      total: results.length,
      hint: results.length > 0
        ? "Use manage_reaction with the message ID to add/remove reactions"
        : "No messages found matching your criteria",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    toolLogger.error({ error: errorMessage }, "Failed to search messages");
    return JSON.stringify({ error: "Failed to search messages", details: errorMessage });
  }
}
