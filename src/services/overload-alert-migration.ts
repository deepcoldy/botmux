/**
 * One-time migration of the legacy per-bot `overloadAlert: boolean` toggle
 * (bots.json card-pref, dashboard → Bot 配置) to the machine-level global config
 * `hostOverloadAlert` (dashboard → Global Settings), which names a single
 * "notifier bot".
 *
 * Why: host load/memory is a machine-wide signal, so "which bot alerts" and the
 * thresholds belong at the host level, not duplicated per bot. The new watcher
 * (daemon.ts) reads ONLY `hostOverloadAlert` and gates sampling to the selected
 * bot's own daemon.
 *
 * Runs at daemon startup, BEFORE the overload watcher arms. Multiple per-bot
 * daemons boot concurrently: the whole migration runs under the global config
 * file's cross-process lock and re-checks inside it that `hostOverloadAlert` is
 * still absent, so exactly one daemon performs it and the rest see it already
 * done.
 *
 * Routing:
 *   - `hostOverloadAlert` already present  → nothing to do (idempotent no-op).
 *   - no legacy bot has `overloadAlert`    → nothing to migrate; leave global
 *                                            unset (feature stays off).
 *   - exactly one legacy bot on            → that bot becomes the notifier target,
 *                                            enabled=true.
 *   - MULTIPLE legacy bots on              → pick the FIRST by sorted larkAppId
 *                                            (stable/deterministic) as the target,
 *                                            log a warning naming the losers.
 * Then atomically write the global config FIRST (so a crash after this point
 * leaves a valid, enabled global config), and only after that clear the per-bot
 * `overloadAlert` keys (best-effort; a failure to clear a stale key is harmless
 * because the new watcher never reads it).
 *
 * Backward compat: the per-bot `overloadAlert` field is intentionally NOT removed
 * from the types/parsers — an older build restored on top still reads it. This
 * migration only moves the source of truth; the new watcher ignores the old key.
 * Never throws — a failed/partial migration must not brick daemon startup.
 */
import { readGlobalConfig, writeHostOverloadAlertConfig, globalConfigPath, invalidateGlobalConfigCache } from '../global-config.js';
import { getBotCardPrefs, updateBotCardPrefs } from './card-prefs-store.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { logger } from '../utils/logger.js';

/**
 * @param allBots every bot known to this host (from bots.json), each with its
 * `larkAppId` and `apiOnly` flag. apiOnly (core-only) bots are EXCLUDED as
 * migration candidates: they have no Feishu transport and can never DM an admin,
 * so migrating one to `enabled=true` would produce an undeliverable target (and
 * by sort order could even shadow a perfectly good non-apiOnly bot). The runtime
 * `isOverloadAlertTarget` fail-closes on apiOnly too, as a backstop for
 * hand-edited configs. Order-independent: the target is chosen by sorted app id
 * for determinism.
 */
export async function migrateOverloadAlertAtStartup(
  allBots: Array<{ larkAppId: string; apiOnly?: boolean }>,
): Promise<void> {
  try {
    // Fast path outside the lock: already migrated → skip (the common case on
    // every boot after the first).
    if (readGlobalConfig().hostOverloadAlert !== undefined) return;

    // Which bots have the legacy per-bot toggle on? Read is lock-free (each
    // getBotCardPrefs reads bots.json); the decision + writes happen under lock.
    // apiOnly bots are skipped — they can't deliver the DM (see above).
    const legacyOn = allBots
      .filter(bot => bot.apiOnly !== true)
      .map(bot => bot.larkAppId)
      .filter(appId => {
        try { return getBotCardPrefs(appId).overloadAlert === true; }
        catch { return false; }
      })
      .sort(); // deterministic pick when several are on

    if (legacyOn.length === 0) return; // nothing to migrate

    const target = legacyOn[0]!;
    if (legacyOn.length > 1) {
      logger.warn(
        `[overload-migrate] ${legacyOn.length} bots had per-bot overloadAlert on `
        + `(${legacyOn.join(', ')}); host alert is machine-level, keeping only `
        + `${target} as the notifier bot and clearing the rest.`,
      );
    }

    // Serialize the migration across concurrently-booting daemons on the global
    // config file's lock; re-check inside so exactly one performs it. The
    // lock-outer fast-path read above may have primed the 2s TTL read cache with
    // a pre-write snapshot, so invalidate it FIRST — otherwise a daemon that
    // acquires the lock after an earlier one already wrote could still read a
    // stale "absent" and re-write, clobbering a selection the user saved in that
    // same window. invalidate → read from disk → decide.
    let didWrite = false;
    withFileLockSync(globalConfigPath(), () => {
      invalidateGlobalConfigCache();
      if (readGlobalConfig().hostOverloadAlert !== undefined) return; // another daemon won (or a user saved)
      // Write global FIRST so a crash here still leaves a valid enabled config.
      writeHostOverloadAlertConfig({ enabled: true, targetBotAppId: target });
      didWrite = true;
    });
    if (!didWrite) return; // another daemon migrated; it will clear the keys

    logger.info(`[overload-migrate] migrated per-bot overloadAlert → global hostOverloadAlert (target=${target})`);

    // Best-effort: clear the now-obsolete per-bot keys so bots.json stays tidy
    // and the dashboard bot card no longer shows a dead toggle. A failure here
    // is harmless — the new watcher ignores the legacy key.
    for (const appId of legacyOn) {
      try { await updateBotCardPrefs(appId, { overloadAlert: false }); }
      catch (err) {
        logger.warn(`[overload-migrate] failed to clear per-bot overloadAlert for ${appId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    logger.warn(`[overload-migrate] skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}
