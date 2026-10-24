/**
 * Bounded buffer for dsh runner notifications that arrive before the turn's
 * agent/inbox/spliced receipt. Side-effect-free so the cap is unit-testable.
 */

/** Upper bound on notifications buffered while waiting for the receipt. A
 *  normal turn produces single-digit to low-hundreds of events and the receipt
 *  arrives before them; the cap is only reachable on the protocol-drift path
 *  where the receipt never comes. With the default (no turn timeout) that path
 *  would otherwise buffer for the whole unbounded turn. */
export const MAX_PENDING_NOTIFICATIONS = 1000;

/** Append a pre-receipt notification, dropping the oldest one once the buffer
 *  is full. The oldest entries can never be replayed (they precede the still
 *  missing receipt), so dropping them loses nothing the turn could consume. */
export function appendPendingNotification<T>(pending: T[], item: T): void {
  if (pending.length >= MAX_PENDING_NOTIFICATIONS) pending.shift();
  pending.push(item);
}
