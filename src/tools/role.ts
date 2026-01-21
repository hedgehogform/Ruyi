import type { ColorResolvable, Guild, Role, GuildMember } from "discord.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { toolLogger } from "../logger";
import { getToolContext } from "../utils/types";

function parseColor(color: string | undefined): ColorResolvable | undefined {
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
      (m) =>
        m.user.username.toLowerCase() === username.toLowerCase() ||
        m.displayName.toLowerCase() === username.toLowerCase(),
    ) || members.first()
  );
}

export const manageRoleDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "manage_role",
    description:
      "Manage Discord roles: create a new role, edit an existing role's name/color, or assign/remove a role from a user",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "edit", "assign", "remove"],
          description:
            "Action to perform: create a new role, edit existing role, assign role to user, or remove role from user",
        },
        role_name: {
          type: "string",
          description: "Name of the role to create, edit, assign, or remove",
        },
        new_name: {
          type: ["string", "null"],
          description:
            "New name for the role (only for edit action, null otherwise)",
        },
        color: {
          type: ["string", "null"],
          description:
            "Hex color for the role e.g. '#FF5733' (for create/edit actions, null otherwise)",
        },
        username: {
          type: ["string", "null"],
          description:
            "Username to assign/remove the role to/from (for assign/remove actions, null otherwise)",
        },
      },
      required: ["action", "role_name", "new_name", "color", "username"],
    },
  },
};

async function createRole(
  guild: Guild,
  roleName: string,
  color?: string,
): Promise<string> {
  if (findRole(guild, roleName)) {
    return JSON.stringify({ error: `Role "${roleName}" already exists` });
  }

  const newRole = await guild.roles.create({
    name: roleName,
    color: parseColor(color),
    reason: "Created by Ruyi bot",
  });

  toolLogger.info(
    { role: newRole.name, color: newRole.hexColor },
    "Created role",
  );
  return JSON.stringify({
    success: true,
    action: "created",
    role: { name: newRole.name, color: newRole.hexColor, id: newRole.id },
  });
}

async function editRole(
  guild: Guild,
  roleName: string,
  newName?: string,
  color?: string,
): Promise<string> {
  const role = findRole(guild, roleName);
  if (!role) {
    return JSON.stringify({ error: `Role "${roleName}" not found` });
  }

  if (!newName && !color) {
    return JSON.stringify({
      error: "No changes specified (provide new_name or color)",
    });
  }

  await role.edit({
    name: newName,
    color: parseColor(color),
    reason: "Edited by Ruyi bot",
  });

  toolLogger.info({ role: role.name, newName, color }, "Edited role");
  return JSON.stringify({
    success: true,
    action: "edited",
    role: { name: role.name, color: role.hexColor, id: role.id },
  });
}

async function assignRole(
  guild: Guild,
  roleName: string,
  username?: string,
): Promise<string> {
  if (!username) {
    return JSON.stringify({ error: "Username required for assign action" });
  }

  const role = findRole(guild, roleName);
  if (!role) {
    return JSON.stringify({ error: `Role "${roleName}" not found` });
  }

  const member = await findMember(guild, username);
  if (!member) {
    return JSON.stringify({ error: `User "${username}" not found` });
  }

  if (member.roles.cache.has(role.id)) {
    return JSON.stringify({
      error: `${member.displayName} already has the "${role.name}" role`,
    });
  }

  await member.roles.add(role, "Assigned by Ruyi bot");

  toolLogger.info(
    { role: role.name, user: member.displayName },
    "Assigned role",
  );
  return JSON.stringify({
    success: true,
    action: "assigned",
    role: { name: role.name, color: role.hexColor },
    user: member.displayName,
  });
}

async function removeRole(
  guild: Guild,
  roleName: string,
  username?: string,
): Promise<string> {
  if (!username) {
    return JSON.stringify({ error: "Username required for remove action" });
  }

  const role = findRole(guild, roleName);
  if (!role) {
    return JSON.stringify({ error: `Role "${roleName}" not found` });
  }

  const member = await findMember(guild, username);
  if (!member) {
    return JSON.stringify({ error: `User "${username}" not found` });
  }

  if (!member.roles.cache.has(role.id)) {
    return JSON.stringify({
      error: `${member.displayName} doesn't have the "${role.name}" role`,
    });
  }

  await member.roles.remove(role, "Removed by Ruyi bot");

  toolLogger.info(
    { role: role.name, user: member.displayName },
    "Removed role",
  );
  return JSON.stringify({
    success: true,
    action: "removed",
    role: { name: role.name, color: role.hexColor },
    user: member.displayName,
  });
}

export async function manageRole(
  action: "create" | "edit" | "assign" | "remove",
  roleName: string,
  newName?: string,
  color?: string,
  username?: string,
): Promise<string> {
  const { guild } = getToolContext();
  if (!guild) {
    toolLogger.warn("manage_role called without guild context");
    return JSON.stringify({ error: "Not in a server" });
  }
  toolLogger.debug(
    { action, roleName, newName, color, username },
    "Managing role",
  );

  try {
    switch (action) {
      case "create":
        return await createRole(guild, roleName, color);
      case "edit":
        return await editRole(guild, roleName, newName, color);
      case "assign":
        return await assignRole(guild, roleName, username);
      case "remove":
        return await removeRole(guild, roleName, username);
      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    toolLogger.error({ action, roleName, error }, "Error managing role");
    return JSON.stringify({
      error: `Failed to ${action} role: ${(error as Error).message}`,
    });
  }
}
