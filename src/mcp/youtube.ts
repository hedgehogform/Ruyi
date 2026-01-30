import { SmitheryMCPServer } from "./smithery";

/**
 * YouTube MCP server configuration.
 * Uses Smithery's hosted YouTube MCP server.
 *
 * Capabilities:
 * - YOUTUBE_GET_CHANNEL_ACTIVITIES: Get recent channel activities
 * - YOUTUBE_GET_CHANNEL_ID_BY_HANDLE: Get channel ID from handle
 * - YOUTUBE_GET_CHANNEL_STATISTICS: Get channel stats (subscribers, views, videos)
 * - YOUTUBE_GET_VIDEO_DETAILS_BATCH: Get multiple video details in one call
 * - YOUTUBE_LIST_CAPTION_TRACK: List caption tracks for a video
 * - YOUTUBE_SEARCH_YOU_TUBE: Search YouTube
 * - YOUTUBE_LOAD_CAPTIONS: Load video captions
 */
export class YouTubeMCPServer extends SmitheryMCPServer {
  readonly name = "youtube";
  readonly toolPrefix = "youtube_";
  protected readonly slug = "youtube";
}

export const youtubeMCP = new YouTubeMCPServer();
