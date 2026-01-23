import { tool } from "@openrouter/sdk";
import { z } from "zod";
import { toolLogger } from "../logger";

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

interface WebSearchResponse {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string;
      annotations?: Array<{ type: string; url?: string; title?: string }>;
    };
  }>;
  error?: { message?: string; code?: string };
}

function extractCitations(response: WebSearchResponse): Array<{ url: string; title: string }> {
  const annotations = response.choices?.[0]?.message?.annotations ?? [];
  return annotations
    .filter((a) => a.type === "url_citation" && a.url)
    .map((a) => ({ url: a.url!, title: a.title ?? a.url! }));
}

async function webPluginRequest(
  prompt: string,
  plugins: Array<{ id: string; max_results?: number }>,
  operationName: string,
  logContext: Record<string, unknown>
): Promise<{
  success?: boolean;
  content?: string;
  sources?: Array<{ url: string; title: string }>;
  error?: string;
  details?: string;
}> {
  toolLogger.info(logContext, `Starting ${operationName}`);

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Bun.env.MODEL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openrouter/auto",
      plugins,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    toolLogger.error({ status: response.status, error: errorText }, `${operationName} API error`);
    return { error: `${operationName} failed with status ${response.status}`, details: errorText };
  }

  const data = (await response.json()) as WebSearchResponse;

  if (data.error) {
    toolLogger.error({ error: data.error }, `${operationName} returned error`);
    return { error: `${operationName} failed`, details: data.error.message ?? "Unknown error" };
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    return { error: `No content returned from ${operationName}` };
  }

  const citations = extractCitations(data);
  toolLogger.info({ ...logContext, citationCount: citations.length }, `${operationName} complete`);

  return {
    success: true,
    content,
    sources: citations.length > 0 ? citations : undefined,
  };
}

async function performWebSearch(query: string) {
  const prompt = `Search the web and provide comprehensive information about: ${query}\n\nInclude relevant facts, dates, sources, and any important details. Format the response clearly.`;
  return webPluginRequest(prompt, [{ id: "web", max_results: 10 }], "Web search", { query });
}

async function fetchUrls(urls: string[]) {
  const urlList = urls.map((u) => `- ${u}`).join("\n");
  const prompt = `Fetch and summarize the content from these URLs:\n${urlList}\n\nProvide the key information from each page. If a URL fails, note that it couldn't be accessed.`;
  return webPluginRequest(prompt, [{ id: "web" }], "URL fetch", { urls, urlCount: urls.length });
}

export const fetchTool = tool({
  name: "fetch",
  description:
    "Search the web or fetch content from URLs. Use this for current events, facts, documentation, or any information that requires up-to-date data.",
  inputSchema: z.object({
    query: z.string().nullable().describe("Search query to find information on the web."),
    urls: z.array(z.string()).nullable().describe("Specific URLs to fetch content from."),
  }),
  execute: async ({ query, urls }) => {
    try {
      if (urls && urls.length > 0) {
        const imageUrls = urls.filter(isImageUrl);
        const regularUrls = urls.filter((url) => !isImageUrl(url));

        if (imageUrls.length > 0 && regularUrls.length === 0) {
          toolLogger.info({ imageUrls }, "Returning image URLs for visual analysis");
          return {
            type: "images",
            images: imageUrls.map((url) => ({ type: "image_url", image_url: { url } })),
            hint: "These are image URLs for visual analysis.",
          };
        }

        if (regularUrls.length > 0) {
          const result = await fetchUrls(regularUrls);
          if (imageUrls.length > 0 && result.success) {
            return {
              ...result,
              images: imageUrls.map((url) => ({ type: "image_url", image_url: { url } })),
            };
          }
          return result;
        }
      }

      if (query) {
        return await performWebSearch(query);
      }

      return { error: "Must provide either a search query or URLs to fetch" };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      toolLogger.error({ error: errorMessage }, "Web operation failed");
      return { error: "Web operation failed", details: errorMessage };
    }
  },
});
