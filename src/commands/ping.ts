import type { Message } from "discord.js";
import { botLogger } from "../logger";
import { getPrefix } from "../config";

export async function handlePing(message: Message): Promise<boolean> {
  if (message.content !== `${getPrefix()}ping`) return false;

  botLogger.debug({ user: message.author.username }, "Ping command");
  await message.reply("Pong!");
  return true;
}
