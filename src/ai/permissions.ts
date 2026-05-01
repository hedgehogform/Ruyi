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
import { PERMISSION_TIMEOUT_MS } from "../constants";

// Re-export SDK types for convenience
export type {
  PermissionRequest,
  PermissionRequestResult,
  PermissionHandler,
} from "@github/copilot-sdk";

export interface PermissionContext {
  channel: GuildTextBasedChannel;
  userId: string;
}

function getPermissionDescription(request: PermissionRequest): string {
  switch (request.kind) {
    case "shell":
      return "Execute a shell command";
    case "write":
      return "Write to a file";
    case "read":
      return "Read a file";
    case "mcp":
      return "Use an MCP tool";
    case "url":
      return "Access a URL";
    case "custom-tool":
      return "Use a custom tool";
    case "memory":
      return "Access memory";
    case "hook":
      return "Run a hook";
    default:
      return `Permission request: ${request.kind}`;
  }
}

function getPermissionColor(kind: string): number {
  switch (kind) {
    case "shell":
      return 0xff6b6b;
    case "write":
      return 0xffa500;
    case "mcp":
      return 0x9b59b6;
    case "read":
      return 0x3498db;
    case "url":
      return 0x2ecc71;
    default:
      return 0x95a5a6;
  }
}

export class PermissionManager {
  private readonly contexts = new Map<string, PermissionContext>();

  setContext(channelId: string, context: PermissionContext): void {
    this.contexts.set(channelId, context);
  }

  clearContext(channelId: string): void {
    this.contexts.delete(channelId);
  }

  async requestPermission(
    channelId: string,
    request: PermissionRequest,
    sessionId: string,
    timeoutMs = PERMISSION_TIMEOUT_MS,
  ): Promise<PermissionRequestResult> {
    const context = this.contexts.get(channelId);

    if (!context) {
      aiLogger.warn(
        { channelId, kind: request.kind },
        "No permission context found, denying request",
      );
      return { kind: "user-not-available" };
    }

    const { channel, userId } = context;

    try {
      const embed = new EmbedBuilder()
        .setTitle(`🔐 Permission Required: ${request.kind.toUpperCase()}`)
        .setDescription(getPermissionDescription(request))
        .setColor(getPermissionColor(request.kind))
        .setFooter({
          text: `Only the requesting user can respond • Expires in ${Math.round(timeoutMs / 1000)}s`,
        })
        .setTimestamp();

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

      const promptMessage = await channel.send({
        embeds: [embed],
        components: [row],
      });

      aiLogger.info(
        { channelId, sessionId, kind: request.kind, userId },
        "Permission prompt sent, waiting for user response",
      );

      try {
        const interaction = await promptMessage.awaitMessageComponent({
          componentType: ComponentType.Button,
          filter: (i: ButtonInteraction) => i.user.id === userId,
          time: timeoutMs,
        });

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

        return approved ? { kind: "approve-once" } : { kind: "reject" };
      } catch {
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
          .catch((error: unknown) => {
            aiLogger.debug(
              {
                error: (error as Error)?.message,
                channelId,
                sessionId,
                kind: request.kind,
              },
              "Failed to edit timed-out permission prompt",
            );
          });

        aiLogger.warn(
          { channelId, sessionId, kind: request.kind },
          "Permission request timed out",
        );

        return { kind: "user-not-available" };
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
      return { kind: "user-not-available" };
    }
  }

  createHandler(channelId: string): PermissionHandler {
    return async (
      request: PermissionRequest,
      invocation: { sessionId: string },
    ): Promise<PermissionRequestResult> => {
      return this.requestPermission(channelId, request, invocation.sessionId);
    };
  }
}

export const permissionManager = new PermissionManager();
