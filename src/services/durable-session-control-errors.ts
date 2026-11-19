/**
 * A standby replica discovered control work for a Session whose exact owner
 * still holds the distributed lease. This is a routing handoff, not a backend
 * failure: re-expose the Inbox row quickly so the owner can claim it instead
 * of paying the ordinary multi-second effect retry delay.
 */
export class DurableSessionControlOwnerHandoffError extends Error {
  override name = 'DurableSessionControlOwnerHandoffError';
}
