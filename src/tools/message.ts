import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { toolLogger } from "../logger";
import { getToolContext } from "../utils/types";
import { ChannelType, TextChannel, Message } from "discord.js";

export const searchMessagesDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_messages",
    description:
      "Search for messages in Discord. Can search current channel, a specific channel, or across the entire server. Returns message IDs, content, reactions, and URLs. Use the returned message ID with manage_reaction or delete_messages.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: ["string", "null"],
          description:
            "Text to search for in message content. Leave null to get recent messages without filtering by content.",
        },
        author: {
          type: ["string", "null"],
          description:
            "Filter by author username or display name. Leave null to search all authors.",
        },
        channel_name: {
          type: ["string", "null"],
          description:
            "Name of a specific channel to search in. Leave null to search current channel.",
        },
        search_all_channels: {
          type: ["boolean", "null"],
          description:
            "If true, search across ALL text channels in the server. Default false.",
        },
        limit: {
          type: ["number", "null"],
          description:
            "Maximum number of messages to return (1-100, default 10).",
        },
        include_reactions: {
          type: ["boolean", "null"],
          description:
            "Whether to include reaction details for each message. Default true.",
        },
      },
      required: [
        "query",
        "author",
        "channel_name",
        "search_all_channels",
        "limit",
        "include_reactions",
      ],
      additionalProperties: false,
    },
  },
};

export const deleteMessagesDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "delete_messages",
    description:
      "Delete messages from the current channel. Can delete specific messages by ID, messages from a specific user, or bulk delete recent messages. Requires Manage Messages permission.",
    parameters: {
      type: "object",
      properties: {
        message_ids: {
          type: ["array", "null"],
          items: { type: "string" },
          description:
            "Array of specific message IDs to delete. Use this for targeted deletion.",
        },
        author: {
          type: ["string", "null"],
          description:
            "Delete messages from this specific user (by username/display name). Combine with count.",
        },
        count: {
          type: ["number", "null"],
          description:
            "Number of recent messages to delete (1-100). If author is specified, deletes up to this many messages from that author.",
        },
        contains: {
          type: ["string", "null"],
          description:
            "Only delete messages containing this text. Works with author and count filters.",
        },
      },
      required: ["message_ids", "author", "count", "contains"],
      additionalProperties: false,
    },
  },
};

interface ReactionInfo {
  emoji: string;
  count: number;
}

interface FoundMessage {
  id: string;
  author: string;
  content: string;
  timestamp: number;
  url: string;
  channel?: string;
  reactions?: ReactionInfo[];
}

// Helper: Check if author matches filter
function matchesAuthor(msg: Message, authorFilter: string): boolean {
  const authorLower = authorFilter.toLowerCase();
  return (
    msg.author.username.toLowerCase().includes(authorLower) ||
    msg.author.displayName.toLowerCase().includes(authorLower)
  );
}

// Helper: Check if content matches filter
function matchesContent(msg: Message, query: string): boolean {
  return msg.content.toLowerCase().includes(query.toLowerCase());
}

// Helper: Filter messages by author and query
function filterMessages(
  messages: Message[],
  author: string | null,
  query: string | null,
): Message[] {
  let filtered = messages;
  if (author) {
    filtered = filtered.filter((m) => matchesAuthor(m, author));
  }
  if (query) {
    filtered = filtered.filter((m) => matchesContent(m, query));
  }
  return filtered;
}

// Helper: Get channels to search
async function getChannelsToSearch(
  channelName: string | null,
  searchAllChannels: boolean | null,
  ctx: ReturnType<typeof getToolContext>,
): Promise<TextChannel[] | string> {
  if (searchAllChannels && ctx.guild) {
    const channels = await ctx.guild.channels.fetch();
    const textChannels = channels
      .filter((c): c is TextChannel => c?.type === ChannelType.GuildText)
      .map((c) => c);
    toolLogger.info(
      { channelCount: textChannels.length },
      "Searching all channels",
    );
    return textChannels;
  }

  if (channelName && ctx.guild) {
    const channels = await ctx.guild.channels.fetch();
    const targetChannel = channels.find(
      (c): c is TextChannel =>
        c?.type === ChannelType.GuildText &&
        c.name.toLowerCase().includes(channelName.toLowerCase()),
    );
    if (!targetChannel) {
      return `Channel "${channelName}" not found`;
    }
    return [targetChannel];
  }

  if (ctx.channel && "messages" in ctx.channel) {
    return [ctx.channel];
  }

  return "No valid channel to search";
}

// Helper: Build a FoundMessage from a Discord message
function buildFoundMessage(
  msg: Message,
  showReactions: boolean,
  includeChannel: boolean,
  channelName?: string,
): FoundMessage {
  const result: FoundMessage = {
    id: msg.id,
    author: msg.author.displayName,
    content:
      msg.content.slice(0, 200) + (msg.content.length > 200 ? "..." : ""),
    timestamp: Math.floor(msg.createdTimestamp / 1000),
    url: msg.url,
  };

  if (includeChannel && channelName) {
    result.channel = channelName;
  }

  if (showReactions && msg.reactions.cache.size > 0) {
    result.reactions = msg.reactions.cache.map((r) => ({
      emoji: r.emoji.toString(),
      count: r.count,
    }));
  }

  return result;
}

// Helper: Search a single channel and collect results
async function searchChannel(
  channel: TextChannel,
  query: string | null,
  author: string | null,
  searchLimit: number,
  showReactions: boolean,
  includeChannel: boolean,
  existingCount: number,
): Promise<FoundMessage[]> {
  const results: FoundMessage[] = [];
  const remaining = searchLimit - existingCount;
  if (remaining <= 0) return results;

  const fetchLimit =
    query || author ? Math.min(searchLimit * 5, 100) : searchLimit;
  const messages = await channel.messages.fetch({ limit: fetchLimit });
  const filtered = filterMessages([...messages.values()], author, query);

  for (const msg of filtered.slice(0, remaining)) {
    results.push(
      buildFoundMessage(msg, showReactions, includeChannel, channel.name),
    );
  }

  return results;
}

export async function searchMessages(
  query: string | null,
  author: string | null,
  channelName: string | null,
  searchAllChannels: boolean | null,
  limit: number | null,
  includeReactions: boolean | null = true,
): Promise<string> {
  const ctx = getToolContext();

  if (!ctx.guild && searchAllChannels) {
    return JSON.stringify({
      error: "Cannot search all channels outside of a server",
    });
  }

  const searchLimit = Math.min(Math.max(limit ?? 10, 1), 100);
  const showReactions = includeReactions !== false;

  try {
    const channelsResult = await getChannelsToSearch(
      channelName,
      searchAllChannels,
      ctx,
    );
    if (typeof channelsResult === "string") {
      return JSON.stringify({ error: channelsResult });
    }

    const allResults: FoundMessage[] = [];
    const includeChannel = Boolean(searchAllChannels || channelName);

    for (const channel of channelsResult) {
      const channelResults = await searchChannel(
        channel,
        query,
        author,
        searchLimit,
        showReactions,
        includeChannel,
        allResults.length,
      );
      allResults.push(...channelResults);
      if (allResults.length >= searchLimit) break;
    }

    toolLogger.info(
      {
        query,
        author,
        channelName,
        searchAllChannels,
        found: allResults.length,
      },
      "Message search complete",
    );

    return JSON.stringify({
      messages: allResults,
      total: allResults.length,
      hint:
        allResults.length > 0
          ? "Use manage_reaction with the message ID to add/remove reactions, or delete_messages to remove them"
          : "No messages found matching your criteria",
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    toolLogger.error({ error: errorMessage }, "Failed to search messages");
    return JSON.stringify({
      error: "Failed to search messages",
      details: errorMessage,
    });
  }
}

// Helper: Fetch messages by IDs
async function fetchMessagesByIds(
  channel: TextChannel,
  messageIds: string[],
): Promise<Message[]> {
  const messages: Message[] = [];
  for (const id of messageIds.slice(0, 100)) {
    try {
      const msg = await channel.messages.fetch(id);
      messages.push(msg);
    } catch {
      // Message not found, skip
    }
  }
  return messages;
}

// Helper: Fetch and filter recent messages
async function fetchFilteredMessages(
  channel: TextChannel,
  count: number,
  author: string | null,
  contains: string | null,
): Promise<Message[]> {
  const fetchCount = Math.min(count * 2, 100);
  const messages = await channel.messages.fetch({ limit: fetchCount });
  const filtered = filterMessages([...messages.values()], author, contains);
  return filtered.slice(0, Math.min(count, 100));
}

// Helper: Delete messages with bulk delete for recent, individual for old
async function performDeletion(
  channel: TextChannel,
  messages: Message[],
): Promise<number> {
  const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const recentMessages = messages.filter(
    (m) => m.createdTimestamp > twoWeeksAgo,
  );
  const oldMessages = messages.filter((m) => m.createdTimestamp <= twoWeeksAgo);

  let deletedCount = 0;

  // Bulk delete recent messages (faster)
  if (recentMessages.length > 1) {
    await channel.bulkDelete(recentMessages);
    deletedCount += recentMessages.length;
  } else if (recentMessages.length === 1 && recentMessages[0]) {
    await recentMessages[0].delete();
    deletedCount += 1;
  }

  // Delete old messages one by one
  for (const msg of oldMessages) {
    try {
      await msg.delete();
      deletedCount++;
    } catch {
      // Failed to delete, continue
    }
  }

  return deletedCount;
}

export async function deleteMessages(
  messageIds: string[] | null,
  author: string | null,
  count: number | null,
  contains: string | null,
): Promise<string> {
  const ctx = getToolContext();

  if (!ctx.channel || !("messages" in ctx.channel)) {
    return JSON.stringify({
      error: "No valid channel context for message deletion",
    });
  }

  const channel = ctx.channel;

  try {
    let messagesToDelete: Message[];

    if (messageIds && messageIds.length > 0) {
      messagesToDelete = await fetchMessagesByIds(channel, messageIds);
    } else if (count && count > 0) {
      messagesToDelete = await fetchFilteredMessages(
        channel,
        count,
        author,
        contains,
      );
    } else {
      return JSON.stringify({
        error: "Must specify either message_ids or count",
      });
    }

    if (messagesToDelete.length === 0) {
      return JSON.stringify({ error: "No messages found matching criteria" });
    }

    const deletedCount = await performDeletion(channel, messagesToDelete);

    toolLogger.info({ deletedCount, author, contains }, "Messages deleted");

    return JSON.stringify({
      success: true,
      deleted: deletedCount,
      message: `Deleted ${deletedCount} message${deletedCount === 1 ? "" : "s"}`,
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    toolLogger.error({ error: errorMessage }, "Failed to delete messages");
    return JSON.stringify({
      error: "Failed to delete messages",
      details: errorMessage,
    });
  }
}
