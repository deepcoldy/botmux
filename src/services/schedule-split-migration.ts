/**
 * One-time split of the legacy shared `data/schedules.json` into per-bot
 * stores (`<botmuxHome>/bots/<appId>/schedules.json`).
 *
 * Why: the shared file needed a sandbox policy special-case (single-file
 * readWrite grant) that could not cover the RMW sibling lock
 * (`schedules.json.lock`) — a sandboxed `botmux schedule add` failed EPERM —
 * and it exposed every bot's task prompts/routing to every other sandboxed
 * bot. Per-bot stores live inside each bot's BOT_HOME, which the sandbox
 * already grants readWrite to the owner and denies to siblings by
 * construction.
 *
 * Runs at daemon startup, BEFORE the scheduler and the external-write watcher
 * touch the store. Multiple per-bot daemons boot concurrently against the same
 * legacy file: the whole split runs under the legacy file's cross-process lock
 * and re-checks existence inside it, so exactly one daemon performs the split
 * and the rest see the file already gone (renamed to `schedules.json.bak-split-v1`).
 *
 * Routing (per task):
 *   - OWNERLESS (`larkAppId` undefined) → PRIMARY bot's store, kept ownerless.
 *       The scheduler runs ownerless tasks on the primary daemon (bot-0) — the
 *       exact pre-split behaviour. The appId is NOT stamped on. ONLY `undefined`
 *       is ownerless; a falsy non-string is corrupt data (next branch).
 *   - owner present but NOT a string     → fail-safe: abort the split. Covers
 *     (bool/number/null/object, truthy      `true`/`false`/`0`/`null`/objects —
 *      OR falsy)                             none matches a string appId, and a
 *       falsy one would otherwise slip into primary and run under primary's
 *       identity (codex #611 f3+f4). `assertSafeAppId`'s RegExp.test would also
 *       silently coerce a truthy one (`true`→"true"), so guard the TYPE first.
 *   - owner IS in bots.json             → that owner's own BOT_HOME store.
 *   - owner well-formed but NOT in       → that owner's own (dormant) store, NOT
 *     bots.json (removed / config drift)   primary. Folding it into primary would
 *       either strand it (primary's owner filter rejects a foreign appId) or, if
 *       stripped, run it under the wrong bot identity; its own store keeps it
 *       verbatim so it reappears intact if the bot is re-added (codex #611 f1).
 *   - owner is an UNSAFE string appId    → fail-safe: abort the split before any
 *     (cannot be a path segment)           import, leave the legacy file for a
 *       human. Never silently drop the row.
 * Id conflicts with an existing per-bot entry keep the existing entry (the
 * per-bot store is newer by definition) and are logged.
 *
 * Downgrade: the pre-split file survives verbatim as `*.bak-split-v1`; an
 * older build can be restored by renaming it back (documented in the PR).
 * Never throws — a failed/partial migration must not brick daemon startup;
 * the legacy file stays in place and the next boot retries.
 */
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { assertSafeAppId } from '../adapters/cli/read-isolation.js';
import * as scheduleStore from './schedule-store.js';
import type { ScheduledTask } from '../types.js';

function legacyFilePath(): string {
  return join(config.session.dataDir, 'schedules.json');
}

export function migrateSharedSchedulesAtStartup(
  knownAppIds: readonly string[],
  primaryAppId: string,
): void {
  const legacyFp = legacyFilePath();
  if (!existsSync(legacyFp)) return; // already split (or fresh install) — no-op
  try {
    withFileLockSync(legacyFp, () => {
      // Another daemon may have completed the split while we waited on the lock.
      if (!existsSync(legacyFp)) return;

      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(legacyFp, 'utf-8'));
      } catch (err) {
        // Malformed legacy file: leave it for a human — do NOT rename (that
        // would silently discard whatever tasks it held) and do not brick boot.
        logger.error(`[schedule-split] legacy schedules.json unreadable, split skipped: ${err}`);
        return;
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        logger.error('[schedule-split] legacy schedules.json root is not an object, split skipped');
        return;
      }

      const known = new Set(knownAppIds);
      const byBot = new Map<string, Array<[string, ScheduledTask]>>();
      for (const [id, task] of Object.entries(raw as Record<string, ScheduledTask>)) {
        if (!task || typeof task !== 'object') continue;
        let owner: string;
        if (task.larkAppId === undefined) {
          // Truly OWNERLESS legacy task (field absent) → primary's store, kept
          // ownerless. The scheduler runs an ownerless task on the primary daemon
          // (bot-0), which is exactly the pre-split behaviour. Do NOT stamp
          // primary's appId — that would pin it away from the legacy ownerless
          // semantics. ONLY `undefined` counts as ownerless: a falsy non-string
          // (`false`/`0`/`null`) is corrupt data, not "no owner", and must not be
          // silently absorbed into primary where it would run under primary's
          // identity (codex #611 finding 4).
          owner = primaryAppId;
        } else if (typeof task.larkAppId !== 'string') {
          // Present but NOT a string (boolean/number/null/object, truthy OR falsy):
          // corrupt owner data. It can NEVER match a real bot — the scheduler's
          // owner filter compares `task.larkAppId === ownerAppId` against a STRING
          // appId — and `assertSafeAppId`'s `RegExp.test` would silently coerce it
          // (`true`→"true", `false`→"false") and pass, migrating it into
          // `bots/<coerced>/` where no daemon ever runs it, OR (for falsy values)
          // slip past a truthiness check into primary and run under the WRONG
          // identity (codex #611 findings 3 & 4). Guard the TYPE, then fail-safe:
          // abort the whole split with no import performed, leaving legacy intact.
          logger.error(
            `[schedule-split] task ${id} has a non-string larkAppId ` +
            `(${task.larkAppId === null ? 'null' : typeof task.larkAppId}); ` +
            'split aborted, legacy schedules.json preserved',
          );
          return;
        } else if (known.has(task.larkAppId)) {
          // Configured owner → its own BOT_HOME store.
          owner = task.larkAppId;
        } else {
          // Well-formed STRING appId that is NOT currently in bots.json (bot
          // removed, or config drift): route to ITS OWN store, not primary. Folding
          // it into primary either strands it (primary's owner filter rejects a
          // foreign appId — codex #611 finding 1) or, if we stripped the appId,
          // would run it under the WRONG bot identity. Its own dormant store
          // preserves the task verbatim so it reappears intact if the bot is
          // re-added later.
          //
          // An unsafe string appId (path-traversal, or empty string) cannot be a
          // path segment (`scheduleFilePathFor` → `assertSafeAppId` throws).
          // Fail-safe: abort the whole split with NO import performed yet (imports
          // happen after this loop), leaving legacy untouched — never drop the row.
          try {
            assertSafeAppId(task.larkAppId);
          } catch {
            logger.error(
              `[schedule-split] task ${id} has an unsafe larkAppId ${JSON.stringify(task.larkAppId)}; ` +
              'split aborted, legacy schedules.json preserved for manual resolution',
            );
            return;
          }
          owner = task.larkAppId;
        }
        let bucket = byBot.get(owner);
        if (!bucket) { bucket = []; byBot.set(owner, bucket); }
        bucket.push([id, task]);
      }

      for (const [appId, entries] of byBot) {
        scheduleStore.importTasks(appId, entries);
      }

      const bak = `${legacyFp}.bak-split-v1`;
      renameSync(legacyFp, bak);
      const counts = [...byBot.entries()].map(([a, e]) => `${a}:${e.length}`).join(', ');
      logger.info(`[schedule-split] split legacy schedules.json into per-bot stores (${counts || 'empty'}); backup: ${bak}`);
    });
  } catch (err) {
    logger.warn(`[schedule-split] skipped (${err instanceof Error ? err.message : String(err)})`);
  }
}
