import { connectDB } from "./db";
import { loadConfig } from "./config";
import { loadLastInteractions } from "./ai";
import { registerEvents, startBot } from "./bot";

// Connect to MongoDB first
await connectDB();

// Load config and conversation cache from DB
await loadConfig();
await loadLastInteractions();

// Start the bot
registerEvents();
startBot();
