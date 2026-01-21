import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { AuditLogEvent, type GuildAuditLogsEntry } from "discord.js";
import { toolLogger } from "../logger";
import { getToolContext } from "./types";

// Map readable action names to Discord AuditLogEvent values
const actionTypeMap: Record<string, AuditLogEvent> = {
  // Guild actions
  guild_update: AuditLogEvent.GuildUpdate,
  // Channel actions
  channel_create: AuditLogEvent.ChannelCreate,
  channel_update: AuditLogEvent.ChannelUpdate,
  channel_delete: AuditLogEvent.ChannelDelete,
  // Role actions
  role_create: AuditLogEvent.RoleCreate,
  role_update: AuditLogEvent.RoleUpdate,
  role_delete: AuditLogEvent.RoleDelete,
  // Member actions
  member_kick: AuditLogEvent.MemberKick,
  member_ban_add: AuditLogEvent.MemberBanAdd,
  member_ban_remove: AuditLogEvent.MemberBanRemove,
  member_update: AuditLogEvent.MemberUpdate,
  member_role_update: AuditLogEvent.MemberRoleUpdate,
  // Message actions
  message_delete: AuditLogEvent.MessageDelete,
  message_bulk_delete: AuditLogEvent.MessageBulkDelete,
  message_pin: AuditLogEvent.MessagePin,
  message_unpin: AuditLogEvent.MessageUnpin,
  // Invite actions
  invite_create: AuditLogEvent.InviteCreate,
  invite_delete: AuditLogEvent.InviteDelete,
  // Webhook actions
  webhook_create: AuditLogEvent.WebhookCreate,
  webhook_update: AuditLogEvent.WebhookUpdate,
  webhook_delete: AuditLogEvent.WebhookDelete,
  // Emoji actions
  emoji_create: AuditLogEvent.EmojiCreate,
  emoji_update: AuditLogEvent.EmojiUpdate,
  emoji_delete: AuditLogEvent.EmojiDelete,
  // Integration actions
  integration_create: AuditLogEvent.IntegrationCreate,
  integration_update: AuditLogEvent.IntegrationUpdate,
  integration_delete: AuditLogEvent.IntegrationDelete,
  // Bot/application actions
  bot_add: AuditLogEvent.BotAdd,
};

// Get the action name from the event number
function getActionName(event: AuditLogEvent): string {
  for (const [name, value] of Object.entries(actionTypeMap)) {
    if (value === event) return name;
  }
  return `unknown_${event}`;
}

export const auditLogDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "get_audit_log",
    description:
      "Search and view the Discord server audit log. Shows who did what actions like bans, kicks, role changes, message deletions, channel modifications, etc. Requires VIEW_AUDIT_LOG permission.",
    parameters: {
      type: "object",
      properties: {
        action_type: {
          type: ["string", "null"],
          enum: [
            null,
            "guild_update",
            "channel_create",
            "channel_update",
            "channel_delete",
            "role_create",
            "role_update",
            "role_delete",
            "member_kick",
            "member_ban_add",
            "member_ban_remove",
            "member_update",
            "member_role_update",
            "message_delete",
            "message_bulk_delete",
            "message_pin",
            "message_unpin",
            "invite_create",
            "invite_delete",
            "webhook_create",
            "webhook_update",
            "webhook_delete",
            "emoji_create",
            "emoji_update",
            "emoji_delete",
            "bot_add",
          ],
          description:
            "Filter by action type. Leave null to get all recent actions. Common types: member_kick, member_ban_add, member_ban_remove, role_create, role_update, message_delete, channel_create, channel_delete.",
        },
        user: {
          type: ["string", "null"],
          description:
            "Filter by the user who performed the action (username or display name). Leave null to show all users.",
        },
        target_user: {
          type: ["string", "null"],
          description:
            "Filter by the target of the action (e.g., who was banned/kicked). Leave null to show all targets.",
        },
        limit: {
          type: ["number", "null"],
          description: "Maximum number of entries to return (1-50, default 10).",
        },
      },
      required: ["action_type", "user", "target_user", "limit"],
      additionalProperties: false,
    },
  },
};

interface AuditLogResult {
  id: string;
  action: string;
  executor: string | null;
  executorId: string | null;
  target: string | null;
  targetId: string | null;
  targetType: string | null;
  reason: string | null;
  timestamp: number;
  changes: Array<{ key: string; old?: unknown; new?: unknown }>;
}

// Determine target type from entry
function getTargetType(target: unknown): string {
  if (!target || typeof target !== "object") return "unknown";
  if ("username" in target) return "user";
  if ("guild" in target) return "channel";
  if ("color" in target) return "role";
  return "other";
}

// Format the target based on its type
function formatTarget(entry: GuildAuditLogsEntry): { name: string | null; id: string | null; type: string | null } {
  const target = entry.target;
  if (!target) return { name: null, id: null, type: null };

  // Handle user targets
  if (typeof target === "object" && "username" in target) {
    const user = target as { username: string | null; id: string };
    return {
      name: user.username ?? null,
      id: user.id ?? null,
      type: "user",
    };
  }

  // Handle named targets (channels, roles, etc.)
  if (typeof target === "object" && "name" in target) {
    const named = target as { name: string; id?: string };
    return {
      name: named.name ?? null,
      id: named.id ?? null,
      type: getTargetType(target),
    };
  }

  // Handle targets with just ID
  if (typeof target === "object" && "id" in target) {
    const hasId = target as { id: string };
    return { name: null, id: hasId.id ?? null, type: "unknown" };
  }

  return { name: null, id: null, type: null };
}

export async function getAuditLog(
  actionType: string | null,
  user: string | null,
  targetUser: string | null,
  limit: number | null
): Promise<string> {
  const { guild } = getToolContext();

  if (!guild) {
    toolLogger.warn("get_audit_log called without guild context");
    return JSON.stringify({ error: "Not in a server" });
  }

  const searchLimit = Math.min(Math.max(limit ?? 10, 1), 50);

  try {
    // Build fetch options
    const fetchOptions: { limit: number; type?: AuditLogEvent } = {
      limit: user || targetUser ? Math.min(searchLimit * 3, 100) : searchLimit,
    };

    // Add action type filter if specified
    if (actionType && actionType in actionTypeMap) {
      fetchOptions.type = actionTypeMap[actionType];
    }

    const auditLogs = await guild.fetchAuditLogs(fetchOptions);
    let entries = [...auditLogs.entries.values()];

    // Filter by executor username if specified
    if (user) {
      const userLower = user.toLowerCase();
      entries = entries.filter((entry) => {
        const executor = entry.executor;
        if (!executor?.username) return false;
        return (
          executor.username.toLowerCase().includes(userLower) ||
          executor.displayName.toLowerCase().includes(userLower)
        );
      });
    }

    // Filter by target username if specified
    if (targetUser) {
      const targetLower = targetUser.toLowerCase();
      entries = entries.filter((entry) => {
        const target = entry.target;
        if (!target || typeof target !== "object" || !("username" in target)) return false;
        const username = (target as { username?: string }).username;
        if (!username) return false;
        const displayName = (target as { displayName?: string }).displayName;
        return (
          username.toLowerCase().includes(targetLower) ||
          displayName?.toLowerCase().includes(targetLower)
        );
      });
    }

    // Build results
    const results: AuditLogResult[] = entries.slice(0, searchLimit).map((entry) => {
      const targetInfo = formatTarget(entry);
      return {
        id: entry.id,
        action: getActionName(entry.action),
        executor: entry.executor?.username ?? null,
        executorId: entry.executor?.id ?? null,
        target: targetInfo.name,
        targetId: targetInfo.id,
        targetType: targetInfo.type,
        reason: entry.reason,
        timestamp: Math.floor(entry.createdTimestamp / 1000),
        changes: entry.changes.map((c) => ({
          key: c.key,
          old: c.old,
          new: c.new,
        })),
      };
    });

    toolLogger.info(
      { actionType, user, targetUser, found: results.length },
      "Audit log search complete"
    );

    return JSON.stringify({
      entries: results,
      total: results.length,
      server: guild.name,
      hint:
        results.length > 0
          ? "Timestamps are Unix timestamps. Use <t:TIMESTAMP:F> for full date/time format in Discord."
          : "No audit log entries found matching your criteria.",
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    toolLogger.error({ error: errorMessage }, "Failed to fetch audit log");

    // Check for permission error
    if (errorMessage.includes("Missing Permissions") || errorMessage.includes("VIEW_AUDIT_LOG")) {
      return JSON.stringify({
        error: "Missing VIEW_AUDIT_LOG permission",
        details: "The bot needs the 'View Audit Log' permission to access audit logs.",
      });
    }

    return JSON.stringify({ error: "Failed to fetch audit log", details: errorMessage });
  }
}
