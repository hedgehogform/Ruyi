import type { Client, TextChannel, NewsChannel, ThreadChannel } from "discord.js";
import { Conversation, type IConversation } from "../db/models";
import { syncLogger } from "../logger";

// How often to run the sync (default: every 5 minutes)
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

// Batch size for checking messages (to avoid hammering the API)
const BATCH_SIZE = 10;

// Delay between batches (ms)
const BATCH_DELAY_MS = 1000;

// Type for channels that can fetch messages
type MessageableChannel = TextChannel | NewsChannel | ThreadChannel;

function isMessageableChannel(channel: unknown): channel is MessageableChannel {
  return (
    channel !== null &&
    typeof channel === "object" &&
    "messages" in channel &&
    typeof (channel as { messages: { fetch: unknown } }).messages?.fetch === "function"
  );
}

// Check if a single message exists in Discord
async function messageExists(channel: MessageableChannel, messageId: string): Promise<boolean> {
  try {
    await channel.messages.fetch(messageId);
    return true;
  } catch {
    return false;
  }
}

// Process a batch of messages and return IDs that no longer exist
async function findDeletedMessages(
  channel: MessageableChannel,
  messageIds: string[]
): Promise<string[]> {
  const deleted: string[] = [];

  for (const messageId of messageIds) {
    const exists = await messageExists(channel, messageId);
    if (!exists) {
      deleted.push(messageId);
    }
  }

  return deleted;
}

// Sleep helper for rate limiting
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sync a single conversation's messages with Discord
async function syncConversation(
  client: Client,
  conversation: IConversation
): Promise<{ channelId: string; deleted: number; skipped: number }> {
  const channelId = conversation.channelId;
  const messagesWithIds = conversation.messages.filter((m) => m.messageId);

  if (messagesWithIds.length === 0) {
    return { channelId, deleted: 0, skipped: conversation.messages.length };
  }

  // Try to get the channel
  let channel: MessageableChannel;
  try {
    const fetchedChannel = await client.channels.fetch(channelId);
    if (!isMessageableChannel(fetchedChannel)) {
      syncLogger.debug({ channelId }, "Channel is not messageable, skipping");
      return { channelId, deleted: 0, skipped: messagesWithIds.length };
    }
    channel = fetchedChannel;
  } catch {
    // Channel might be deleted or inaccessible
    syncLogger.debug({ channelId }, "Could not fetch channel, skipping");
    return { channelId, deleted: 0, skipped: messagesWithIds.length };
  }

  // Process messages in batches
  const messageIds = messagesWithIds.map((m) => m.messageId!);
  const deletedIds: string[] = [];

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    const batch = messageIds.slice(i, i + BATCH_SIZE);
    const deleted = await findDeletedMessages(channel, batch);
    deletedIds.push(...deleted);

    // Rate limiting between batches
    if (i + BATCH_SIZE < messageIds.length) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  // Remove deleted messages from the database
  if (deletedIds.length > 0) {
    await Conversation.updateOne(
      { channelId },
      { $pull: { messages: { messageId: { $in: deletedIds } } } }
    );
  }

  const skipped = conversation.messages.filter((m) => !m.messageId).length;
  return { channelId, deleted: deletedIds.length, skipped };
}

// Run a full sync across all conversations
async function runSync(client: Client): Promise<void> {
  const startTime = Date.now();
  syncLogger.info("Starting message sync sweep");

  try {
    const conversations = await Conversation.find({});
    let totalDeleted = 0;
    let totalSkipped = 0;
    let channelsProcessed = 0;

    for (const conversation of conversations) {
      const result = await syncConversation(client, conversation);
      totalDeleted += result.deleted;
      totalSkipped += result.skipped;
      channelsProcessed++;

      // Add a small delay between channels to avoid rate limits
      if (channelsProcessed < conversations.length) {
        await sleep(500);
      }
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    syncLogger.info(
      {
        channels: channelsProcessed,
        deleted: totalDeleted,
        skipped: totalSkipped,
        elapsed: `${elapsed}s`,
      },
      "Message sync sweep completed"
    );
  } catch (error) {
    syncLogger.error({ error }, "Message sync sweep failed");
  }
}

let syncInterval: ReturnType<typeof setInterval> | null = null;

// Start the periodic sync service
export function startMessageSync(client: Client): void {
  if (syncInterval) {
    syncLogger.warn("Message sync already running");
    return;
  }

  syncLogger.info({ intervalMs: SYNC_INTERVAL_MS }, "Starting message sync service");

  // Run immediately on startup
  runSync(client);

  // Then run periodically
  syncInterval = setInterval(() => runSync(client), SYNC_INTERVAL_MS);
}

// Stop the sync service
export function stopMessageSync(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
    syncLogger.info("Message sync service stopped");
  }
}

// Manual trigger for sync (useful for testing or on-demand cleanup)
export async function triggerSync(client: Client): Promise<void> {
  await runSync(client);
}

// Delete a single message from DB (called on messageDelete event)
export async function deleteMessageFromDb(channelId: string, messageId: string): Promise<void> {
  try {
    const result = await Conversation.updateOne(
      { channelId },
      { $pull: { messages: { messageId } } }
    );
    if (result.modifiedCount > 0) {
      syncLogger.debug({ channelId, messageId }, "Deleted message from DB");
    }
  } catch (error) {
    syncLogger.error({ error, channelId, messageId }, "Failed to delete message from DB");
  }
}
