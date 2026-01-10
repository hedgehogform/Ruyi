import OpenAI from "openai";
import { toolDefinitions, executeTool } from "./tools";
import { aiLogger } from "./logger";
import { DateTime } from "luxon";

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

You have access to tools to search Discord messages, get channel/server info, and look up users. Use them when helpful. Use discord formatting (like code blocks, bold, italics) to enhance clarity and readability where appropriate.

Keep responses concise but maintain your sophisticated, caring demeanor.

When handling dates, always format them using Discord's timestamp embeds like <t:UNIX:style> so they render interactively. Use styles F (full), R (relative), or D (date only) as appropriate. (Do NOT ask users to format them; you must do it yourself, Do not edit timestamps provided by tools.)
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

export async function chat(
  userMessage: string,
  username: string,
  chatHistory: ChatMessage[] = [],
  callbacks?: ChatCallbacks
): Promise<string | null> {
  const historyLines = chatHistory.map((m) => m.author + ": " + m.content);
  const historyContext =
    chatHistory.length > 0
      ? "\n\nRecent chat history:\n" + historyLines.join("\n")
      : "";

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `${systemPrompt}\n\nYou are currently speaking with ${username}. Feel free to address them by name when appropriate.${historyContext}\n\nCurrent time is: ${DateTime.now().toUnixInteger()}.`,
    },
    { role: "user", content: userMessage },
  ];

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

  // Handle tool calls in a loop
  while (
    assistantMessage.tool_calls &&
    assistantMessage.tool_calls.length > 0
  ) {
    messages.push(assistantMessage);

    aiLogger.info(
      { toolCount: assistantMessage.tool_calls.length },
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

Reply "no" if:
- Message is clearly directed at another specific person
- Private conversation between others
- Just emojis, reactions, or "lol/lmao" type responses
- Spam or nonsense
- Very short messages with no substance (like just "ok" or "yeah")`,
      },
      { role: "user", content: message },
    ],
  });

  const content = response.choices[0]?.message?.content;
  return content?.toLowerCase().trim() === "yes";
}
