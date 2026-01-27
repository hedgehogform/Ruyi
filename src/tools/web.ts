import { CopilotClient, defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { toolLogger } from "../logger";

const BRAVE_API_BASE = "https://api.search.brave.com/res/v1";

// Shared CopilotClient for summarization
let summarizeClient: CopilotClient | null = null;

async function getSummarizeClient(): Promise<CopilotClient> {
  if (summarizeClient && summarizeClient.getState() === "connected") {
    return summarizeClient;
  }

  summarizeClient = new CopilotClient({
    autoStart: true,
    autoRestart: true,
    logLevel: "warning",
  });

  await summarizeClient.start();
  return summarizeClient;
}

// Summarize content using Copilot SDK
async function summarizeContent(content: string, url: string): Promise<string> {
  // If content is short enough, don't summarize
  if (content.length < 2000) {
    return content;
  }

  try {
    const client = await getSummarizeClient();
    const session = await client.createSession({
      model: "openrouter/auto",
      provider: {
        type: "openai",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: Bun.env.MODEL_TOKEN!,
      },
      systemMessage: {
        mode: "replace",
        content:
          "You are a content summarizer. Extract and summarize the key information from the provided web page content. Be comprehensive but concise. Preserve important facts, data, quotes, and details. Output only the summary, no preamble.",
      },
      excludedTools: ["*"],
      streaming: false,
      infiniteSessions: { enabled: false },
    });

    const result = await session.sendAndWait(
      {
        prompt: `Summarize this web page content from ${url}:\n\n${content}`,
      },
      60000,
    );
    await session.destroy();

    const summary = result?.data.content;
    if (summary) {
      toolLogger.info(
        { url, originalLength: content.length, summaryLength: summary.length },
        "Content summarized",
      );
      return summary;
    }

    return content; // Fallback to full content
  } catch (error) {
    toolLogger.warn(
      { error: (error as Error).message, url },
      "Summarization failed, returning full content",
    );
    return content;
  }
}

// Validate that a URL is accessible (returns 2xx status, filters 401/403/404/5xx etc)
async function isUrlAccessible(url: string): Promise<boolean> {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    // Try HEAD first (faster, no body download)
    let response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      headers,
    });

    clearTimeout(timeout);

    // Some servers block HEAD but allow GET - retry with GET if we get 4xx/5xx
    if (!response.ok && response.status >= 400) {
      const getController = new AbortController();
      const getTimeout = setTimeout(() => getController.abort(), 3000);

      response = await fetch(url, {
        method: "GET",
        signal: getController.signal,
        headers,
      });

      clearTimeout(getTimeout);
    }

    if (!response.ok) {
      toolLogger.debug(
        { url, status: response.status },
        "URL validation failed - non-2xx status",
      );
    }

    return response.ok;
  } catch (error) {
    toolLogger.debug(
      { url, error: (error as Error).message },
      "URL validation failed - request error",
    );
    return false;
  }
}

// Validate multiple URLs in parallel and return only accessible ones
async function filterAccessibleUrls<
  T extends { url: string; thumbnail?: string },
>(items: T[], maxConcurrent = 5): Promise<T[]> {
  const accessible: T[] = [];

  // Process in batches to avoid too many concurrent requests
  for (
    let i = 0;
    i < items.length && accessible.length < 10;
    i += maxConcurrent
  ) {
    const batch = items.slice(i, i + maxConcurrent);
    const checks = await Promise.all(
      batch.map(async (item) => {
        // Check thumbnail URL (what Discord will try to embed)
        const urlToCheck = item.thumbnail ?? item.url;
        const isValid = await isUrlAccessible(urlToCheck);
        return { item, isValid };
      }),
    );

    for (const { item, isValid } of checks) {
      if (isValid && accessible.length < 10) {
        accessible.push(item);
      }
    }
  }

  return accessible;
}

// Search type endpoints
const SEARCH_ENDPOINTS = {
  web: "/web/search",
  news: "/news/search",
  images: "/images/search",
  videos: "/videos/search",
} as const;

type SearchType = keyof typeof SEARCH_ENDPOINTS;

interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
  extra_snippets?: string[];
}

interface BraveImageResult {
  title: string;
  url: string;
  thumbnail?: { src: string };
  properties?: { url?: string };
  source?: string;
}

interface BraveVideoResult {
  title: string;
  url: string;
  description?: string;
  thumbnail?: { src: string };
  age?: string;
  creator?: string;
}

interface BraveNewsResult {
  title: string;
  url: string;
  description?: string;
  age?: string;
  source?: { name: string };
  thumbnail?: { src: string };
}

// Different endpoints have different response structures
interface BraveWebSearchResponse {
  query?: { original: string; altered?: string };
  web?: { results: BraveWebResult[] };
}

interface BraveImageSearchResponse {
  query?: { original: string; altered?: string };
  results?: BraveImageResult[]; // Images are at top level, not nested
}

interface BraveVideoSearchResponse {
  query?: { original: string; altered?: string };
  results?: BraveVideoResult[]; // Videos are at top level
}

interface BraveNewsSearchResponse {
  query?: { original: string; altered?: string };
  results?: BraveNewsResult[]; // News are at top level
}

async function braveSearch(
  query: string,
  searchType: SearchType,
  count = 10,
): Promise<{
  success?: boolean;
  results?: unknown[];
  query?: string;
  alteredQuery?: string;
  error?: string;
  searchType: SearchType;
}> {
  const apiKey = Bun.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    return { error: "BRAVE_SEARCH_API_KEY not configured", searchType };
  }

  const endpoint = SEARCH_ENDPOINTS[searchType];
  const params = new URLSearchParams({
    q: query,
    count: String(count),
  });

  // safesearch: images only supports 'off' or 'strict', others support 'moderate'
  if (searchType === "images") {
    params.set("safesearch", "strict");
  } else {
    params.set("safesearch", "moderate");
  }

  // Add extra_snippets for web/news to get more context
  if (searchType === "web" || searchType === "news") {
    params.set("extra_snippets", "true");
  }

  const url = `${BRAVE_API_BASE}${endpoint}?${params}`;
  toolLogger.info({ query, searchType, count }, "Starting Brave search");

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      toolLogger.error(
        { status: response.status, error: errorText, searchType },
        "Brave API error",
      );
      return {
        error: `Brave ${searchType} search failed with status ${response.status}`,
        searchType,
      };
    }

    const data = await response.json();
    let results: unknown[] = [];
    let queryInfo: { original?: string; altered?: string } = {};

    switch (searchType) {
      case "web": {
        const webData = data as BraveWebSearchResponse;
        queryInfo = webData.query ?? {};
        results = (webData.web?.results ?? []).map((r) => ({
          title: r.title,
          url: r.url,
          description: r.description,
          snippets: r.extra_snippets?.slice(0, 2),
        }));
        break;
      }

      case "images": {
        const imageData = data as BraveImageSearchResponse;
        queryInfo = imageData.query ?? {};
        // Images are at top level results, not nested
        const rawImages = (imageData.results ?? []).map((r) => ({
          title: r.title,
          url: r.properties?.url ?? r.url,
          thumbnail: r.thumbnail?.src,
          source: r.source,
        }));

        toolLogger.info(
          { query, rawCount: rawImages.length },
          "Validating image URLs",
        );

        // Validate URLs to filter out broken/404 links
        results = await filterAccessibleUrls(rawImages);
        toolLogger.info(
          { query, validCount: results.length },
          "Image URL validation complete",
        );
        break;
      }

      case "videos": {
        const videoData = data as BraveVideoSearchResponse;
        queryInfo = videoData.query ?? {};
        // Videos are at top level results
        results = (videoData.results ?? []).map((r) => ({
          title: r.title,
          url: r.url,
          description: r.description,
          thumbnail: r.thumbnail?.src,
          age: r.age,
          creator: r.creator,
        }));
        break;
      }

      case "news": {
        const newsData = data as BraveNewsSearchResponse;
        queryInfo = newsData.query ?? {};
        // News are at top level results
        results = (newsData.results ?? []).map((r) => ({
          title: r.title,
          url: r.url,
          description: r.description,
          age: r.age,
          source: r.source?.name,
          thumbnail: r.thumbnail?.src,
        }));
        break;
      }
    }

    toolLogger.info(
      { query, searchType, resultCount: results.length },
      "Brave search completed",
    );

    return {
      success: true,
      results,
      query: queryInfo.original ?? query,
      alteredQuery: queryInfo.altered,
      searchType,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    toolLogger.error(
      { error: errorMessage, searchType },
      "Brave search failed",
    );
    return { error: `Brave search failed: ${errorMessage}`, searchType };
  }
}

async function fetchUrl(
  url: string,
  summarize = true,
): Promise<{
  success?: boolean;
  content?: string;
  error?: string;
}> {
  toolLogger.info({ url, summarize }, "Fetching URL content");

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    if (!response.ok) {
      return { error: `Failed to fetch URL: ${response.status}` };
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (
      contentType.includes("text/html") ||
      contentType.includes("text/plain")
    ) {
      const text = await response.text();
      // HTML processing that preserves links and images
      const cleaned = text
        // Remove script and style tags entirely
        .replaceAll(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replaceAll(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replaceAll(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, "")
        // Preserve links: <a href="URL">text</a> -> text (URL)
        .replaceAll(
          /<a[^>]*href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi,
          "$2 ($1)",
        )
        // Preserve images: <img src="URL" alt="text"> -> [Image: text - URL]
        .replaceAll(
          /<img[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']+)["'][^>]*\/?>/gi,
          "[Image: $2 - $1]",
        )
        .replaceAll(
          /<img[^>]*alt=["']([^"']+)["'][^>]*src=["']([^"']+)["'][^>]*\/?>/gi,
          "[Image: $1 - $2]",
        )
        // Images without alt text
        .replaceAll(/<img[^>]*src=["']([^"']+)["'][^>]*\/?>/gi, "[Image: $1]")
        // Convert headers to readable format
        .replaceAll(/<h[1-6][^>]*>([^<]*)<\/h[1-6]>/gi, "\n## $1\n")
        // Convert list items
        .replaceAll(/<li[^>]*>/gi, "\n- ")
        // Convert paragraphs and divs to newlines
        .replaceAll(/<\/?(p|div|br|tr)[^>]*>/gi, "\n")
        // Remove remaining HTML tags
        .replaceAll(/<[^>]+>/g, " ")
        // Clean up whitespace
        .replaceAll(/[ \t]+/g, " ")
        .replaceAll(/\n\s*\n\s*\n/g, "\n\n")
        .trim();

      // Summarize long content using Copilot SDK
      const finalContent = summarize
        ? await summarizeContent(cleaned, url)
        : cleaned;

      return { success: true, content: finalContent };
    }

    return { success: true, content: `[Binary content: ${contentType}]` };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    toolLogger.error({ error: errorMessage, url }, "URL fetch failed");
    return { error: `Failed to fetch URL: ${errorMessage}` };
  }
}

export const fetchTool = defineTool("fetch", {
  description: `Search the web using Brave Search or fetch content from URLs. Choose the appropriate search type based on what the user is looking for:
- "web" (default): General web search for information, articles, documentation, facts
- "images": When user asks for pictures, images, fanart, artwork, photos, wallpapers (URLs are pre-validated, all returned images are accessible)
- "videos": When user asks for videos, tutorials, clips, trailers, YouTube content
- "news": When user asks about current events, recent news, breaking stories, headlines

For image requests, always use type="images" and include the thumbnail URLs in your response so Discord can embed them. All image URLs returned have been validated and are working.`,
  parameters: z.object({
    query: z
      .string()
      .nullable()
      .describe("Search query to find information on the web."),
    urls: z
      .array(z.string())
      .nullable()
      .describe("Specific URLs to fetch content from directly."),
    type: z
      .enum(["web", "images", "videos", "news"])
      .nullable()
      .describe(
        "Type of search: 'web' for general info, 'images' for pictures/fanart/photos, 'videos' for video content, 'news' for current events. Default is 'web'.",
      ),
    count: z
      .number()
      .nullable()
      .describe(
        "Number of results to return (default 10, max 20 for web/news, max 50 for images/videos).",
      ),
  }),
  handler: async ({ query, urls, type, count }) => {
    const searchType: SearchType = type ?? "web";
    const resultCount = count ?? (searchType === "images" ? 15 : 10);

    toolLogger.info(
      { query, urls, type: searchType, count: resultCount },
      "Fetch tool invoked",
    );

    try {
      // If URLs provided, fetch them directly
      if (urls && urls.length > 0) {
        const results = await Promise.all(urls.map((u) => fetchUrl(u)));
        return {
          success: true,
          type: "url_fetch",
          results: results.map((r, i) => ({
            url: urls[i],
            ...r,
          })),
        };
      }

      // Otherwise perform search
      if (query) {
        return await braveSearch(query, searchType, resultCount);
      }

      return { error: "Must provide either a search query or URLs to fetch" };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      toolLogger.error(
        { error: errorMessage, query, urls, type: searchType },
        "Fetch operation failed",
      );
      return { error: "Fetch operation failed", details: errorMessage };
    }
  },
});
