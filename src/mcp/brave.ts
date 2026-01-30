import { SmitheryMCPServer } from "./smithery";

/**
 * Brave Search MCP server configuration.
 * Uses Smithery's hosted Brave Search MCP server.
 *
 * Capabilities:
 * - brave_web_search: Search the web with structured results
 * - brave_news_search: Search news articles
 * - brave_image_search: Search for images
 * - brave_local_search: Search local businesses
 *
 * Features country, language, freshness, and SafeSearch filters.
 */
export class BraveMCPServer extends SmitheryMCPServer {
  readonly name = "brave";
  readonly toolPrefix = "brave_";
  protected readonly slug = "brave";
}

export const braveMCP = new BraveMCPServer();
