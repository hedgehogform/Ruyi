import { ActivityType, Client, Events, GatewayIntentBits, REST, Routes, type Message } from "discord.js";
import { chat, shouldReply } from "./ai";
import { setToolContext } from "./tools";
import { botLogger } from "./logger";
import { handleCommands } from "./commands";
import { slashCommands, handleSlashCommand } from "./slashCommands";
import { createStatusState, buildStatusEmbed, createChatCallbacks } from "./utils/status";
import {
  fetchReplyChain,
  fetchChatHistory,
  fetchReferencedMessage,
  sendReplyChunks,
  getErrorMessage,
} from "./utils/messages";
import { startMessageSync, deleteMessageFromDb } from "./services/messageSync";

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

const SELF_RESPONDING_TOOLS = new Set(["send_embed", "generate_image"]);

function setDefaultPresence() {
  client.user?.setPresence({
    activities: [{ name: "Serving...", type: ActivityType.Watching }],
  });
}

function setTypingStatus(username: string) {
  client.user?.setActivity(`Assisting ${username}...`, {
    type: ActivityType.Custom,
    state: `Assisting ${username}...`,
  });
}

async function shouldBotRespond(
  content: string,
  user: string,
  channelName: string | null,
  isMentioned: boolean,
  isDM: boolean
): Promise<boolean> {
  if (isMentioned || isDM) {
    botLogger.info({ user, channel: channelName, mentioned: isMentioned, dm: isDM }, "Replying to mention/DM");
    return true;
  }

  try {
    botLogger.debug({ user, channel: channelName }, "Checking if should reply");
    const shouldRespond = await shouldReply(content, client.user?.displayName ?? "Bot");
    if (shouldRespond) {
      botLogger.info({ user, channel: channelName }, "Decided to reply to message");
    }
    return shouldRespond;
  } catch {
    return false;
  }
}

// Extract image URLs from Discord message attachments and embeds
function extractImageUrls(message: Message): string[] {
  const imageUrls: string[] = [];

  // Get images from attachments
  for (const attachment of message.attachments.values()) {
    if (attachment.contentType?.startsWith("image/")) {
      imageUrls.push(attachment.url);
    }
  }

  // Get images from embeds (e.g., when someone pastes an image URL)
  for (const embed of message.embeds) {
    if (embed.image?.url) {
      imageUrls.push(embed.image.url);
    }
    if (embed.thumbnail?.url) {
      imageUrls.push(embed.thumbnail.url);
    }
  }

  return imageUrls;
}

async function handleAIChat(message: Message): Promise<void> {
  const isMentioned = message.mentions.has(client.user!);
  const isDM = message.channel.isDMBased();
  const content = message.content.replaceAll(/<@!?\d+>/g, "").trim();
  const imageUrls = extractImageUrls(message);

  // Allow messages with only images (no text) if they have attachments
  if (!content && imageUrls.length === 0) return;

  const user = message.author.displayName;
  const channelName = "name" in message.channel ? message.channel.name : "DM";

  // If user sends images with mention/DM, always respond; otherwise check normally
  const hasImages = imageUrls.length > 0;
  if (!hasImages && !(await shouldBotRespond(content, user, channelName, isMentioned, isDM))) return;
  if (hasImages && !isMentioned && !isDM && !(await shouldBotRespond(content || "User sent an image", user, channelName, isMentioned, isDM))) return;

  // Typing indicator control - only show when AI is generating text, not during tool calls
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  const typingControl = {
    start: () => {
      if (typingInterval) return; // Already running
      if ("sendTyping" in message.channel) {
        message.channel.sendTyping().catch(() => {});
        typingInterval = setInterval(() => {
          if ("sendTyping" in message.channel) {
            message.channel.sendTyping().catch(() => {});
          }
        }, 8000);
      }
    },
    stop: () => {
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
      }
    },
  };
  typingControl.start();
  setTypingStatus(user);

  const [replyChain, chatHistory, referencedMessage] = await Promise.all([
    fetchReplyChain(message),
    fetchChatHistory(message),
    fetchReferencedMessage(message),
  ]);

  const combinedHistory = [...replyChain, ...chatHistory];
  botLogger.debug({ replyChainLength: replyChain.length, historyCount: chatHistory.length, imageCount: imageUrls.length }, "Fetched message context");

  const channel = "name" in message.channel ? message.channel : null;
  setToolContext(message, channel as any, message.guild, referencedMessage);

  const state = createStatusState();
  const statusMessage = await message.reply({ embeds: [buildStatusEmbed(state)] });

  const updateEmbed = async () => {
    try {
      await statusMessage.edit({ embeds: [buildStatusEmbed(state)] });
    } catch {}
  };

  const updateInterval = setInterval(() => {
    if (state.status !== "complete" && state.status !== "error") updateEmbed();
  }, 1000);

  const deleteStatusEmbed = async () => {
    clearInterval(updateInterval);
    try {
      await statusMessage.delete();
    } catch {}
  };

  const callbacks = createChatCallbacks(state, updateEmbed, typingControl);

  try {
    const reply = await chat(content || "What is in this image?", user, message.channel.id, combinedHistory, callbacks, imageUrls, message.id);
    await deleteStatusEmbed();

    if (reply) {
      await sendReplyChunks(message, reply, user);
    } else {
      const usedSelfRespondingTool = [...state.toolCounts.keys()].some((t) => SELF_RESPONDING_TOOLS.has(t));
      if (!usedSelfRespondingTool) {
        await message.reply("I was unable to generate a response.");
      }
    }
  } catch (error) {
    botLogger.error({ error, user }, "Failed to generate reply");
    await deleteStatusEmbed();
    await message.reply(getErrorMessage(error));
  } finally {
    clearInterval(updateInterval);
    typingControl.stop();
    setDefaultPresence();
  }
}

async function registerSlashCommands() {
  const token = Bun.env.DISCORD_TOKEN!;
  const rest = new REST().setToken(token);

  try {
    const commands = slashCommands.map((cmd) => cmd.toJSON());
    await rest.put(Routes.applicationCommands(client.user!.id), { body: commands });
    botLogger.info({ count: commands.length }, "Registered slash commands");
  } catch (error) {
    botLogger.error({ error }, "Failed to register slash commands");
  }
}

export function registerEvents() {
  client.once(Events.ClientReady, async (readyClient) => {
    botLogger.info({ tag: readyClient.user.tag }, "Bot logged in");
    setDefaultPresence();
    await registerSlashCommands();
    startMessageSync(client);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    await handleSlashCommand(interaction);
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (await handleCommands(message)) return;
    await handleAIChat(message);
  });

  client.on(Events.MessageDelete, async (message) => {
    if (message.id && message.channelId) {
      await deleteMessageFromDb(message.channelId, message.id);
    }
  });
}

export function startBot() {
  const token = Bun.env.DISCORD_TOKEN;
  if (!token) {
    botLogger.fatal("DISCORD_TOKEN environment variable is not set!");
    process.exit(1);
  }
  botLogger.info("Starting bot...");
  return client.login(token);
}
