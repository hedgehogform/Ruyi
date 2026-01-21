import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { toolLogger } from "../logger";
import { getToolContext } from "../utils/types";

export const channelInfoDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_channel_info",
    description: "Get information about the current Discord channel",
    parameters: { type: "object", properties: {} },
  },
};

export function getChannelInfo(): string {
  const { channel } = getToolContext();
  if (!channel) {
    toolLogger.warn("get_channel_info called without channel context");
    return JSON.stringify({ error: "No channel context" });
  }
  toolLogger.info({ channel: channel.name }, "Got channel info");
  return JSON.stringify({
    name: channel.name,
    id: channel.id,
    topic: channel.topic || "No topic",
  });
}
