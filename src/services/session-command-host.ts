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
 * the heartbeat probe that still decides when no live lease exists. The probe
 * only refuses (with a reason); it never permits a write. A sandboxed /
 * read-isolated CLI must never reach this module's writes
 * (see `isIsolatedCliProcess`): it can only send.
 *
 * Design: docs/design/2026-08-12-session-restage-store-first.md §1, §3.4.
 */
import { config } from '../config.js';
import { cleanupMaterializedDashboardImages } from '../core/dashboard-images.js';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import { logger } from '../utils/logger.js';
import type { HostSessionCommand } from './session-commands.js';
import {
  applySessionCommandUnowned,
  hostOccupancyLeaseHeld,
  readOccupancyLease,
  readSessionRowUnowned,
  SessionStoreSqliteUnavailableError,
  type OccupancyLease,
  type UnownedRowApply,
  type UnownedRowRead,
} from './session-store.js';
import type { HolderReason } from './session-store-copy.js';

export type { UnownedRowApply, UnownedRowRead } from './session-store.js';
export type { HolderReason } from './session-store-copy.js';

type HostTarget = { sessionId: string; larkAppId: string };

/**
 * Fresh descriptor → reason. Missing file is NOT "old version".
 * Unreadable registry is treated as offline (no reason).
 */
export function probeHolder(larkAppId: string, dataDir: string): HolderReason | undefined {
  let daemon;
  try { daemon = findOnlineDaemon(larkAppId, dataDir); }
  catch { return undefined; }
  if (!daemon) return undefined;
  return daemon.sessionStoreProtocol ? 'daemon_without_lease' : 'legacy_daemon';
}

function hostOptions(target: HostTarget, dataDir: string): {
  dataDir: string;
  probeHolder: () => HolderReason | undefined;
} {
  return {
    dataDir,
    probeHolder: () => probeHolder(target.larkAppId, dataDir),
  };
}

/**
 * Whether this bot's store is held by a live host, and why.
 *
 * A live occupancy lease is the authority. Without one the descriptor
 * heartbeat still refuses. Never throws.
 */
export function isOccupancyHeld(
  larkAppId: string,
  options: { dataDir?: string; now?: number } = {},
): HolderReason | undefined {
  const dataDir = options.dataDir ?? config.session.dataDir;
  const now = options.now ?? Date.now();
  let lease: OccupancyLease | undefined;
  try { lease = readOccupancyLease(larkAppId, dataDir); }
  catch (err) {
    if (err instanceof SessionStoreSqliteUnavailableError) return 'store_unreadable';
    lease = undefined;
  }
  if (hostOccupancyLeaseHeld(lease, now)) return 'lease';
  return probeHolder(larkAppId, dataDir);
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
 * `applied` / `noop` are the command's success; `refused` is the command's
 * own precondition failing on the fresh row; `owned` / `missing` /
 * `unmigrated` / `contended` mean the store was not this process's to act on.
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
