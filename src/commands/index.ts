import type { ChatInputCommandInteraction, Message } from "discord.js";
import { handlePing } from "./ping";
import { handleCredits } from "./credits";
import { prefixCommand, handlePrefixCommand } from "./prefix";

type MessageCommandHandler = (message: Message) => Promise<boolean>;

const messageCommands: MessageCommandHandler[] = [handlePing, handleCredits];

export async function handleCommands(message: Message): Promise<boolean> {
  for (const handler of messageCommands) {
    if (await handler(message)) return true;
  }
  return false;
}

// Slash commands
export const slashCommands = [prefixCommand];

export async function handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.commandName === "prefix") {
    await handlePrefixCommand(interaction);
  }
}
