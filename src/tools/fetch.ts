import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { toolLogger } from "../logger";
import { fetch } from "bun";

export const fetchDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "fetch",
    description:
      "Fetch and extract content from web URLs. Use this tool to search for information online, look up documentation, find answers to questions, etc. You can call this tool multiple times in sequence to gather more information before responding - for example, first search for a topic, then fetch specific pages from the results. Always use this tool when the user asks about current events, facts you're unsure about, or anything that requires up-to-date information.",
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
      },
      required: ["urls", "priority"],
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
  error_message?: string;
}

interface CrawlResponse {
  results?: CrawlResult[];
  [key: string]: unknown;
}

export async function getFetchData(
  urls: string[],
  priority?: number
): Promise<string> {
  toolLogger.info({ urls, priority }, "Fetching data from web crawler");

  try {
    const response = await fetch("http://localhost:11235/crawl", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        urls,
        priority: priority ?? 10,
        browser_config: {
          type: "BrowserConfig",
          params: {
            headless: true,
          },
        },
        crawler_config: {
          type: "CrawlerRunConfig",
          params: {
            stream: false,
            cache_mode: "bypass",
          },
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      toolLogger.error(
        { status: response.status, error: errorText },
        "Web crawler request failed"
      );
      return JSON.stringify({
        error: `Web crawler returned status ${response.status}`,
        details: errorText,
      });
    }

    const data = (await response.json()) as CrawlResponse;
    toolLogger.info(
      { resultCount: data.results?.length ?? 0 },
      "Received data from web crawler"
    );

    // Handle array of results (multiple URLs)
    if (data.results && Array.isArray(data.results)) {
      const formattedResults = data.results.map((result: CrawlResult) => {
        if (!result.success) {
          return {
            url: result.url,
            error: result.error_message ?? "Failed to fetch",
          };
        }
        // Prefer markdown, fall back to extracted_content, then html
        const content =
          result.markdown || result.extracted_content || result.html;
        // Truncate very long content to avoid token limits
        const truncated =
          content && content.length > 8000
            ? content.slice(0, 8000) + "\n\n[Content truncated...]"
            : content;
        return {
          url: result.url,
          content: truncated ?? "No content extracted",
        };
      });
      return JSON.stringify({ results: formattedResults });
    }

    // Handle single result or different response format
    const content =
      (data as unknown as CrawlResult).markdown ||
      (data as unknown as CrawlResult).extracted_content;
    if (content) {
      const truncated =
        content.length > 8000
          ? content.slice(0, 8000) + "\n\n[Content truncated...]"
          : content;
      return JSON.stringify({ content: truncated });
    }

    // Return raw data if we can't parse it
    return JSON.stringify(data);
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    toolLogger.error({ error: errorMessage }, "Failed to fetch from crawler");
    return JSON.stringify({
      error: "Failed to connect to web crawler",
      details: errorMessage,
    });
  }
}
