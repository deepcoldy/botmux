/**
 * Per-bot file-sandbox toggle persistence. Mirrors brand-store: cross-process
 * file lock + atomic bots.json write + in-memory registry sync, so the daemon
 * picks up the change without a restart (the next session spawn reads
 * `botCfg.sandbox` in forkWorker). Pure opt-in; absent = off (legacy behaviour).
 */
import { rmwBotEntry } from './config-store.js';
import { getBot } from '../bot-registry.js';
import { logger } from '../utils/logger.js';

/** Current configured file-sandbox flag for a bot. */
export function getBotSandbox(larkAppId: string): boolean {
  try { return getBot(larkAppId).config.sandbox === true; } catch { return false; }
}

export async function updateBotSandbox(
  larkAppId: string,
  enabled: boolean,
): Promise<{ ok: true; sandbox: boolean } | { ok: false; reason: string }> {
  let bot;
  try { bot = getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const r = await rmwBotEntry<boolean>(larkAppId, (entry) => {
    if (enabled) entry.sandbox = true;
    else delete entry.sandbox;  // omit key when off → preserves "absent = off"
    return { write: true, result: enabled };
  });
  if (!r.ok) return { ok: false, reason: r.reason };

  bot.config.sandbox = enabled;
  logger.info(`[sandbox:${larkAppId}] sandbox → ${enabled}`);
  return { ok: true, sandbox: enabled };
}

/** Current configured read-isolation flag for a bot. */
export function getBotReadIsolation(larkAppId: string): boolean {
  try { return getBot(larkAppId).config.readIsolation === true; } catch { return false; }
}

/** Restore only the daemon's live spawn view before an async persistence
 * rollback. This closes the otherwise observable window where a cold refork
 * could consume a transient read-isolation value while bots.json is being
 * rolled back after a Codex App ownership conflict. */
export function setBotReadIsolationRuntime(larkAppId: string, enabled: boolean): void {
  try {
    const cfg = getBot(larkAppId).config;
    if (enabled) cfg.readIsolation = true;
    else delete cfg.readIsolation;
  } catch { /* the preceding successful update already proves this in production */ }
}

/** Persist the desired flag without exposing it to worker admission yet.
 * Dashboard cold-restart mutations use this staged form so the daemon can
 * atomically fence all old generations before publishing the new spawn view. */
export async function persistBotReadIsolation(
  larkAppId: string,
  enabled: boolean,
): Promise<{ ok: true; readIsolation: boolean } | { ok: false; reason: string }> {
  try { getBot(larkAppId); } catch { return { ok: false, reason: 'bot_not_registered' }; }

  const r = await rmwBotEntry<boolean>(larkAppId, (entry) => {
    if (enabled) entry.readIsolation = true;
    else delete entry.readIsolation;
    return { write: true, result: enabled };
  });
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, readIsolation: enabled };
}

/** Per-bot read-isolation toggle (macOS Seatbelt read-deny). Same persistence
 *  contract as {@link updateBotSandbox}: atomic bots.json write + in-memory sync,
 *  so the next session spawn reads `botCfg.readIsolation` without a daemon restart. */
export async function updateBotReadIsolation(
  larkAppId: string,
  enabled: boolean,
): Promise<{ ok: true; readIsolation: boolean } | { ok: false; reason: string }> {
  const r = await persistBotReadIsolation(larkAppId, enabled);
  if (!r.ok) return { ok: false, reason: r.reason };
  setBotReadIsolationRuntime(larkAppId, enabled);
  logger.info(`[read-isolation:${larkAppId}] readIsolation → ${enabled}`);
  return { ok: true, readIsolation: enabled };
}
