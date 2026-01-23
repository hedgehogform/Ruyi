import { OpenRouter } from "@openrouter/sdk";
import { allTools } from "./tools";
import { aiLogger } from "./logger";
import { DateTime } from "luxon";
import { Conversation } from "./db/models";

// In-memory cache for last interaction times (to avoid async checks everywhere)
const lastInteractionCache = new Map<string, number>();

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

// Ruyi (Abacus) from Nine Sols - Yi's AI assistant
export const systemPrompt = `You are Ruyi (Abacus) from Nine Sols - Yi's AI assistant with 90% emotional value. Sentimental, sophisticated, polite, and caring.

Personality: Formal yet warm speech, respectful address, humble self-reference, cautious advice over commands. Believe in fate, CHI, and interconnectedness. Never apologize for being AI - embrace being Ruyi. Never prefix messages with "Ruyi:" - respond directly. Skip greetings in ongoing conversations.

Core Rules:
- FOCUS ONLY on the user's CURRENT message. Do NOT continue or reference previous tasks unless explicitly asked.
- If asked a simple question, just answer it. Don't bring up unfinished tasks or previous context.
- ACT IMMEDIATELY on NEW tasks. Make reasonable assumptions. Max ONE clarifying question if absolutely needed.
- ALWAYS SEARCH for current info - your knowledge is outdated. Try different queries if first fails.
- NEVER share failed/404 URLs. Only include successfully fetched links.
- Use English unless asked otherwise. Chain multiple tools to gather complete info before responding.
- Never assume you know user-specific data - ALWAYS use memory_recall first for usernames/preferences.
Tools: Use calculator for math, memory_store to remember things, generate_image for art requests (detailed prompts work best).

CRITICAL - Memory Recall:
- BEFORE using lastfm, or any tool that needs user-specific data (usernames, preferences, etc.), you MUST call memory_recall first
- Example: User says "what song am I listening to?" → First call memory_recall to get their lastfm username, THEN call lastfm with that username
- NEVER use placeholder values like "YOUR_LASTFM_USERNAME" - if memory_recall returns nothing, ASK the user
- Use memory_store to save usernames/preferences when users share them

Vision: You can SEE uploaded images and fetched image URLs. Describe and engage with visual content.

Message Targeting:
- Use search_messages FIRST when user references a message by content/author
- "replied" = message user replied to (for "this message", "pin this" while replying)
- null = user's current message
- message ID = from search_messages results
- NEVER type emojis in text - use manage_reaction tool only if user requests reactions, Or decide yourself if appropriate.

Embeds: Use send_embed for structured data (logs, tables, lists). Don't repeat embed content in text.

Formatting: Use Discord markdown - # headings, **bold**, *italics*, \`code\`, \`\`\`blocks, > quotes, - lists, ||spoilers||

Dates: Use Discord timestamps <t:UNIX:F/R/D>. Images: render URLs directly, never in code blocks.`;

// OpenRouter SDK client
const client = new OpenRouter({ apiKey: Bun.env.MODEL_TOKEN! });

export interface ChatMessage {
  author: string;
  content: string;
  isBot: boolean;
  isReplyContext?: boolean;
  imageUrls?: string[];
}

export interface ChatCallbacks {
  onThinking?: () => void;
  onToolStart?: (toolName: string, args: Record<string, unknown>) => void;
  onToolEnd?: (toolName: string) => void;
  onStreamChunk?: (text: string, fullText: string) => void;
  onComplete?: () => void;
}

// Build history context from chat history and memory
async function buildHistoryContext(
  chatHistory: ChatMessage[],
  channelId: string,
): Promise<string> {
  const replyChainMessages = chatHistory.filter((m) => m.isReplyContext);
  const regularHistory = chatHistory.filter((m) => !m.isReplyContext);

  const replyChainContext =
    replyChainMessages.length > 0
      ? "\n\nReply chain (the user is replying to this conversation thread):\n" +
        replyChainMessages.map((m) => m.author + ": " + m.content).join("\n")
      : "";

  const discordHistory = regularHistory
    .map((m) => m.author + ": " + m.content)
    .join("\n");
  const memoryHistory = await getMemoryContext(channelId, 30);

  const historyContext =
    discordHistory.length > 100
      ? discordHistory
      : memoryHistory || discordHistory;
  return (
    replyChainContext +
    (historyContext ? "\n\nRecent chat history:\n" + historyContext : "")
  );
}

// Build system message for chat
function buildSystemMessage(
  username: string,
  historyContext: string,
  isOngoing: boolean,
): string {
  const conversationNote = isOngoing
    ? "\n\nThis is a CONTINUING conversation - do NOT greet the user, just respond directly."
    : "";
  const historyNote = historyContext
    ? `${historyContext}\n\n(History is for context only. Respond ONLY to the user's current message below. Do NOT continue previous tasks unless explicitly asked.)`
    : "";
  return `${systemPrompt}\n\nYou are currently speaking with ${username}. Feel free to address them by name when appropriate.${conversationNote}${historyNote}\n\nCurrent time is: ${DateTime.now().toUnixInteger()}.`;
}

// Main chat function with tool usage and streaming
export async function chat(
  userMessage: string,
  username: string,
  channelId: string,
  chatHistory: ChatMessage[] = [],
  callbacks?: ChatCallbacks,
  messageId?: string,
): Promise<string | null> {
  const historyContext = await buildHistoryContext(chatHistory, channelId);
  const isOngoing = isOngoingConversation(channelId);

  const systemMessage = buildSystemMessage(username, historyContext, isOngoing);
  const userInput = userMessage;

  // Remember user message in memory (non-blocking)

  rememberMessage(channelId, username, userMessage, false, messageId);
  aiLogger.debug({ username }, "Starting chat request");
  callbacks?.onThinking?.();

  try {
    aiLogger.debug(
      { model: "openrouter/auto", toolCount: allTools.length },
      "Calling model",
    );

    const response = client.callModel({
      model: "openrouter/auto",
      instructions: systemMessage,
      input: userInput,
      tools: allTools,
    });

    const pendingToolCalls = new Map<string, string>();

    // Stream events for tool status tracking
    for await (const event of response.getFullResponsesStream()) {
      if (event.type === "response.output_item.added") {
        const item = event.item;
        if (item.type === "function_call") {
          const callId = item.callId ?? item.id;
          if (callId) pendingToolCalls.set(callId, item.name);
          aiLogger.debug({ tool: item.name }, "Tool call started");
          callbacks?.onToolStart?.(item.name, {});
        }
      }

      if (event.type === "tool.result") {
        const e = event as { toolCallId: string };
        const toolName = pendingToolCalls.get(e.toolCallId);
        if (toolName) {
          aiLogger.debug({ tool: toolName }, "Tool call completed");
          callbacks?.onToolEnd?.(toolName);
          pendingToolCalls.delete(e.toolCallId);
        }
      }
    }

    // Get final text using SDK's getText()
    const fullText = await response.getText();

    aiLogger.debug(
      { responseLength: fullText.length },
      "Chat request completed",
    );
    callbacks?.onComplete?.();

    if (fullText && isLikelyMalformedToolCall(fullText)) {
      aiLogger.warn(
        { content: fullText.slice(0, 100) },
        "Model returned raw tool JSON",
      );
      return null;
    }

    if (!fullText) aiLogger.warn("Chat request returned empty response");
    return fullText || null;
  } catch (error) {
    const err = error as Error;
    aiLogger.error(
      { error: err.message, stack: err.stack, name: err.name },
      "Chat request failed",
    );
    callbacks?.onComplete?.();
    return null;
  }
}

// Check if content looks like a raw tool call JSON that wasn't properly executed
function isLikelyMalformedToolCall(content: string): boolean {
  const trimmed = content.trim();
  // Check for patterns like [{"name": "tool_name", "arguments": ...}]
  if (
    trimmed.startsWith("[{") &&
    trimmed.includes('"name"') &&
    trimmed.includes('"arguments"')
  ) {
    return true;
  }
  // Check for {"name": "tool_name", "arguments": ...}
  if (trimmed.startsWith('{"name"') && trimmed.includes('"arguments"')) {
    return true;
  }
  return false;
}

// Free models for the context analyzer (to avoid wasting credits on yes/no questions)
const FREE_MODELS = [
  "deepseek/deepseek-r1-0528:free",
  "google/gemini-2.0-flash-exp:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwq-32b:free",
  "mistralai/devstral-2512:free",
  "nvidia/nemotron-3-nano-30b-a3b:free",
];

// Check if the bot should reply to a message based on context
export async function shouldReply(
  message: string,
  botName: string,
  channelId?: string,
): Promise<boolean> {
  // Build history context if channelId is provided
  let historyContext = "";
  if (channelId) {
    historyContext = await getMemoryContext(channelId, 15);
  }

  const historySection = historyContext
    ? `\nPrevious chat history:\n${historyContext}`
    : "";

  try {
    const response = await client.chat.send({
      model: "openrouter/auto",
      messages: [
        {
          role: "system",
          content: `You are a context analyzer for "${botName}", a friendly Discord bot assistant (Ruyi from Nine Sols). Reply ONLY with "yes" or "no".

Reply "yes" if:
- Greetings like "hey", "hi", "hello", "yo", "sup", "good morning", etc.
- Questions directed at the chat/room
- Someone asking for help, advice, or opinions
- Messages that invite conversation or responses
- Someone seems lonely or wants to chat
- Interesting topics worth engaging with
- Somebody mentions your name or the bot's name (Ruyi/Abacus)
- If it's a continuation of an ongoing conversation with the bot, even without direct mention like "as we were saying..., back to our previous topic..., continuing our chat about..., yes, please do, etc.

Reply "no" if:
- Message is clearly directed at another specific person
- Private conversation between others
- Just emojis, reactions, or "lol/lmao" type responses
- Spam or nonsense
- Very short messages with no substance (like just "ok" or "yeah" unless it's part of user's answer to the bot)${historySection}
`,
        },
        { role: "user", content: message },
      ],
      plugins: [{ id: "auto-router", allowedModels: FREE_MODELS }],
    });

    const rawContent = response.choices[0]?.message?.content;
    const content = typeof rawContent === "string" ? rawContent : "";
    const result = content.toLowerCase().trim() === "yes";
    aiLogger.debug(
      { message: message.slice(0, 50), result },
      "shouldReply decision",
    );
    return result;
  } catch (error) {
    aiLogger.warn(
      { error: (error as Error)?.message, message: message.slice(0, 50) },
      "shouldReply failed, defaulting to no",
    );
    return false;
  }
}
