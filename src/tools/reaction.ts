import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { Message, MessageReaction } from "discord.js";
import { toolLogger } from "../logger";
import { getToolContext } from "./types";

// Find a reaction by emoji (handles unicode and custom emojis)
function findReaction(message: Message, emoji: string): MessageReaction | undefined {
  return message.reactions.cache.find((r) => {
    const emojiStr = r.emoji.toString();
    const emojiName = r.emoji.name;
    const emojiId = r.emoji.id;
    return emojiStr === emoji || emojiName === emoji || (emojiId && emoji.includes(emojiId));
  });
}

// Build success response
function successResponse(action: string, emoji: string, message: Message) {
  return JSON.stringify({
    success: true,
    action,
    emoji,
    messageId: message.id,
    messageUrl: message.url,
  });
}

export const reactionDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "manage_reaction",
    description:
      "Add or remove emoji reactions on messages. Can target the current message, the message the user replied to, or any message by ID.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["add", "remove"],
          description: "Whether to add or remove the reaction.",
        },
        emoji: {
          type: "string",
          description:
            "The emoji to react with. Can be a unicode emoji (👍, ❤️, 🔥, 😊, 🎉, etc.) or a custom emoji in the format <:name:id> or <a:name:id> for animated.",
        },
        message_id: {
          type: ["string", "null"],
          description:
            'The target message. Use "replied" to react to the message the user replied to. Use null to react to the user\'s current message. Use a message ID to react to any other message (use search_messages to find IDs).',
        },
      },
      required: ["action", "emoji", "message_id"],
      additionalProperties: false,
    },
  },
};

export async function manageReaction(
  action: "add" | "remove",
  emoji: string,
  messageId: string | null
): Promise<string> {
  const ctx = getToolContext();

  if (!ctx.channel) {
    toolLogger.warn("No channel context available for reaction");
    return JSON.stringify({ error: "No channel context available" });
  }

  const channel = ctx.channel;
  if (!("messages" in channel)) {
    return JSON.stringify({ error: "Cannot access messages in this channel type" });
  }

  try {
    // Get the target message based on messageId value
    let targetMessage;
    if (messageId === "replied") {
      // React to the message the user replied to
      targetMessage = ctx.referencedMessage;
      if (!targetMessage) {
        return JSON.stringify({ error: "The user did not reply to any message" });
      }
    } else if (messageId) {
      // React to a specific message by ID
      targetMessage = await channel.messages.fetch(messageId);
    } else {
      // React to the user's current message
      targetMessage = ctx.message;
    }

    if (!targetMessage) {
      return JSON.stringify({ error: "Could not find the target message" });
    }

    if (action === "add") {
      await targetMessage.react(emoji);
      toolLogger.info({ emoji, messageId: targetMessage.id, action }, "Added reaction");
      return successResponse("added", emoji, targetMessage);
    }

    // Remove the bot's own reaction
    const botUserId = ctx.message?.client.user?.id;
    if (!botUserId) {
      return JSON.stringify({ error: "Could not determine bot user ID" });
    }

    // Fetch fresh message to ensure we have latest reactions
    const freshMessage = await channel.messages.fetch(targetMessage.id);
    const reaction = findReaction(freshMessage, emoji);

    if (!reaction) {
      const availableReactions = freshMessage.reactions.cache.map((r) => r.emoji.toString()).join(", ");
      return JSON.stringify({
        error: "Reaction not found on this message",
        emoji,
        availableReactions: availableReactions || "none",
        messageId: targetMessage.id,
      });
    }

    await reaction.users.remove(botUserId);
    toolLogger.info({ emoji, messageId: targetMessage.id, action }, "Removed reaction");
    return successResponse("removed", emoji, targetMessage);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    toolLogger.error({ error: errorMessage, emoji, action, messageId }, "Failed to manage reaction");
    return JSON.stringify({ error: "Failed to manage reaction", details: errorMessage });
  }
}
