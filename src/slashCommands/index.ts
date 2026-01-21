import type { ChatInputCommandInteraction } from "discord.js";
import { creditsCommand, handleCreditsCommand } from "./credits";
import { prefixCommand, handlePrefixCommand } from "./prefix";

export const slashCommands = [prefixCommand, creditsCommand];

export async function handleSlashCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  switch (interaction.commandName) {
    case "prefix":
      await handlePrefixCommand(interaction);
      break;
    case "credits":
      await handleCreditsCommand(interaction);
      break;
  }
}
