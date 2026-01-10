import type { Message, TextChannel, Guild } from "discord.js";

export interface ToolContext {
  message: Message | null;
  channel: TextChannel | null;
  guild: Guild | null;
}

const context: ToolContext = {
  message: null,
  channel: null,
  guild: null,
};

export function getToolContext(): ToolContext {
  return context;
}

export function setToolContext(
  message: Message,
  channel: TextChannel | null,
  guild: Guild | null
) {
  context.message = message;
  context.channel = channel;
  context.guild = guild;
}
