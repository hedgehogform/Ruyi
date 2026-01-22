import type { Message } from "discord.js";
import type { ChatMessage } from "../ai";
import { botLogger } from "../logger";

export function splitMessage(text: string, maxLength = 2000): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = maxLength;
    const newlineIndex = remaining.lastIndexOf("\n", maxLength);
    if (newlineIndex > maxLength - 200) {
      splitIndex = newlineIndex + 1;
    } else {
      const spaceIndex = remaining.lastIndexOf(" ", maxLength);
      if (spaceIndex > maxLength - 100) {
        splitIndex = spaceIndex + 1;
      }
    }

    chunks.push(remaining.slice(0, splitIndex).trimEnd());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

export interface SentChunk {
  id: string;
  content: string;
}

export async function sendReplyChunks(
  message: Message,
  reply: string,
  user: string
): Promise<SentChunk[]> {
  const chunks = splitMessage(reply);
  const sentChunks: SentChunk[] = [];

  for (const [i, chunk] of chunks.entries()) {
    if (i === 0) {
      try {
        const sent = await message.reply(chunk);
        sentChunks.push({ id: sent.id, content: chunk });
      } catch (error) {
        // If reply fails (e.g., original message was deleted), send as regular message
        const err = error as { code?: number };
        if (err.code === 50035 && "send" in message.channel) {
          botLogger.debug("Original message unavailable, sending as regular message");
          const sent = await message.channel.send(chunk);
          sentChunks.push({ id: sent.id, content: chunk });
        } else {
          throw error;
        }
      }
    } else if ("send" in message.channel) {
      const sent = await message.channel.send(chunk);
      sentChunks.push({ id: sent.id, content: chunk });
    }
  }
  botLogger.info({ user, replyLength: reply.length, chunks: chunks.length }, "Sent reply");
  return sentChunks;
}

export async function fetchReplyChain(
  message: Message,
  maxDepth = 10
): Promise<ChatMessage[]> {
  const chain: ChatMessage[] = [];
  let currentRef: { channelId: string; messageId: string } | null =
    message.reference?.messageId
      ? { channelId: message.channel.id, messageId: message.reference.messageId }
      : null;
  let depth = 0;

  if (!("messages" in message.channel)) return chain;

  while (currentRef && depth < maxDepth) {
    try {
      const referencedMessage = await message.channel.messages.fetch(currentRef.messageId);
      chain.unshift({
        author: referencedMessage.author.displayName,
        content: referencedMessage.content.replaceAll(/<@!?\d+>/g, "").trim(),
        isBot: referencedMessage.author.bot,
        isReplyContext: true,
      });
      currentRef = referencedMessage.reference?.messageId
        ? { channelId: referencedMessage.channel.id, messageId: referencedMessage.reference.messageId }
        : null;
      depth++;
    } catch {
      break;
    }
  }

  return chain;
}

export async function fetchChatHistory(message: Message): Promise<ChatMessage[]> {
  const chatHistory: ChatMessage[] = [];
  if (!("messages" in message.channel)) return chatHistory;

  const messages = await message.channel.messages.fetch({ limit: 15 });
  const sorted = [...messages.values()].reverse();
  for (const msg of sorted) {
    if (msg.id === message.id) continue;
    chatHistory.push({
      author: msg.author.displayName,
      content: msg.content.replaceAll(/<@!?\d+>/g, "").trim(),
      isBot: msg.author.bot,
    });
  }
  return chatHistory;
}

export async function fetchReferencedMessage(message: Message): Promise<Message | null> {
  if (!message.reference?.messageId || !("messages" in message.channel)) {
    return null;
  }
  try {
    return await message.channel.messages.fetch(message.reference.messageId);
  } catch {
    return null;
  }
}

export function getErrorMessage(error: unknown): string {
  const err = error as { status?: number; code?: number; error?: { message?: string }; message?: string };
  const status = err?.status || err?.code;
  const errorMsg = err?.error?.message || err?.message;

  if (status === 402) {
    return "Apologies, but I've run out of credits to process requests. Please try again later.";
  }
  if (status === 429) {
    return "I'm receiving too many requests right now. Please wait a moment.";
  }
  if (status === 503 || status === 502) {
    return "The AI service is temporarily unavailable. Please try again shortly.";
  }
  return `Something went wrong: ${errorMsg || "Unknown error"}`;
}
