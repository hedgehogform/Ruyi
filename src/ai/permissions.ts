import type {
  PermissionRequest,
  PermissionRequestResult,
  PermissionHandler,
} from "@github/copilot-sdk";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type GuildTextBasedChannel,
  type ButtonInteraction,
  ComponentType,
  EmbedBuilder,
} from "discord.js";
import { aiLogger } from "../logger";

// Re-export SDK types for convenience
export type {
  PermissionRequest,
  PermissionRequestResult,
  PermissionHandler,
} from "@github/copilot-sdk";

/**
 * Context needed to show permission prompts in Discord.
 */
export interface PermissionContext {
  channel: GuildTextBasedChannel;
  userId: string; // The user who triggered the request (only they can approve)
}

// Store permission contexts by channel ID
const permissionContexts = new Map<string, PermissionContext>();

/**
 * Set the permission context for a channel.
 * Call this before sending a message that may trigger permission requests.
 */
export function setPermissionContext(
  channelId: string,
  context: PermissionContext,
): void {
  permissionContexts.set(channelId, context);
}

/**
 * Clear the permission context for a channel.
 */
export function clearPermissionContext(channelId: string): void {
  permissionContexts.delete(channelId);
}

/**
 * Get a friendly description of the permission request.
 */
function getPermissionDescription(request: PermissionRequest): string {
  switch (request.kind) {
    case "shell": {
      const command =
        (request.command as string) ||
        (request.shell as string) ||
        "unknown command";
      return `Execute shell command:\n\`\`\`\n${command}\n\`\`\``;
    }
    case "write": {
      const path =
        (request.path as string) || (request.file as string) || "unknown file";
      return `Write to file: \`${path}\``;
    }
    case "read": {
      const path =
        (request.path as string) || (request.file as string) || "unknown file";
      return `Read file: \`${path}\``;
    }
    case "mcp": {
      const tool =
        (request.tool as string) ||
        (request.toolName as string) ||
        "unknown tool";
      return `Use MCP tool: \`${tool}\``;
    }
    case "url": {
      const url = (request.url as string) || "unknown URL";
      return `Access URL: \`${url}\``;
    }
    default:
      return `Permission request: ${request.kind}`;
  }
}

/**
 * Get the color for permission embed based on kind.
 */
function getPermissionColor(kind: string): number {
  switch (kind) {
    case "shell":
      return 0xff6b6b; // Red - most dangerous
    case "write":
      return 0xffa500; // Orange - modifies files
    case "mcp":
      return 0x9b59b6; // Purple - external tools
    case "read":
      return 0x3498db; // Blue - read only
    case "url":
      return 0x2ecc71; // Green - network access
    default:
      return 0x95a5a6; // Gray
  }
}

/**
 * Request permission from the user via Discord buttons.
 * Returns a PermissionRequestResult based on user response.
 *
 * @param channelId - The channel ID to look up the permission context
 * @param request - The permission request from the SDK
 * @param sessionId - The session ID (for logging)
 * @param timeoutMs - Timeout in milliseconds (default 60 seconds)
 */
export async function requestDiscordPermission(
  channelId: string,
  request: PermissionRequest,
  sessionId: string,
  timeoutMs = 60000,
): Promise<PermissionRequestResult> {
  const context = permissionContexts.get(channelId);

  if (!context) {
    aiLogger.warn(
      { channelId, kind: request.kind },
      "No permission context found, denying request",
    );
    return { kind: "denied-no-approval-rule-and-could-not-request-from-user" };
  }

  const { channel, userId } = context;

  try {
    // Build the permission prompt embed
    const embed = new EmbedBuilder()
      .setTitle(`🔐 Permission Required: ${request.kind.toUpperCase()}`)
      .setDescription(getPermissionDescription(request))
      .setColor(getPermissionColor(request.kind))
      .setFooter({
        text: `Only the requesting user can respond • Expires in ${Math.round(timeoutMs / 1000)}s`,
      })
      .setTimestamp();

    // Build approve/deny buttons
    const buttonId = request.toolCallId || String(Date.now());
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`perm_approve_${buttonId}`)
        .setLabel("✅ Allow")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`perm_deny_${buttonId}`)
        .setLabel("❌ Deny")
        .setStyle(ButtonStyle.Danger),
    );

    // Send the permission prompt
    const promptMessage = await channel.send({
      embeds: [embed],
      components: [row],
    });

    aiLogger.info(
      { channelId, sessionId, kind: request.kind, userId },
      "Permission prompt sent, waiting for user response",
    );

    // Wait for button interaction
    try {
      const interaction = await promptMessage.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: (i: ButtonInteraction) => i.user.id === userId,
        time: timeoutMs,
      });

      // Disable buttons after interaction
      const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("perm_approve_disabled")
          .setLabel("✅ Allow")
          .setStyle(ButtonStyle.Success)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId("perm_deny_disabled")
          .setLabel("❌ Deny")
          .setStyle(ButtonStyle.Danger)
          .setDisabled(true),
      );

      const approved = interaction.customId.startsWith("perm_approve");

      // Update the embed to show the decision
      const resultEmbed = new EmbedBuilder()
        .setTitle(
          approved
            ? `✅ Permission Granted: ${request.kind.toUpperCase()}`
            : `❌ Permission Denied: ${request.kind.toUpperCase()}`,
        )
        .setDescription(getPermissionDescription(request))
        .setColor(approved ? 0x00ff00 : 0xff0000)
        .setFooter({ text: `Decided by ${interaction.user.username}` })
        .setTimestamp();

      await interaction.update({
        embeds: [resultEmbed],
        components: [disabledRow],
      });

      aiLogger.info(
        { channelId, sessionId, kind: request.kind, approved },
        "User responded to permission request",
      );

      return approved
        ? { kind: "approved" }
        : { kind: "denied-interactively-by-user" };
    } catch {
      // Timeout - disable buttons and deny
      const timeoutRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("perm_approve_timeout")
          .setLabel("✅ Allow")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
        new ButtonBuilder()
          .setCustomId("perm_deny_timeout")
          .setLabel("❌ Deny")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
      );

      const timeoutEmbed = new EmbedBuilder()
        .setTitle(`⏰ Permission Expired: ${request.kind.toUpperCase()}`)
        .setDescription(getPermissionDescription(request))
        .setColor(0x95a5a6)
        .setFooter({ text: "Request timed out" })
        .setTimestamp();

      await promptMessage
        .edit({
          embeds: [timeoutEmbed],
          components: [timeoutRow],
        })
        .catch(() => {}); // Ignore edit errors

      aiLogger.warn(
        { channelId, sessionId, kind: request.kind },
        "Permission request timed out",
      );

      return {
        kind: "denied-no-approval-rule-and-could-not-request-from-user",
      };
    }
  } catch (error) {
    aiLogger.error(
      {
        channelId,
        sessionId,
        kind: request.kind,
        error: (error as Error).message,
      },
      "Failed to send permission prompt",
    );
    return { kind: "denied-no-approval-rule-and-could-not-request-from-user" };
  }
}

/**
 * Create a permission handler function for a specific channel.
 * This returns a function that can be passed to the SDK's onPermissionRequest.
 */
export function createPermissionHandler(channelId: string): PermissionHandler {
  return async (
    request: PermissionRequest,
    invocation: { sessionId: string },
  ): Promise<PermissionRequestResult> => {
    return requestDiscordPermission(channelId, request, invocation.sessionId);
  };
}
