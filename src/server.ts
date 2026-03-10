import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { validateConfig } from './config.js';
import { tools } from './tools/index.js';
import { logger } from './utils/logger.js';

export function createServer(): McpServer {
  validateConfig();

  const server = new McpServer({
    name: 'claude-code-robot',
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
