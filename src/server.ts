import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBot, loadBotConfigs, getAllBots } from './bot-registry.js';
import * as sessionStore from './services/session-store.js';
import { tools } from './tools/index.js';
import { logger } from './utils/logger.js';

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

  // Only inject instructions when running inside a botmux session (LARK_APP_ID
  // is set by the worker process). When the MCP server is used standalone (e.g.
  // user runs Claude Code directly), skip instructions to save context.
  const instructions = appId
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

  // Register all tools
  for (const [name, tool] of Object.entries(tools)) {
    server.tool(name, tool.description, tool.schema.shape, async (args: any) => {
      logger.info(`Tool called: ${name}`, args);
      const result = await tool.execute(args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    });
  }

  return server;
}
