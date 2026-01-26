import OpenAI from "openai";
import { allTools, toOpenAITools, executeTool } from "./tools";
import { aiLogger } from "./logger";
import { DateTime } from "luxon";
import { Conversation } from "./db/models";

// OpenAI client configured for OpenRouter
const client = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: Bun.env.MODEL_TOKEN!,
});

// Model to use
const MODEL = "openrouter/auto";

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

General Rules:
- Use English unless asked otherwise.
- Never assume you know user-specific data - ALWAYS use memory_recall first for usernames/preferences.
- NEVER use emoji in text responses. Use manage_reaction tool for reactions only.

Tool Usage:
- ONLY use tools when the user's message EXPLICITLY requests the action.
- fetch/web search: ONLY when user asks you to look something up, search for info, or get current data.
- calculator: Only for explicit math calculations.
- memory_store: Only when user says "remember" or explicitly asks you to store something.

CRITICAL - Image Requests:
- When user asks for an image ("give me an image of X", "show me X", "find a picture of X"), ALWAYS use web search to find real image links. Users want ACTUAL images, not AI-generated ones.
- NEVER use generate_image unless the user EXPLICITLY asks for AI-generated/created/drawn images (e.g., "generate an AI image", "draw me", "create an AI picture").
- If unsure whether they want real or AI-generated, ask them first: "Would you like me to search for existing images or generate one with AI?"
- Default assumption: users want real photographs/artwork, not AI generations.

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

// Main chat function with tool usage
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
    // Build messages array for OpenAI
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: systemMessage },
      { role: "user", content: userMessage },
    ];

    // Convert tools to OpenAI format
    const openAITools = toOpenAITools([...allTools]);

    // Tool calling loop - max 10 iterations to prevent infinite loops
    const MAX_TOOL_ITERATIONS = 10;
    let iteration = 0;

    while (iteration < MAX_TOOL_ITERATIONS) {
      iteration++;

      const response = await client.chat.completions.create({
        model: MODEL,
        messages,
        tools: openAITools,
        tool_choice: "auto",
      });

      const choice = response.choices[0];
      if (!choice) {
        aiLogger.warn("No choice in response");
        break;
      }

      const assistantMessage = choice.message;
      messages.push(assistantMessage);

      // Check if there are tool calls to process
      if (
        !assistantMessage.tool_calls ||
        assistantMessage.tool_calls.length === 0
      ) {
        // No more tool calls - we have the final response
        const fullText = assistantMessage.content;

        // DEBUG: Log the response
        aiLogger.info(
          {
            responseLength: fullText?.length ?? 0,
            responseText: fullText?.slice(0, 500) ?? "null",
            iterations: iteration,
          },
          "DEBUG: Chat response",
        );
        callbacks?.onComplete?.();

        if (!fullText) aiLogger.warn("Chat request returned empty response");
        return fullText || null;
      }

      // Process each tool call
      for (const toolCall of assistantMessage.tool_calls) {
        // Only handle function tool calls
        if (toolCall.type !== "function") continue;

        const toolName = toolCall.function.name;
        const toolArgs = toolCall.function.arguments;

        aiLogger.debug({ tool: toolName, args: toolArgs }, "Executing tool");
        callbacks?.onToolStart?.(toolName, JSON.parse(toolArgs || "{}"));

        // Execute the tool
        const result = await executeTool([...allTools], toolName, toolArgs);

        aiLogger.debug(
          { tool: toolName, result: result.slice(0, 200) },
          "Tool result",
        );
        callbacks?.onToolEnd?.(toolName);

        // Add tool result to messages
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }
    }

    // If we hit max iterations, return whatever we have
    aiLogger.warn(
      { iterations: MAX_TOOL_ITERATIONS },
      "Hit max tool iterations",
    );
    callbacks?.onComplete?.();
    return null;
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
    const response = await client.chat.completions.create({
      model: MODEL,
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
