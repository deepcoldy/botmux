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
export function beginFinalOutputDelivery(ds: DaemonSession, turnId?: string): () => void {
  let resolve!: () => void;
  const settled = new Promise<void>(done => { resolve = done; });
  const pending = ds.finalOutputDeliveriesInFlight
    ?? (ds.finalOutputDeliveriesInFlight = new Set<Promise<void>>());
  pending.add(settled);
  const pendingForTurn = turnId
    ? (ds.finalOutputDeliveriesByTurn ??= new Map()).get(turnId)
      ?? (() => {
        const created = new Set<Promise<void>>();
        ds.finalOutputDeliveriesByTurn!.set(turnId, created);
        return created;
      })()
    : undefined;
  pendingForTurn?.add(settled);
  allFinalOutputDeliveries.add(settled);

  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    pending.delete(settled);
    pendingForTurn?.delete(settled);
    if (turnId && pendingForTurn?.size === 0) {
      ds.finalOutputDeliveriesByTurn?.delete(turnId);
      if (ds.finalOutputDeliveriesByTurn?.size === 0) delete ds.finalOutputDeliveriesByTurn;
    }
    allFinalOutputDeliveries.delete(settled);
    if (pending.size === 0) delete ds.finalOutputDeliveriesInFlight;
    resolve();
  };
}

/** Wait for answer delivery belonging to one exact turn. Terminal-state strips
 * use this instead of the session-wide shutdown drain so a sibling turn cannot
 * hold their ordering hostage. The microtask yield covers the ordered IPC case
 * where final_output and turn_terminal are dispatched back-to-back. */
export async function waitForTurnFinalOutputDeliveryDrain(
  ds: DaemonSession,
  turnId: string,
): Promise<void> {
  await Promise.resolve();
  for (;;) {
    const pending = [...(ds.finalOutputDeliveriesByTurn?.get(turnId) ?? [])];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
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
