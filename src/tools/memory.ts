import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { toolLogger } from "../logger";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Memory store path
const MEMORY_STORE_FILE = join(import.meta.dir, "..", "..", "memory_store.json");

interface MemoryItem {
  key: string;
  value: string;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
}

interface MemoryStore {
  global: Record<string, MemoryItem>;
  users: Record<string, Record<string, MemoryItem>>;
}

// Load or initialize memory store
function loadMemoryStore(): MemoryStore {
  try {
    if (existsSync(MEMORY_STORE_FILE)) {
      const data = readFileSync(MEMORY_STORE_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (error) {
    toolLogger.warn({ error }, "Failed to load memory store, starting fresh");
  }
  return { global: {}, users: {} };
}

function saveMemoryStore(store: MemoryStore): void {
  try {
    writeFileSync(MEMORY_STORE_FILE, JSON.stringify(store, null, 2));
  } catch (error) {
    toolLogger.error({ error }, "Failed to save memory store");
  }
}

// Memory store instance
const memoryStore = loadMemoryStore();

// Tool definitions
export const memoryStoreDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "memory_store",
    description:
      "Store information to remember for later. Use this when a user asks you to remember something, save a note, or store information. Memories persist across conversations and bot restarts. You can store global memories (accessible by everyone) or user-specific memories.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["save", "get", "delete", "list"],
          description:
            "The action to perform: 'save' to store a memory, 'get' to retrieve a specific memory, 'delete' to remove a memory, 'list' to show all memories",
        },
        key: {
          type: ["string", "null"],
          description:
            "A short identifier/name for the memory (e.g., 'favorite_color', 'birthday', 'project_deadline'). Required for save, get, delete.",
        },
        value: {
          type: ["string", "null"],
          description: "The information to remember. Required for save action.",
        },
        scope: {
          type: "string",
          enum: ["global", "user"],
          description:
            "Where to store the memory: 'global' for server-wide memories anyone can access, 'user' for memories specific to the current user. Defaults to 'user'.",
        },
        username: {
          type: ["string", "null"],
          description:
            "The username for user-scoped memories. Will be provided automatically.",
        },
      },
      required: ["action", "key", "value", "scope", "username"],
      additionalProperties: false,
    },
  },
};

export const memoryRecallDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "memory_recall",
    description:
      "Recall all stored memories for context. Use this at the start of conversations or when you need to remember what you know about a user or topic. Returns a summary of all relevant memories.",
    parameters: {
      type: "object",
      properties: {
        username: {
          type: ["string", "null"],
          description: "The username to recall memories for.",
        },
        include_global: {
          type: "boolean",
          description: "Whether to include global memories. Defaults to true.",
        },
      },
      required: ["username", "include_global"],
      additionalProperties: false,
    },
  },
};

// Truncate value if too long
function truncateValue(value: string, maxLength = 500): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength - 3) + "...";
}

// Find oldest key in a memory record
function findOldestKey(records: Record<string, MemoryItem>): string | null {
  const entries = Object.entries(records);
  if (entries.length === 0) return null;

  const sorted = entries.toSorted(([, a], [, b]) => a.updatedAt - b.updatedAt);
  return sorted[0]?.[0] ?? null;
}

// Enforce memory limits
function enforceGlobalLimit(): void {
  const globalKeys = Object.keys(memoryStore.global);
  if (globalKeys.length > 50) {
    const oldest = findOldestKey(memoryStore.global);
    if (oldest) delete memoryStore.global[oldest];
  }
}

function enforceUserLimit(username: string): void {
  const userMemories = memoryStore.users[username];
  if (!userMemories) return;

  const userKeys = Object.keys(userMemories);
  if (userKeys.length > 30) {
    const oldest = findOldestKey(userMemories);
    if (oldest) delete userMemories[oldest];
  }
}

// Individual action handlers
function handleSave(
  key: string,
  value: string,
  scope: "global" | "user",
  username: string | null
): string {
  const truncatedValue = truncateValue(value);
  const item: MemoryItem = {
    key,
    value: truncatedValue,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    createdBy: username ?? "unknown",
  };

  if (scope === "global") {
    const existing = memoryStore.global[key];
    if (existing) {
      item.createdAt = existing.createdAt;
    }
    memoryStore.global[key] = item;
    enforceGlobalLimit();
  } else {
    if (!username) {
      return JSON.stringify({ error: "Username required for user-scoped memories" });
    }
    memoryStore.users[username] ??= {};
    const existing = memoryStore.users[username][key];
    if (existing) {
      item.createdAt = existing.createdAt;
    }
    memoryStore.users[username][key] = item;
    enforceUserLimit(username);
  }

  saveMemoryStore(memoryStore);
  return JSON.stringify({
    success: true,
    message: `Remembered "${key}" for ${scope === "global" ? "everyone" : username}`,
  });
}

function handleGet(
  key: string,
  scope: "global" | "user",
  username: string | null
): string {
  let item: MemoryItem | undefined;
  if (scope === "global") {
    item = memoryStore.global[key];
  } else if (username) {
    item = memoryStore.users[username]?.[key];
  }

  if (!item) {
    return JSON.stringify({ found: false, message: `No memory found for "${key}"` });
  }

  return JSON.stringify({
    found: true,
    key: item.key,
    value: item.value,
    createdBy: item.createdBy,
    createdAt: item.createdAt,
  });
}

function handleDelete(
  key: string,
  scope: "global" | "user",
  username: string | null
): string {
  let deleted = false;
  if (scope === "global" && memoryStore.global[key]) {
    delete memoryStore.global[key];
    deleted = true;
  } else if (username && memoryStore.users[username]?.[key]) {
    delete memoryStore.users[username][key];
    deleted = true;
  }

  if (deleted) {
    saveMemoryStore(memoryStore);
    return JSON.stringify({ success: true, message: `Forgot "${key}"` });
  }
  return JSON.stringify({ success: false, message: `No memory found for "${key}"` });
}

function handleList(username: string | null): string {
  const memories: { scope: string; key: string; value: string; createdBy: string }[] = [];

  for (const [k, v] of Object.entries(memoryStore.global)) {
    memories.push({ scope: "global", key: k, value: v.value, createdBy: v.createdBy });
  }

  if (username && memoryStore.users[username]) {
    for (const [k, v] of Object.entries(memoryStore.users[username])) {
      memories.push({ scope: "user", key: k, value: v.value, createdBy: v.createdBy });
    }
  }

  return JSON.stringify({ count: memories.length, memories });
}

// Memory store operations
export function memoryStoreOperation(
  action: "save" | "get" | "delete" | "list",
  key: string | null,
  value: string | null,
  scope: "global" | "user",
  username: string | null
): string {
  toolLogger.info({ action, key, scope, username }, "Memory store operation");

  try {
    switch (action) {
      case "save":
        if (!key || !value) {
          return JSON.stringify({ error: "Key and value are required for save" });
        }
        return handleSave(key, value, scope, username);

      case "get":
        if (!key) {
          return JSON.stringify({ error: "Key is required for get" });
        }
        return handleGet(key, scope, username);

      case "delete":
        if (!key) {
          return JSON.stringify({ error: "Key is required for delete" });
        }
        return handleDelete(key, scope, username);

      case "list":
        return handleList(username);

      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    toolLogger.error({ error: errorMessage }, "Memory store operation failed");
    return JSON.stringify({ error: errorMessage });
  }
}

// Helper to add memories with truncation
function addMemoriesFromEntries(
  entries: [string, MemoryItem][],
  header: string,
  memories: string[],
  state: { totalLength: number },
  maxLength: number
): void {
  if (entries.length === 0) return;

  memories.push(header);
  for (const [key, item] of entries) {
    const line = `• ${key}: ${item.value}`;
    if (state.totalLength + line.length > maxLength) {
      memories.push("... (truncated)");
      return;
    }
    memories.push(line);
    state.totalLength += line.length;
  }
}

export function memoryRecall(
  username: string | null,
  includeGlobal = true
): string {
  toolLogger.info({ username, includeGlobal }, "Recalling memories");

  const memories: string[] = [];
  const state = { totalLength: 0 };
  const maxTotalLength = 2000;

  if (includeGlobal) {
    addMemoriesFromEntries(
      Object.entries(memoryStore.global),
      "=== Global Memories ===",
      memories,
      state,
      maxTotalLength
    );
  }

  if (username && memoryStore.users[username]) {
    addMemoriesFromEntries(
      Object.entries(memoryStore.users[username]),
      `=== Memories about ${username} ===`,
      memories,
      state,
      maxTotalLength
    );
  }

  if (memories.length === 0) {
    return JSON.stringify({ hasMemories: false, message: "No memories stored yet." });
  }

  return JSON.stringify({
    hasMemories: true,
    summary: memories.join("\n"),
  });
}
