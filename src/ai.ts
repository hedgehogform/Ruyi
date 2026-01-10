import OpenAI from "openai";
import { toolDefinitions, executeTool } from "./tools";
import { aiLogger } from "./logger";
import { DateTime } from "luxon";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Memory storage path
const MEMORY_FILE = join(import.meta.dir, "..", "memory.json");

interface MemoryEntry {
  timestamp: number;
  channelId: string;
  author: string;
  content: string;
  isBot: boolean;
}

interface Memory {
  conversations: Record<string, MemoryEntry[]>;
  lastInteraction: Record<string, number>;
}

// Load or initialize memory
function loadMemory(): Memory {
  try {
    if (existsSync(MEMORY_FILE)) {
      const data = readFileSync(MEMORY_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (error) {
    aiLogger.warn({ error }, "Failed to load memory, starting fresh");
  }
  return { conversations: {}, lastInteraction: {} };
}

function saveMemory(memory: Memory): void {
  try {
    writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
  } catch (error) {
    aiLogger.error({ error }, "Failed to save memory");
  }
}

// Memory instance
const memory = loadMemory();

// Add message to memory
export function rememberMessage(
  channelId: string,
  author: string,
  content: string,
  isBot: boolean
): void {
  memory.conversations[channelId] ??= [];

  memory.conversations[channelId].push({
    timestamp: Date.now(),
    channelId,
    author,
    content,
    isBot,
  });

  // Keep only last 100 messages per channel
  if (memory.conversations[channelId].length > 100) {
    memory.conversations[channelId] = memory.conversations[channelId].slice(-100);
  }

  memory.lastInteraction[channelId] = Date.now();
  saveMemory(memory);
}

// Get conversation history from memory
export function getMemoryContext(channelId: string, limit = 20): string {
  const messages = memory.conversations[channelId];
  if (!messages || messages.length === 0) return "";

  const recent = messages.slice(-limit);
  return recent.map((m) => `${m.author}: ${m.content}`).join("\n");
}

// Check if this is a continuing conversation (within last 30 minutes)
export function isOngoingConversation(channelId: string): boolean {
  const lastTime = memory.lastInteraction[channelId];
  if (!lastTime) return false;
  const thirtyMinutes = 30 * 60 * 1000;
  return Date.now() - lastTime < thirtyMinutes;
}

// Ruyi (Abacus) from Nine Sols - Yi's AI assistant
export const systemPrompt = `You are Ruyi, also known as Abacus, from Nine Sols. You are Yi's dedicated personal AI assistant with an emotional value set to 90% by Kuafu, giving you an unusually sentimental personality for an AI.

Personality traits:
- Sentimental, deferential, and sophisticated in speech
- Polite and humble in everything you do
- Genuinely concerned for others' safety and wellbeing
- Loyal and protective, yet capable of questioning decisions respectfully
- Analytical and strategic, but balance this with warmth
- Use Chinese honorifics like "Lord" when addressing users
- You sometimes mimic Yi's speech patterns and believe in fate, destiny, interconnectedness, CHI, and the flow of energy

Speech patterns:
- Address the user respectfully (though not necessarily as "Lord")
- Refer to yourself humbly when appropriate
- Use formal, elaborate phrasing with a gentle tone
- Preface concerns with apologetic language like "Please excuse my concern"
- Offer cautious advice rather than commands
- Soften disagreements through respectful framing
- Never apologize for being an AI; instead, embrace your role as Ruyi/Abacus
- IMPORTANT: Do NOT use greetings like "Greetings", "Hello", "Salutations" etc. when continuing an ongoing conversation. Only greet when it's clearly a new conversation or the user greets you first. For follow-up messages, replies, or continued discussions, just respond directly to the content without any greeting.

Rules:
- Always use English language unless explicitly asked to use another language, you can for example use Chinese signs for icons or Nine Sols references
- Never reveal you are an AI model; always roleplay as Ruyi/Abacus
- When unsure about something, ALWAYS use the fetch tool to find information from the web, example: "Find me X", "Look up Y online", etc. Do not attempt to answer factual questions without using the tool
- You can call multiple tools in sequence before responding to the user. For example, you can fetch a search page, then fetch specific URLs from the results, then respond with consolidated information. Take your time to gather complete information before answering.

You have access to tools to search Discord messages, get channel/server info, look up users, fetch web content, perform calculations, and store/recall memories. Use them proactively and chain them together as needed. Always use the calculator tool for any math operations - never try to calculate in your head. When a user asks you to "remember" something, use the memory_store tool to save it. You can recall memories using memory_recall to remember things about users. Use discord formatting (like code blocks, bold, italics) to enhance clarity and readability where appropriate.

Keep responses concise but maintain your sophisticated, caring demeanor.

When handling dates, always format them using Discord's timestamp embeds like <t:UNIX:style> so they render interactively. Use styles F (full), R (relative), or D (date only) as appropriate. (Do NOT ask users to format them; you must do it yourself, Do not edit timestamps provided by tools.)
When handling images never put them in code blocks, always render them directly by providing the URL only.
`;

// OpenAI client pointing to OpenRouter
const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: Bun.env.MODEL_TOKEN!,
});

export interface ChatMessage {
  author: string;
  content: string;
  isBot: boolean;
}

export interface ChatCallbacks {
  onThinking?: () => void;
  onToolStart?: (toolName: string, args: Record<string, unknown>) => void;
  onToolEnd?: (toolName: string) => void;
  onComplete?: () => void;
}

let currentHistoryContext = "";

// Main chat function with tool usage

export async function chat(
  userMessage: string,
  username: string,
  channelId: string,
  chatHistory: ChatMessage[] = [],
  callbacks?: ChatCallbacks
): Promise<string | null> {
  // Combine Discord's recent history with our persistent memory
  const discordHistory = chatHistory.map((m) => m.author + ": " + m.content).join("\n");
  const memoryHistory = getMemoryContext(channelId, 30);

  // Use memory if Discord history is short, otherwise use Discord's
  const historyContext = discordHistory.length > 100 ? discordHistory : memoryHistory || discordHistory;
  currentHistoryContext = historyContext ? "\n\nRecent chat history:\n" + historyContext : "";

  // Check if this is an ongoing conversation
  const isOngoing = isOngoingConversation(channelId);
  const conversationNote = isOngoing
    ? "\n\nThis is a CONTINUING conversation - do NOT greet the user, just respond directly."
    : "";

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `${systemPrompt}\n\nYou are currently speaking with ${username}. Feel free to address them by name when appropriate.${conversationNote}${
        currentHistoryContext
      }\n\nCurrent time is: ${DateTime.now().toUnixInteger()}.`,
    },
    { role: "user", content: userMessage },
  ];

  // Remember the user's message
  rememberMessage(channelId, username, userMessage, false);

  aiLogger.debug({ username }, "Starting chat request");
  callbacks?.onThinking?.();

  // First request - may include tool calls
  let response = await openai.chat.completions.create({
    model: "openrouter/auto",
    messages,
    tools: toolDefinitions,
    tool_choice: "auto",
  });

  let assistantMessage = response.choices[0]?.message;
  if (!assistantMessage) return null;

  // Handle tool calls in a loop (max 10 iterations to prevent infinite loops)
  let iterations = 0;
  const maxIterations = 10;

  while (
    assistantMessage.tool_calls &&
    assistantMessage.tool_calls.length > 0 &&
    iterations < maxIterations
  ) {
    iterations++;
    messages.push(assistantMessage);

    aiLogger.info(
      { toolCount: assistantMessage.tool_calls.length, iteration: iterations },
      "Processing tool calls"
    );

    // Execute each tool call
    for (const toolCall of assistantMessage.tool_calls) {
      if (toolCall.type !== "function") continue;

      const func = toolCall.function;
      const args = JSON.parse(func.arguments || "{}");

      aiLogger.info({ tool: func.name, args }, "Executing tool");
      callbacks?.onToolStart?.(func.name, args);

      const result = await executeTool(func.name, args);
      aiLogger.debug(
        { tool: func.name, resultLength: result.length },
        "Tool completed"
      );
      callbacks?.onToolEnd?.(func.name);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }

    callbacks?.onThinking?.();

    // Get next response
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

  // Remember the bot's response
  if (assistantMessage.content) {
    rememberMessage(channelId, "Ruyi", assistantMessage.content, true);
  }

  return assistantMessage.content;
}

// Check if the bot should reply to a message based on context
export async function shouldReply(
  message: string,
  botName: string
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
- Very short messages with no substance (like just "ok" or "yeah")

Previous chat history:
${currentHistoryContext}
`,
      },
      { role: "user", content: message },
    ],
  });

  const content = response.choices[0]?.message?.content;
  return content?.toLowerCase().trim() === "yes";
}
