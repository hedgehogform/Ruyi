import {
  ActivityType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  type Message,
} from "discord.js";
import { chat, shouldReply, type ChatMessage, type ChatCallbacks } from "./ai";
import { setToolContext } from "./tools";
import { botLogger } from "./logger";

// Client setup
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers, // REQUIRED
  ],
});

function setDefaultPresence() {
  client.user?.setPresence({
    activities: [{ name: "Serving...", type: ActivityType.Watching }],
  });
}

// Status helpers
function setTypingStatus(username: string) {
  client.user?.setActivity(`Assisting ${username}...`, {
    type: ActivityType.Custom,
    state: `Assisting ${username}...`,
  });
}

function clearStatus() {
  setDefaultPresence();
}

// Status embed builder
interface StatusState {
  status: "thinking" | "tool" | "complete" | "error";
  currentTool?: string;
  toolsUsed: string[];
  startTime: number;
}

function getStatusColor(status: StatusState["status"]): number {
  if (status === "complete") return 0x00ff00;
  if (status === "error") return 0xff0000;
  return 0xffaa00;
}

function buildStatusEmbed(state: StatusState): EmbedBuilder {
  const elapsed = Math.floor((Date.now() - state.startTime) / 1000);

  const embed = new EmbedBuilder()
    .setTitle("Ruyi")
    .setColor(getStatusColor(state.status))
    .setTimestamp();

  // Status field
  let statusText: string;
  switch (state.status) {
    case "thinking":
      statusText = "Thinking...";
      break;
    case "tool":
      statusText = `Running: \`${state.currentTool}\``;
      break;
    case "complete":
      statusText = "Complete";
      break;
    case "error":
      statusText = "Error";
      break;
  }
  embed.addFields({ name: "Status", value: statusText, inline: true });
  embed.addFields({ name: "Time", value: `${elapsed}s`, inline: true });

  // Tools used
  if (state.toolsUsed.length > 0) {
    const toolList = state.toolsUsed.map((t) => `\`${t}\``).join(", ");
    embed.addFields({ name: "Tools Used", value: toolList, inline: false });
  }

  return embed;
}

// Message handlers
async function handlePing(message: Message): Promise<boolean> {
  if (message.content === "!ping") {
    botLogger.debug({ user: message.author.displayName }, "Ping command");
    await message.reply("Pong!");
    return true;
  }
  return false;
}

async function handleAIChat(message: Message): Promise<void> {
  const isMentioned = message.mentions.has(client.user!);
  const isDM = message.channel.isDMBased();
  const content = message.content.replaceAll(/<@!?\d+>/g, "").trim();

  if (!content) return;

  const user = message.author.displayName;
  const channelName = "name" in message.channel ? message.channel.name : "DM";

  // Always reply to mentions and DMs
  // For regular messages, check if we should reply based on context
  if (!isMentioned && !isDM) {
    try {
      botLogger.debug(
        { user, channel: channelName },
        "Checking if should reply"
      );
      const shouldRespond = await shouldReply(
        content,
        client.user?.displayName ?? "Bot"
      );
      if (!shouldRespond) {
        botLogger.debug({ user, channel: channelName }, "Decided not to reply");
        return;
      }
      botLogger.info(
        { user, channel: channelName },
        "Decided to reply to message"
      );
    } catch {
      return;
    }
  } else {
    botLogger.info(
      { user, channel: channelName, mentioned: isMentioned, dm: isDM },
      "Replying to mention/DM"
    );
  }

  if ("sendTyping" in message.channel) {
    await message.channel.sendTyping();
  }
  setTypingStatus(user);

  // Fetch recent chat history
  const chatHistory: ChatMessage[] = [];
  if ("messages" in message.channel) {
    const messages = await message.channel.messages.fetch({ limit: 15 });
    const sorted = [...messages.values()].reverse();
    for (const msg of sorted) {
      if (msg.id === message.id) continue;
      chatHistory.push({
        author: msg.author.displayName,
        content: msg.content.replaceAll(/<@!?\d+>/g, "").trim(),
        isBot: msg.author.bot,
      });
    }
  }

  botLogger.debug({ historyCount: chatHistory.length }, "Fetched chat history");

  // Set tool context so tools can access Discord data
  const channel = "name" in message.channel ? message.channel : null;
  const guild = message.guild;
  setToolContext(message, channel as any, guild);

  // Create status state and embed
  const state: StatusState = {
    status: "thinking",
    toolsUsed: [],
    startTime: Date.now(),
  };

  const statusEmbed = buildStatusEmbed(state);
  const statusMessage = await message.reply({ embeds: [statusEmbed] });

  // Update embed helper
  const updateEmbed = async () => {
    try {
      await statusMessage.edit({ embeds: [buildStatusEmbed(state)] });
    } catch {
      // Message may have been deleted
    }
  };

  // Start interval to update embed every second
  const updateInterval = setInterval(() => {
    if (state.status !== "complete" && state.status !== "error") {
      updateEmbed();
    }
  }, 1000);

  // Callbacks for chat progress
  const callbacks: ChatCallbacks = {
    onThinking: () => {
      state.status = "thinking";
      state.currentTool = undefined;
    },
    onToolStart: (toolName) => {
      state.status = "tool";
      state.currentTool = toolName;
      updateEmbed(); // Immediate update on tool change
    },
    onToolEnd: (toolName) => {
      if (!state.toolsUsed.includes(toolName)) {
        state.toolsUsed.push(toolName);
      }
    },
    onComplete: () => {
      state.status = "complete";
      state.currentTool = undefined;
    },
  };

  // Helper to delete status embed silently
  const deleteStatusEmbed = async () => {
    clearInterval(updateInterval);
    try {
      await statusMessage.delete();
    } catch {
      // Message may have been deleted already
    }
  };

  try {
    const reply = await chat(content, user, chatHistory, callbacks);

    // Delete status embed and send normal reply
    await deleteStatusEmbed();

    if (reply) {
      const truncated =
        reply.length > 2000 ? reply.slice(0, 1997) + "..." : reply;
      await message.reply(truncated);
      botLogger.info({ user, replyLength: reply.length }, "Sent reply");
    } else {
      await message.reply("I was unable to generate a response.");
    }
  } catch (error: any) {
    botLogger.error({ error, user }, "Failed to generate reply");

    // Delete status embed
    await deleteStatusEmbed();

    // Handle OpenRouter specific errors
    const status = error?.status || error?.code;
    const errorMsg = error?.error?.message || error?.message;

    if (status === 402) {
      await message.reply(
        "Apologies, but I've run out of credits to process requests. Please try again later."
      );
    } else if (status === 429) {
      await message.reply(
        "I'm receiving too many requests right now. Please wait a moment."
      );
    } else if (status === 503 || status === 502) {
      await message.reply(
        "The AI service is temporarily unavailable. Please try again shortly."
      );
    } else {
      await message.reply(
        `Something went wrong: ${errorMsg || "Unknown error"}`
      );
    }
  } finally {
    clearInterval(updateInterval);
    clearStatus();
  }
}

// Register events
export function registerEvents() {
  client.once(Events.ClientReady, (readyClient) => {
    botLogger.info({ tag: readyClient.user.tag }, "Bot logged in");

    // Set initial presence
    setDefaultPresence();
  });

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    if (await handlePing(message)) return;

    await handleAIChat(message);
  });
}

// Start bot
export function startBot() {
  const token = Bun.env.DISCORD_TOKEN;
  if (!token) {
    botLogger.fatal("DISCORD_TOKEN environment variable is not set!");
    process.exit(1);
  }
  botLogger.info("Starting bot...");
  return client.login(token);
}
