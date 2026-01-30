import type { ChatInputCommandInteraction } from "discord.js";
import { creditsCommand, handleCreditsCommand } from "./credits";
import { prefixCommand, handlePrefixCommand } from "./prefix";
import { smitheryCommand, handleSmitheryCommand } from "./smithery";

export const slashCommands = [prefixCommand, creditsCommand, smitheryCommand];

export {
  handleSmitherySelect,
  handleSmitheryCodeButton,
  handleSmitheryModal,
} from "./smithery";

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
    case "smithery":
      await handleSmitheryCommand(interaction);
      break;
  }
}
