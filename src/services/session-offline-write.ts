/**
 * The single offline session-row write for processes that own no store.
 *
 * A session row has one authority at a time: while the owning bot's daemon is
 * up it holds the row in memory and will `persistRow` over anything written
 * behind its back, so every other process must send it a command instead.
 * Only when no daemon holds the SQLite occupancy lease may another process
 * publish the row itself — and the lease is re-read inside the store's write
 * exclusion, so a daemon that claims between the caller's check and the
 * commit wins.
 *
 * `sessionStore.mutateSessionRowOffline` implements the exclusion and the
 * in-txn occupancy read. This wrapper supplies the upgrade-window heartbeat
 * probe used only when the occupancy row is absent (pre-occupancy daemon),
 * and so the probe and the store read resolve the SAME data dir.
 * Stage 2 of `docs/design/2026-08-12-session-restage-store-first.md` deletes
 * the offline write: it becomes a lease plus the daemon's own apply.
 */
import { config } from '../config.js';
import { findOnlineDaemon } from '../utils/daemon-discovery.js';
import {
  mutateSessionRowOffline,
  occupancyLeaseIsActive,
  readOccupancyLease,
} from './session-store.js';
import type { Session } from '../types.js';

function legacyHeartbeatHeld(larkAppId: string, dataDir: string): boolean {
  try { return !!findOnlineDaemon(larkAppId, dataDir); }
  catch { return false; /* unreadable registry → treat as offline */ }
}

/**
 * Whether this bot's store is held by a live host.
 *
 * A present occupancy row is the authority (fresh heartbeat cannot override
 * an expired lease). A missing row falls back to the descriptor heartbeat —
 * the upgrade window for daemons that write SQLite but not occupancy.
 */
export function isOccupancyHeld(
  larkAppId: string,
  options: { dataDir?: string; now?: number } = {},
): boolean {
  const dataDir = options.dataDir ?? config.session.dataDir;
  const now = options.now ?? Date.now();
  const lease = readOccupancyLease(larkAppId, dataDir);
  if (lease) return occupancyLeaseIsActive(lease, now);
  return legacyHeartbeatHeld(larkAppId, dataDir);
}

/**
 * Mutate one exact row only while its owning daemon is absent.
 *
 * Returns the fresh row (mutated when `mutate` returned true), or undefined
 * when the row is missing or a daemon holds it. A row with no `larkAppId` is a
 * pre-per-bot legacy row in the flat store: no daemon owns one — daemons all
 * run per-bot stores — so there is nothing to probe and the write proceeds.
 */
export function mutateSessionRowWhenUnowned(
  target: { sessionId: string; larkAppId?: string },
  mutate: (current: Session) => boolean,
  options: { dataDir?: string } = {},
): Session | undefined {
  const dataDir = options.dataDir ?? config.session.dataDir;
  const larkAppId = target.larkAppId;
  return mutateSessionRowOffline(
    { sessionId: target.sessionId, ...(larkAppId ? { larkAppId } : {}) },
    mutate,
    {
      dataDir,
      ...(larkAppId
        ? {
            abortIf: () => legacyHeartbeatHeld(larkAppId, dataDir),
          }
        : {}),
    },
  );
}
