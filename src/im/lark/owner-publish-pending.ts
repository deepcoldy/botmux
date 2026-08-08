/**
 * One-shot pending store for "仅发起人可见 → 采纳后转全群可见" cards. When the
 * bot sends an owner-only (ephemeral) card via `botmux send --owner-only`, the
 * card carries a fresh nonce in its 采纳 button `value`; the daemon that sent it
 * remembers the payload here — the owner open_id, the target chat, and the final
 * card JSON to publish to the whole group on acceptance.
 *
 * The publish payload lives here rather than on the button `value` because a
 * card action `value` is a small `Record<string,string>` (size-limited by
 * Feishu); a full card JSON wouldn't fit reliably.
 *
 * When the owner clicks 采纳, the handler validates the nonce is still live and
 * the operator is the owner, then burns it — so a re-delivered callback, a
 * double-tap, or a click on a stale card (from before a daemon restart) can't
 * publish twice.
 *
 * Pure in-memory, per daemon process (the sending daemon is the one that
 * validates, since it sent the card). Daemon restart clears it → old owner-only
 * cards expire naturally, which is the desired behaviour (the ephemeral card is
 * only visible to the owner anyway, so a stale one lingering is harmless).
 */
const NONCE_TTL_MS = 24 * 60 * 60_000; // 24h: an owner-only card older than this is stale.

interface PendingPublish {
  at: number;
  /** Only this open_id may accept (转为所有人可见). */
  ownerOpenId: string;
  /** The group the ephemeral card was sent into; the published card goes here. */
  chatId: string;
  /** The final card JSON to send to the whole group on acceptance. */
  publishCardJson: string;
}

const pending = new Map<string, PendingPublish>();
let lastPrunedAt = 0;
const PRUNE_INTERVAL_MS = 60_000;

function prune(now: number): void {
  if (now - lastPrunedAt < PRUNE_INTERVAL_MS) return;
  lastPrunedAt = now;
  for (const [k, e] of pending) {
    if (now - e.at >= NONCE_TTL_MS) pending.delete(k);
  }
}

/** Register a freshly-issued owner-only card (called when the card is sent). */
export function registerOwnerPublish(
  nonce: string,
  entry: { ownerOpenId: string; chatId: string; publishCardJson: string },
): void {
  if (!nonce) return;
  const now = Date.now();
  prune(now);
  pending.set(nonce, { at: now, ...entry });
}

/**
 * Try to claim `nonce` for publishing. Returns the pending payload exactly once:
 * the first successful claim burns the nonce, so a double-tap / re-delivered
 * callback / stale card can't publish twice. Unknown or expired nonce → null.
 */
export function claimOwnerPublish(nonce: string): PendingPublish | null {
  if (!nonce) return null;
  const now = Date.now();
  prune(now);
  const e = pending.get(nonce);
  if (!e) return null;
  if (now - e.at >= NONCE_TTL_MS) { pending.delete(nonce); return null; }
  pending.delete(nonce); // one-shot: burn on claim
  return e;
}

export function _resetOwnerPublishForTest(): void { pending.clear(); lastPrunedAt = 0; }
export function _ownerPublishCountForTest(): number { return pending.size; }
