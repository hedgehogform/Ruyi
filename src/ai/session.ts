import type { CopilotSession as SDKSession } from "@github/copilot-sdk";
import { allTools } from "../tools";
import { aiLogger } from "../logger";
import { CopilotSession as CopilotSessionModel } from "../db/models";
import { getMcpTools } from "../mcp/client";
import { getClient, getProviderConfig, MODEL } from "./client";
import { createPermissionHandler } from "./permissions";

// In-memory cache of active SDK sessions by channel ID
const activeSessions = new Map<string, SDKSession>();

/**
 * Load persisted sessions from the database and try to resume them.
 * Call this after initializeCopilotClient().
 */
export async function loadPersistedSessions(): Promise<void> {
  try {
    const client = await getClient();
    const persistedSessions = await CopilotSessionModel.find({
      isActive: true,
    });

    // Get all tools including MCP tools
    const mcpTools = getMcpTools();
    const allAvailableTools = [...allTools, ...mcpTools];

    aiLogger.info(
      { count: persistedSessions.length },
      "Loading persisted sessions",
    );

    for (const persisted of persistedSessions) {
      try {
        // Try to resume the session
        const session = await client.resumeSession(persisted.sessionId, {
          tools: [...allAvailableTools],
        });

        activeSessions.set(persisted.channelId, session);
        aiLogger.debug(
          { channelId: persisted.channelId, sessionId: persisted.sessionId },
          "Resumed persisted session",
        );
      } catch (error) {
        // Session couldn't be resumed (expired, invalid, etc.) - mark as inactive
        aiLogger.warn(
          {
            channelId: persisted.channelId,
            sessionId: persisted.sessionId,
            error: (error as Error).message,
          },
          "Failed to resume session, marking inactive",
        );
        await CopilotSessionModel.updateOne(
          { channelId: persisted.channelId },
          { $set: { isActive: false } },
        );
      }
    }

    aiLogger.info(
      { activeCount: activeSessions.size },
      "Session loading complete",
    );
  } catch (error) {
    aiLogger.error({ error }, "Failed to load persisted sessions");
  }
}

/**
 * Get or create a session for a channel.
 * Sessions are cached in memory and persisted to MongoDB.
 */
export async function getOrCreateSession(
  channelId: string,
  systemMessage: string,
): Promise<SDKSession> {
  // Check if we have an active session in memory
  const existingSession = activeSessions.get(channelId);
  if (existingSession) {
    aiLogger.debug({ channelId }, "Using cached session");
    // Update last used time in DB
    await CopilotSessionModel.updateOne(
      { channelId },
      { $set: { lastUsed: new Date() } },
    );
    return existingSession;
  }

  const client = await getClient();

  // Check if we have a persisted session in DB that we haven't loaded yet
  const persistedSession = await CopilotSessionModel.findOne({
    channelId,
    isActive: true,
  });

  if (persistedSession) {
    try {
      // Get all tools including MCP tools
      const mcpTools = getMcpTools();
      const allAvailableTools = [...allTools, ...mcpTools];

      // Try to resume the session
      const session = await client.resumeSession(persistedSession.sessionId, {
        tools: [...allAvailableTools],
      });

      activeSessions.set(channelId, session);
      await CopilotSessionModel.updateOne(
        { channelId },
        { $set: { lastUsed: new Date() } },
      );

      aiLogger.debug(
        { channelId, sessionId: persistedSession.sessionId },
        "Resumed session from DB",
      );
      return session;
    } catch (error) {
      aiLogger.warn(
        { channelId, error: (error as Error).message },
        "Failed to resume session, creating new one",
      );
      // Mark old session as inactive
      await CopilotSessionModel.updateOne(
        { channelId },
        { $set: { isActive: false } },
      );
    }
  }

  // Create a new session with a channel-based session ID
  const sessionId = `ruyi-${channelId}-${Date.now()}`;

  // Get all tools including MCP tools (wrapped via client.ts)
  const mcpTools = getMcpTools();
  const allAvailableTools = [...allTools, ...mcpTools];

  // Create permission handler for Discord button-based approval
  const permissionHandler = createPermissionHandler(channelId);

  const session = await client.createSession({
    sessionId,
    model: MODEL,
    provider: getProviderConfig(),
    tools: [...allAvailableTools],
    systemMessage: {
      mode: "replace",
      content: systemMessage,
    },
    streaming: false,
    infiniteSessions: { enabled: true },
    onPermissionRequest: permissionHandler,
  });

  // Log MCP tools included
  if (mcpTools.length > 0) {
    aiLogger.info(
      {
        channelId,
        mcpToolCount: mcpTools.length,
        tools: mcpTools.map((t) => t.name),
      },
      "Session created with MCP tools",
    );
  }

  // Cache the session in memory
  activeSessions.set(channelId, session);

  // Persist to MongoDB
  await CopilotSessionModel.findOneAndUpdate(
    { channelId },
    {
      $set: {
        sessionId: session.sessionId,
        lastUsed: new Date(),
        isActive: true,
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
    },
    { upsert: true },
  );

  aiLogger.info(
    { channelId, sessionId: session.sessionId },
    "Created new session",
  );

  return session;
}

/**
 * Invalidate and remove a session for a channel.
 * Use this when a session encounters errors or needs to be reset.
 */
export async function invalidateSession(channelId: string): Promise<void> {
  const session = activeSessions.get(channelId);
  if (session) {
    try {
      await session.destroy();
    } catch (error) {
      aiLogger.warn(
        { channelId, error: (error as Error).message },
        "Error destroying session",
      );
    }
    activeSessions.delete(channelId);
  }

  await CopilotSessionModel.updateOne(
    { channelId },
    { $set: { isActive: false } },
  );

  aiLogger.debug({ channelId }, "Session invalidated");
}

/**
 * Destroy all active sessions.
 */
export async function destroyAllSessions(): Promise<void> {
  for (const [channelId, session] of activeSessions) {
    try {
      await session.destroy();
      aiLogger.debug({ channelId }, "Session destroyed on shutdown");
    } catch (error) {
      aiLogger.warn(
        { channelId, error: (error as Error).message },
        "Error destroying session on shutdown",
      );
    }
  }
  activeSessions.clear();
}

/**
 * Get the count of active sessions.
 */
export function getActiveSessionCount(): number {
  return activeSessions.size;
}
