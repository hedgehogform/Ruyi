import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  type Message,
} from "discord.js";
import { chat, shouldReply } from "./ai";

// Client setup
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Status helpers
function setTypingStatus(username: string) {
  client.user?.setActivity(`Assisting ${username}...`, {
    type: ActivityType.Custom,
    state: `Assisting ${username}...`,
  });
}

function clearStatus() {
  client.user?.setPresence({ activities: [] });
}

// Message handlers
async function handlePing(message: Message): Promise<boolean> {
  if (message.content === "!ping") {
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

  // Always reply to mentions and DMs
  // For regular messages, check if we should reply based on context
  if (!isMentioned && !isDM) {
    try {
      const shouldRespond = await shouldReply(
        content,
        client.user?.displayName ?? "Bot"
      );
      if (!shouldRespond) return;
    } catch {
      return;
    }
  }

  if ("sendTyping" in message.channel) {
    await message.channel.sendTyping();
  }
  setTypingStatus(message.author.displayName);

  try {
    const reply = await chat(content);

    if (reply) {
      const truncated =
        reply.length > 2000 ? reply.slice(0, 1997) + "..." : reply;
      await message.reply(truncated);
    }
  } catch (error) {
    console.error("OpenRouter error:", error);
    await message.reply("Sorry, I couldn't process that request.");
  } finally {
    clearStatus();
  }
}

// Register events
export function registerEvents() {
  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Logged in as ${readyClient.user.tag}`);
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
    console.error("DISCORD_TOKEN environment variable is not set!");
    process.exit(1);
  }
  return client.login(token);
}
