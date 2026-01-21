import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { toolLogger } from "../logger";
import { getToolContext } from "./types";

export const serverInfoDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_server_info",
    description: "Get information about the current Discord server",
    parameters: { type: "object", properties: {} },
  },
};

export async function getServerInfo(): Promise<string> {
  const { guild } = getToolContext();
  if (!guild) {
    toolLogger.warn("get_server_info called without guild context");
    return JSON.stringify({ error: "Not in a server" });
  }

  toolLogger.info({ server: guild.name }, "Got server info");

  // Fetch ALL members (humans + bots)
  const members = await guild.members.fetch();

  const list = members.map((m) => ({
    id: m.user.id,
    username: m.user.username,
    globalName: m.user.globalName, // new Discord display name
    tag: m.user.tag, // username#1234 (if available)
    avatar: m.user.avatarURL(),
    banner: m.user.bannerURL(),
    joinedAt: m.joinedAt?.toISOString(),
    createdAt: m.user.createdAt.toISOString(),
    isBot: m.user.bot,
    roles: m.roles.cache.map((r) => r.name),
  }));

  return JSON.stringify({
    server: {
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL(),
    },
    memberCount: members.size,
    members: list,
  });
}
