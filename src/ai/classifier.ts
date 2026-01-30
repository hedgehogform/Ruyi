import {
  CopilotClient,
  type AssistantMessageEvent,
  type SessionEvent,
} from "@github/copilot-sdk";
import { aiLogger } from "../logger";
import { getMemoryContext } from "./context";
import { getProviderConfig, MODEL } from "./client";

/**
 * Check if the bot should reply to a message based on context.
 * Uses a separate lightweight session for classification.
 */
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
    aiLogger.info(
      { message: message.slice(0, 50) },
      "DEBUG: shouldReply starting",
    );

    // Create a fresh client for classification to avoid shared state issues
    const classifyClient = new CopilotClient({
      autoStart: true,
      autoRestart: false,
      logLevel: "debug", // Enable debug logging to see what's happening
    });

    aiLogger.info("DEBUG: shouldReply client created, starting...");
    await classifyClient.start();
    aiLogger.info(
      { state: classifyClient.getState() },
      "DEBUG: shouldReply client started",
    );

    // Create a simple session without tools for classification
    aiLogger.info("DEBUG: shouldReply creating session...");
    const session = await classifyClient.createSession({
      model: MODEL,
      provider: getProviderConfig(),
      systemMessage: {
        mode: "replace",
        content: systemPromptText,
      },
      streaming: true, // Enable streaming to get faster response
      infiniteSessions: { enabled: false },
    });
    aiLogger.info("DEBUG: shouldReply session created, sending message...");

    // Listen for all events to debug
    session.on((event: SessionEvent) => {
      aiLogger.info(
        {
          eventType: event.type,
          data: JSON.stringify(event.data).slice(0, 100),
        },
        "DEBUG: shouldReply session event",
      );
    });

    // Use 30 second timeout - model might be slow
    const resultEvent: AssistantMessageEvent | undefined =
      await session.sendAndWait({ prompt: message }, 30000);
    const responseContent = resultEvent?.data.content ?? "";
    aiLogger.info({ responseContent }, "DEBUG: shouldReply got response");

    // Clean up
    await session.destroy();
    await classifyClient.stop();

    const result = responseContent.toLowerCase().trim() === "yes";
    aiLogger.debug(
      { message: message.slice(0, 50), result },
      "shouldReply decision",
    );
    return result;
  } catch (error) {
    aiLogger.warn(
      {
        error: (error as Error)?.message,
        stack: (error as Error)?.stack?.slice(0, 300),
        message: message.slice(0, 50),
      },
      "shouldReply failed, defaulting to no",
    );
    return false;
  }
}
