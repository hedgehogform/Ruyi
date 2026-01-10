import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { toolLogger } from "../logger";
import { getToolContext } from "./types";

export const userInfoDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_user_info",
    description:
      "Get information about a Discord user by username. The response includes Discord timestamp embeds (like <t:123456789:F>) for dates - use these EXACTLY as-is in your response so Discord renders them as interactive timestamps users can hover over.",
    parameters: {
      type: "object",
      properties: {
        username: { type: "string", description: "Username to look up" },
      },
      required: ["username"],
    },
  },
};

export async function getUserInfo(username: string): Promise<string> {
  const { guild } = getToolContext();
  if (!guild) {
    toolLogger.warn("get_user_info called without guild context");
    return JSON.stringify({ error: "Not in a server" });
  }
  toolLogger.debug({ username }, "Looking up user");

  try {
    const members = await guild.members.fetch({
      query: username,
      limit: 10,
    });
    const member =
      members.find(
        (m) =>
          m.user.username.toLowerCase() === username.toLowerCase() ||
          m.displayName.toLowerCase() === username.toLowerCase()
      ) || members.first();

    if (!member) {
      toolLogger.warn({ username }, "User not found");
      return JSON.stringify({ error: "User not found: " + username });
    }

    const user = member.user;
    toolLogger.info({ username, found: member.displayName }, "Found user");

    // Debug: log the raw timestamps
    toolLogger.debug(
      {
        joinedTimestamp: member.joinedTimestamp,
        joinedAt: member.joinedAt?.toISOString(),
        createdTimestamp: user.createdTimestamp,
        createdAt: user.createdAt?.toISOString(),
      },
      "Raw timestamps"
    );

    return JSON.stringify({
      username: user.username,
      displayName: member.displayName,
      id: user.id,
      discriminator: user.discriminator,
      bot: user.bot,
      avatar: user.avatarURL(),
      banner: user.bannerURL(),
      accentColor: user.accentColor,
      createdAt: user.createdAt?.toISOString(),
      createdAtRelative: user.createdAt?.toISOString(),
      joinedServer: member.joinedAt?.toISOString(),
      joinedServerRelative: member.joinedAt?.toISOString(),
      nickname: member.nickname,
      pending: member.pending,
      communicationDisabledUntil:
        member.communicationDisabledUntil?.toISOString(),

      premiumSince: member.premiumSince?.toISOString(),
      roles: member.roles.cache
        .filter((r) => r.name !== "@everyone")
        .map((r) => ({ name: r.name, color: r.hexColor })),
      highestRole: member.roles.highest.name,
      isOwner: member.id === guild.ownerId,
    });
  } catch (error) {
    toolLogger.error({ username, error }, "Error fetching user");
    return JSON.stringify({ error: "Failed to fetch user: " + username });
  }
}
