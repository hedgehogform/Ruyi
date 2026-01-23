import { tool } from "@openrouter/sdk";
import { z } from "zod";
import type { ColorResolvable, Guild, Role, GuildMember } from "discord.js";
import { toolLogger } from "../logger";
import { getToolContext } from "../utils/types";

function parseColor(
  color: string | undefined | null,
): ColorResolvable | undefined {
  if (!color) return undefined;
  return (color.startsWith("#") ? color : `#${color}`) as ColorResolvable;
}

function findRole(guild: Guild, roleName: string): Role | undefined {
  return guild.roles.cache.find(
    (r) => r.name.toLowerCase() === roleName.toLowerCase(),
  );
}

async function findMember(
  guild: Guild,
  username: string,
): Promise<GuildMember | undefined> {
  const members = await guild.members.fetch({ query: username, limit: 10 });
  return (
    members.find(
      (m) => m.user.username.toLowerCase() === username.toLowerCase(),
    ) || members.first()
  );
}

export const manageRoleTool = tool({
  name: "manage_role",
  description:
    "Manage Discord roles: create a new role, edit an existing role's name/color, or assign/remove a role from a user",
  inputSchema: z.object({
    action: z
      .enum(["create", "edit", "assign", "remove"])
      .describe(
        "Action to perform: create a new role, edit existing role, assign role to user, or remove role from user",
      ),
    role_name: z
      .string()
      .describe("Name of the role to create, edit, assign, or remove"),
    new_name: z
      .string()
      .nullable()
      .describe("New name for the role (only for edit action, null otherwise)"),
    color: z
      .string()
      .nullable()
      .describe(
        "Hex color for the role e.g. '#FF5733' (for create/edit actions, null otherwise)",
      ),
    username: z
      .string()
      .nullable()
      .describe(
        "Username to assign/remove the role to/from (for assign/remove actions, null otherwise)",
      ),
  }),
  execute: async ({ action, role_name, new_name, color, username }) => {
    const { guild } = getToolContext();
    if (!guild) {
      toolLogger.warn("manage_role called without guild context");
      return { error: "Not in a server" };
    }

    toolLogger.debug(
      { action, role_name, new_name, color, username },
      "Managing role",
    );

    try {
      switch (action) {
        case "create": {
          if (findRole(guild, role_name)) {
            return { error: `Role "${role_name}" already exists` };
          }
          const newRole = await guild.roles.create({
            name: role_name,
            color: parseColor(color),
            reason: "Created by Ruyi bot",
          });
          toolLogger.info(
            { role: newRole.name, color: newRole.hexColor },
            "Created role",
          );
          return {
            success: true,
            action: "created",
            role: {
              name: newRole.name,
              color: newRole.hexColor,
              id: newRole.id,
            },
          };
        }

        case "edit": {
          const role = findRole(guild, role_name);
          if (!role) {
            return { error: `Role "${role_name}" not found` };
          }
          if (!new_name && !color) {
            return {
              error: "No changes specified (provide new_name or color)",
            };
          }
          await role.edit({
            name: new_name ?? undefined,
            color: parseColor(color),
            reason: "Edited by Ruyi bot",
          });
          toolLogger.info({ role: role.name, new_name, color }, "Edited role");
          return {
            success: true,
            action: "edited",
            role: { name: role.name, color: role.hexColor, id: role.id },
          };
        }

        case "assign": {
          if (!username) {
            return { error: "Username required for assign action" };
          }
          const role = findRole(guild, role_name);
          if (!role) {
            return { error: `Role "${role_name}" not found` };
          }
          const member = await findMember(guild, username);
          if (!member) {
            return { error: `User "${username}" not found` };
          }
          if (member.roles.cache.has(role.id)) {
            return {
              error: `${member.user.username} already has the "${role.name}" role`,
            };
          }
          await member.roles.add(role, "Assigned by Ruyi bot");
          toolLogger.info(
            { role: role.name, user: member.user.username },
            "Assigned role",
          );
          return {
            success: true,
            action: "assigned",
            role: { name: role.name, color: role.hexColor },
            user: member.user.username,
          };
        }

        case "remove": {
          if (!username) {
            return { error: "Username required for remove action" };
          }
          const role = findRole(guild, role_name);
          if (!role) {
            return { error: `Role "${role_name}" not found` };
          }
          const member = await findMember(guild, username);
          if (!member) {
            return { error: `User "${username}" not found` };
          }
          if (!member.roles.cache.has(role.id)) {
            return {
              error: `${member.user.username} doesn't have the "${role.name}" role`,
            };
          }
          await member.roles.remove(role, "Removed by Ruyi bot");
          toolLogger.info(
            { role: role.name, user: member.user.username },
            "Removed role",
          );
          return {
            success: true,
            action: "removed",
            role: { name: role.name, color: role.hexColor },
            user: member.user.username,
          };
        }

        default:
          return { error: `Unknown action: ${action}` };
      }
    } catch (error) {
      toolLogger.error({ action, role_name, error }, "Error managing role");
      return { error: `Failed to ${action} role: ${(error as Error).message}` };
    }
  },
});
