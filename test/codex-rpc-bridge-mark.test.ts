import { describe, it, expect } from 'vitest';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { shouldPreMarkFirstTurn, shouldQueueInitialPrompt, type EngageOutcome } from '../src/codex-rpc-lifecycle.js';
import type { CodexBridgeEvent } from '../src/services/codex-transcript.js';

// Consecutive-turn regressions against the REAL CodexBridgeQueue, locking the
// fresh-first-turn mark discipline (Codex P1): the active pre-mark fires only
// for a confirmed-accepted turn. Ambiguous delivery now has a separate
// fail-closed attribution mark that is explicitly retired at terminal/teardown;
// not-sent still leaves no mark before the safe paste fallback.
const T0 = 'first prompt alpha';
const T1 = 'second prompt beta';
const user = (uuid: string, text: string, ts: number): CodexBridgeEvent => ({ uuid, timestampMs: ts, kind: 'user', text });
const asst = (uuid: string, text: string, ts: number): CodexBridgeEvent => ({ uuid, timestampMs: ts, kind: 'assistant_final', text });

describe('shouldPreMarkFirstTurn — accepted-only pre-mark', () => {
  it('only accepted pre-marks the bridge', () => {
    expect(shouldPreMarkFirstTurn('accepted')).toBe(true);
    expect(shouldPreMarkFirstTurn('ambiguous')).toBe(false);
    expect(shouldPreMarkFirstTurn('not-engaged')).toBe(false);
    expect(shouldPreMarkFirstTurn('resumed')).toBe(false);
  });
});

describe('CodexBridgeQueue — fresh first-turn mark discipline (Codex P1 stale-head)', () => {
  it('accepted single pre-mark → the turn emits once, queue empties, next turn still emits', () => {
    const q = new CodexBridgeQueue();
    q.mark('t0', T0, 1000); // accepted → exactly ONE mark (prompt not re-queued)
    q.ingest([user('u0', T0, 1001), asst('a0', 'reply0', 1002)]);
    expect(q.drainEmittable().map(t => t.turnId)).toEqual(['t0']);
    expect(q.size()).toBe(0); // no stale head
    q.mark('t1', T1, 2000);
    q.ingest([user('u1', T1, 2001), asst('a1', 'reply1', 2002)]);
    expect(q.drainEmittable().map(t => t.turnId)).toEqual(['t1']);
    expect(q.size()).toBe(0);
  });

  it('not-sent → paste flush marks EXACTLY ONCE → emits once + next different prompt still emits', () => {
    // The worker does NOT pre-mark on not-sent; only flushPending marks (once).
    const q = new CodexBridgeQueue();
    q.mark('t0', T0, 1000); // the single paste-path mark
    q.ingest([user('u0', T0, 1001), asst('a0', 'reply0', 1002)]);
    expect(q.drainEmittable().map(t => t.turnId)).toEqual(['t0']);
    expect(q.size()).toBe(0);
    q.mark('t1', T1, 2000);
    q.ingest([user('u1', T1, 2001), asst('a1', 'reply1', 2002)]);
    expect(q.drainEmittable().map(t => t.turnId)).toEqual(['t1']);
  });

  it('ambiguous fail-closed attribution mark is explicitly retired before a successor can run', () => {
    const q = new CodexBridgeQueue();
    q.mark('t0', T0, 1000);
    // Engine teardown/terminal owns this explicit retirement. A successor is
    // not admitted while the worker's separate fail-closed gate is asserted.
    expect(q.dropPendingTurn('t0')).toBeDefined();
    q.mark('t1', T1, 2000);
    q.ingest([user('u1', T1, 2001), asst('a1', 'reply1', 2002)]);
    expect(q.drainEmittable().map(t => t.turnId)).toEqual(['t1']);
    expect(q.size()).toBe(0);
  });

  // Decision-level regression: drive the queue with the mark sequence the REAL
  // worker helpers produce per outcome (pre-mark via shouldPreMarkFirstTurn +
  // paste-flush mark via shouldQueueInitialPrompt), so this FAILS under the old
  // "always pre-mark before sendFirstTurn" implementation, not just documents the
  // queue. `preMarkAlways` models the reverted bug.
  function nextTurnAfterFirst(outcome: EngageOutcome, preMarkAlways: boolean): string[] {
    const q = new CodexBridgeQueue();
    const engineActive = outcome === 'accepted' || outcome === 'ambiguous'; // not-engaged tears the engine down
    const preMark = preMarkAlways ? true : shouldPreMarkFirstTurn(outcome);
    const flushMark = shouldQueueInitialPrompt({ hasPrompt: true, rpcEngineActive: engineActive, queuePrompt: false, passesInitialPromptViaArgs: false, deferInitialPrompt: false });
    if (preMark) q.mark('t0', T0, 1000);
    if (outcome === 'ambiguous') {
      q.mark('t0', T0, 1000); // attribution-only while fail-closed
      q.dropPendingTurn('t0'); // native terminal / engine teardown
    }
    if (flushMark) q.mark('t0', T0, 1000); // paste flush re-marks the SAME turnId
    q.ingest([user('u0', T0, 1001), asst('a0', 'reply0', 1002)]);
    q.drainEmittable();
    q.mark('t1', T1, 2000);
    q.ingest([user('u1', T1, 2001), asst('a1', 'reply1', 2002)]);
    return q.drainEmittable().map(t => t.turnId);
  }

  it('FIXED worker: accepted / not-sent(→not-engaged) / ambiguous all let the NEXT turn emit', () => {
    // accepted: active pre-mark(1); not-engaged: paste mark(1);
    // ambiguous: fail-closed attribution mark retired before successor.
    expect(nextTurnAfterFirst('accepted', false)).toEqual(['t1']);
    expect(nextTurnAfterFirst('not-engaged', false)).toEqual(['t1']);
    expect(nextTurnAfterFirst('ambiguous', false)).toEqual(['t1']);
  });

  it('OLD always-pre-mark impl: not-sent(→not-engaged) double-marks → next turn WEDGED (regression fails here)', () => {
    // pre-mark(1)+flush(1)=2 same-turnId marks → stale unstarted head → drain []
    expect(nextTurnAfterFirst('not-engaged', true)).toEqual([]);
  });

  it('characterizes the reverted double-mark failure: a DOUBLE mark of the same turnId wedges the next turn', () => {
    const q = new CodexBridgeQueue();
    q.mark('t0', T0, 1000); // early pre-mark (old bug)
    q.mark('t0', T0, 1000); // flush re-mark, same turnId
    q.ingest([user('u0', T0, 1001), asst('a0', 'reply0', 1002)]);
    expect(q.drainEmittable().map(t => t.turnId)).toEqual(['t0']);
    expect(q.size()).toBe(1); // the duplicate t0 lingers UNSTARTED at the head
    q.mark('t1', T1, 2000);
    q.ingest([user('u1', T1, 2001), asst('a1', 'reply1', 2002)]);
    // wedged: the stale unstarted head breaks the FIFO drain — this is exactly
    // what accepted-only marking prevents.
    expect(q.drainEmittable()).toEqual([]);
  });
});
