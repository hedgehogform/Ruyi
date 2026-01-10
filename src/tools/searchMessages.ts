import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { toolLogger } from "../logger";
import { getToolContext } from "./types";

export const searchMessagesDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_messages",
    description:
      "Search for messages in the current Discord channel. Returns up to 10 matching messages.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for in messages" },
      },
      required: ["query"],
    },
  },
};

export async function searchMessages(query: string, limit: number): Promise<string> {
  const { channel } = getToolContext();
  if (!channel || !("messages" in channel)) {
    toolLogger.warn("search_messages called without channel context");
    return JSON.stringify({ error: "Cannot search in this channel" });
  }
  toolLogger.debug({ query, limit }, "Searching messages");
  const messages = await channel.messages.fetch({ limit });
  const matches = messages.filter((m) =>
    m.content.toLowerCase().includes(query.toLowerCase())
  );
  const results = [...matches.values()].slice(0, 10).map((m) => ({
    author: m.author.displayName,
    content: m.content,
    timestamp: m.createdAt.toISOString(),
  }));
  toolLogger.info({ query, found: results.length }, "Message search complete");
  return JSON.stringify({ query, found: results.length, messages: results });
}
