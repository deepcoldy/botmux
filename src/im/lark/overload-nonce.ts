/**
 * One-shot nonce store for host-overload alert cards. Each `entered` alert card
 * embeds a fresh nonce in its button `value`; the daemon that sent the card
 * remembers it here. When the owner clicks a button, the handler validates the
 * nonce is still live before executing, then burns it — so a re-delivered
 * callback, a double-tap, or a click on a stale card (from before a daemon
 * restart) can't fire the destructive op twice.
 *
 * Pure in-memory, per daemon process (the sending daemon is the one that
 * validates, since it sent the card). Daemon restart clears it → old cards
 * expire naturally, which is the desired behaviour.
 */
const NONCE_TTL_MS = 60 * 60_000; // 1h: an alert older than this is stale; re-alert will issue a new one.

interface NonceEntry { at: number; usedActions: Set<string> }
const nonces = new Map<string, NonceEntry>();
let lastPrunedAt = 0;
const PRUNE_INTERVAL_MS = 60_000;

function prune(now: number): void {
  if (now - lastPrunedAt < PRUNE_INTERVAL_MS) return;
  lastPrunedAt = now;
  for (const [k, e] of nonces) {
    if (now - e.at >= NONCE_TTL_MS) nonces.delete(k);
  }
}

/** Register a freshly-issued nonce (called when the alert card is sent). */
export function registerOverloadNonce(nonce: string): void {
  if (!nonce) return;
  const now = Date.now();
  prune(now);
  nonces.set(nonce, { at: now, usedActions: new Set() });
}

/**
 * Try to claim `nonce` for `action`. Returns true exactly once per (nonce,
 * action): the two buttons on one card each get one claim, so the owner can
 * click BOTH 清僵尸 and 挂起闲置 on the same alert, but neither twice. Unknown
 * or expired nonce → false (stale card).
 */
export function claimOverloadNonce(nonce: string, action: string): boolean {
  if (!nonce) return false;
  const now = Date.now();
  prune(now);
  const e = nonces.get(nonce);
  if (!e) return false;
  if (now - e.at >= NONCE_TTL_MS) { nonces.delete(nonce); return false; }
  if (e.usedActions.has(action)) return false;
  e.usedActions.add(action);
  return true;
}

export function _resetOverloadNoncesForTest(): void { nonces.clear(); lastPrunedAt = 0; }
export function _overloadNonceCountForTest(): number { return nonces.size; }

/**
 * Undo a claim for `(nonce, action)` so the button can be retried. Called when
 * the action a claim guarded (the sweep) fails: without this a transient error
 * would permanently burn the button and force the owner to the CLI. No-op if
 * the nonce already expired/pruned.
 */
export function releaseOverloadNonce(nonce: string, action: string): void {
  if (!nonce) return;
  const e = nonces.get(nonce);
  if (e) e.usedActions.delete(action);
}
