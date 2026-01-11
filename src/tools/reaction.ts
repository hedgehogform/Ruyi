import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { toolLogger } from "../logger";
import { getToolContext } from "./types";

export const reactionDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "add_reaction",
    description:
      "Add an emoji reaction to the user's message. Use this to express emotions, acknowledge messages, or add flair to your responses. You can react with standard emojis (like 👍, ❤️, 🎉) or custom server emojis.",
    parameters: {
      type: "object",
      properties: {
        emoji: {
          type: "string",
          description:
            "The emoji to react with. Can be a unicode emoji (👍, ❤️, 🔥, etc.) or a custom emoji in the format <:name:id> or <a:name:id> for animated.",
        },
      },
      required: ["emoji"],
      additionalProperties: false,
    },
  },
};

export async function addReaction(emoji: string): Promise<string> {
  const ctx = getToolContext();

  if (!ctx.message) {
    toolLogger.warn("No message context available for reaction");
    return JSON.stringify({ error: "No message context available" });
  }

  try {
    await ctx.message.react(emoji);
    toolLogger.info({ emoji }, "Added reaction to message");
    return JSON.stringify({ success: true, emoji });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    toolLogger.error({ error: errorMessage, emoji }, "Failed to add reaction");
    return JSON.stringify({ error: "Failed to add reaction", details: errorMessage });
  }
}
