import { DateTime } from "luxon";
import { Conversation, Memory } from "../db/models";
import { aiLogger } from "../logger";

// In-memory cache for last interaction times (to avoid async checks everywhere)
const lastInteractionCache = new Map<string, number>();

export interface ChatMessage {
  author: string;
  content: string;
  isBot: boolean;
  isReplyContext?: boolean;
}

// Add message to memory
export async function rememberMessage(
  channelId: string,
  author: string,
  content: string,
  isBot: boolean,
  messageId?: string,
): Promise<void> {
  try {
    await Conversation.updateOne(
      { channelId },
      {
        $push: {
          messages: {
            $each: [
              { messageId, author, content, isBot, timestamp: new Date() },
            ],
            $slice: -100, // Keep only last 100 messages
          },
        },
        $set: { lastInteraction: new Date() },
      },
      { upsert: true },
    );
    lastInteractionCache.set(channelId, Date.now());
  } catch (error) {
    aiLogger.error({ error }, "Failed to save message to memory");
  }
}

// Get conversation history from memory
export async function getMemoryContext(
  channelId: string,
  limit = 20,
): Promise<string> {
  try {
    const conversation = await Conversation.findOne({ channelId });
    if (!conversation || conversation.messages.length === 0) return "";

    const recent = conversation.messages.slice(-limit);
    return recent.map((m) => `${m.author}: ${m.content}`).join("\n");
  } catch (error) {
    aiLogger.error({ error }, "Failed to get memory context");
    return "";
  }
}

// Check if this is a continuing conversation (within last 30 minutes)
export function isOngoingConversation(channelId: string): boolean {
  const lastTime = lastInteractionCache.get(channelId);
  if (!lastTime) return false;
  const thirtyMinutes = 30 * 60 * 1000;
  return Date.now() - lastTime < thirtyMinutes;
}

// Load last interaction times from DB on startup
export async function loadLastInteractions(): Promise<void> {
  try {
    const conversations = await Conversation.find(
      {},
      { channelId: 1, lastInteraction: 1 },
    );
    for (const conv of conversations) {
      if (conv.lastInteraction) {
        lastInteractionCache.set(
          conv.channelId,
          conv.lastInteraction.getTime(),
        );
      }
    }
    aiLogger.info(
      { count: conversations.length },
      "Loaded last interaction times",
    );
  } catch (error) {
    aiLogger.error({ error }, "Failed to load last interactions");
  }
}

// Fetch relevant memories for a user to inject into context
export async function fetchUserMemories(username: string): Promise<string> {
  try {
    const userMemories = await Memory.find({ scope: "user", username }).limit(
      20,
    );
    const globalMemories = await Memory.find({ scope: "global" }).limit(10);

    const lines: string[] = [];

    if (userMemories.length > 0) {
      lines.push(`Stored memories about ${username}:`);
      for (const m of userMemories) {
        lines.push(`  - ${m.key}: ${m.value}`);
      }
    }

    if (globalMemories.length > 0) {
      lines.push("Global memories:");
      for (const m of globalMemories) {
        lines.push(`  - ${m.key}: ${m.value}`);
      }
    }

    if (lines.length === 0) {
      return "";
    }

    aiLogger.debug(
      {
        username,
        userCount: userMemories.length,
        globalCount: globalMemories.length,
      },
      "Fetched memories for context",
    );

    return "\n\n" + lines.join("\n");
  } catch (error) {
    aiLogger.error({ error }, "Failed to fetch user memories");
    return "";
  }
}

// Build conversation history for context (last 20 messages)
// Mark bot's own messages clearly so it can avoid repetition
export function buildConversationHistory(chatHistory: ChatMessage[]): string {
  const recent = chatHistory.slice(-20);
  if (recent.length === 0) return "";

  const formatted = recent
    .map((msg) => {
      // Mark bot's own messages clearly so it knows what it already said
      const prefix = msg.isBot ? "[You]" : msg.author;
      // Full content - no truncation
      return `${prefix}: ${msg.content}`;
    })
    .join("\n");

  return `\n\nConversation history (messages marked [You] are YOUR previous responses - DO NOT repeat them):\n${formatted}`;
}

// Build dynamic context to prepend to user messages (for persistent sessions)
// This includes per-message context like current user, time, memories, and chat history
export async function buildDynamicContext(
  username: string,
  channelId: string,
  chatHistory: ChatMessage[],
): Promise<string> {
  const historyContext = buildConversationHistory(chatHistory);
  const memoryContext = await fetchUserMemories(username);
  const currentTime = DateTime.now().toUnixInteger();
  const isOngoing = isOngoingConversation(channelId);

  const contextLines = [
    `<context>`,
    `Current user: ${username}`,
    `CURRENT TIME: Unix ${currentTime} — Use <t:${currentTime}:t> for time, <t:${currentTime}:F> for full datetime, <t:${currentTime}:R> for relative`,
    historyContext ? `${historyContext}` : null,
    memoryContext ? `${memoryContext}` : null,
    `</context>`,
  ]
    .filter(Boolean)
    .join("\n");

  const instructionsSection = isOngoing
    ? `\n<instructions>\nThis is a CONTINUING conversation - do NOT greet the user, just respond directly.\nCRITICAL: Review your [You] messages above. You MUST NOT repeat any phrase, question, or sentiment from those messages. If you already asked "what's on your mind" or said "I understand" - use COMPLETELY DIFFERENT words now.\n</instructions>\n`
    : "";

  return `${contextLines}${instructionsSection}`;
}
