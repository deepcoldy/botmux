import type { DaemonSession } from './types.js';
import { waitAllWithin } from './producer-quiescence.js';

const allFinalOutputDeliveries = new Set<Promise<void>>();

/** Register one daemon-owned user-visible final delivery.
 *
 * The worker may already have emitted its provider terminal, but graceful
 * shutdown is not complete until the daemon finishes the corresponding
 * external reply attempt. The returned callback is idempotent and must be
 * called for both success and terminal failure of the bounded retry pipeline.
 */
export function beginFinalOutputDelivery(ds: DaemonSession): () => void {
  let resolve!: () => void;
  const settled = new Promise<void>(done => { resolve = done; });
  const pending = ds.finalOutputDeliveriesInFlight
    ?? (ds.finalOutputDeliveriesInFlight = new Set<Promise<void>>());
  pending.add(settled);
  allFinalOutputDeliveries.add(settled);

  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    pending.delete(settled);
    allFinalOutputDeliveries.delete(settled);
    if (pending.size === 0) delete ds.finalOutputDeliveriesInFlight;
    resolve();
  };
}

export function snapshotFinalOutputDeliveries(ds: DaemonSession): Promise<void>[] {
  return [...(ds.finalOutputDeliveriesInFlight ?? [])];
}

export function finalOutputDeliveryCount(ds: DaemonSession): number {
  return ds.finalOutputDeliveriesInFlight?.size ?? 0;
}

export function snapshotAllFinalOutputDeliveries(): Promise<void>[] {
  return [...allFinalOutputDeliveries];
}

export function allFinalOutputDeliveryCount(): number {
  return allFinalOutputDeliveries.size;
}

/** Wait until the session has no accepted final reply still being delivered.
 * Re-snapshot after each wave so a retry registered by an already-running
 * handler cannot escape the drain. The caller supplies one absolute deadline
 * shared with the rest of graceful shutdown. */
export async function waitForFinalOutputDeliveryDrain(
  ds: DaemonSession,
  deadlineMs: number,
  now: () => number = Date.now,
): Promise<boolean> {
  // Let an earlier IPC message handler reach its synchronous registration
  // point before sampling the later shutdown-prepare acknowledgement.
  await Promise.resolve();
  for (;;) {
    const pending = snapshotFinalOutputDeliveries(ds);
    if (pending.length === 0) return true;
    if (!await waitAllWithin(pending, deadlineMs, now)) return false;
    if (finalOutputDeliveryCount(ds) === 0) return true;
  }
}
