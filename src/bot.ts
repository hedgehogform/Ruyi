import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  type Message,
  type GuildTextBasedChannel,
} from "discord.js";
import { chat, shouldReply, rememberMessage } from "./ai";
import { setToolContext } from "./tools";
import { botLogger } from "./logger";
import { handleCommands } from "./commands";
import {
  slashCommands,
  handleSlashCommand,
  handleSmitherySelect,
  handleSmitheryCodeButton,
  handleSmitheryModal,
} from "./slashCommands";
import { ChatSession } from "./utils/chatSession";
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
  username: string,
  channelName: string | null,
  isMentioned: boolean,
  isDM: boolean,
  isReplyToBot: boolean,
  channelId: string,
): Promise<boolean> {
  // Skip shouldReply check entirely for mentions, DMs, or replies to bot - always respond
  if (isMentioned || isDM || isReplyToBot) {
    botLogger.info(
      {
        user: username,
        channel: channelName,
        mentioned: isMentioned,
        dm: isDM,
        replyToBot: isReplyToBot,
      },
      "Replying to mention/DM/reply",
    );
    return true;
  }

  // Only run shouldReply for standalone messages (saves tokens)
  try {
    botLogger.debug(
      { user: username, channel: channelName, content: content.slice(0, 50) },
      "Checking if should reply to standalone message",
    );
    const shouldRespond = await shouldReply(
      content,
      client.user?.username ?? "Bot",
      channelId,
    );
    if (shouldRespond) {
      botLogger.info(
        { user: username, channel: channelName, content: content.slice(0, 50) },
        "Decided to reply to message",
      );
    } else {
      botLogger.debug(
        { user: username, channel: channelName, content: content.slice(0, 50) },
        "Decided NOT to reply to message",
      );
    }
    return shouldRespond;
  } catch (error) {
    botLogger.error(
      {
        error: (error as Error)?.message,
        user: username,
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
  const isReplyToBot =
    message.reference?.messageId != null &&
    (await message.channel.messages
      .fetch(message.reference.messageId)
      .then((msg) => msg.author.id === client.user!.id)
      .catch(() => false));
  const content = message.content.trim();

  const username = message.author.username;
  const channelName = "name" in message.channel ? message.channel.name : "DM";

  const shouldRespond = await shouldBotRespond(
    content,
    username,
    channelName,
    isMentioned,
    isDM,
    isReplyToBot,
    message.channel.id,
  );

  if (!shouldRespond) return;

  const session = new ChatSession(message.channel);
  session.startTyping();
  setTypingStatus(message.author.displayName);

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

  await session.sendStatusEmbed(message);

  // Cast channel - permission prompts work best in guild channels
  // DMs will still work but permissions may auto-deny if context is missing
  const guildChannel = message.channel as GuildTextBasedChannel;

  try {
    const reply = await chat({
      userMessage: content,
      username,
      channelId: message.channel.id,
      channel: guildChannel,
      userId: message.author.id,
      session,
      chatHistory: combinedHistory,
      messageId: message.id,
    });
    await session.deleteStatusEmbed();

    if (reply) {
      const sentChunks = await sendReplyChunks(message, reply, username);
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
      const usedSelfRespondingTool = session.usedSelfRespondingTool(
        SELF_RESPONDING_TOOLS,
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
      {
        status: err?.status || err?.code,
        error: err?.error?.message,
        user: username,
      },
      "Failed to generate reply",
    );
    await session.deleteStatusEmbed();
    await message.reply(getErrorMessage(error));
  } finally {
    session.cleanup();
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
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (interaction.isStringSelectMenu()) {
      if (interaction.customId === "smithery_select_server") {
        await handleSmitherySelect(interaction);
      }
    } else if (interaction.isButton()) {
      if (interaction.customId === "smithery_enter_code") {
        await handleSmitheryCodeButton(interaction);
      }
    } else if (interaction.isModalSubmit()) {
      if (interaction.customId === "smithery_code_modal") {
        await handleSmitheryModal(interaction);
      }
    }
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
