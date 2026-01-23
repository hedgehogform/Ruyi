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
3. `ai.ts` - OpenRouter SDK integration, streaming responses, system prompt

### AI Integration
The bot uses the OpenRouter TypeScript SDK (`@openrouter/sdk`). The `chat()` function in `ai.ts`:
- Uses `client.callModel()` with streaming enabled
- Passes tools via `allTools` array - the SDK handles tool execution automatically
- Streams text responses via `response.getTextStream()`

### Tools Structure (`src/tools/`)
Each tool uses the OpenRouter SDK's `tool()` helper with Zod schemas:
- `index.ts` - Exports `allTools` array and re-exports individual tools
- Individual tools define `name`, `description`, `inputSchema` (Zod), and `execute` function
- Tools: `calc.ts`, `channel.ts`, `server.ts`, `user.ts`, `role.ts`, `reaction.ts`, `pin.ts`, `message.ts`, `embed.ts`, `image.ts`, `web.ts`, `memory.ts`, `audit.ts`, `lastfm.ts`

Tools access Discord context (message, channel, guild) via `getToolContext()` from `utils/types.ts`.

### Web Fetching
The `fetch` tool uses OpenRouter's web plugin for search and URL fetching.

### Status Embed
While processing, the bot shows a status embed that updates every second showing: current status (thinking/tool/complete/error), elapsed time, and tools used. The embed is deleted after completion and the final reply is sent as plain text.

## Key Patterns

- **Tool definitions**: Use `tool()` from `@openrouter/sdk` with Zod schemas for `inputSchema`
- **Discord timestamps**: Use `<t:UNIX:style>` format (F=full, R=relative, D=date)
- **Logging**: Use child loggers from `logger.ts`: `botLogger`, `aiLogger`, `toolLogger`
- **Streaming**: Bot streams AI responses with 1-second Discord message updates
