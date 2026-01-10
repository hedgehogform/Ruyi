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

// Check if bot should respond to a non-mention/non-DM message
async function checkShouldRespond(
  content: string,
  user: string,
  channelName: string | null
): Promise<boolean> {
  botLogger.debug({ user, channel: channelName }, "Checking if should reply");
  const shouldRespond = await shouldReply(
    content,
    client.user?.displayName ?? "Bot"
  );
  if (!shouldRespond) {
    botLogger.debug({ user, channel: channelName }, "Decided not to reply");
    return false;
  }
  botLogger.info({ user, channel: channelName }, "Decided to reply to message");
  return true;
}

// Fetch recent chat history from channel
async function fetchChatHistory(message: Message): Promise<ChatMessage[]> {
  const chatHistory: ChatMessage[] = [];
  if (!("messages" in message.channel)) return chatHistory;

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
  return chatHistory;
}

// Create chat callbacks for status updates
function createChatCallbacks(
  state: StatusState,
  updateEmbed: () => Promise<void>
): ChatCallbacks {
  return {
    onThinking: () => {
      state.status = "thinking";
      state.currentTool = undefined;
    },
    onToolStart: (toolName) => {
      state.status = "tool";
      state.currentTool = toolName;
      updateEmbed();
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
}

// Get error message for OpenRouter API errors
function getErrorMessage(error: any): string {
  const status = error?.status || error?.code;
  const errorMsg = error?.error?.message || error?.message;

  if (status === 402) {
    return "Apologies, but I've run out of credits to process requests. Please try again later.";
  }
  if (status === 429) {
    return "I'm receiving too many requests right now. Please wait a moment.";
  }
  if (status === 503 || status === 502) {
    return "The AI service is temporarily unavailable. Please try again shortly.";
  }
  return `Something went wrong: ${errorMsg || "Unknown error"}`;
}

// Check if bot should respond and log appropriately
async function shouldBotRespond(
  content: string,
  user: string,
  channelName: string | null,
  isMentioned: boolean,
  isDM: boolean
): Promise<boolean> {
  if (isMentioned || isDM) {
    botLogger.info(
      { user, channel: channelName, mentioned: isMentioned, dm: isDM },
      "Replying to mention/DM"
    );
    return true;
  }

  try {
    return await checkShouldRespond(content, user, channelName);
  } catch {
    return false;
  }
}

async function handleAIChat(message: Message): Promise<void> {
  const isMentioned = message.mentions.has(client.user!);
  const isDM = message.channel.isDMBased();
  const content = message.content.replaceAll(/<@!?\d+>/g, "").trim();

  if (!content) return;

  const user = message.author.displayName;
  const channelName = "name" in message.channel ? message.channel.name : "DM";

  const shouldRespond = await shouldBotRespond(
    content,
    user,
    channelName,
    isMentioned,
    isDM
  );
  if (!shouldRespond) return;

  if ("sendTyping" in message.channel) {
    await message.channel.sendTyping();
  }
  setTypingStatus(user);

  const chatHistory = await fetchChatHistory(message);
  botLogger.debug({ historyCount: chatHistory.length }, "Fetched chat history");

  // Set tool context so tools can access Discord data
  const channel = "name" in message.channel ? message.channel : null;
  setToolContext(message, channel as any, message.guild);

  // Create status state and embed
  const state: StatusState = {
    status: "thinking",
    toolsUsed: [],
    startTime: Date.now(),
  };

  const statusMessage = await message.reply({
    embeds: [buildStatusEmbed(state)],
  });

  const updateEmbed = async () => {
    try {
      await statusMessage.edit({ embeds: [buildStatusEmbed(state)] });
    } catch {
      // Message may have been deleted
    }
  };

  const updateInterval = setInterval(() => {
    if (state.status !== "complete" && state.status !== "error") {
      updateEmbed();
    }
  }, 1000);

  const deleteStatusEmbed = async () => {
    clearInterval(updateInterval);
    try {
      await statusMessage.delete();
    } catch {
      // Message may have been deleted already
    }
  };

  const callbacks = createChatCallbacks(state, updateEmbed);

  try {
    const reply = await chat(
      content,
      user,
      message.channel.id,
      chatHistory,
      callbacks
    );
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
    await deleteStatusEmbed();
    await message.reply(getErrorMessage(error));
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
