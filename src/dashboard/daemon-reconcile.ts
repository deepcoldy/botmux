// src/dashboard/daemon-reconcile.ts
import type { DaemonInfo } from './registry.js';
import type { Aggregator } from './aggregator.js';
import { fetchDaemonIpc } from '../core/daemon-ipc-auth.js';
import { logger } from '../utils/logger.js';

export type DaemonSnapshot = { sessions: any[]; schedules: any[] };
export type SnapshotFetcher = (port: number, signal: AbortSignal) => Promise<DaemonSnapshot>;

const defaultFetchSnapshot: SnapshotFetcher = async (port, signal) => {
  const [sRes, schRes] = await Promise.all([
    fetchDaemonIpc(port, '/api/sessions', { signal }),
    fetchDaemonIpc(port, '/api/schedules', { signal }),
  ]);
  const s = await sRes.json() as { sessions: any[] };
  const sch = await schRes.json() as { schedules: any[] };
  return { sessions: s.sessions ?? [], schedules: sch.schedules ?? [] };
};

/**
 * Install one daemon's authoritative snapshot into the aggregator. Runs as
 * the subscribeDaemon barrier — BEFORE any SSE frame is read — on both
 * initial attach and reconnect, so the snapshot can never clobber fresher
 * SSE-delivered state.
 *
 * Epoch arbitration: `signal` is the subscription's abort signal. If this
 * subscription was aborted (daemon offline, superseded by a newer
 * generation) while the fetches were in flight, the result is discarded
 * entirely — applying it would reverse-clobber the newer generation's
 * state. The aggregator's hydrate paths have no version arbitration, so the
 * subscription generation (this signal) is the arbitration: abort ⟺ this
 * generation is no longer authoritative for the daemon. The check-then-
 * mutate sequence below has no await in between, so no abort can interleave.
 *
 * Best-effort: on failure the live SSE stream remains the source of truth.
 */
export async function reconcileDaemonSnapshot(
  d: DaemonInfo,
  agg: Aggregator,
  signal: AbortSignal,
  fetchSnapshot: SnapshotFetcher = defaultFetchSnapshot,
): Promise<DaemonSnapshot | undefined> {
  try {
    const snapshot = await fetchSnapshot(
      d.ipcPort,
      AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    );
    if (signal.aborted) return undefined;
    const rows = snapshot.sessions.map((row: any) => (
      d.botAvatarUrl ? { ...row, botAvatarUrl: d.botAvatarUrl } : row
    ));
    agg.hydrateSessions(d.larkAppId, rows);
    agg.hydrateSchedules(d.larkAppId, snapshot.schedules);
    return snapshot;
  } catch (e: any) {
    if (signal.aborted) return undefined;
    logger.warn(`[dashboard] reconcile ${d.larkAppId}: ${e?.message ?? e}`);
    return undefined;
  }
}
