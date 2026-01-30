import { getGitHubMCPConfig, type MCPHttpServerConfig } from "./github";

export { type MCPHttpServerConfig } from "./github";

/**
 * Get all configured MCP servers.
 * Returns undefined if no MCP servers are configured.
 */
export function getMcpServersConfig():
  | Record<string, MCPHttpServerConfig>
  | undefined {
  const servers: Record<string, MCPHttpServerConfig> = {};

  // Add GitHub MCP if configured
  const githubConfig = getGitHubMCPConfig();
  if (githubConfig) {
    servers.github = githubConfig;
  }

  // Add more MCP servers here as needed
  // const otherConfig = getOtherMCPConfig();
  // if (otherConfig) servers.other = otherConfig;

  // Return undefined if no servers configured
  return Object.keys(servers).length > 0 ? servers : undefined;
}
