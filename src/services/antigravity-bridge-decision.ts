/**
 * Pure per-tick binding decision for the antigravity zero-prompt bridge.
 *
 * The worker's 1s ticker must decide what to do with three pieces of live
 * state — the currently bound transcript path, a lazily-created pending
 * conversation id (reported by writeInput before its brain file existed), and
 * what the live process currently holds open. Extracted as a pure function so
 * the /new lazy-create race is unit-testable without spawning a worker.
 *
 * Resolution provenance matters:
 *  - a SID lookup is AUTHORITATIVE for the pending conversation — if it yields
 *    the bound path, the pending id really is the current conversation and the
 *    pending marker can be dropped;
 *  - a PID lookup only says "this process has some conversation open". During
 *    a /new wait it can still return the RETIRED conversation A (its db fd
 *    stays open) while pending holds the NEW conversation B. Such a hit must
 *    NOT clear pending B — clearing it would leave B undiscoverable forever.
 */

/** What the ticker should do this tick. */
export type AntigravityTickerAction =
  | { kind: 'idle' }
  /** Nothing bound yet: attach the resolved path (initial / late attach). */
  | { kind: 'bind-initial'; path: string }
  /** A different conversation resolved while one was bound: flush the retired
   *  transcript's held final, detach, then bind the new path fresh. */
  | { kind: 'rotate'; path: string }
  /** The pending SID itself resolved to the bound path: drop the marker. */
  | { kind: 'clear-pending' };

export interface AntigravityTickerDecisionInput {
  /** Transcript path currently bound to the bridge (undefined = unbound). */
  boundPath?: string;
  /** Conversation id waiting for its lazily-created brain file. */
  pendingSid?: string;
  /** Resolve a conversation id to its transcript path. */
  resolveBySid: (sid: string) => string | undefined;
  /** Resolve the live process's open conversation to a transcript path. */
  resolveByPid: () => string | undefined;
}

export function decideAntigravityTickerAction(input: AntigravityTickerDecisionInput): AntigravityTickerAction {
  const { boundPath, pendingSid, resolveBySid, resolveByPid } = input;

  // Bound with nothing pending: no probing at all (mirrors the worker's
  // `!bound || pending` entry guard). A pid that happens to hold a different
  // conversation here is not a requested rotation.
  if (boundPath && !pendingSid) return { kind: 'idle' };

  // The SID lookup runs first and is the ONLY resolution allowed to prove the
  // pending id equals the bound path.
  let sidPath: string | undefined;
  if (pendingSid) sidPath = resolveBySid(pendingSid);
  if (sidPath !== undefined) {
    if (boundPath && sidPath === boundPath) return { kind: 'clear-pending' };
    return boundPath ? { kind: 'rotate', path: sidPath } : { kind: 'bind-initial', path: sidPath };
  }

  // SID unresolved (file not on disk yet), or unbound with no pending: fall
  // back to the process's open conversation. A pid hit on the SAME bound path
  // while a different id is pending is meaningless — the retired conversation's
  // fd can still be open; leave pending intact for the next tick.
  const pidPath = resolveByPid();
  if (pidPath && pidPath !== boundPath) {
    return boundPath ? { kind: 'rotate', path: pidPath } : { kind: 'bind-initial', path: pidPath };
  }
  return { kind: 'idle' };
}
