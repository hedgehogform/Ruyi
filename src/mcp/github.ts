import { MCPServer } from "./base";

/**
 * GitHub MCP server configuration.
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
export class GitHubMCPServer extends MCPServer {
  readonly name = "github";
  readonly toolPrefix = "github_";
  protected readonly url = "https://api.githubcopilot.com/mcp/";

  isEnabled(): boolean {
    return !!Bun.env.GITHUB_TOKEN;
  }

  protected getHeaders(): Record<string, string> | undefined {
    const token = Bun.env.GITHUB_TOKEN;
    return token ? { Authorization: `Bearer ${token}` } : undefined;
  }
}

export const githubMCP = new GitHubMCPServer();
