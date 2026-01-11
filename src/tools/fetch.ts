import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { toolLogger } from "../logger";
import { fetch } from "bun";

// Cache for storing paginated content
const contentCache = new Map<string, { parts: string[]; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export const fetchDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "fetch",
    description:
      "Fetch and extract content from web URLs. Use this tool to search for information online, look up documentation, find answers to questions, etc. You can call this tool multiple times in sequence to gather more information before responding - for example, first search for a topic, then fetch specific pages from the results. Always use this tool when the user asks about current events, facts you're unsure about, or anything that requires up-to-date information. If content is large, it will be returned in parts - use the 'part' parameter to request subsequent parts.",
    parameters: {
      type: "object",
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description:
            "List of URLs to fetch. Can be search engine URLs (e.g., 'https://www.google.com/search?q=your+query') or direct page URLs. Fetch multiple URLs at once for efficiency.",
        },
        priority: {
          type: ["number", "null"],
          description: "Priority of the fetch request (1-10, default 10)",
        },
        part: {
          type: ["number", "null"],
          description:
            "Part number to retrieve (1-indexed). Use this to get subsequent parts of large content. If omitted, returns part 1.",
        },
      },
      required: ["urls", "priority", "part"],
      additionalProperties: false,
    },
  },
};

interface CrawlResult {
  url: string;
  html?: string;
  markdown?: string;
  extracted_content?: string;
  success: boolean;
  status_code?: number | null;
  error_message?: string;
}

// Get a human-readable error description based on status code
function getStatusDescription(statusCode: number | null | undefined): string {
  if (statusCode === null || statusCode === undefined) {
    return "Failed before receiving HTTP response";
  }
  const descriptions: Record<number, string> = {
    400: "Bad Request",
    401: "Unauthorized - authentication required",
    403: "Forbidden - access denied",
    404: "Page Not Found - this URL does not exist, try a different search or URL",
    410: "Gone - this page has been permanently removed",
    429: "Too Many Requests - rate limited",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
  };
  return descriptions[statusCode] ?? `HTTP ${statusCode}`;
}

interface CrawlResponse {
  results?: CrawlResult[];
  [key: string]: unknown;
}

// Split content into parts at natural break points
const PART_SIZE = 6000; // Characters per part

function splitIntoParts(content: string): string[] {
  if (content.length <= PART_SIZE) return [content];

  const parts: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= PART_SIZE) {
      parts.push(remaining);
      break;
    }

    let splitIndex = PART_SIZE;

    // Try to split at paragraph break within last 500 chars
    const lastParagraph = remaining.lastIndexOf("\n\n", PART_SIZE);
    if (lastParagraph > PART_SIZE - 500) {
      splitIndex = lastParagraph + 2;
    } else {
      // Try sentence break
      const lastSentence = Math.max(
        remaining.lastIndexOf(". ", PART_SIZE),
        remaining.lastIndexOf(".\n", PART_SIZE),
        remaining.lastIndexOf("! ", PART_SIZE),
        remaining.lastIndexOf("? ", PART_SIZE)
      );
      if (lastSentence > PART_SIZE - 300) {
        splitIndex = lastSentence + 1;
      } else {
        // Fall back to word break
        const lastSpace = remaining.lastIndexOf(" ", PART_SIZE);
        if (lastSpace > PART_SIZE - 100) {
          splitIndex = lastSpace + 1;
        }
      }
    }

    parts.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return parts;
}

// Generate cache key from URLs
function getCacheKey(urls: string[]): string {
  return urls.toSorted((a, b) => a.localeCompare(b)).join("|");
}

// Clean expired cache entries
function cleanCache(): void {
  const now = Date.now();
  for (const [key, value] of contentCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      contentCache.delete(key);
    }
  }
}

// Format a part response
function formatPartResponse(
  parts: string[],
  partIndex: number,
  requestedPart: number,
  includeHint = false
): string {
  return JSON.stringify({
    part: requestedPart,
    totalParts: parts.length,
    content: parts[partIndex],
    hasMore: partIndex < parts.length - 1,
    hint: includeHint && parts.length > 1
      ? "Call fetch again with part=2, part=3, etc. to get more content"
      : undefined,
  });
}

// Result of processing crawl data
interface ProcessedContent {
  content: string;
  errors: Array<{ url: string; status: number | null | undefined; message: string }>;
  successCount: number;
  failCount: number;
}

// Extract content from crawl results with detailed error tracking
function extractContent(data: CrawlResponse): ProcessedContent {
  const result: ProcessedContent = { content: "", errors: [], successCount: 0, failCount: 0 };

  if (data.results && Array.isArray(data.results)) {
    for (const item of data.results) {
      if (!item.success || (item.status_code && item.status_code >= 400)) {
        result.failCount++;
        result.errors.push({
          url: item.url,
          status: item.status_code,
          message: getStatusDescription(item.status_code),
        });
        continue;
      }
      const content = item.markdown || item.extracted_content || item.html;
      if (content) {
        result.content += `\n\n--- ${item.url} ---\n${content}`;
        result.successCount++;
      }
    }
    return result;
  }

  // Handle single result
  const singleResult = data as unknown as CrawlResult;
  if (!singleResult.success || (singleResult.status_code && singleResult.status_code >= 400)) {
    result.failCount = 1;
    result.errors.push({
      url: singleResult.url ?? "unknown",
      status: singleResult.status_code,
      message: getStatusDescription(singleResult.status_code),
    });
    return result;
  }

  result.content = singleResult.markdown || singleResult.extracted_content || "";
  result.successCount = result.content ? 1 : 0;
  return result;
}

// Fetch content from crawler
async function fetchFromCrawler(
  urls: string[],
  priority: number
): Promise<{ data?: CrawlResponse; error?: string }> {
  const response = await fetch("http://localhost:11235/crawl", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      urls,
      priority,
      browser_config: { type: "BrowserConfig", params: { headless: true } },
      crawler_config: { type: "CrawlerRunConfig", params: { stream: false, cache_mode: "bypass" } },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    toolLogger.error({ status: response.status, error: errorText }, "Web crawler request failed");
    return { error: JSON.stringify({ error: `Web crawler returned status ${response.status}`, details: errorText }) };
  }

  return { data: (await response.json()) as CrawlResponse };
}

export async function getFetchData(
  urls: string[],
  priority?: number,
  part?: number
): Promise<string> {
  const cacheKey = getCacheKey(urls);
  const requestedPart = part ?? 1;
  const partIndex = requestedPart - 1;

  cleanCache();

  // Return cached part if available
  const cached = contentCache.get(cacheKey);
  if (cached && requestedPart > 1) {
    if (partIndex >= cached.parts.length) {
      return JSON.stringify({ error: `Part ${requestedPart} does not exist. Total parts: ${cached.parts.length}` });
    }
    toolLogger.info({ urls, part: requestedPart, totalParts: cached.parts.length }, "Returning cached part");
    return formatPartResponse(cached.parts, partIndex, requestedPart);
  }

  toolLogger.info({ urls, priority }, "Fetching data from web crawler");

  try {
    const { data, error } = await fetchFromCrawler(urls, priority ?? 10);
    if (error) return error;

    toolLogger.info({ resultCount: data!.results?.length ?? 0 }, "Received data from web crawler");

    const processed = extractContent(data!);
    const combinedContent = processed.content.trim();

    // All URLs failed
    if (processed.failCount > 0 && processed.successCount === 0) {
      toolLogger.warn({ errors: processed.errors }, "All URLs failed to fetch");
      return JSON.stringify({
        error: "All URLs failed to fetch",
        failedUrls: processed.errors,
        suggestion: "Try a different search query or check if the URLs are correct",
      });
    }

    // Some URLs failed, some succeeded
    if (processed.failCount > 0 && processed.successCount > 0) {
      toolLogger.warn({ errors: processed.errors }, "Some URLs failed to fetch");
    }

    if (!combinedContent) {
      return JSON.stringify({ error: "No content extracted from URLs" });
    }

    const parts = splitIntoParts(combinedContent);
    contentCache.set(cacheKey, { parts, timestamp: Date.now() });
    toolLogger.info({ urls, totalParts: parts.length }, "Content split into parts");

    if (partIndex >= parts.length) {
      return JSON.stringify({ error: `Part ${requestedPart} does not exist. Total parts: ${parts.length}` });
    }

    // Include error info in response if some URLs failed
    const response = JSON.parse(formatPartResponse(parts, partIndex, requestedPart, true));
    if (processed.failCount > 0) {
      response.warnings = {
        message: `${processed.failCount} URL(s) failed to fetch`,
        failedUrls: processed.errors,
      };
    }
    return JSON.stringify(response);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    toolLogger.error({ error: errorMessage }, "Failed to fetch from crawler");
    return JSON.stringify({ error: "Failed to connect to web crawler", details: errorMessage });
  }
}
