import { getConfigValue, setConfigValue } from "./db/models";

const DEFAULT_PREFIX = "!";

// In-memory cache for prefix (to avoid async calls everywhere)
let cachedPrefix = DEFAULT_PREFIX;

export async function loadConfig(): Promise<void> {
  cachedPrefix = await getConfigValue("prefix", DEFAULT_PREFIX);
}

export function getPrefix(): string {
  return cachedPrefix;
}

export async function setPrefix(prefix: string): Promise<void> {
  cachedPrefix = prefix;
  await setConfigValue("prefix", prefix);
}
