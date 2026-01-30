import { connectDB } from "./db";
import { loadConfig } from "./config";
import {
  loadLastInteractions,
  initializeCopilotClient,
  loadPersistedSessions,
  shutdownCopilotClient,
} from "./ai";
import { registerEvents, startBot } from "./bot";

// Connect to MongoDB first
await connectDB();

// Load config and conversation cache from DB
await loadConfig();
await loadLastInteractions();

// Initialize the CopilotClient and load persisted sessions
await initializeCopilotClient();
await loadPersistedSessions();

// Start the bot
registerEvents();
startBot();

// Graceful shutdown handling
process.on("SIGINT", async () => {
  console.log("\nReceived SIGINT, shutting down gracefully...");
  await shutdownCopilotClient();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\nReceived SIGTERM, shutting down gracefully...");
  await shutdownCopilotClient();
  process.exit(0);
});
