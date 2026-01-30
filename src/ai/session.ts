import type { CopilotSession as SDKSession } from "@github/copilot-sdk";
import { allTools } from "../tools";
import { aiLogger } from "../logger";
import { CopilotSession as CopilotSessionModel } from "../db/models";
import { getMcpServersConfig } from "../mcp";
import { getClient, getProviderConfig, MODEL } from "./client";

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

    aiLogger.info(
      { count: persistedSessions.length },
      "Loading persisted sessions",
    );

    for (const persisted of persistedSessions) {
      try {
        // Try to resume the session - ResumeSessionConfig only takes tools, not model/provider
        const session = await client.resumeSession(persisted.sessionId, {
          tools: [...allTools],
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
      // Try to resume the session - ResumeSessionConfig only takes tools, not model/provider
      const session = await client.resumeSession(persistedSession.sessionId, {
        tools: [...allTools],
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

  // Get MCP servers config (GitHub MCP if token is set)
  const mcpServers = getMcpServersConfig();

  console.log(
    "DEBUG: Creating session with MCP config:",
    mcpServers ? JSON.stringify(mcpServers, null, 2) : "none",
  );

  const session = await client.createSession({
    sessionId,
    model: MODEL,
    provider: getProviderConfig(),
    tools: [...allTools],
    systemMessage: {
      mode: "replace",
      content: systemMessage,
    },
    streaming: false,
    infiniteSessions: { enabled: true }, // Enable infinite sessions for persistence
    ...(mcpServers && { mcpServers }), // Add MCP servers if configured
  });

  // Log MCP status
  if (mcpServers) {
    aiLogger.info(
      { channelId, mcpServers: Object.keys(mcpServers) },
      "Session created with MCP servers",
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
