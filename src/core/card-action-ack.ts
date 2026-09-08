/**
 * Bot-level cutoff for synchronous Lark card-action ACKs.
 *
 * Lark allows roughly three seconds for the callback response. The upper bound
 * deliberately preserves 500 ms of transport headroom; the lower bound avoids
 * turning ordinary short work into background processing too aggressively.
 */
export const DEFAULT_CARD_ACTION_ACK_TIMEOUT_MS = 2_500;
export const MIN_CARD_ACTION_ACK_TIMEOUT_MS = 500;
export const MAX_CARD_ACTION_ACK_TIMEOUT_MS = 2_500;

export const normalizeCardActionAckTimeoutMs = (value: unknown): number | undefined => (
  typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_CARD_ACTION_ACK_TIMEOUT_MS
    && value <= MAX_CARD_ACTION_ACK_TIMEOUT_MS
    ? value
    : undefined
);

export const resolveCardActionAckTimeoutMs = (value: unknown): number => (
  normalizeCardActionAckTimeoutMs(value) ?? DEFAULT_CARD_ACTION_ACK_TIMEOUT_MS
);
