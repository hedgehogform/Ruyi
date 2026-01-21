import { EmbedBuilder } from "discord.js";
import type { ChatCallbacks } from "../ai";

export interface StatusState {
  status: "thinking" | "tool" | "complete" | "error";
  currentTool?: string;
  toolCounts: Map<string, number>;
  startTime: number;
}

export function createStatusState(): StatusState {
  return { status: "thinking", toolCounts: new Map(), startTime: Date.now() };
}

function getStatusColor(status: StatusState["status"]): number {
  if (status === "complete") return 0x00ff00;
  if (status === "error") return 0xff0000;
  return 0xffaa00;
}

function formatElapsedTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return secs > 0 ? `${minutes}m ${secs}s` : `${minutes}m`;
}

export function buildStatusEmbed(state: StatusState): EmbedBuilder {
  const elapsed = Math.floor((Date.now() - state.startTime) / 1000);

  let statusText: string;
  switch (state.status) {
    case "thinking":
      statusText = "Thinking...";
      break;
    case "tool":
      statusText = `Running: \`${state.currentTool}\``;
      break;
    case "complete":
      statusText = "Complete";
      break;
    case "error":
      statusText = "Error";
      break;
  }

  let description = `**${statusText}** • ${formatElapsedTime(elapsed)}`;
  if (state.toolCounts.size > 0) {
    const toolList = [...state.toolCounts.entries()]
      .map(([tool, count]) => count > 1 ? `\`${tool}\` ×${count}` : `\`${tool}\``)
      .join(" ");
    description += `\n${toolList}`;
  }

  return new EmbedBuilder().setColor(getStatusColor(state.status)).setDescription(description);
}

export interface TypingControl {
  start: () => void;
  stop: () => void;
}

export function createChatCallbacks(
  state: StatusState,
  updateEmbed: () => Promise<void>,
  typing?: TypingControl
): ChatCallbacks {
  return {
    onThinking: () => {
      state.status = "thinking";
      state.currentTool = undefined;
      typing?.start();
    },
    onToolStart: (toolName) => {
      state.status = "tool";
      state.currentTool = toolName;
      typing?.stop();
      updateEmbed();
    },
    onToolEnd: (toolName) => {
      state.toolCounts.set(toolName, (state.toolCounts.get(toolName) ?? 0) + 1);
    },
    onComplete: () => {
      state.status = "complete";
      state.currentTool = undefined;
      typing?.stop();
    },
  };
}
