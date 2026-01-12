import type { Message, TextChannel, Guild } from "discord.js";

export interface ToolContext {
  message: Message | null;
  channel: TextChannel | null;
  guild: Guild | null;
  referencedMessage: Message | null;
}

const context: ToolContext = {
  message: null,
  channel: null,
  guild: null,
  referencedMessage: null,
};

export function getToolContext(): ToolContext {
  return context;
}

export function setToolContext(
  message: Message,
  channel: TextChannel | null,
  guild: Guild | null,
  referencedMessage: Message | null = null
) {
  context.message = message;
  context.channel = channel;
  context.guild = guild;
  context.referencedMessage = referencedMessage;
}
