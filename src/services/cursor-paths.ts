import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getBot } from '../bot-registry.js';

/** Cursor stores chats under CONFIG_DIR, but agent-transcripts under DATA_DIR.
 * These can differ. User hooks, in contrast, always live at ~/.cursor/hooks.json. */
export function cursorConfigDirForBot(larkAppId?: string): string {
  let env = process.env;
  if (larkAppId) {
    try { env = { ...env, ...getBot(larkAppId).config.env }; } catch { /* offline caller */ }
  }
  if (env.CURSOR_CONFIG_DIR?.trim()) return resolve(env.CURSOR_CONFIG_DIR);
  if (env.XDG_CONFIG_HOME?.trim()) return resolve(env.XDG_CONFIG_HOME, 'cursor');
  return join(homedir(), '.cursor');
}

