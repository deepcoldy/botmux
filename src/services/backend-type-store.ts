/**
 * Per-bot session-backend override persistence. Mirrors sandbox-store:
 * cross-process file lock + atomic bots.json write + in-memory registry sync,
 * so the daemon picks up the change WITHOUT a restart.
 *
 * Live-safe by construction: only the NEXT session spawn reads the new
 * `botCfg.backendType` (forkWorker resolves `botCfg.backendType ?? default`).
 * Already-running sessions keep the backend stamped on `Session.backendType`
 * at spawn time — `getSessionPersistentBackendType` prefers that stamp over
 * live config and never falls back to the current default — so an operator
 * flipping herdr↔tmux here can't strand or zombie-close existing sessions.
 *
 * `null` clears the override → the bot falls back to `config.daemon.backendType`
 * (auto-detected default).
 */
import type { BackendType } from '../adapters/backend/types.js';
import { rmwBotEntry } from './config-store.js';
import { getBot } from '../bot-registry.js';
import { logger } from '../utils/logger.js';

/** Backends an operator may pick from in the dashboard. */
export const EDITABLE_BACKEND_TYPES: readonly BackendType[] = ['pty', 'tmux', 'herdr', 'zellij'];

export function isEditableBackendType(v: unknown): v is BackendType {
  return typeof v === 'string' && (EDITABLE_BACKEND_TYPES as readonly string[]).includes(v);
}

/** Current per-bot backend override (undefined = follow the daemon default). */
export function getBotBackendType(larkAppId: string): BackendType | undefined {
  try { return getBot(larkAppId).config.backendType; } catch { return undefined; }
}

/**
 * Persist a per-bot backend override. Pass `null` to clear it (auto-detect).
 * Never touches running sessions — takes effect on the next spawn / restart.
 */
export async function updateBotBackendType(
  larkAppId: string,
  backendType: BackendType | null,
): Promise<{ ok: true; backendType: BackendType | null } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const r = await rmwBotEntry<BackendType | null>(larkAppId, (entry) => {
    if (backendType) entry.backendType = backendType;
    else delete entry.backendType;  // omit key → "absent = follow daemon default"
    return { write: true, result: backendType };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  bot.config.backendType = backendType ?? undefined;
  logger.info(`[backend-type:${larkAppId}] backendType → ${backendType ?? '(auto)'}`);
  return { ok: true, backendType };
}
