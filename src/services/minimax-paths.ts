import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getBot } from '../bot-registry.js';

/** Match the native CLI and adapter, including per-bot account directories. */
export function minimaxDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MINIMAX_DATA_DIR?.trim() || env.MAVIS_DATA_DIR?.trim();
  if (configured) return configured.startsWith('~/') ? join(homedir(), configured.slice(2)) : resolve(configured);
  return join(homedir(), '.minimax');
}

export function minimaxDataDirForBot(larkAppId?: string): string {
  let env = process.env;
  if (larkAppId) {
    try { env = { ...env, ...getBot(larkAppId).config.env }; } catch { /* offline/unregistered caller */ }
  }
  return minimaxDataDir(env);
}
