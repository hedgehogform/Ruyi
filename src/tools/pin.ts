import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { toolLogger } from "../logger";
import { resolveTargetMessage, formatError } from "../utils/types";

export const pinDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "manage_pin",
    description:
      "Pin or unpin messages in the current channel. Use search_messages first to find the message ID if the user references a specific message.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["pin", "unpin"],
          description: "Whether to pin or unpin the message.",
        },
        message_id: {
          type: ["string", "null"],
          description:
            'The message ID to pin/unpin. Use "replied" for the message the user replied to, null for the user\'s current message, or an actual message ID from search_messages.',
        },
      },
      required: ["action", "message_id"],
      additionalProperties: false,
    },
  },
};

export async function managePin(
  action: "pin" | "unpin",
  messageId: string | null,
): Promise<string> {
  const result = await resolveTargetMessage(messageId, "pin");
  if (!result.success) {
    return JSON.stringify({ error: result.error });
  }

  const targetMessage = result.message;

  try {
    if (action === "pin") {
      await targetMessage.pin();
      toolLogger.info(
        { messageId: targetMessage.id, action },
        "Pinned message",
      );
      return JSON.stringify({
        success: true,
        action: "pinned",
        messageId: targetMessage.id,
        messageUrl: targetMessage.url,
        content:
          targetMessage.content.slice(0, 100) +
          (targetMessage.content.length > 100 ? "..." : ""),
      });
    } else {
      await targetMessage.unpin();
      toolLogger.info(
        { messageId: targetMessage.id, action },
        "Unpinned message",
      );
      return JSON.stringify({
        success: true,
        action: "unpinned",
        messageId: targetMessage.id,
        messageUrl: targetMessage.url,
      });
    }
  } catch (error) {
    const errorMessage = formatError(error);
    toolLogger.error(
      { error: errorMessage, action, messageId },
      "Failed to manage pin",
    );
    return JSON.stringify({
      error: "Failed to manage pin",
      details: errorMessage,
    });
  }
}
