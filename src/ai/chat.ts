import type { SessionEvent } from "@github/copilot-sdk";
import type { GuildTextBasedChannel } from "discord.js";
import { allTools } from "../tools";
import { aiLogger } from "../logger";
import { getMcpServerForTool } from "../mcp";
import type { ChatSession } from "../utils/chatSession";
import { systemPrompt } from "./prompt";
import { getOrCreateSession, invalidateSession } from "./session";
import {
  rememberMessage,
  buildDynamicContext,
  type ChatMessage,
} from "./context";
import { setPermissionContext, clearPermissionContext } from "./permissions";

export interface ChatOptions {
  userMessage: string;
  username: string;
  channelId: string;
  channel: GuildTextBasedChannel;
  userId: string;
  session: ChatSession;
  chatHistory?: ChatMessage[];
  messageId?: string;
}

// Main chat function with tool usage - uses persistent CopilotClient sessions
export async function chat(options: ChatOptions): Promise<string | null> {
  const {
    userMessage,
    username,
    channelId,
    channel,
    userId,
    session,
    chatHistory = [],
    messageId,
  } = options;

  // Set permission context so the permission handler can prompt the user
  setPermissionContext(channelId, { channel, userId });

  // Build dynamic context to prepend to the user message
  // This includes current user, time, memories, and conversation history
  const dynamicContext = await buildDynamicContext(
    username,
    channelId,
    chatHistory,
  );

  // Prepend context to the user message so the model has current info
  const enrichedMessage = `${dynamicContext}\n\nUser message from ${username}:\n${userMessage}`;

  // DEBUG: Print full prompt to console
  console.log("\n" + "=".repeat(80));
  console.log("SYSTEM PROMPT (set once on session creation):");
  console.log("=".repeat(80));
  console.log(systemPrompt);
  console.log("\n" + "=".repeat(80));
  console.log("ENRICHED USER MESSAGE (sent with each message):");
  console.log("=".repeat(80));
  console.log(enrichedMessage);
  console.log("=".repeat(80) + "\n");

  // DEBUG: Log exactly what we're sending
  aiLogger.info(
    {
      userMessage,
      username,
      contextLength: dynamicContext.length,
      historyCount: chatHistory.length,
    },
    "DEBUG: Chat input",
  );

  rememberMessage(channelId, username, userMessage, false, messageId);
  session.onThinking();

  try {
    // Get or create a persistent session for this channel
    // Pass the base system prompt for new sessions
    const copilotSession = await getOrCreateSession(channelId, systemPrompt);

    // DEBUG: Log the tools being passed
    aiLogger.info(
      {
        channelId,
        sessionId: copilotSession.sessionId,
        toolCount: allTools.length,
      },
      "DEBUG: Using persistent session",
    );

    // Track tool names by call ID for execution_complete events
    const toolCallMap = new Map<string, string>();

    // Get registered tool names to identify local vs MCP tools
    const registeredToolNames = new Set(allTools.map((t) => t.name));

    // SDK internal tools to filter out (these are not user-facing)
    const internalTools = new Set(["report_intent", "report_progress"]);

    // Set up event handlers for tool tracking and typing indicator
    // Note: We set up handlers for each message since the session persists
    const unsubscribe = copilotSession.on((event: SessionEvent) => {
      // DEBUG: Log ALL events to see what the SDK is doing
      aiLogger.debug(
        {
          eventType: event.type,
          eventData: JSON.stringify(event.data).slice(0, 200),
        },
        "DEBUG: Session event received",
      );

      if (event.type === "tool.execution_start") {
        const data = event.data as {
          toolName: string;
          toolCallId: string;
          arguments?: unknown;
        };

        // Skip SDK internal tools (like report_intent, report_progress)
        if (internalTools.has(data.toolName)) {
          aiLogger.debug({ tool: data.toolName }, "Skipping internal SDK tool");
          return;
        }

        // Determine if this is a local tool or MCP tool
        const isLocalTool = registeredToolNames.has(data.toolName);
        const mcpServer = getMcpServerForTool(data.toolName);

        let displayName: string;
        if (isLocalTool) {
          displayName = data.toolName;
        } else if (mcpServer) {
          displayName = `${mcpServer}:${data.toolName}`;
        } else {
          displayName = `mcp:${data.toolName}`;
        }

        toolCallMap.set(data.toolCallId, displayName);
        aiLogger.info(
          { tool: data.toolName, isMCP: !isLocalTool },
          isLocalTool
            ? "Tool execution starting"
            : "MCP tool execution starting",
        );
        session.onComplete();
        session.onToolStart(
          displayName,
          (data.arguments as Record<string, unknown>) ?? {},
        );
      } else if (event.type === "tool.execution_complete") {
        const data = event.data as { toolCallId: string };
        const displayName = toolCallMap.get(data.toolCallId);

        // Skip if we didn't track this tool (internal SDK tool)
        if (!displayName) return;

        toolCallMap.delete(data.toolCallId);
        aiLogger.debug({ tool: displayName }, "Tool execution complete");
        session.onToolEnd(displayName);
        session.onThinking();
      }
    });

    // Send message and wait for completion - returns the final assistant message
    // Use 5 minute timeout (300000ms) for tool calls that may take longer (e.g., web search)
    const result = await copilotSession.sendAndWait(
      { prompt: enrichedMessage },
      300000,
    );
    const finalContent = result?.data.content ?? null;

    // Unsubscribe from events after this message is done
    unsubscribe();

    // DEBUG: Log the response
    aiLogger.info(
      {
        responseLength: finalContent?.length ?? 0,
        responseText: finalContent?.slice(0, 500) ?? "null",
      },
      "DEBUG: Chat response",
    );

    session.onComplete();

    // DON'T destroy the session - keep it alive for future messages
    // Session will be cleaned up on shutdown or if it becomes invalid

    if (!finalContent) aiLogger.warn("Chat request returned empty response");

    // Clear permission context after chat completes
    clearPermissionContext(channelId);

    return finalContent;
  } catch (error) {
    const err = error as Error;
    aiLogger.error(
      { error: err.message, stack: err.stack, name: err.name },
      "Chat request failed",
    );

    // If the session errored, invalidate it so a fresh one is created next time
    await invalidateSession(channelId);

    // Clear permission context on error too
    clearPermissionContext(channelId);

    session.onComplete();
    return null;
  }
}
