import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { toolLogger } from "../logger";
import { getToolContext } from "./types";

export const searchMessagesDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_messages",
    description:
      "Search for messages in the current Discord channel. Use this to find specific messages to react to, reference, or quote. You can search by content, author, or get recent messages. Returns message IDs that can be used with react_to_message.",
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
      },
      required: ["query", "author", "limit"],
      additionalProperties: false,
    },
  },
};

export const reactToMessageDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "react_to_message",
    description:
      "Add an emoji reaction to a specific message by its ID. Use search_messages first to get message IDs, or use add_reaction to react to the user's current message.",
    parameters: {
      type: "object",
      properties: {
        message_id: {
          type: "string",
          description: "The ID of the message to react to.",
        },
        emoji: {
          type: "string",
          description:
            "The emoji to react with. Can be a unicode emoji (👍, ❤️, 🔥, etc.) or a custom emoji in the format <:name:id> or <a:name:id> for animated.",
        },
      },
      required: ["message_id", "emoji"],
      additionalProperties: false,
    },
  },
};

interface FoundMessage {
  id: string;
  author: string;
  content: string;
  timestamp: number;
  url: string;
}

export async function searchMessages(
  query: string | null,
  author: string | null,
  limit: number | null
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

    // Take only the requested limit
    const results: FoundMessage[] = filtered.slice(0, searchLimit).map((m) => ({
      id: m.id,
      author: m.author.displayName,
      content: m.content.slice(0, 200) + (m.content.length > 200 ? "..." : ""),
      timestamp: Math.floor(m.createdTimestamp / 1000),
      url: m.url,
    }));

    toolLogger.info(
      { query, author, found: results.length },
      "Message search complete"
    );

    return JSON.stringify({
      messages: results,
      total: results.length,
      hint: results.length > 0
        ? "Use react_to_message with a message ID to add a reaction, or reference messages using their URL"
        : "No messages found matching your criteria",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    toolLogger.error({ error: errorMessage }, "Failed to search messages");
    return JSON.stringify({ error: "Failed to search messages", details: errorMessage });
  }
}

export async function reactToMessage(
  messageId: string,
  emoji: string
): Promise<string> {
  const ctx = getToolContext();

  if (!ctx.channel) {
    toolLogger.warn("No channel context available for react_to_message");
    return JSON.stringify({ error: "No channel context available" });
  }

  const channel = ctx.channel;
  if (!("messages" in channel)) {
    return JSON.stringify({ error: "Cannot access messages in this channel type" });
  }

  try {
    const message = await channel.messages.fetch(messageId);
    await message.react(emoji);
    toolLogger.info({ messageId, emoji }, "Added reaction to message");
    return JSON.stringify({
      success: true,
      emoji,
      messageId,
      messageUrl: message.url,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    toolLogger.error({ error: errorMessage, messageId, emoji }, "Failed to react to message");
    return JSON.stringify({ error: "Failed to add reaction", details: errorMessage });
  }
}
