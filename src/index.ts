#!/usr/bin/env node
import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { logger } from './utils/logger.js';

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('claude-code-robot MCP server running (stdio)');
}

main().catch((err) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});
