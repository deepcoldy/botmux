#!/usr/bin/env node
import { config as dotenvConfig } from 'dotenv';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { startDaemon } from './daemon.js';
import { logger } from './utils/logger.js';

// Load .env: try ~/.claude-code-robot/.env first, then CWD/.env
const globalEnv = join(homedir(), '.claude-code-robot', '.env');
if (existsSync(globalEnv)) {
  dotenvConfig({ path: globalEnv });
} else {
  dotenvConfig();
}

async function main() {
  logger.info('Starting claude-code-robot daemon...');
  await startDaemon();
}

main().catch((err) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});
