import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config, validateConfig } from './config.js';
import { registerBot } from './bot-registry.js';
import { tools } from './tools/index.js';
import { logger } from './utils/logger.js';

export function createServer(): McpServer {
  validateConfig();

  // Register bot for MCP process (credentials from env)
  if (config.lark.appId && config.lark.appSecret) {
    registerBot({
      larkAppId: config.lark.appId,
      larkAppSecret: config.lark.appSecret,
      cliId: (process.env.CLI_ID ?? 'claude-code') as any,
    });
  }

  const server = new McpServer({
    name: 'botmux',
    version: '1.0.0',
  });

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
