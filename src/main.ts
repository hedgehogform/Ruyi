import { connectDB } from "./db";
import { loadConfig } from "./config";
import {
  loadLastInteractions,
  initializeCopilotClient,
  loadPersistedSessions,
  shutdownCopilotClient,
} from "./ai";
import { registerEvents, startBot } from "./bot";
import { allTools } from "./tools";
import { logMcpServersHealth } from "./mcp";
import { SmitheryMCPServer } from "./mcp/smithery";
import { initializeMcpTools, closeMcpConnections } from "./mcp/client";

// Connect to MongoDB first (needed for Smithery tokens)
await connectDB();

// Initialize Smithery tokens from database
const smitheryStatus = await SmitheryMCPServer.initializeTokens();
if (!smitheryStatus.brave && !smitheryStatus.youtube) {
  console.log("⚠️  No Smithery tokens found. Run /smithery to authorize.");
} else {
  const authorized = [];
  if (smitheryStatus.brave) authorized.push("Brave");
  if (smitheryStatus.youtube) authorized.push("YouTube");
  console.log(`✅ Smithery tokens loaded: ${authorized.join(", ")}`);
}

// Log MCP server status with health check
await logMcpServersHealth();

// Initialize MCP tools via wrapper (connects to Smithery servers)
const mcpTools = await initializeMcpTools();

// Combine all tools
const allAvailableTools = [...allTools, ...mcpTools];

// Log registered tools
console.log("\n" + "=".repeat(60));
console.log("REGISTERED TOOLS");
console.log("=".repeat(60));
for (const tool of allTools) {
  console.log(`  • ${tool.name}`);
}
if (mcpTools.length > 0) {
  console.log("\nMCP Tools:");
  for (const tool of mcpTools) {
    console.log(`  • ${tool.name} (MCP)`);
  }
}
console.log(
  `\nTotal: ${allAvailableTools.length} tools (${allTools.length} local + ${mcpTools.length} MCP)`,
);
console.log("=".repeat(60));

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
  await closeMcpConnections();
  await shutdownCopilotClient();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\nReceived SIGTERM, shutting down gracefully...");
  await closeMcpConnections();
  await shutdownCopilotClient();
  process.exit(0);
});
