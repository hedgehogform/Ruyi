import { aiLogger } from "../logger";

// MCP server configuration type (matches SDK expectations)
export interface MCPHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  tools: string[]; // Required by SDK
}

/**
 * Get GitHub MCP server configuration.
 * Requires GITHUB_TOKEN environment variable to be set.
 *
 * Token scopes needed:
 * - repo: Repository operations, issues, PRs
 * - read:org: Organization/team access
 * - gist: Gist operations
 * - notifications: Notification management
 * - project: Project boards
 * - security_events: Code scanning, Dependabot, secret scanning
 */
export function getGitHubMCPConfig(): MCPHttpServerConfig | undefined {
  const githubToken = Bun.env.GITHUB_TOKEN;

  if (!githubToken) {
    aiLogger.debug("GITHUB_TOKEN not set, GitHub MCP server disabled");
    return undefined;
  }

  return {
    type: "http" as const,
    url: "https://api.githubcopilot.com/mcp/",
    headers: {
      Authorization: `Bearer ${githubToken}`,
    },
    tools: ["*"], // Enable all GitHub tools
  };
}
