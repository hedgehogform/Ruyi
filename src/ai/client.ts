import { CopilotClient } from "@github/copilot-sdk";
import { aiLogger } from "../logger";

// =============================================================================
// CLIENT MANAGEMENT - Single persistent client
// =============================================================================

let copilotClient: CopilotClient | null = null;

// Model to use - configurable via env
export const MODEL = Bun.env.MODEL_NAME ?? "openrouter/auto";

// Provider config for OpenRouter BYOK
export function getProviderConfig() {
  return {
    type: "openai" as const,
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: Bun.env.MODEL_TOKEN!,
  };
}

/**
 * Initialize the CopilotClient. Call this once at startup.
 */
export async function initializeCopilotClient(): Promise<void> {
  if (copilotClient && copilotClient.getState() === "connected") {
    aiLogger.info("CopilotClient already initialized");
    return;
  }

  copilotClient = new CopilotClient({
    autoStart: false,
    autoRestart: true,
    logLevel: "warning",
  });

  await copilotClient.start();
  aiLogger.info("CopilotClient initialized and started");
}

/**
 * Get the CopilotClient, initializing if needed.
 */
export async function getClient(): Promise<CopilotClient> {
  if (!copilotClient || copilotClient.getState() !== "connected") {
    await initializeCopilotClient();
  }
  return copilotClient!;
}

/**
 * Stop and cleanup the CopilotClient.
 */
export async function stopClient(): Promise<void> {
  if (!copilotClient) return;

  try {
    await copilotClient.stop();
  } catch (error) {
    aiLogger.warn({ error: (error as Error).message }, "Error stopping client");
  }
  copilotClient = null;
}

/**
 * Check if the client is connected.
 */
export function isClientConnected(): boolean {
  return copilotClient?.getState() === "connected";
}
