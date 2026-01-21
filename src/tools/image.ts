import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { AttachmentBuilder, EmbedBuilder } from "discord.js";
import { toolLogger } from "../logger";
import { getToolContext } from "./types";

export const generateImageDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "generate_image",
    description:
      "Generate an image using AI based on a text prompt. Use this when the user asks you to create, draw, generate, or make an image, picture, artwork, illustration, etc. The generated image will be sent directly to the Discord channel.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "A detailed description of the image to generate. Be specific about style, colors, composition, mood, and details. More detailed prompts produce better results.",
        },
        aspect_ratio: {
          type: ["string", "null"],
          description:
            "Aspect ratio for the image. Options: '1:1' (square), '16:9' (widescreen), '9:16' (portrait/mobile), '4:3' (standard), '3:4' (portrait), '3:2', '2:3', '4:5', '5:4', '21:9' (ultrawide). Default is '1:1'.",
        },
        image_size: {
          type: ["string", "null"],
          description:
            "Resolution of the generated image. Options: '1K' (standard), '2K' (higher resolution), '4K' (highest resolution). Default is '1K'.",
        },
      },
      required: ["prompt", "aspect_ratio", "image_size"],
      additionalProperties: false,
    },
  },
};

interface ImageGenerationResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      images?: Array<{
        type: string;
        image_url: {
          url: string;
        };
      }>;
    };
  }>;
  error?: {
    message?: string;
    code?: string;
  };
}

// Build request body for image generation API
function buildRequestBody(prompt: string, aspectRatio: string | null, imageSize: string | null): Record<string, unknown> {
  const requestBody: Record<string, unknown> = {
    model: "google/gemini-3-pro-image-preview",
    messages: [{ role: "user", content: prompt }],
    modalities: ["image", "text"],
  };

  if (aspectRatio || imageSize) {
    const imageConfig: Record<string, string> = {};
    if (aspectRatio) imageConfig.aspect_ratio = aspectRatio;
    if (imageSize) imageConfig.image_size = imageSize;
    requestBody.image_config = imageConfig;
  }

  return requestBody;
}

// Extract and validate image data from API response
function extractImageData(data: ImageGenerationResponse): { error?: string; imageUrl?: string; content?: string | null } {
  if (data.error) {
    return { error: data.error.message ?? "Unknown error" };
  }

  const message = data.choices?.[0]?.message;
  const images = message?.images;

  if (!images || images.length === 0) {
    return { error: message?.content ?? "The model did not return an image" };
  }

  const imageUrl = images[0]?.image_url?.url;
  if (!imageUrl) {
    return { error: "Image URL missing from response" };
  }

  return { imageUrl, content: message?.content };
}

// Parse base64 image data from URL
function parseBase64Image(imageUrl: string): { error?: string; format?: string; buffer?: Buffer } {
  const base64Match = /^data:image\/(\w+);base64,(.+)$/.exec(imageUrl);
  if (!base64Match) {
    return { error: "Invalid image data format received" };
  }

  const format = base64Match[1] ?? "png";
  const buffer = Buffer.from(base64Match[2] ?? "", "base64");
  return { format, buffer };
}

// Send generated image to Discord channel
async function sendImageToChannel(
  channel: { send: (options: unknown) => Promise<unknown> },
  imageBuffer: Buffer,
  imageFormat: string,
  prompt: string,
): Promise<void> {
  const fileName = `generated-image.${imageFormat}`;
  const attachment = new AttachmentBuilder(imageBuffer, { name: fileName });

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("Generated Image")
    .setDescription(prompt.length > 200 ? `${prompt.slice(0, 197)}...` : prompt)
    .setImage(`attachment://${fileName}`)
    .setTimestamp();

  await channel.send({ embeds: [embed], files: [attachment] });
}

export async function generateImage(
  prompt: string,
  aspectRatio: string | null,
  imageSize: string | null,
): Promise<string> {
  const ctx = getToolContext();

  if (!ctx.channel || !("send" in ctx.channel)) {
    return JSON.stringify({ error: "No valid channel context available" });
  }

  const channel = ctx.channel as { send: (options: unknown) => Promise<unknown> };
  toolLogger.info({ prompt, aspectRatio, imageSize }, "Generating image");

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Bun.env.MODEL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildRequestBody(prompt, aspectRatio, imageSize)),
    });

    if (!response.ok) {
      const errorText = await response.text();
      toolLogger.error({ status: response.status, error: errorText }, "Image generation API error");
      return JSON.stringify({ error: `Image generation failed with status ${response.status}`, details: errorText });
    }

    const data = (await response.json()) as ImageGenerationResponse;
    const extracted = extractImageData(data);

    if (extracted.error) {
      toolLogger.error({ error: extracted.error }, "Image extraction failed");
      return JSON.stringify({ error: "Image generation failed", details: extracted.error });
    }

    const parsed = parseBase64Image(extracted.imageUrl!);
    if (parsed.error) {
      toolLogger.error({ imageUrl: extracted.imageUrl?.slice(0, 100) }, parsed.error);
      return JSON.stringify({ error: parsed.error });
    }

    await sendImageToChannel(channel, parsed.buffer!, parsed.format!, prompt);

    toolLogger.info({ prompt: prompt.slice(0, 50), format: parsed.format, size: parsed.buffer!.length }, "Image generated and sent");

    return JSON.stringify({ success: true, format: parsed.format, description: extracted.content ?? null });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    toolLogger.error({ error: errorMessage }, "Failed to generate image");
    return JSON.stringify({ error: "Failed to generate image", details: errorMessage });
  }
}
