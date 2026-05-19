#!/usr/bin/env node
import { config as dotenvConfig } from 'dotenv';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

// Legacy: load .env for global settings (WEB_HOST, WEB_EXTERNAL_HOST, etc.)
// Bot config now lives in bots.json; this is kept for backward compatibility.
const globalEnv = join(homedir(), '.botmux', '.env');
dotenvConfig({ path: existsSync(globalEnv) ? globalEnv : '.env' });

async function main() {
  // Resolve global UI locale from ~/.botmux/config.json BEFORE loading
  // daemon code — `bot-registry`, `card-builder`, etc. read `t()` against
  // the process default when a bot has no per-bot `lang` set.
  {
    const { readGlobalConfig } = await import('./global-config.js');
    const { setDefaultLocale } = await import('./i18n/index.js');
    const cfg = readGlobalConfig();
    if (cfg.lang) setDefaultLocale(cfg.lang);
  }

  // Dynamic import so config.ts reads env vars AFTER dotenv has loaded them
  const { startDaemon } = await import('./daemon.js');
  const { logger } = await import('./utils/logger.js');

  const botIndexStr = process.env.BOTMUX_BOT_INDEX;
  const botIndex = botIndexStr !== undefined ? parseInt(botIndexStr, 10) : undefined;

  logger.info(`Starting botmux daemon...${botIndex !== undefined ? ` (bot index: ${botIndex})` : ''}`);
  await startDaemon(botIndex);
}

main().catch((err) => {
  console.error(`Fatal error: ${err}`);
  process.exit(1);
});
