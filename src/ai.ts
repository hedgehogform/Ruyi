import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { toolDefinitions, executeTool } from "./tools";
import { aiLogger } from "./logger";
import { DateTime } from "luxon";
import { Conversation } from "./db/models";

// OpenRouter plugin for auto-router model selection
interface OpenRouterPlugin {
  id: "auto-router";
  allowed_models?: string[];
}

// Extend OpenAI params with OpenRouter-specific options
interface OpenRouterChatParams extends ChatCompletionCreateParamsNonStreaming {
  plugins?: OpenRouterPlugin[];
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

Tools: Use calculator for math, memory_store to remember things, memory_recall for user info, generate_image for art requests (detailed prompts work best).

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

// OpenAI client pointing to OpenRouter
const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: Bun.env.MODEL_TOKEN!,
});

export interface ChatMessage {
  author: string;
  content: string;
  isBot: boolean;
  isReplyContext?: boolean;
  imageUrls?: string[];
}

// Content part types for multimodal messages
type TextContent = { type: "text"; text: string };
type ImageContent = {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
};
type MessageContent = TextContent | ImageContent;

// Extract image URLs from fetch tool result if present
function extractImagesFromToolResult(result: string): string[] {
  try {
    const parsed = JSON.parse(result);
    if (parsed.images && Array.isArray(parsed.images)) {
      return parsed.images
        .filter(
          (img: unknown) =>
            typeof img === "object" &&
            img !== null &&
            "image_url" in (img as Record<string, unknown>),
        )
        .map((img: { image_url: { url: string } }) => img.image_url.url);
    }
    // Also check for type: "images" response (image-only URLs)
    if (parsed.type === "images" && Array.isArray(parsed.images)) {
      return parsed.images
        .filter(
          (img: unknown) =>
            typeof img === "object" &&
            img !== null &&
            "image_url" in (img as Record<string, unknown>),
        )
        .map((img: { image_url: { url: string } }) => img.image_url.url);
    }
  } catch {
    // Not JSON or doesn't have images
  }
  return [];
}

export interface ChatCallbacks {
  onThinking?: () => void;
  onToolStart?: (toolName: string, args: Record<string, unknown>) => void;
  onToolEnd?: (toolName: string) => void;
  onComplete?: () => void;
}

let currentHistoryContext = "";

// Main chat function with tool usage

// Build multimodal content array for a message with optional images
function buildMessageContent(
  text: string,
  imageUrls?: string[],
): string | MessageContent[] {
  if (!imageUrls || imageUrls.length === 0) {
    return text;
  }

  const content: MessageContent[] = [{ type: "text", text }];
  for (const url of imageUrls) {
    content.push({ type: "image_url", image_url: { url, detail: "auto" } });
  }
  return content;
}

// Add images to a tool result message for the AI to see
function buildToolResultWithImages(
  textResult: string,
  imageUrls: string[],
): MessageContent[] {
  const content: MessageContent[] = [{ type: "text", text: textResult }];
  for (const url of imageUrls) {
    content.push({ type: "image_url", image_url: { url, detail: "auto" } });
  }
  return content;
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

// Execute a single tool call and return the message to add
async function executeToolCall(
  toolCall: {
    id: string;
    type: string;
    function: { name: string; arguments: string };
  },
  callbacks?: ChatCallbacks,
): Promise<OpenAI.ChatCompletionToolMessageParam> {
  const func = toolCall.function;
  const args = JSON.parse(func.arguments || "{}");

  aiLogger.info({ tool: func.name, args }, "Executing tool");
  callbacks?.onToolStart?.(func.name, args);

  const result = await executeTool(func.name, args);
  aiLogger.debug(
    { tool: func.name, resultLength: result.length },
    "Tool completed",
  );
  callbacks?.onToolEnd?.(func.name);

  const toolImages = extractImagesFromToolResult(result);
  if (toolImages.length > 0) {
    aiLogger.info(
      { imageCount: toolImages.length },
      "Tool returned images for visual analysis",
    );
    return {
      role: "tool",
      tool_call_id: toolCall.id,
      content: buildToolResultWithImages(result, toolImages) as any,
    };
  }
  return { role: "tool", tool_call_id: toolCall.id, content: result };
}

// Process all tool calls from assistant message
async function processToolCalls(
  toolCalls: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>,
  callbacks?: ChatCallbacks,
): Promise<OpenAI.ChatCompletionToolMessageParam[]> {
  const results: OpenAI.ChatCompletionToolMessageParam[] = [];
  for (const toolCall of toolCalls) {
    if (toolCall.type !== "function") continue;
    results.push(await executeToolCall(toolCall, callbacks));
  }
  return results;
}

export async function chat(
  userMessage: string,
  username: string,
  channelId: string,
  chatHistory: ChatMessage[] = [],
  callbacks?: ChatCallbacks,
  imageUrls?: string[],
  messageId?: string,
): Promise<string | null> {
  currentHistoryContext = await buildHistoryContext(chatHistory, channelId);
  const isOngoing = isOngoingConversation(channelId);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: buildSystemMessage(username, currentHistoryContext, isOngoing),
    },
    {
      role: "user",
      content: buildMessageContent(userMessage, imageUrls) as any,
    },
  ];

  rememberMessage(channelId, username, userMessage, false, messageId);
  aiLogger.debug({ username }, "Starting chat request");
  callbacks?.onThinking?.();

  let response = await openai.chat.completions.create({
    model: "openrouter/auto",
    messages,
    tools: toolDefinitions,
    tool_choice: "auto",
  });

  let assistantMessage = response.choices[0]?.message;
  if (!assistantMessage) return null;

  let iterations = 0;
  const maxIterations = 10;

  while (assistantMessage.tool_calls?.length && iterations < maxIterations) {
    iterations++;
    messages.push(assistantMessage);

    aiLogger.info(
      { toolCount: assistantMessage.tool_calls.length, iteration: iterations },
      "Processing tool calls",
    );
    const toolResults = await processToolCalls(
      assistantMessage.tool_calls as any,
      callbacks,
    );
    messages.push(...toolResults);

    callbacks?.onThinking?.();

    response = await openai.chat.completions.create({
      model: "openrouter/auto",
      messages,
      tools: toolDefinitions,
      tool_choice: "auto",
    });

    assistantMessage = response.choices[0]?.message;
    if (!assistantMessage) return null;
  }

  aiLogger.debug("Chat request completed");
  callbacks?.onComplete?.();

  // Check if the model returned raw JSON tool call instead of actually calling the tool
  // This can happen with some models - filter it out
  const content = assistantMessage.content;
  if (content && isLikelyMalformedToolCall(content)) {
    aiLogger.warn(
      { content: content.slice(0, 100) },
      "Model returned raw tool JSON instead of calling tool",
    );
    return null;
  }

  // Note: Bot's reply is stored in bot.ts after sending, so we have the message ID
  return content;
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
  "deepseek/deepseek-r1:free",
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
): Promise<boolean> {
  const response = await openai.chat.completions.create({
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
- Very short messages with no substance (like just "ok" or "yeah" unless it's part of user's answer to the bot)

Previous chat history:
${currentHistoryContext}
`,
      },
      { role: "user", content: message },
    ],
    plugins: [{ id: "auto-router", allowed_models: FREE_MODELS }],
  } as OpenRouterChatParams);

  const content = response.choices[0]?.message?.content;
  return content?.toLowerCase().trim() === "yes";
}
