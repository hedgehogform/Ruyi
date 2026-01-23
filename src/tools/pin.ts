import { tool } from "@openrouter/sdk";
import { z } from "zod";
import { toolLogger } from "../logger";
import { resolveTargetMessage, formatError } from "../utils/types";

export const pinTool = tool({
  name: "manage_pin",
  description:
    "Pin or unpin messages in the current channel. Use search_messages first to find the message ID if the user references a specific message.",
  inputSchema: z.object({
    action: z.enum(["pin", "unpin"]).describe("Whether to pin or unpin the message."),
    message_id: z
      .string()
      .nullable()
      .describe(
        'The message ID to pin/unpin. Use "replied" for the message the user replied to, null for the user\'s current message, or an actual message ID from search_messages.'
      ),
  }),
  execute: async ({ action, message_id }) => {
    const result = await resolveTargetMessage(message_id, "pin");
    if (!result.success) {
      return { error: result.error };
    }

    const targetMessage = result.message;

    try {
      if (action === "pin") {
        await targetMessage.pin();
        toolLogger.info({ messageId: targetMessage.id, action }, "Pinned message");
        return {
          success: true,
          action: "pinned",
          messageId: targetMessage.id,
          messageUrl: targetMessage.url,
          content:
            targetMessage.content.slice(0, 100) +
            (targetMessage.content.length > 100 ? "..." : ""),
        };
      } else {
        await targetMessage.unpin();
        toolLogger.info({ messageId: targetMessage.id, action }, "Unpinned message");
        return {
          success: true,
          action: "unpinned",
          messageId: targetMessage.id,
          messageUrl: targetMessage.url,
        };
      }
    } catch (error) {
      const errorMessage = formatError(error);
      toolLogger.error({ error: errorMessage, action, message_id }, "Failed to manage pin");
      return { error: "Failed to manage pin", details: errorMessage };
    }
  },
});
