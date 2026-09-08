/**
 * Session commands from a process that owns no store.
 *
 * A session row has one authority at a time: while the owning bot's daemon is
 * up it holds the row in memory and will `persistRow` over anything written
 * behind its back, so every other process must send it the command over IPC.
 * Only when no daemon holds the SQLite occupancy lease — and no fresh
 * descriptor heartbeat says one is up — may a HOST process (a non-sandboxed
 * CLI, the dashboard) become the row's temporary activation and run the very
 * same command apply (session-commands.ts) itself.
 *
 * `session-store.applySessionCommandUnowned` / `readSessionRowUnowned`
 * implement the exclusion and the in-txn occupancy read. This module supplies
 * the heartbeat probe that still decides when no live lease exists (the
 * upgrade window: a daemon that writes SQLite but not occupancy), keeps the
 * probe and the store access on the SAME data dir, and runs the post-commit
 * cleanup a close hands back. A sandboxed / read-isolated CLI must never reach
 * this module's writes (see `isIsolatedCliProcess`): it can only send.
 *
 * Design: docs/design/2026-08-12-session-restage-store-first.md §1, §3 Stage 2.
 */
import { config } from '../config.js';
import { cleanupMaterializedDashboardImages } from '../core/dashboard-images.js';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import { logger } from '../utils/logger.js';
import type { HostSessionCommand } from './session-commands.js';
import {
  applySessionCommandUnowned,
  occupancyLeaseIsActive,
  readOccupancyLease,
  readSessionRowUnowned,
  type OccupancyLease,
  type UnownedRowApply,
  type UnownedRowRead,
} from './session-store.js';

export type { UnownedRowApply, UnownedRowRead } from './session-store.js';

type HostTarget = { sessionId: string; larkAppId?: string };

function legacyHeartbeatHeld(larkAppId: string, dataDir: string): boolean {
  try { return !!findOnlineDaemon(larkAppId, dataDir); }
  catch { return false; /* unreadable registry → treat as offline */ }
}

/** A row with no `larkAppId` is a pre-per-bot legacy row in the flat store:
 *  no daemon owns one — daemons all run per-bot stores — so there is nothing
 *  to probe. */
function hostOptions(target: HostTarget, dataDir: string): { dataDir: string; abortIf?: () => boolean } {
  const larkAppId = target.larkAppId;
  return {
    dataDir,
    ...(larkAppId ? { abortIf: () => legacyHeartbeatHeld(larkAppId, dataDir) } : {}),
  };
}

/**
 * Whether this bot's store is held by a live host.
 *
 * A live occupancy lease is the authority. Without one (row absent, expired,
 * or unreadable) the descriptor heartbeat still counts — the upgrade window
 * for daemons that write SQLite but not occupancy, including a rollback that
 * runs behind a stale row a crashed newer build left. Never throws: callers
 * sit inside IPC error handlers, and an unreadable store (sandbox read-only
 * grant, corrupt file, no SQLite engine) must not replace their own error.
 */
export function isOccupancyHeld(
  larkAppId: string,
  options: { dataDir?: string; now?: number } = {},
): boolean {
  const dataDir = options.dataDir ?? config.session.dataDir;
  const now = options.now ?? Date.now();
  let lease: OccupancyLease | undefined;
  try { lease = readOccupancyLease(larkAppId, dataDir); }
  catch { lease = undefined; /* unreadable store → the heartbeat decides */ }
  return occupancyLeaseIsActive(lease, now) || legacyHeartbeatHeld(larkAppId, dataDir);
}

/** Exclusion-ordered fresh read of one exact row while its owning daemon is
 *  absent — the same ownership rules as the apply, without a write. */
export function readSessionRowAsHost(
  target: HostTarget,
  options: { dataDir?: string } = {},
): UnownedRowRead {
  const dataDir = options.dataDir ?? config.session.dataDir;
  return readSessionRowUnowned(target, hostOptions(target, dataDir));
}

/**
 * Apply one command to one exact row only while its owning daemon is absent.
 *
 * `applied` / `noop` are the command's success (a re-applied command changes
 * nothing and keeps e.g. the original `closedAt`); `refused` is the command's
 * own precondition failing on the fresh row; `owned` / `missing` /
 * `contended` mean the store was not this process's to act on. The
 * materialised dashboard images a close releases are deleted here, after the
 * commit, exactly as the daemon does after its own.
 */
export function applySessionCommandAsHost(
  target: HostTarget,
  command: HostSessionCommand,
  options: { dataDir?: string; expectAdopted?: boolean } = {},
): UnownedRowApply {
  const dataDir = options.dataDir ?? config.session.dataDir;
  const result = applySessionCommandUnowned(target, command, {
    ...hostOptions(target, dataDir),
    ...(options.expectAdopted !== undefined ? { expectAdopted: options.expectAdopted } : {}),
  });
  if (result.outcome === 'applied' && result.row.larkAppId && result.released.dashboardAttachments?.length) {
    try {
      cleanupMaterializedDashboardImages(result.row.larkAppId, result.released.dashboardAttachments);
    } catch (error: any) {
      logger.warn(`Failed to clean Dashboard images for session ${target.sessionId}: ${error?.message ?? error}`);
    }
  }
  return result;
}
