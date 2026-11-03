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
 *
 * "The same conversation" is compared by conversation, not by path: the
 * resolver prefers transcript_full.jsonl, so a bind made on the compact
 * transcript.jsonl (an agy build without the full log, or the few ms before agy
 * creates it) later resolves to the full log of the SAME conversation. Treating
 * that as a rotation would rebind fresh-empty and replay the whole conversation.
 * Moving such a bind to the full log is decideAntigravityFullUpgrade's job.
 */
import {
  antigravityCompactSiblingPath,
  antigravityFullSiblingPath,
  isSameAntigravityConversation,
} from './antigravity-transcript.js';


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
    if (boundPath && isSameAntigravityConversation(sidPath, boundPath)) return { kind: 'clear-pending' };
    return boundPath ? { kind: 'rotate', path: sidPath } : { kind: 'bind-initial', path: sidPath };
  }

  // SID unresolved (file not on disk yet), or unbound with no pending: fall
  // back to the process's open conversation. A pid hit on the SAME bound path
  // while a different id is pending is meaningless — the retired conversation's
  // fd can still be open; leave pending intact for the next tick.
  const pidPath = resolveByPid();
  if (pidPath && !isSameAntigravityConversation(pidPath, boundPath)) {
    return boundPath ? { kind: 'rotate', path: pidPath } : { kind: 'bind-initial', path: pidPath };
  }
  return { kind: 'idle' };
}

/** What writeInput's conversation-id report means for the bind. */
export type AntigravityNotifyAction =
  /** Already bound to this conversation (either log) — drop the pending id. */
  | { kind: 'same' }
  /** A different conversation (`/new`): flush the retired transcript's held
   *  final, detach, and bind `path` fresh. */
  | { kind: 'rotate'; path: string }
  | { kind: 'bind-initial'; path: string }
  /** The reported conversation has no log on disk yet — keep it pending. */
  | { kind: 'wait-pending' };

/** writeInput reports agy's conversation id on every submit. While the bridge
 *  is still on the compact log (a restored turn pinned it there, or it bound
 *  before agy created the full log), that id resolves to the full log of the
 *  same conversation; a raw path comparison would take it for a `/new` and
 *  force-release the in-flight turn's held final. */
export function decideAntigravityNotifyAction(
  boundPath: string | undefined,
  resolvedPath: string | undefined,
): AntigravityNotifyAction {
  // Unbound with nothing resolved also lands here (historical behavior: the
  // ticker's pid probe covers that first attach).
  if (resolvedPath === boundPath || isSameAntigravityConversation(resolvedPath, boundPath)) return { kind: 'same' };
  if (!resolvedPath) return { kind: 'wait-pending' };
  return boundPath ? { kind: 'rotate', path: resolvedPath } : { kind: 'bind-initial', path: resolvedPath };
}

/** Whether the bridge should move its bind from transcript.jsonl to
 *  transcript_full.jsonl this tick. */
export type AntigravityFullUpgradeAction =
  | { kind: 'stay' }
  /** Rebind to `path` at `offset` (a byte offset in the full log), keeping the
   *  driver state — the same records continue, only the file changes. */
  | { kind: 'rebind'; path: string; offset: number };

export interface AntigravityFullUpgradeInput {
  /** Transcript path currently bound to the bridge (undefined = unbound). */
  boundPath?: string;
  /** Consumed byte offset in `boundPath`. */
  offset: number;
  /** Unparsed bytes after `offset` (a record still being written). */
  pendingTail: string;
  /** A provisional final is held in driver state. */
  hasHeldCandidate: boolean;
  /** A queued Lark turn has not received its final yet. */
  hasUnfinishedTurn: boolean;
  fullExists: (fullPath: string) => boolean;
  /** mapAntigravityCompactOffsetToFull (injected for tests). */
  mapOffset: (compactPath: string, compactOffset: number, fullPath: string) => number | undefined;
}

/**
 * Move a compact bind to the full log only at a turn boundary: no partial
 * record, no held candidate (its text came from the compact log and its uuid
 * names that file), and no queued turn still waiting for its final (its
 * restart-recovery cursor was journaled against the compact file and its byte
 * offsets). Until then — and for good on an agy build that never writes the
 * full log — the bridge keeps reading the compact log, whose cut finals carry
 * ANTIGRAVITY_TRUNCATED_REPLY_NOTICE.
 */
export function decideAntigravityFullUpgrade(input: AntigravityFullUpgradeInput): AntigravityFullUpgradeAction {
  const { boundPath } = input;
  const fullPath = boundPath ? antigravityFullSiblingPath(boundPath) : null;
  if (!boundPath || !fullPath) return { kind: 'stay' };
  if (input.pendingTail || input.hasHeldCandidate || input.hasUnfinishedTurn) return { kind: 'stay' };
  if (!input.fullExists(fullPath)) return { kind: 'stay' };
  const offset = input.mapOffset(boundPath, input.offset, fullPath);
  return offset === undefined ? { kind: 'stay' } : { kind: 'rebind', path: fullPath, offset };
}

/**
 * Which log a resume baseline should bind. Restart recovery is scoped to the
 * exact transcript file a pending turn was journaled against, with byte
 * offsets in that file; a journal written while the bridge read the compact
 * transcript.jsonl (a botmux build that only read the compact log, or a bind
 * made before agy created the full log) can only restore against the compact
 * log. Binding the full log there would silently drop those turns' recovery,
 * so the compact log is bound until they finish (decideAntigravityFullUpgrade
 * then moves over).
 */
export function antigravityRecoveryBindPath(input: {
  /** The resolved (full-first) transcript path. */
  path: string;
  compactExists: (compactPath: string) => boolean;
  /** Restorable journal entries recorded against `jsonlPath`. */
  restorableTurnsOn: (jsonlPath: string) => number;
}): string {
  const compactPath = antigravityCompactSiblingPath(input.path);
  if (!compactPath || !input.compactExists(compactPath)) return input.path;
  return input.restorableTurnsOn(compactPath) > 0 ? compactPath : input.path;
}
