import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  type Message,
} from "discord.js";
import { chat, shouldReply, rememberMessage } from "./ai";
import { setToolContext } from "./tools";
import { botLogger } from "./logger";
import { handleCommands } from "./commands";
import { slashCommands, handleSlashCommand } from "./slashCommands";
import {
  createStatusState,
  buildStatusEmbed,
  createChatCallbacks,
} from "./utils/status";
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
  isDM: boolean,
  channelId: string,
): Promise<boolean> {
  if (isMentioned || isDM) {
    botLogger.info(
      { user, channel: channelName, mentioned: isMentioned, dm: isDM },
      "Replying to mention/DM",
    );
    return true;
  }

  try {
    botLogger.debug(
      { user, channel: channelName, content: content.slice(0, 50) },
      "Checking if should reply",
    );
    const shouldRespond = await shouldReply(
      content,
      client.user?.displayName ?? "Bot",
      channelId,
    );
    if (shouldRespond) {
      botLogger.info(
        { user, channel: channelName, content: content.slice(0, 50) },
        "Decided to reply to message",
      );
    } else {
      botLogger.debug(
        { user, channel: channelName, content: content.slice(0, 50) },
        "Decided NOT to reply to message",
      );
    }
    return shouldRespond;
  } catch (error) {
    botLogger.error(
      {
        error: (error as Error)?.message,
        user,
        channel: channelName,
        content: content.slice(0, 50),
      },
      "Error checking if should reply",
    );
    return false;
  }
}

async function handleAIChat(message: Message): Promise<void> {
  const isMentioned = message.mentions.has(client.user!);
  const isDM = message.channel.isDMBased();
  const content = message.content.replaceAll(/<@!?\d+>/g, "").trim();

  const user = message.author.displayName;
  const channelName = "name" in message.channel ? message.channel.name : "DM";

  const shouldRespond = await shouldBotRespond(
    content,
    user,
    channelName,
    isMentioned,
    isDM,
    message.channel.id,
  );

  if (!shouldRespond) return;

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
  botLogger.debug(
    {
      replyChainLength: replyChain.length,
      historyCount: chatHistory.length,
    },
    "Fetched message context",
  );

  const channel = "name" in message.channel ? message.channel : null;
  setToolContext(message, channel as any, message.guild, referencedMessage);

  const state = createStatusState();
  const statusMessage = await message.reply({
    embeds: [buildStatusEmbed(state)],
  });

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
    const reply = await chat(
      content,
      user,
      message.channel.id,
      combinedHistory,
      callbacks,
      message.id,
    );
    await deleteStatusEmbed();

    if (reply) {
      const sentChunks = await sendReplyChunks(message, reply, user);
      // Store each chunk with its own message ID
      for (const chunk of sentChunks) {
        rememberMessage(
          message.channel.id,
          "Ruyi",
          chunk.content,
          true,
          chunk.id,
        );
      }
    } else {
      const usedSelfRespondingTool = [...state.toolCounts.keys()].some((t) =>
        SELF_RESPONDING_TOOLS.has(t),
      );
      if (!usedSelfRespondingTool) {
        await message.reply("I was unable to generate a response.");
      }
    }
  } catch (error) {
    const err = error as {
      status?: number;
      code?: number;
      error?: { message?: string };
    };
    botLogger.error(
      { status: err?.status || err?.code, error: err?.error?.message, user },
      "Failed to generate reply",
    );
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
    await rest.put(Routes.applicationCommands(client.user!.id), {
      body: commands,
    });
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
