import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool as MCPToolDef } from "@modelcontextprotocol/sdk/types.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { defineTool, type Tool } from "@github/copilot-sdk";
import { z } from "zod";
import { aiLogger, toolLogger } from "../logger";
import { mcpServers, type MCPServer } from "./index";

/**
 * Connected MCP client with its transport.
 */
interface ConnectedClient {
  server: MCPServer;
  client: Client;
  transport: StreamableHTTPClientTransport;
  tools: MCPToolDef[];
}

/**
 * Active MCP connections - kept alive for the lifetime of the bot.
 */
const activeConnections = new Map<string, ConnectedClient>();

/**
 * Wrapped MCP tools as Copilot SDK tools.
 */
let wrappedTools: Tool[] = [];

/**
 * Convert JSON Schema property to a Zod type.
 */
function propertyToZod(prop: Record<string, unknown>): z.ZodType {
  switch (prop.type) {
    case "string":
      if (prop.enum && Array.isArray(prop.enum) && prop.enum.length > 0) {
        return z.enum(prop.enum as [string, ...string[]]);
      }
      return z.string();
    case "number":
    case "integer":
      return z.number();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(z.unknown());
    default:
      return z.unknown();
  }
}

/**
 * Convert JSON Schema to Zod schema for MCP tool parameters.
 */
function jsonSchemaToZod(
  schema: unknown,
): z.ZodObject<Record<string, z.ZodType>> {
  if (!schema || typeof schema !== "object") {
    return z.object({});
  }

  const s = schema as Record<string, unknown>;

  // Only handle object type schemas
  if (s.type !== "object" || !s.properties) {
    return z.object({});
  }

  const props = s.properties as Record<string, Record<string, unknown>>;
  const required = (s.required as string[]) ?? [];
  const shape: Record<string, z.ZodType> = {};

  for (const [key, prop] of Object.entries(props)) {
    let fieldSchema = propertyToZod(prop);

    // Add description if present
    if (prop.description && typeof prop.description === "string") {
      fieldSchema = fieldSchema.describe(prop.description);
    }

    // Make optional if not required
    shape[key] = required.includes(key) ? fieldSchema : fieldSchema.optional();
  }

  return z.object(shape);
}

/**
 * Create a Copilot SDK tool that wraps an MCP tool call.
 */
function createWrappedTool(
  serverName: string,
  mcpTool: MCPToolDef,
): Tool | null {
  const connection = activeConnections.get(serverName);
  if (!connection) {
    aiLogger.warn(
      { serverName, tool: mcpTool.name },
      "No active connection for tool",
    );
    return null;
  }

  // Convert the MCP tool's JSON Schema to Zod
  const zodSchema = jsonSchemaToZod(mcpTool.inputSchema);

  try {
    // Use type assertion to satisfy the Tool type
    const tool = defineTool(mcpTool.name, {
      description: mcpTool.description ?? `MCP tool from ${serverName}`,
      parameters: zodSchema,
      handler: async (args) => {
        toolLogger.info(
          { server: serverName, tool: mcpTool.name, args },
          "Calling MCP tool",
        );

        try {
          const result = await connection.client.callTool({
            name: mcpTool.name,
            arguments: args,
          });

          toolLogger.info(
            { server: serverName, tool: mcpTool.name },
            "MCP tool call complete",
          );

          // Return the result content
          if (result.content && Array.isArray(result.content)) {
            // Combine text content
            const textParts = result.content
              .filter((c) => c.type === "text")
              .map((c) => (c as { type: "text"; text: string }).text);

            if (textParts.length > 0) {
              return { result: textParts.join("\n") };
            }

            // Return raw content if no text
            return { result: result.content };
          }

          return { result };
        } catch (error) {
          const errorMsg =
            error instanceof Error ? error.message : "Unknown error";
          toolLogger.error(
            { server: serverName, tool: mcpTool.name, error: errorMsg },
            "MCP tool call failed",
          );
          return { error: errorMsg };
        }
      },
    });

    return tool as Tool;
  } catch (error) {
    aiLogger.error(
      { error, tool: mcpTool.name },
      "Failed to create wrapped tool",
    );
    return null;
  }
}

/**
 * Create an OAuth provider for Smithery MCP connections.
 * Uses stored tokens from database.
 */
function createSmitheryAuthProvider(tokens: OAuthTokens): OAuthClientProvider {
  return {
    get redirectUrl(): string {
      return "https://smithery.ai/oauth/callback";
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "Ruyi Discord Bot",
        redirect_uris: ["https://smithery.ai/oauth/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },
    clientInformation(): OAuthClientInformation | undefined {
      return undefined;
    },
    saveClientInformation: async () => {},
    tokens(): OAuthTokens | undefined {
      return tokens;
    },
    saveTokens: async () => {},
    redirectToAuthorization: async () => {},
    saveCodeVerifier: async () => {},
    codeVerifier: async () => {
      throw new Error("No code verifier");
    },
  };
}

/**
 * Connect to an MCP server using StreamableHTTPClientTransport with OAuth.
 */
async function connectToServer(
  server: MCPServer,
): Promise<ConnectedClient | null> {
  if (!server.isEnabled()) {
    aiLogger.debug({ server: server.name }, "MCP server not enabled, skipping");
    return null;
  }

  const config = server.getConfig();
  if (!config) {
    return null;
  }

  const client = new Client(
    { name: `ruyi-${server.name}`, version: "1.0.0" },
    { capabilities: {} },
  );

  try {
    const serverUrl = new URL(config.url);

    // Get OAuth tokens from the server
    const tokens = server.getTokens();

    let transport: StreamableHTTPClientTransport;

    if (tokens) {
      // Use OAuth provider with tokens (Smithery servers)
      const authProvider = createSmitheryAuthProvider(tokens);
      transport = new StreamableHTTPClientTransport(serverUrl, {
        authProvider,
      });
    } else if (config.headers) {
      // Fallback: use custom fetch with headers for non-OAuth servers
      const headers = config.headers;
      const authFetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const newInit = {
          ...init,
          headers: {
            ...headers,
            ...(init?.headers as Record<string, string>),
          },
        };
        return fetch(input, newInit);
      };
      transport = new StreamableHTTPClientTransport(serverUrl, {
        fetch: authFetch,
      });
    } else {
      transport = new StreamableHTTPClientTransport(serverUrl);
    }

    await client.connect(transport);

    // List available tools
    const toolsResult = await client.listTools();
    const tools = toolsResult.tools;

    aiLogger.info(
      {
        server: server.name,
        toolCount: tools.length,
        tools: tools.map((t) => t.name),
      },
      "Connected to MCP server via StreamableHTTP",
    );

    return { server, client, transport, tools };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    aiLogger.error(
      { server: server.name, error: errorMsg },
      "Failed to connect to MCP server",
    );
    return null;
  }
}

/**
 * Initialize all MCP connections and create wrapped tools.
 * Call this at bot startup after tokens are loaded.
 */
export async function initializeMcpTools(): Promise<Tool[]> {
  aiLogger.info("Initializing MCP tool connections...");

  // Close any existing connections
  for (const [name, connection] of activeConnections) {
    try {
      await connection.transport.close();
    } catch {
      // Ignore close errors
    }
    activeConnections.delete(name);
  }

  wrappedTools = [];

  // Connect to all enabled servers
  const connections = await Promise.all(
    mcpServers.map((server) => connectToServer(server)),
  );

  // Store active connections and create wrapped tools
  for (const connection of connections) {
    if (connection) {
      activeConnections.set(connection.server.name, connection);

      // Create wrapped tools for each MCP tool
      for (const mcpTool of connection.tools) {
        const wrapped = createWrappedTool(connection.server.name, mcpTool);
        if (wrapped) {
          wrappedTools.push(wrapped);
        }
      }
    }
  }

  aiLogger.info(
    {
      servers: [...activeConnections.keys()],
      toolCount: wrappedTools.length,
      tools: wrappedTools.map((t) => t.name),
    },
    "MCP tools initialized",
  );

  return wrappedTools;
}

/**
 * Get all wrapped MCP tools.
 * Returns empty array if not initialized.
 */
export function getMcpTools(): Tool[] {
  return wrappedTools;
}

/**
 * Reconnect to a specific MCP server (e.g., after token refresh).
 */
export async function reconnectMcpServer(serverName: string): Promise<boolean> {
  const server = mcpServers.find((s) => s.name === serverName);
  if (!server) {
    aiLogger.warn({ serverName }, "Unknown MCP server");
    return false;
  }

  // Close existing connection
  const existing = activeConnections.get(serverName);
  if (existing) {
    try {
      await existing.transport.close();
    } catch {
      // Ignore
    }
    activeConnections.delete(serverName);

    // Remove old tools
    wrappedTools = wrappedTools.filter(
      (t) => !existing.tools.some((mt) => mt.name === t.name),
    );
  }

  // Reconnect
  const connection = await connectToServer(server);
  if (connection) {
    activeConnections.set(serverName, connection);

    // Add new wrapped tools
    for (const mcpTool of connection.tools) {
      const wrapped = createWrappedTool(serverName, mcpTool);
      if (wrapped) {
        wrappedTools.push(wrapped);
      }
    }

    return true;
  }

  return false;
}

/**
 * Close all MCP connections.
 */
export async function closeMcpConnections(): Promise<void> {
  for (const [name, connection] of activeConnections) {
    try {
      await connection.transport.close();
      aiLogger.debug({ server: name }, "Closed MCP connection");
    } catch {
      // Ignore close errors
    }
  }
  activeConnections.clear();
  wrappedTools = [];
}
