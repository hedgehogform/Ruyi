// Main AI module - re-exports all public APIs

// Client management
export { initializeCopilotClient, getProviderConfig, MODEL } from "./client";
import { stopClient } from "./client";
import { destroyAllSessions, getActiveSessionCount } from "./session";
import { aiLogger } from "../logger";

// Session management
export { loadPersistedSessions, invalidateSession } from "./session";

// Context and memory
export {
  rememberMessage,
  getMemoryContext,
  isOngoingConversation,
  loadLastInteractions,
  type ChatMessage,
} from "./context";

// Chat function
export { chat, type ChatOptions } from "./chat";

// Classifier
export { shouldReply } from "./classifier";

// System prompt (for reference/testing)
export { systemPrompt } from "./prompt";

/**
 * Gracefully shutdown the Copilot client and all sessions.
 * Call this on app shutdown.
 */
export async function shutdownCopilotClient(): Promise<void> {
  aiLogger.info(
    { sessionCount: getActiveSessionCount() },
    "Shutting down Copilot client",
  );

  // Destroy all active sessions
  await destroyAllSessions();

  // Stop the client
  await stopClient();

  aiLogger.info("Copilot client shutdown complete");
}
