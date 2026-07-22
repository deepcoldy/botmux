#!/usr/bin/env node
import { config as dotenvConfig } from 'dotenv';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { installStdioEpipeGuard } from './utils/stdio-epipe-guard.js';
import { scrubSessionCliHomeEnv } from './utils/child-env.js';

// Under pm2 the daemon's stdout/stderr are pipes to the God daemon. A broken
// pipe (log streaming detaches, God daemon restart) would otherwise emit an
// unhandled 'error' and crash the daemon, which has no uncaughtException trap.
installStdioEpipeGuard();

// Legacy: load .env for global settings (WEB_HOST, WEB_EXTERNAL_HOST, etc.)
// Bot config now lives in bots.json; this is kept for backward compatibility.
const globalEnv = join(homedir(), '.botmux', '.env');
dotenvConfig({ path: existsSync(globalEnv) ? globalEnv : '.env' });

// A daemon is never a session. pm2 startOrRestart injects the caller's
// environment into restarted apps, so a `botmux restart` issued from inside a
// botmux session leaks session-scoped vars into this long-lived process —
// hook-runner's CLI gate would then mistake the daemon for CLI context and
// forward every hook event to the daemon itself (/api/hooks/emit) in an
// infinite self-loop. Scrub unconditionally at boot.
// BOTMUX_OWNER_OPEN_ID / __OWNER_OPEN_ID additionally leak a stale *identity*:
// v3 workflow workers spread this process's env into their spawn env, so a
// restart issued from a bot session would otherwise pin that session's owner
// onto every workflow CLI child.
for (const k of ['BOTMUX_SESSION_ID', 'BOTMUX_LARK_APP_ID', 'BOTMUX_CHAT_ID', 'BOTMUX_CHAT_TYPE', 'BOTMUX_ROOT_MESSAGE_ID', 'BOTMUX_OWNER_OPEN_ID', '__OWNER_OPEN_ID']) {
  delete process.env[k];
}
// Same vector, session-level CLI data-root pointers (CLAUDE_CONFIG_DIR /
// CODEX_HOME): a value baked into pm2's saved app env — or resurrected from a
// stale dump.pm2, which bypasses the pm2Env() strip in cli.ts — would make
// every worker (forked with this process's env) and every non-isolated CLI
// child read/write the leaking bot's home. Per-session values are recomputed
// downstream (worker isolation pins / adapter spawnEnv).
scrubSessionCliHomeEnv(process.env);

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
