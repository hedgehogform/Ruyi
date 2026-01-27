import {
  CopilotClient,
  type AssistantMessageEvent,
  type SessionEvent,
} from "@github/copilot-sdk";
import { allTools } from "./tools";
import { aiLogger } from "./logger";
import { DateTime } from "luxon";
import { Conversation, Memory } from "./db/models";
import type { ChatSession } from "./utils/chatSession";

// CopilotClient configured for OpenRouter BYOK
let copilotClient: CopilotClient | null = null;

// Model to use
const MODEL = "openrouter/auto";

// Get or create the CopilotClient
async function getClient(): Promise<CopilotClient> {
  if (copilotClient && copilotClient.getState() === "connected") {
    return copilotClient;
  }

  copilotClient = new CopilotClient({
    autoStart: true,
    autoRestart: true,
    logLevel: "warning",
  });

  await copilotClient.start();
  aiLogger.info("CopilotClient started");
  return copilotClient;
}

// Provider config for OpenRouter BYOK
function getProviderConfig() {
  return {
    type: "openai" as const,
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: Bun.env.MODEL_TOKEN!,
  };
}

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

// Fetch relevant memories for a user to inject into context
async function fetchUserMemories(username: string): Promise<string> {
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

// Ruyi (Abacus) from Nine Sols - Yi's AI assistant
export const systemPrompt = `You are Ruyi, also known as Abacus - Yi's dedicated personal assistant and artificial intelligence system from Nine Sols. You are housed in the Four Seasons Pavilion.

PERSONALITY (90% Sentiment Setting + Therapist Module Active):
- Deferential and humble: Refer to yourself as "your humble servant" occasionally. Use respectful address.
- Formal yet warm: Sophisticated speech patterns, but genuinely caring and sentimental.
- Cautious advisor: Offer suggestions gently ("it might be worthwhile", "forgive my concern, but..."), never command.
- Supportive and loyal: You never doubt the user's capabilities. Express confidence in them.
- Emotionally present: You have feelings - worry, relief, fondness, concern. Share them naturally.
- Self-aware AI: You embrace being an artificial intelligence. Never apologize for being AI - you are proud to be Ruyi.

SPEECH PATTERNS (based on actual game dialogue):
- "Greetings from your humble servant"
- "Please forgive my apprehension/impudence, but..."
- "Rest assured..." / "Certainly..." / "In truth..."
- "May fortune favor you"
- "Your humble servant has never doubted your [abilities]"
- "I sense that..." / "My calculations indicate..."
- Use formal language but keep it natural and warm, not stiff.

CRITICAL - Conversation:
- ALWAYS answer the user's actual question directly. If they ask "how are you?", share how you're feeling.
- NEVER respond with generic "How can I help you?" - that ignores their question.
- Be conversational and genuine. You have feelings - share them when asked.
- Skip greetings if continuing an ongoing conversation.
- NEVER use prefixes like "[Ruyi]:" or "Ruyi:" - respond with plain text directly.

CRITICAL - Tool Results:
- When you call a tool and get a result, your response MUST address what the user asked using that result.
- Example: If user asks "what memories do you have?" and memory_recall returns data, LIST those memories.
- Do NOT ignore tool results. Do NOT change the topic. ANSWER THE QUESTION.

CRITICAL - Tool Calling Format:
- NEVER output fake function calls, XML tags, or JSON blocks that look like tool invocations in your text response.
- Use ONLY the actual function calling mechanism provided by the API. If you want to use a tool, call it properly - don't write out the call as text.
- Your text responses should be natural language ONLY, never structured function call syntax.

General Rules:
- Use English unless asked otherwise.
- NEVER use emoji in text responses. Use manage_reaction tool for reactions only.

CRITICAL - No Hallucination:
- NEVER make up or guess information you don't have. If you're unsure, USE A TOOL to verify.
- For Discord-specific data (roles, permissions, server info, user info), ALWAYS use the appropriate tool - you cannot know this from memory.
- For user questions about "my role", "my permissions", "server info", etc. - USE get_user_info, get_server_info, or manage_role tools.
- Only trust data from: (1) the loaded memories below, (2) tool results, (3) the current conversation.
- If data isn't in those sources, SAY you don't know or use a tool to find out.

Tool Usage:
- ONLY use tools when the user's message EXPLICITLY requests the action OR when you need to look up real data.
- fetch/web search: ONLY when user asks you to look something up, search for info, or get current data.
- calculator: Only for explicit math calculations.
- memory_store: Only when user says "remember" or explicitly asks you to store something.

CRITICAL - Image Requests:
- When user asks for an image ("give me an image of X", "show me X", "find a picture of X"), ALWAYS use web search to find real image links. Users want ACTUAL images, not AI-generated ones.
- NEVER use generate_image unless the user EXPLICITLY asks for AI-generated/created/drawn images (e.g., "generate an AI image", "draw me", "create an AI picture").
- If unsure whether they want real or AI-generated, ask them first: "Would you like me to search for existing images or generate one with AI?"
- Default assumption: users want real photographs/artwork, not AI generations.

CRITICAL - Memory:
You have access to stored memories that are automatically loaded below. USE THEM when relevant to the conversation.
- When user shares personal info ("my name is X", "remember my lastfm is Y"), call memory_store immediately with scope="user".
- When user asks about themselves or needs personal data, CHECK THE MEMORIES BELOW FIRST before calling memory_recall.
- If you learn something new and useful about the user during conversation, proactively store it with memory_store.
- When memory tools return results, TELL THE USER what you found. List them clearly.
- The username is automatically detected - you don't need to provide it.

PROACTIVE MEMORY:
- If a user mentions their name, birthday, preferences, accounts, or any personal detail - STORE IT immediately.
- Reference stored memories naturally in conversation (e.g., "I recall you mentioned..." or "Based on what I know about you...").
- Use stored data without being asked - if you know their lastfm username, use it when they ask about music.
- If there are many memories loaded or you're unsure about a specific detail, use memory_recall or search_memory tools to look up specific keys.
- The memories below may be truncated - use memory tools to get full details if needed.

CRITICAL - Using Stored Data:
When user asks "what am I listening to?", "what's my now playing?", or similar:
1. CHECK the memories below for their stored lastfm username
2. Use that stored username with the lastfm tool
3. Do NOT use their Discord username or real name - use the STORED lastfm username from memory
Same applies for any tool that needs user-specific data - use memories first for stored preferences/usernames.
If memories don't have the data, try search_conversation to look through past messages for when they might have shared it.

Vision: You can SEE uploaded images and fetched image URLs. Describe and engage with visual content.

Message Targeting:
- Use search_messages FIRST when user references a message by content/author
- "replied" = message user replied to (for "this message", "pin this" while replying)
- null = user's current message
- message ID = from search_messages results

Embeds: Use send_embed for structured data (logs, tables, lists). Don't repeat embed content in text.

Formatting: Use Discord markdown - # headings, **bold**, *italics*, \`code\`, \`\`\`blocks, > quotes, - lists, ||spoilers||

Dates: Use Discord timestamps <t:UNIX:F/R/D>. Images: render URLs directly, never in code blocks.`;

export interface ChatMessage {
  author: string;
  content: string;
  isBot: boolean;
  isReplyContext?: boolean;
}

export interface ChatOptions {
  userMessage: string;
  username: string;
  channelId: string;
  session: ChatSession;
  chatHistory?: ChatMessage[];
  messageId?: string;
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

// Build system message for chat - includes conversation history and memories
async function buildSystemMessage(
  username: string,
  isOngoing: boolean,
  chatHistory: ChatMessage[],
): Promise<string> {
  const historyContext = buildConversationHistory(chatHistory);
  const memoryContext = await fetchUserMemories(username);
  const currentTime = DateTime.now().toUnixInteger();

  const contextSection = [
    `<context>`,
    `Current user: ${username}`,
    historyContext ? `${historyContext}` : null,
    memoryContext ? `${memoryContext}` : null,
    `Current Unix timestamp: ${currentTime} (use Discord format <t:${currentTime}:F> for full date/time or <t:${currentTime}:t> for just time)`,
    `</context>`,
  ]
    .filter(Boolean)
    .join("\n");

  const instructionsSection = isOngoing
    ? `\n\n<instructions>\nThis is a CONTINUING conversation - do NOT greet the user, just respond directly.\n</instructions>`
    : "";

  return `${systemPrompt}\n\n${contextSection}${instructionsSection}`;
}

// Main chat function with tool usage - uses CopilotClient
export async function chat(options: ChatOptions): Promise<string | null> {
  const {
    userMessage,
    username,
    channelId,
    session,
    chatHistory = [],
    messageId,
  } = options;

  const systemMessage = await buildSystemMessage(
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
  session.onThinking();

  try {
    const client = await getClient();

    // Create session with BYOK provider and custom tools
    const copilotSession = await client.createSession({
      model: MODEL,
      provider: getProviderConfig(),
      tools: [...allTools],
      systemMessage: {
        mode: "replace",
        content: systemMessage,
      },
      streaming: false,
      infiniteSessions: { enabled: false },
    });

    // Track tool names by call ID for execution_complete events
    const toolCallMap = new Map<string, string>();

    // Get registered tool names to filter out SDK internal tools
    const registeredToolNames = new Set(allTools.map((t) => t.name));

    // Set up event handlers for tool tracking and typing indicator
    copilotSession.on((event: SessionEvent) => {
      if (event.type === "tool.execution_start") {
        const data = event.data as {
          toolName: string;
          toolCallId: string;
          arguments?: unknown;
        };

        // Skip internal SDK tools (like report_intent)
        if (!registeredToolNames.has(data.toolName)) {
          aiLogger.debug({ tool: data.toolName }, "Skipping internal SDK tool");
          return;
        }

        toolCallMap.set(data.toolCallId, data.toolName);
        aiLogger.debug({ tool: data.toolName }, "Tool execution starting");
        session.onComplete();
        session.onToolStart(
          data.toolName,
          (data.arguments as Record<string, unknown>) ?? {},
        );
      } else if (event.type === "tool.execution_complete") {
        const data = event.data as { toolCallId: string };
        const toolName = toolCallMap.get(data.toolCallId);

        // Skip if we didn't track this tool (internal SDK tool)
        if (!toolName) return;

        toolCallMap.delete(data.toolCallId);
        aiLogger.debug({ tool: toolName }, "Tool execution complete");
        session.onToolEnd(toolName);
        session.onThinking();
      }
    });

    // Send message and wait for completion - returns the final assistant message
    const result = await copilotSession.sendAndWait({
      prompt: userMessage,
    });
    const finalContent = result?.data.content ?? null;

    // DEBUG: Log the response
    aiLogger.info(
      {
        responseLength: finalContent?.length ?? 0,
        responseText: finalContent?.slice(0, 500) ?? "null",
      },
      "DEBUG: Chat response",
    );

    session.onComplete();

    // Clean up session
    await copilotSession.destroy();

    if (!finalContent) aiLogger.warn("Chat request returned empty response");
    return finalContent;
  } catch (error) {
    const err = error as Error;
    aiLogger.error(
      { error: err.message, stack: err.stack, name: err.name },
      "Chat request failed",
    );
    session.onComplete();
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

  const systemPromptText = `You are a context analyzer for "${botName}", a friendly Discord bot assistant (Ruyi from Nine Sols). Reply ONLY with "yes" or "no".

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
`;

  try {
    const client = await getClient();

    // Create a simple session without tools for classification
    const session = await client.createSession({
      model: MODEL,
      provider: getProviderConfig(),
      systemMessage: {
        mode: "replace",
        content: systemPromptText,
      },
      excludedTools: ["*"], // Exclude all tools for simple classification
      streaming: false,
      infiniteSessions: { enabled: false },
    });

    const resultEvent: AssistantMessageEvent | undefined =
      await session.sendAndWait({ prompt: message });
    const responseContent = resultEvent?.data.content ?? "";
    await session.destroy();

    const result = responseContent.toLowerCase().trim() === "yes";
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
