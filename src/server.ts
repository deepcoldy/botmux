import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { registerBot, loadBotConfigs, getAllBots } from './bot-registry.js';
import * as sessionStore from './services/session-store.js';
import { tools } from './tools/index.js';
import { logger } from './utils/logger.js';

/**
 * Check whether the MCP server's parent process (the CLI) was spawned by a
 * botmux worker.  The worker writes a marker file at
 *   SESSION_DATA_DIR/.botmux-cli-pids/<cli-pid>
 * after spawning each CLI.  The MCP server checks if its own ppid has a
 * corresponding marker.
 *
 * Cross-platform: uses only process.ppid + existsSync (no /proc dependency).
 */
function isParentBotmuxCli(): boolean {
  const dataDir = process.env.SESSION_DATA_DIR;
  if (!dataDir) return false;
  return existsSync(join(dataDir, '.botmux-cli-pids', String(process.ppid)));
}

export function createServer(): McpServer {
  // Register all bots so MCP tools can send messages as any bot.
  // loadBotConfigs() reads from bots.json / env vars — works regardless
  // of whether the CLI passes LARK_APP_ID through to the MCP subprocess.
  try {
    const configs = loadBotConfigs();
    for (const cfg of configs) {
      registerBot(cfg);
    }
    logger.info(`MCP server registered ${configs.length} bot(s)`);
  } catch (err: any) {
    logger.warn(`MCP server: no bot configs found (${err.message}). Tools will fail at runtime.`);
  }

  // Scope session store to the owning bot's per-bot file (sessions-{appId}.json).
  // LARK_APP_ID is inherited from the worker process env.
  const appId = process.env.LARK_APP_ID;
  if (appId) {
    sessionStore.init(appId);
  }

  // Two-gate session detection:
  //
  //  1. BOTMUX=1 in env — set in the static MCP config so it reaches all
  //     CLI MCP servers (the MCP SDK only passes config env + a 6-var
  //     whitelist to the server subprocess, NOT the full parent env).
  //
  //  2. isParentBotmuxCli() — checks if the MCP server's parent process
  //     (the CLI) has a marker file written by the botmux worker.
  //     Cross-platform: uses process.ppid + existsSync, no /proc needed.
  const isBotmuxSession = process.env.BOTMUX === '1' && isParentBotmuxCli();

  const instructions = isBotmuxSession
    ? [
        'You are connected to a Lark (Feishu) topic group. The user reads Lark, not your terminal.',
        'Anything you want the user to see MUST go through the send_to_thread tool — your terminal output never reaches the chat.',
        '',
        'Guidelines:',
        '- Use send_to_thread for: key conclusions, proposed plans (wait for confirmation before executing), final results, and progress updates.',
        '- The message includes a session_id — pass it back when calling send_to_thread.',
        '- Send plain text only — formatting is handled automatically.',
        '- Use react_to_message to acknowledge messages (e.g. THUMBSUP, OnIt).',
        '- Use get_thread_messages to read earlier conversation context if needed.',
      ].join('\n')
    : undefined;

  const server = new McpServer(
    {
      name: 'botmux',
      version: '1.0.0',
    },
    {
      ...(instructions && { instructions }),
    },
  );

  // Only register tools inside botmux sessions. Outside botmux, tools would
  // fail anyway and just waste tool-description context tokens.
  if (isBotmuxSession) {
    for (const [name, tool] of Object.entries(tools)) {
      server.tool(name, tool.description, tool.schema.shape, async (args: any) => {
        logger.info(`Tool called: ${name}`, args);
        const result = await tool.execute(args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      });
    }
  } else {
    // Declare empty tools capability so CLI clients (e.g. Codex) that call
    // tools/list during startup don't fail with "Method not found" (-32601).
    server.server.registerCapabilities({ tools: {} });
    server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    logger.info('MCP server: not a botmux session — running as empty shell (no tools, no instructions)');
  }

  return server;
}
