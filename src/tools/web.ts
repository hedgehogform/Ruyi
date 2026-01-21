import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { toolLogger } from "../logger";

// Common image extensions
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"]);

function isImageUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname.toLowerCase();
    return [...IMAGE_EXTENSIONS].some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

export const fetchDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "fetch",
    description:
      "Search the web or fetch content from URLs. Use this for current events, facts, documentation, or any information that requires up-to-date data. Supports two modes: (1) Search mode - provide a search query to find information, (2) URL mode - provide specific URLs to fetch. For image URLs, returns them for visual analysis.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: ["string", "null"],
          description:
            "Search query to find information on the web. Use this for general searches like 'latest news about X' or 'how to do Y'. Leave null if fetching specific URLs.",
        },
        urls: {
          type: ["array", "null"],
          items: { type: "string" },
          description:
            "Specific URLs to fetch content from. Use this when you have exact URLs. Leave null if using search query.",
        },
      },
      required: ["query", "urls"],
      additionalProperties: false,
    },
  },
};

interface WebSearchResponse {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string;
      annotations?: Array<{
        type: string;
        url?: string;
        title?: string;
      }>;
    };
  }>;
  error?: {
    message?: string;
    code?: string;
  };
}

// Build image-only response for visual analysis
function buildImageResponse(imageUrls: string[]): string {
  toolLogger.info({ imageUrls }, "Returning image URLs for visual analysis");
  return JSON.stringify({
    type: "images",
    images: imageUrls.map((url) => ({ type: "image_url", image_url: { url } })),
    hint: "These are image URLs for visual analysis.",
  });
}

// Extract citations from response annotations
function extractCitations(response: WebSearchResponse): Array<{ url: string; title: string }> {
  const annotations = response.choices?.[0]?.message?.annotations ?? [];
  return annotations
    .filter((a) => a.type === "url_citation" && a.url)
    .map((a) => ({ url: a.url!, title: a.title ?? a.url! }));
}

// Perform web search using OpenRouter's web plugin
async function performWebSearch(query: string): Promise<string> {
  toolLogger.info({ query }, "Performing web search");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Bun.env.MODEL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openrouter/auto",
      plugins: [{ id: "web", max_results: 10 }],
      messages: [
        {
          role: "user",
          content: `Search the web and provide comprehensive information about: ${query}\n\nInclude relevant facts, dates, sources, and any important details. Format the response clearly.`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    toolLogger.error({ status: response.status, error: errorText }, "Web search API error");
    return JSON.stringify({ error: `Web search failed with status ${response.status}`, details: errorText });
  }

  const data = (await response.json()) as WebSearchResponse;

  if (data.error) {
    toolLogger.error({ error: data.error }, "Web search returned error");
    return JSON.stringify({ error: "Web search failed", details: data.error.message ?? "Unknown error" });
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    return JSON.stringify({ error: "No content returned from web search" });
  }

  const citations = extractCitations(data);
  toolLogger.info({ query, citationCount: citations.length }, "Web search complete");

  return JSON.stringify({
    success: true,
    content,
    sources: citations.length > 0 ? citations : undefined,
  });
}

// Fetch specific URLs using OpenRouter's web plugin
async function fetchUrls(urls: string[]): Promise<string> {
  toolLogger.info({ urls }, "Fetching URLs");

  const urlList = urls.map((u) => `- ${u}`).join("\n");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Bun.env.MODEL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openrouter/auto",
      plugins: [{ id: "web" }],
      messages: [
        {
          role: "user",
          content: `Fetch and summarize the content from these URLs:\n${urlList}\n\nProvide the key information from each page. If a URL fails, note that it couldn't be accessed.`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    toolLogger.error({ status: response.status, error: errorText }, "URL fetch API error");
    return JSON.stringify({ error: `URL fetch failed with status ${response.status}`, details: errorText });
  }

  const data = (await response.json()) as WebSearchResponse;

  if (data.error) {
    toolLogger.error({ error: data.error }, "URL fetch returned error");
    return JSON.stringify({ error: "URL fetch failed", details: data.error.message ?? "Unknown error" });
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    return JSON.stringify({ error: "No content returned from URL fetch" });
  }

  const citations = extractCitations(data);
  toolLogger.info({ urlCount: urls.length, citationCount: citations.length }, "URL fetch complete");

  return JSON.stringify({
    success: true,
    content,
    sources: citations.length > 0 ? citations : undefined,
  });
}

export async function getFetchData(
  query: string | null,
  urls: string[] | null,
): Promise<string> {
  try {
    // Handle image URLs separately
    if (urls && urls.length > 0) {
      const imageUrls = urls.filter(isImageUrl);
      const regularUrls = urls.filter((url) => !isImageUrl(url));

      // If all URLs are images, return them for visual analysis
      if (imageUrls.length > 0 && regularUrls.length === 0) {
        return buildImageResponse(imageUrls);
      }

      // If we have regular URLs, fetch them
      if (regularUrls.length > 0) {
        const result = await fetchUrls(regularUrls);
        // Add image URLs to the response if present
        if (imageUrls.length > 0) {
          const parsed = JSON.parse(result);
          parsed.images = imageUrls.map((url) => ({ type: "image_url", image_url: { url } }));
          return JSON.stringify(parsed);
        }
        return result;
      }
    }

    // If we have a search query, perform web search
    if (query) {
      return await performWebSearch(query);
    }

    return JSON.stringify({ error: "Must provide either a search query or URLs to fetch" });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    toolLogger.error({ error: errorMessage }, "Web operation failed");
    return JSON.stringify({ error: "Web operation failed", details: errorMessage });
  }
}
