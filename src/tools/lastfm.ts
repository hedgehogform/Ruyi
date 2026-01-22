import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { toolLogger } from "../logger";
import {
  getNowPlaying,
  getRecentTracks,
  getUserInfo,
  getTopArtists,
  getTopTracks,
  getTopAlbums,
  type Period,
} from "../lib/lastfm";

export const lastfmDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "lastfm",
    description:
      "Query Last.fm for music listening data. Can get recent scrobbles, now playing, user profile, and top artists/tracks/albums.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["now_playing", "recent_tracks", "user_info", "top_artists", "top_tracks", "top_albums"],
          description:
            "The action to perform: now_playing (current/last track), recent_tracks (scrobble history), user_info (profile), top_artists/tracks/albums (charts)",
        },
        username: {
          type: "string",
          description: "The Last.fm username to query",
        },
        period: {
          type: ["string", "null"],
          enum: ["overall", "7day", "1month", "3month", "6month", "12month", null],
          description: "Time period for top charts (default: overall). Only used for top_artists/tracks/albums.",
        },
        limit: {
          type: ["number", "null"],
          description: "Number of results to return (default: 10, max: 50). Used for recent_tracks and top charts.",
        },
      },
      required: ["action", "username", "period", "limit"],
      additionalProperties: false,
    },
  },
};

export async function queryLastFm(
  action: "now_playing" | "recent_tracks" | "user_info" | "top_artists" | "top_tracks" | "top_albums",
  username: string,
  period: Period | null,
  limit: number | null,
): Promise<string> {
  try {
    const effectiveLimit = Math.min(limit ?? 10, 50);
    const effectivePeriod = period ?? "overall";

    toolLogger.info({ action, username, period: effectivePeriod, limit: effectiveLimit }, "Last.fm query");

    switch (action) {
      case "now_playing": {
        const result = await getNowPlaying(username);
        if (!result) {
          return JSON.stringify({ error: "No recent tracks found for this user" });
        }
        return JSON.stringify({ success: true, ...result });
      }

      case "recent_tracks": {
        const result = await getRecentTracks(username, effectiveLimit);
        return JSON.stringify({ success: true, ...result });
      }

      case "user_info": {
        const result = await getUserInfo(username);
        return JSON.stringify({ success: true, user: result });
      }

      case "top_artists": {
        const result = await getTopArtists(username, effectivePeriod, effectiveLimit);
        return JSON.stringify({ success: true, ...result });
      }

      case "top_tracks": {
        const result = await getTopTracks(username, effectivePeriod, effectiveLimit);
        return JSON.stringify({ success: true, ...result });
      }

      case "top_albums": {
        const result = await getTopAlbums(username, effectivePeriod, effectiveLimit);
        return JSON.stringify({ success: true, ...result });
      }

      default:
        return JSON.stringify({ error: `Unknown action: ${action}` });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    toolLogger.error({ error: errorMessage, action, username }, "Last.fm query failed");
    return JSON.stringify({ error: errorMessage });
  }
}
