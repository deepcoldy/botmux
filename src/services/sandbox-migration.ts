/**
 * bots.json sandbox-config auto-migration (old fields → fs-policy model).
 *
 * Runs at daemon startup, inside the shared cross-process file lock (multiple
 * per-bot daemons boot concurrently against the same bots.json). Writes the
 * NEW fields while KEEPING the legacy ones on disk — a downgraded daemon reads
 * the untouched legacy fields, so downgrade needs no reverse script (design
 * doc §6.2: upgrade rewrites, downgrade is zero-op). The original file is
 * backed up once to `bots.json.bak-sandbox-v1` before the first rewrite.
 *
 * Idempotent: entries that already carry `sandboxPaths` (or have nothing to
 * migrate) are skipped, so every subsequent boot is a no-op.
 */
import { promises as fsp, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { FileLockTimeoutError, withFileLock, type FileLockOptions } from '../utils/file-lock.js';
import { writeRawConfigAtomic } from './config-store.js';
import { migrateLegacySandboxFields } from '../adapters/cli/fs-policy.js';
import { logger } from '../utils/logger.js';

/** The bots.json path the daemon will load (same resolution as loadBotConfigs). */
export function resolveBotsConfigPath(): string | null {
  const fromEnv = process.env.BOTS_CONFIG;
  if (fromEnv) {
    const p = resolve(fromEnv);
    return existsSync(p) ? p : null;
  }
  const p = resolve(homedir(), '.botmux', 'bots.json');
  return existsSync(p) ? p : null;
}

/**
 * Migrate every entry's legacy sandbox fields in `path`. Returns the appIds
 * that were migrated (empty = file untouched). Never throws on a malformed
 * file — migration must not brick daemon startup; loadBotConfigs surfaces
 * parse errors with better context right after.
 */
export async function migrateSandboxConfigOnDisk(
  path: string,
  lockOpts?: FileLockOptions,
): Promise<{ migrated: string[]; lockBusy?: true }> {
  try {
    return await withFileLock(path, async () => {
      let raw: unknown;
      try { raw = JSON.parse(await fsp.readFile(path, 'utf-8')); } catch { return { migrated: [] }; }
      if (!Array.isArray(raw)) return { migrated: [] };
      const migrated: string[] = [];
      for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const m = migrateLegacySandboxFields(entry);
        if (!m) continue;
        entry.sandbox = m.sandbox;
        if (m.sandboxPaths) entry.sandboxPaths = m.sandboxPaths;
        migrated.push(typeof entry.larkAppId === 'string' ? entry.larkAppId : '<unknown>');
      }
      if (!migrated.length) return { migrated };
      const bak = `${path}.bak-sandbox-v1`;
      if (!existsSync(bak)) {
        await fsp.copyFile(path, bak);
        await fsp.chmod(bak, 0o600);
      }
      await writeRawConfigAtomic(path, raw);
      logger.info(`[sandbox-migration] migrated legacy sandbox fields for ${migrated.length} bot(s): ${migrated.join(', ')} (backup: ${bak})`);
      return { migrated };
    }, lockOpts);
  } catch (err) {
    logger.warn(`[sandbox-migration] skipped (${err instanceof Error ? err.message : String(err)})`);
    return err instanceof FileLockTimeoutError ? { migrated: [], lockBusy: true } : { migrated: [] };
  }
}

/** Delays of the background retries after the startup attempt found the
 *  bots.json lock busy (dozens of per-bot daemons boot at once, and every
 *  other bots.json writer shares the lock). */
export const SANDBOX_MIGRATION_RETRY_DELAYS_MS = [15_000, 60_000, 300_000] as const;

/**
 * Startup convenience: resolve the config path and migrate if present. A busy
 * lock is retried in the background instead of being skipped until the next
 * restart; the migration is idempotent, so whichever daemon gets the lock first
 * writes and the rest find nothing to do. The legacy fields stay honoured
 * meanwhile (they are kept on disk and frozen into sessions as before).
 */
export async function migrateSandboxConfigAtStartup(
  opts: {
    retryDelaysMs?: readonly number[];
    schedule?: (fn: () => void, ms: number) => void;
    lockOpts?: FileLockOptions;
  } = {},
): Promise<void> {
  const path = resolveBotsConfigPath();
  if (!path) return;
  const delays = opts.retryDelaysMs ?? SANDBOX_MIGRATION_RETRY_DELAYS_MS;
  const schedule = opts.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  const attempt = async (retry: number): Promise<void> => {
    const result = await migrateSandboxConfigOnDisk(path, opts.lockOpts);
    if (!result.lockBusy) return;
    const delay = delays[retry];
    if (delay === undefined) {
      logger.warn(`[sandbox-migration] bots.json lock still busy after ${retry} background retr${retry === 1 ? 'y' : 'ies'}; will try again on the next daemon start`);
      return;
    }
    logger.info(`[sandbox-migration] bots.json lock busy; retrying in ${Math.round(delay / 1000)}s`);
    schedule(() => { void attempt(retry + 1); }, delay);
  };
  await attempt(0);
}
