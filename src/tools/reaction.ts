import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { Message, MessageReaction } from "discord.js";
import { toolLogger } from "../logger";
import {
  getToolContext,
  resolveTargetMessage,
  formatError,
} from "../utils/types";

// Find a reaction by emoji (handles unicode and custom emojis)
function findReaction(
  message: Message,
  emoji: string,
): MessageReaction | undefined {
  return message.reactions.cache.find((r) => {
    const emojiStr = r.emoji.toString();
    const emojiName = r.emoji.name;
    const emojiId = r.emoji.id;
    return (
      emojiStr === emoji ||
      emojiName === emoji ||
      (emojiId && emoji.includes(emojiId))
    );
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
  messageId: string | null,
): Promise<string> {
  const result = await resolveTargetMessage(messageId, "reaction");
  if (!result.success) {
    return JSON.stringify({ error: result.error });
  }

  const targetMessage = result.message;
  const ctx = getToolContext();

  try {
    if (action === "add") {
      await targetMessage.react(emoji);
      toolLogger.info(
        { emoji, messageId: targetMessage.id, action },
        "Added reaction",
      );
      return JSON.stringify({
        success: true,
        action: "added",
        emoji,
        messageId: targetMessage.id,
        messageUrl: targetMessage.url,
      });
    }

    // Remove the bot's own reaction
    const botUserId = ctx.message?.client.user?.id;
    if (!botUserId) {
      return JSON.stringify({ error: "Could not determine bot user ID" });
    }

    // Fetch fresh message to ensure we have latest reactions
    const channel = ctx.channel!;
    const freshMessage = await channel.messages.fetch(targetMessage.id);
    const reaction = findReaction(freshMessage, emoji);

    if (!reaction) {
      const availableReactions = freshMessage.reactions.cache
        .map((r) => r.emoji.toString())
        .join(", ");
      return JSON.stringify({
        error: "Reaction not found on this message",
        emoji,
        availableReactions: availableReactions || "none",
        messageId: targetMessage.id,
      });
    }

    await reaction.users.remove(botUserId);
    toolLogger.info(
      { emoji, messageId: targetMessage.id, action },
      "Removed reaction",
    );
    return JSON.stringify({
      success: true,
      action: "removed",
      emoji,
      messageId: targetMessage.id,
      messageUrl: targetMessage.url,
    });
  } catch (error) {
    const errorMessage = formatError(error);
    toolLogger.error(
      { error: errorMessage, emoji, action, messageId },
      "Failed to manage reaction",
    );
    return JSON.stringify({
      error: "Failed to manage reaction",
      details: errorMessage,
    });
  }
}
