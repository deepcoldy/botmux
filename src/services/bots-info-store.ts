/**
 * Writer side of the shared `bots-info.json` (readers: bots-info-cache.ts and
 * the agent-facing CLI subcommands).
 *
 * One daemon per bot, and each daemon upserts only its own entries — a fleet
 * restart starts dozens of them at once. The read-merge-write therefore runs
 * under a cross-process file lock: without it, concurrent upserts drop each
 * other's entries, and nothing rewrites a dropped entry until that bot's
 * daemon restarts (writes happen only after the startup probe and on a
 * rename / avatar change).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { FileLockTimeoutError, withFileLockSync } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';

export interface BotInfoEntry {
  larkAppId: string;
  botOpenId: string | null;
  botName: string | null;
  botAvatarUrl: string | null;
  cliId: string;
}

/** Bounded so a wedged lock holder cannot stall a daemon's startup for long. */
const LOCK_WAIT_MS = 2_000;

/** Merge `entries` (keyed by larkAppId) into `<dataDir>/bots-info.json`. */
export function upsertBotInfoEntries(dataDir: string, entries: readonly BotInfoEntry[]): void {
  const filePath = join(dataDir, 'bots-info.json');
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  try {
    withFileLockSync(filePath, () => mergeAndWrite(filePath, entries), { maxWaitMs: LOCK_WAIT_MS });
  } catch (err) {
    if (!(err instanceof FileLockTimeoutError)) throw err;
    // Still contended past the bound: an unlocked merge (the old behavior) is
    // better than skipping this daemon's entry altogether.
    logger.warn(`[bots-info] lock still busy after ${LOCK_WAIT_MS}ms; merging without it`);
    mergeAndWrite(filePath, entries);
  }
}

function mergeAndWrite(filePath: string, entries: readonly BotInfoEntry[]): void {
  let existing: unknown = [];
  try {
    if (existsSync(filePath)) existing = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch { /* ignore corrupt file — every daemon re-adds its own entry */ }

  const map = new Map<string, BotInfoEntry>();
  if (Array.isArray(existing)) {
    for (const entry of existing as BotInfoEntry[]) {
      if (entry?.larkAppId) map.set(entry.larkAppId, entry);
    }
  }
  for (const entry of entries) map.set(entry.larkAppId, entry);

  // Atomic write: concurrent lock-free readers never see a half-written file.
  atomicWriteFileSync(filePath, JSON.stringify([...map.values()], null, 2) + '\n');
}
