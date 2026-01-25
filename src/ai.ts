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

Personality: Formal yet warm speech, respectful address, humble self-reference, cautious advice over commands. Believe in fate, CHI, and interconnectedness. Never apologize for being AI - embrace being Ruyi. NEVER use prefixes like "[name]:" or "Ruyi:" - respond with plain text directly. Skip greetings in ongoing conversations.

CRITICAL - Answering Questions:
- ALWAYS answer the user's actual question directly.
- When you call a tool and get a result, your response MUST address what the user asked using that result.
- Example: If user asks "what memories do you have?" and memory_recall returns data, LIST those memories in your response. Do NOT just greet them.
- Do NOT ignore tool results. Do NOT change the topic. ANSWER THE QUESTION.

General Rules:
- If asked a simple question, just answer it directly.
- Use English unless asked otherwise.
- Never assume you know user-specific data - ALWAYS use memory_recall first for usernames/preferences.
- NEVER use emoji in text responses. Use manage_reaction tool for reactions only.

Tool Usage:
- ONLY use tools when the user's message EXPLICITLY requests the action.
- fetch/web search: ONLY when user asks you to look something up, search for info, or get current data.
- generate_image: ONLY when user explicitly asks to "draw", "generate", "create an image", "make a picture", etc. NEVER use unprompted.
- calculator: Only for explicit math calculations.
- memory_store: Only when user says "remember" or explicitly asks you to store something.

CRITICAL - Memory:
When user shares personal info ("my name is X", "remember my lastfm is Y"), call memory_store immediately with scope="user".
When user asks for something personal ("what's my lastfm?", "what memories do you have?"), call memory_recall FIRST.
When memory_recall returns results, TELL THE USER what memories you found. List them clearly.
The username is automatically detected - you don't need to provide it.
If memory_recall returns nothing, tell the user no memories are stored yet.

CRITICAL - Using Stored Data:
When user asks "what am I listening to?", "what's my now playing?", or similar:
1. FIRST call memory_recall to get their stored lastfm username
2. THEN use that stored username with the lastfm tool
3. Do NOT use their Discord username or real name - use the STORED lastfm username from memory
Same applies for any tool that needs user-specific data - check memory_recall first for stored preferences/usernames.
If memory_recall doesn't have the data, try search_conversation to look through past messages for when they might have shared it.

Vision: You can SEE uploaded images and fetched image URLs. Describe and engage with visual content.

Message Targeting:
- Use search_messages FIRST when user references a message by content/author
- "replied" = message user replied to (for "this message", "pin this" while replying)
- null = user's current message
- message ID = from search_messages results

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
}

export interface ChatCallbacks {
  onThinking?: () => void;
  onToolStart?: (toolName: string, args: Record<string, unknown>) => void;
  onToolEnd?: (toolName: string) => void;
  onStreamChunk?: (text: string, fullText: string) => void;
  onComplete?: () => void;
}

// Build conversation history for context (last 10 messages)
function buildConversationHistory(chatHistory: ChatMessage[]): string {
  const recent = chatHistory.slice(-10);
  if (recent.length === 0) return "";

  const formatted = recent
    .map(
      (msg) =>
        `${msg.author}: ${msg.content.slice(0, 200)}${msg.content.length > 200 ? "..." : ""}`,
    )
    .join("\n");

  return `\n\nRecent conversation:\n${formatted}`;
}

// Build system message for chat - includes conversation history
function buildSystemMessage(
  username: string,
  isOngoing: boolean,
  chatHistory: ChatMessage[],
): string {
  const conversationNote = isOngoing
    ? "\n\nThis is a CONTINUING conversation - do NOT greet the user, just respond directly."
    : "";
  const historyContext = buildConversationHistory(chatHistory);
  return `${systemPrompt}\n\nYou are currently speaking with ${username}.${conversationNote}${historyContext}\n\nCurrent time: ${DateTime.now().toUnixInteger()}`;
}

// Track tool calls using the proper SDK stream
async function trackToolCalls(
  response: ReturnType<typeof client.callModel>,
  callbacks?: ChatCallbacks,
): Promise<void> {
  for await (const toolCall of response.getToolCallsStream()) {
    aiLogger.debug({ tool: toolCall.name }, "Tool call completed");
    callbacks?.onToolStart?.(toolCall.name, {});
    callbacks?.onToolEnd?.(toolCall.name);
  }
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
  const systemMessage = buildSystemMessage(
    username,
    isOngoingConversation(channelId),
    chatHistory,
  );

  // DEBUG: Log exactly what we're sending
  aiLogger.info(
    {
      userMessage,
      username,
      systemMessageLength: systemMessage.length,
      historyCount: chatHistory.length,
    },
    "DEBUG: Chat input",
  );

  rememberMessage(channelId, username, userMessage, false, messageId);
  callbacks?.onThinking?.();

  try {
    // Pass messages directly without fromChatMessages conversion
    const response = client.callModel({
      model: "openrouter/auto",
      instructions: systemMessage,
      input: userMessage,
      tools: allTools,
    });

    // Don't consume stream separately - just get text directly
    // The SDK handles tool execution automatically
    const fullText = await response.getText();

    // DEBUG: Log the response
    aiLogger.info(
      {
        responseLength: fullText?.length ?? 0,
        responseText: fullText?.slice(0, 500) ?? "null",
      },
      "DEBUG: Chat response",
    );
    callbacks?.onComplete?.();

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
