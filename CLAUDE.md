# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ruyi is a Discord bot assistant themed after the character Ruyi/Abacus from the game Nine Sols. It uses AI (via OpenRouter) to respond to messages with a specific personality - sentimental, deferential, and sophisticated.

## Commands

```bash
bun run src/main.ts    # Start the bot
bun install            # Install dependencies
```

## Environment Variables

- `DISCORD_TOKEN` - Discord bot token
- `MODEL_TOKEN` - OpenRouter API key

## Architecture

### Core Flow
1. `main.ts` - Entry point, calls `registerEvents()` and `startBot()`
2. `bot.ts` - Discord client setup, message handling, status embeds
3. `ai.ts` - OpenRouter integration, tool calling loop, system prompt

### AI Tool Calling
The bot uses OpenAI-compatible function calling via OpenRouter. The `chat()` function in `ai.ts` implements a loop that:
- Sends messages with `tool_choice: "auto"`
- Executes tool calls via `executeTool()`
- Continues looping until the AI responds with text (max 10 iterations)

### Tools Structure (`src/tools/`)
Each tool has a definition (`ChatCompletionTool`) and implementation function:
- `types.ts` - Shared `ToolContext` with getter/setter pattern (avoids mutable export issues)
- `index.ts` - Aggregates all tool definitions and the `executeTool()` switch
- Individual tools: `searchMessages.ts`, `channelInfo.ts`, `serverInfo.ts`, `userInfo.ts`, `manageRole.ts`, `fetch.ts`

Tools access Discord context (message, channel, guild) via `getToolContext()`.

### Web Fetching
The `fetch` tool uses Crawl4AI (localhost:11235) for web scraping. Request format:
```json
{
  "urls": [...],
  "browser_config": { "type": "BrowserConfig", "params": { "headless": true } },
  "crawler_config": { "type": "CrawlerRunConfig", "params": { "stream": false, "cache_mode": "bypass" } }
}
```

### Status Embed
While processing, the bot shows a status embed that updates every second showing: current status (thinking/tool/complete/error), elapsed time, and tools used. The embed is deleted after completion and the final reply is sent as plain text.

## Key Patterns

- **Azure/OpenRouter compatibility**: Tool schemas must have all properties in `required` array. Optional properties use `type: ["string", "null"]` instead of omitting from required.
- **Discord timestamps**: Use `<t:UNIX:style>` format (F=full, R=relative, D=date). Tools should return these pre-formatted.
- **Logging**: Use child loggers from `logger.ts`: `botLogger`, `aiLogger`, `toolLogger`
