import {
  MCPServer,
  type MCPServerConfig,
  type MCPHealthCheckResult,
} from "./base";
import { braveMCP } from "./brave";
import { githubMCP } from "./github";
import { youtubeMCP } from "./youtube";

export {
  MCPServer,
  type MCPServerConfig,
  type MCPHealthCheckResult,
} from "./base";

/**
 * All registered MCP servers.
 * Add new servers here to enable them.
 */
export const mcpServers: MCPServer[] = [braveMCP, githubMCP, youtubeMCP];

/**
 * Log all MCP servers and their status to console.
 */
export function logMcpServers(): void {
  console.log("\n" + "=".repeat(60));
  console.log("MCP SERVERS");
  console.log("=".repeat(60));

  for (const server of mcpServers) {
    const enabled = server.isEnabled();
    const status = enabled
      ? "\x1b[32m✓ ENABLED\x1b[0m"
      : "\x1b[31m✗ DISABLED\x1b[0m";
    const config = server.getConfig();

    console.log(
      `\n${server.name.toUpperCase()} (prefix: ${server.toolPrefix})`,
    );
    console.log(`  Status: ${status}`);

    if (config) {
      console.log(`  URL: ${config.url}`);
    }
  }

  const enabledCount = mcpServers.filter((s) => s.isEnabled()).length;
  console.log(
    `\nTotal: ${enabledCount}/${mcpServers.length} MCP servers enabled`,
  );
  console.log("=".repeat(60) + "\n");
}

/**
 * Get the MCP server name for a given tool name.
 * Returns the server name (e.g., "github", "reddit") or undefined if not an MCP tool.
 */
export function getMcpServerForTool(toolName: string): string | undefined {
  for (const server of mcpServers) {
    if (server.ownssTool(toolName)) {
      return server.name;
    }
  }
  return undefined;
}

/**
 * Get all configured MCP servers.
 * Returns undefined if no MCP servers are configured.
 */
export function getMcpServersConfig():
  | Record<string, MCPServerConfig>
  | undefined {
  const servers: Record<string, MCPServerConfig> = {};

  for (const server of mcpServers) {
    const config = server.getConfig();
    if (config) {
      servers[server.name] = config;
    }
  }

  // Return undefined if no servers configured
  return Object.keys(servers).length > 0 ? servers : undefined;
}

/**
 * Check health of all MCP servers by attempting to connect.
 * Returns array of health check results.
 */
export async function checkMcpServersHealth(): Promise<MCPHealthCheckResult[]> {
  const results = await Promise.all(
    mcpServers.map((server) => server.checkHealth()),
  );
  return results;
}

/**
 * Get the status icon for a health check result.
 */
function getStatusIcon(result: MCPHealthCheckResult): string {
  if (result.connected) return "\x1b[32m● CONNECTED\x1b[0m";
  if (result.reachable) return "\x1b[33m◐ REACHABLE\x1b[0m";
  if (result.enabled) return "\x1b[31m✗ FAILED\x1b[0m";
  return "\x1b[90m○ DISABLED\x1b[0m";
}

/**
 * Log a single MCP server health result.
 */
function logServerResult(result: MCPHealthCheckResult): void {
  console.log(`\n${result.name.toUpperCase()}`);
  console.log(`  Status: ${getStatusIcon(result)}`);
  console.log(`  URL: ${result.url}`);

  if (result.responseTimeMs !== undefined) {
    console.log(`  Response: ${result.responseTimeMs}ms`);
  }

  if (result.tools && result.tools.length > 0) {
    const preview = result.tools.slice(0, 5).join(", ");
    const more =
      result.tools.length > 5 ? `, +${result.tools.length - 5} more` : "";
    console.log(`  Tools: ${result.tools.length} available`);
    console.log(`    → ${preview}${more}`);
  }

  if (result.error) {
    console.log(`  Note: ${result.error}`);
  }
}

/**
 * Log MCP server health status with actual connectivity check.
 * Use this at startup to verify servers are reachable.
 */
export async function logMcpServersHealth(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("MCP SERVERS HEALTH CHECK");
  console.log("=".repeat(60));

  const results = await checkMcpServersHealth();

  for (const result of results) {
    logServerResult(result);
  }

  const connectedCount = results.filter((r) => r.connected).length;
  const reachableCount = results.filter((r) => r.reachable).length;
  const enabledCount = results.filter((r) => r.enabled).length;
  console.log(
    `\nStatus: ${connectedCount} connected, ${reachableCount - connectedCount} reachable, ${enabledCount - reachableCount} failed`,
  );
  console.log("=".repeat(60) + "\n");
}
