/**
 * Journal-derived attempt numbering shared by the runtime and the external
 * attempt control functions (retry / reassign).
 */

import type { StoredEvent } from './event-contract.js';

// ─── Attempt numbering (journal-derived — no hardcoded 001) ──────────────────

const ATTEMPT_NNN_RE = /\/attempts\/(\d{3})$/;

export function attemptNumber(attemptId: string): number | undefined {
  const m = ATTEMPT_NNN_RE.exec(attemptId);
  return m ? parseInt(m[1]!, 10) : undefined;
}

/**
 * Compute the attemptId the NEXT dispatch of `nodeId` must use, from the
 * journal: an unconsumed `nodeRetryRequested` reservation wins (retry intent
 * is authoritative for the redrive); otherwise max(seen)+1 — which is 001 for
 * a first dispatch.  Dispatch events are the authority for "seen"; a
 * reservation is consumed by a later `nodeDispatched` with the same number.
 */
export function nextAttemptIdFor(events: StoredEvent[], key: string): string {
  // `key` is the dispatch namespace: a runtime instance (`A#001`), a loop body
  // expansion (`loopId.i001.code`), or a legacy nodeId.  Match events by their
  // instance when they carry one, else by nodeId — so `A#002`'s attempts are
  // counted separately from `A#001`'s (constraint 3/5).
  const matches = (e: { nodeId: string; instanceId?: string }): boolean => (e.instanceId ?? e.nodeId) === key;
  let maxSeen = 0;
  let reserved: number | undefined;
  let prepared: string | undefined;
  for (const e of events) {
    if (e.type === 'nodeDispatched' && matches(e)) {
      const n = attemptNumber(e.attemptId);
      if (n === undefined) continue;
      maxSeen = Math.max(maxSeen, n);
      if (reserved === n) reserved = undefined; // reservation consumed
    } else if (e.type === 'hostInputPrepared' && matches(e)) {
      const n = attemptNumber(e.attemptId);
      if (n === undefined) continue;
      maxSeen = Math.max(maxSeen, n);
      if (reserved === n) reserved = undefined;
      prepared = e.attemptId;
    } else if (
      (e.type === 'nodeSucceeded' || e.type === 'nodeFailed' || e.type === 'nodeBlocked') &&
      matches(e)
    ) {
      // A pre-intent host crash can leave only a blocked verdict for the
      // reserved attempt (the sidecar was partial, so no prepared event is
      // trustworthy). The verdict is still durable proof that this number was
      // consumed and a retry must advance rather than collide with it.
      const n = attemptNumber(e.attemptId);
      if (n !== undefined) maxSeen = Math.max(maxSeen, n);
      if (prepared === e.attemptId) prepared = undefined;
    } else if (
      e.type === 'hostEffectIntent' && matches(e) && prepared === e.attemptId
    ) {
      prepared = undefined;
    } else if (e.type === 'nodeRetryRequested' && matches(e)) {
      const n = attemptNumber(e.nextAttemptId);
      if (n === undefined) continue;
      reserved = n;
      prepared = undefined;
      maxSeen = Math.max(maxSeen, n);
    }
  }
  if (prepared) return prepared;
  const n = reserved ?? maxSeen + 1;
  return `${key}/attempts/${String(n).padStart(3, '0')}`;
}

/** Latest dispatched attemptId for a dispatch `key` (the `previousAttemptId` a
 *  retry entrypoint must reference).  `key` is an instance (`A#001`), a loop
 *  body expansion, or a legacy nodeId — matched by `(instanceId ?? nodeId)` so
 *  a retry stays inside the same instance.  Undefined when never dispatched. */
export function latestAttemptIdFor(events: StoredEvent[], key: string): string | undefined {
  let latest: string | undefined;
  let latestNumber = -1;
  for (const e of events) {
    if (
      (
        e.type === 'nodeDispatched' ||
        e.type === 'hostInputPrepared' ||
        e.type === 'hostEffectIntent' ||
        e.type === 'nodeSucceeded' ||
        e.type === 'nodeFailed' ||
        e.type === 'nodeBlocked'
      ) &&
      (e.instanceId ?? e.nodeId) === key
    ) {
      const n = attemptNumber(e.attemptId);
      if (n === undefined) {
        if (latestNumber < 0) latest = e.attemptId;
      } else if (n >= latestNumber) {
        // A stale settle for attempt 001 may arrive after attempt 002 was
        // dispatched. Choose the highest reserved number, never journal order,
        // so retry/cancel cannot regress to an obsolete attempt.
        latest = e.attemptId;
        latestNumber = n;
      }
    }
  }
  return latest;
}
