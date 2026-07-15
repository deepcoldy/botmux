import { describe, it, expect } from 'vitest';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { buildBridgeSendMarkerContent, shouldSuppressBridgeEmit, type BridgeSendMarker } from '../src/services/bridge-fallback-gate.js';
import type { CodexBridgeEvent } from '../src/services/codex-transcript.js';

let nextUuid = 0;
function userEv(text: string, uuid?: string, ts = 0): CodexBridgeEvent {
  return { uuid: uuid ?? `u${++nextUuid}`, timestampMs: ts, kind: 'user', text };
}
function asstEv(text: string, uuid?: string, ts = 0): CodexBridgeEvent {
  return { uuid: uuid ?? `a${++nextUuid}`, timestampMs: ts, kind: 'assistant_final', text };
}
function markerForContent(sentAtMs: number, content: string): BridgeSendMarker {
  return { sentAtMs, ...buildBridgeSendMarkerContent(content) };
}

/** Mirrors emitReadyCodexTurns' boundary computation so the queue + gate can
 *  be exercised jointly without the worker's IO. Returns, for each ready turn,
 *  whether its transcript fallback would be suppressed given the send markers.
 *  IMPORTANT: drains then reads `peek()` exactly like the worker, and only a
 *  STARTED pending turn bounds the last ready turn's window. */
function emitDecisions(
  q: CodexBridgeQueue,
  markers: readonly BridgeSendMarker[],
  adoptMode = false,
): { turnId: string; suppressed: boolean }[] {
  const ready = q.drainEmittable();
  const remaining = q.peek();
  const nextPendingMarkTimeMs = remaining.length > 0 && remaining[0].started
    ? remaining[0].markTimeMs
    : undefined;
  const out: { turnId: string; suppressed: boolean }[] = [];
  for (let i = 0; i < ready.length; i++) {
    const turn = ready[i];
    if (!turn.finalText) continue;
    const nextBoundaryMs = i + 1 < ready.length ? ready[i + 1].markTimeMs : nextPendingMarkTimeMs;
    out.push({
      turnId: turn.turnId,
      suppressed: shouldSuppressBridgeEmit(
        { markTimeMs: turn.markTimeMs, isLocal: turn.isLocal, finalText: turn.finalText }, nextBoundaryMs, markers, adoptMode,
      ),
    });
  }
  return out;
}

describe('CodexBridgeQueue', () => {
  it('marked turn whose user fingerprint matches becomes started; assistant_final closes it; drainEmittable yields finalText', () => {
    const q = new CodexBridgeQueue();
    q.mark('t1', 'hello model please', 100);
    q.ingest([userEv('hello model please'), asstEv('reply text')]);
    const ready = q.drainEmittable();
    expect(ready).toHaveLength(1);
    expect(ready[0].turnId).toBe('t1');
    expect(ready[0].finalText).toBe('reply text');
  });

  it('carries an explicit transcript terminal outcome with an empty final', () => {
    const q = new CodexBridgeQueue();
    q.mark('t1', 'durable prompt', 100, 7);
    q.ingest([
      userEv('durable prompt'),
      {
        ...asstEv(''),
        terminalStatus: 'failed',
        terminalErrorCode: 'grok_turn_error',
      },
    ]);
    expect(q.drainEmittable()).toEqual([
      expect.objectContaining({
        turnId: 't1',
        dispatchAttempt: 7,
        finalText: '',
        terminalStatus: 'failed',
        terminalErrorCode: 'grok_turn_error',
      }),
    ]);
  });

  it('drops only the retired dispatch attempt before the same turnId is replayed', () => {
    const q = new CodexBridgeQueue();
    q.mark('same-turn', 'durable prompt', 100, 1);
    q.mark('same-turn', 'durable prompt', 200, 2);

    expect(q.dropPendingTurn('same-turn', 1)).toEqual(
      expect.objectContaining({ turnId: 'same-turn', dispatchAttempt: 1 }),
    );
    expect(q.peek()).toEqual([
      expect.objectContaining({ turnId: 'same-turn', dispatchAttempt: 2 }),
    ]);

    q.ingest([userEv('durable prompt'), asstEv('replayed answer')]);
    expect(q.drainEmittable()).toEqual([
      expect.objectContaining({
        turnId: 'same-turn',
        dispatchAttempt: 2,
        finalText: 'replayed answer',
      }),
    ]);
  });

  it('user event with no fingerprint match is ignored (history / local input)', () => {
    const q = new CodexBridgeQueue();
    q.mark('t1', 'lark message', 100);
    // First user event is unrelated history — should not start t1.
    q.ingest([userEv('something completely different'), userEv('lark message'), asstEv('answer')]);
    const ready = q.drainEmittable();
    expect(ready).toHaveLength(1);
    expect(ready[0].finalText).toBe('answer');
  });

  it('user event with no pending turn is silently dropped', () => {
    const q = new CodexBridgeQueue();
    q.ingest([userEv('orphan user event'), asstEv('orphan reply')]);
    expect(q.size()).toBe(0);
    expect(q.drainEmittable()).toEqual([]);
  });

  it('replays recently buffered unmatched events when a matching mark arrives later', () => {
    const q = new CodexBridgeQueue();
    q.ingest([
      userEv('say hi please', 'u-early', 1_000),
      asstEv('Hi，收到。', 'a-early', 1_100),
    ]);
    q.mark('t1', 'say hi please', 4_000);
    const ready = q.drainEmittable();
    expect(ready).toHaveLength(1);
    expect(ready[0].turnId).toBe('t1');
    expect(ready[0].finalText).toBe('Hi，收到。');
  });

  it('does not replay buffered events older than the 5s skew window', () => {
    const q = new CodexBridgeQueue();
    q.ingest([
      userEv('old prompt', 'u-old-buffered', 1_000),
      asstEv('old answer', 'a-old-buffered', 1_100),
    ]);
    q.mark('t1', 'old prompt', 8_000);
    expect(q.peek()[0].started).toBe(false);
    expect(q.drainEmittable()).toEqual([]);
  });

  it('absorb registers events as seen so they cannot start a turn later', () => {
    const q = new CodexBridgeQueue();
    const ev = userEv('historical message', 'u-hist');
    q.absorb([ev]);
    q.mark('t1', 'historical message', 100);
    q.ingest([ev]);  // re-feed same uuid
    expect(q.peek()[0].started).toBe(false);
  });

  it('two pending turns marked sequentially: each user event starts the head', () => {
    const q = new CodexBridgeQueue();
    q.mark('t1', 'first prompt', 100);
    q.mark('t2', 'second prompt', 200);
    q.ingest([userEv('first prompt'), asstEv('first reply')]);
    let ready = q.drainEmittable();
    expect(ready.map(t => t.turnId)).toEqual(['t1']);
    q.ingest([userEv('second prompt'), asstEv('second reply')]);
    ready = q.drainEmittable();
    expect(ready.map(t => t.turnId)).toEqual(['t2']);
  });

  it('type-ahead, interleaved transcript (CoCo always; Codex when no tool_call): both turns marked upfront attribute in order', () => {
    // The worker writes msg1 AND msg2 to the PTY back-to-back (type-ahead), so
    // both turns are marked before either is processed. This models the
    // INTERLEAVED transcript shape (user1 → asst1 → user2 → asst2): CoCo always
    // produces it (parks msg2 and writes its events.jsonl user event only at
    // dequeue time); Codex produces it only when msg1's turn runs no tool_call
    // (its parked input is then submitted as a fresh next turn). The single
    // `collecting` pointer stays correct here without any HOL drop. Marks land
    // at t=100 while the user events arrive much later — the tooOld gate
    // (ts < markTime - 5s) must NOT trip because events come AFTER marks. (The
    // Codex steer-merge shape — user1 → user2 → final, when msg1 runs a tool —
    // is covered by the dedicated steer-merge tests below.)
    const q = new CodexBridgeQueue();
    q.mark('t1', 'first prompt', 100);
    q.mark('t2', 'second prompt', 100);  // type-ahead: marked ~immediately
    q.ingest([
      userEv('first prompt', 'u1', 5_000),
      asstEv('first reply', 'a1', 6_000),
      userEv('second prompt', 'u2', 12_000),  // dequeued only after turn 1
      asstEv('second reply', 'a2', 13_000),
    ]);
    const ready = q.drainEmittable();
    expect(ready.map(t => t.turnId)).toEqual(['t1', 't2']);
    expect(ready.map(t => t.finalText)).toEqual(['first reply', 'second reply']);
  });

  it('Codex steer-merge: user2 steered into active turn before any final → t1 dropped, t2 gets merged final, no wedge', () => {
    // codex-cli 0.134.0 active-turn steer (verified empirically): when msg1's
    // turn runs a tool_call, msg2 is steered into the SAME turn and codex emits
    // ONE merged final answering both. Rollout: user1 → user2 → assistant_final
    // (no final for t1 before user2). Without HOL-block-drop the single
    // `collecting` pointer switches to t2, the merged final closes t2, and t1
    // stays at the queue head with no finalText → drainEmittable() wedges
    // forever. HOL-drop discards the textless collecting t1 when user2 arrives.
    const q = new CodexBridgeQueue();
    q.mark('t1', 'first prompt', 100);
    q.mark('t2', 'second prompt', 100);  // type-ahead: marked ~immediately
    q.ingest([
      userEv('first prompt', 'u1', 5_000),
      userEv('second prompt', 'u2', 8_000),   // steered in BEFORE any assistant_final
      asstEv('merged reply', 'a1', 12_000),   // single combined final
    ]);
    const ready = q.drainEmittable();
    expect(ready.map(t => t.turnId)).toEqual(['t2']);   // t1 dropped, t2 emits
    expect(ready[0].finalText).toBe('merged reply');
    expect(q.size()).toBe(0);                            // no wedge
  });

  it('Codex steer-merge with leading environment_context (real rollout shape): env event ignored, t1 dropped, t2 emits', () => {
    // Real codex rollout opens with a role=user <environment_context> event
    // before the first prompt. It matches no fingerprint and (collecting=null)
    // must neither start a turn nor spuriously HOL-drop. Then user1 → user2 →
    // merged final, same as the steer-merge case.
    const q = new CodexBridgeQueue();
    q.mark('t1', 'first prompt', 100);
    q.mark('t2', 'second prompt', 100);
    q.ingest([
      userEv('<environment_context>   <cwd>/tmp/x</cwd>', 'env', 4_000),  // not a real turn
      userEv('first prompt', 'u1', 5_000),
      userEv('second prompt', 'u2', 8_000),
      asstEv('merged reply', 'a1', 12_000),
    ]);
    const ready = q.drainEmittable();
    expect(ready.map(t => t.turnId)).toEqual(['t2']);
    expect(q.size()).toBe(0);
  });

  it('Codex steer-merge with N type-ahead messages: only the last steered turn emits the merged final', () => {
    // Three messages typed-ahead into one tool-running turn; codex steers all
    // into the active turn → user1 → user2 → user3 → one merged final. Each new
    // user event HOL-drops the previous textless collecting turn.
    const q = new CodexBridgeQueue();
    q.mark('t1', 'prompt one', 100);
    q.mark('t2', 'prompt two', 100);
    q.mark('t3', 'prompt three', 100);
    q.ingest([
      userEv('prompt one', 'u1', 5_000),
      userEv('prompt two', 'u2', 6_000),
      userEv('prompt three', 'u3', 7_000),
      asstEv('one combined reply', 'a1', 12_000),
    ]);
    const ready = q.drainEmittable();
    expect(ready.map(t => t.turnId)).toEqual(['t3']);   // t1, t2 dropped
    expect(ready[0].finalText).toBe('one combined reply');
    expect(q.size()).toBe(0);
  });

  it('Codex steer-merge with clock skew: live user events a few seconds BELOW the mark (within tooOld tolerance) still HOL-drop', () => {
    // Regression for the freshness-gate P1 (Codex review v2): turn-start tolerates
    // events up to 5s before the mark (tooOld = ts < mark - 5000) and markTimeMs
    // never moves backwards (Math.max). So a legit live user1 a couple seconds
    // before the mark starts t1 while collecting.markTimeMs stays at the mark; a
    // subsequent live user2 also below the mark must STILL HOL-drop t1. Gating
    // HOL-drop on "this event actually starts a turn" (reusing tooOld/fingerprint)
    // keeps the two freshness rules consistent.
    const q = new CodexBridgeQueue();
    q.mark('t1', 'first prompt', 10_000);
    q.mark('t2', 'second prompt', 10_001);
    q.ingest([
      userEv('first prompt', 'u1', 8_000),    // 2s before mark — within tooOld tolerance, legit live start
      userEv('second prompt', 'u2', 9_000),   // also below mark, real steer after user1
      asstEv('merged reply', 'a1', 12_000),
    ]);
    const ready = q.drainEmittable();
    expect(ready.map(t => t.turnId)).toEqual(['t2']);   // t1 HOL-dropped despite ts < mark
    expect(q.size()).toBe(0);                            // no wedge
  });

  it('HOL-drop only fires on a real turn-start: a fresh user event that matches no pending fingerprint (non-adopt) does NOT evict the collecting turn', () => {
    // Hardening (Codex review v2): HOL-drop must not treat ANY fresh user event
    // as a turn-start. A user event that neither matches a pending fingerprint
    // nor synthesises a local turn (localTurns off) leaves the collecting turn
    // intact so its in-flight final still lands.
    const q = new CodexBridgeQueue();
    q.mark('t1', 'real prompt', 100);
    q.ingest([userEv('real prompt', 'u1', 5_000)]);          // t1 started, collecting
    q.ingest([userEv('unrelated stray text', 'u-x', 6_000)]); // no fingerprint match, non-adopt → ignored
    expect(q.peek().some(t => t.turnId === 't1')).toBe(true); // t1 NOT dropped
    q.ingest([asstEv('t1 reply', 'a1', 7_000)]);
    expect(q.drainEmittable().map(t => t.turnId)).toEqual(['t1']);
  });

  it('HOL-drop is gated on freshness: a replayed historical user event does NOT evict a live collecting turn', () => {
    // A late-attach / replay can feed an OLD user event after a turn is already
    // collecting. The freshness gate (event ts >= collecting mark) prevents it
    // from HOL-dropping the live turn, which would lose the in-flight reply.
    const q = new CodexBridgeQueue();
    q.mark('t1', 'live prompt', 10_000);
    q.ingest([userEv('live prompt', 'u-live', 12_000)]);   // t1 started, markTimeMs→12_000
    q.ingest([userEv('ancient history', 'u-old', 3_000)]); // stale; must NOT drop t1
    expect(q.peek().some(t => t.turnId === 't1')).toBe(true);
    q.ingest([asstEv('live reply', 'a-live', 13_000)]);
    expect(q.drainEmittable().map(t => t.turnId)).toEqual(['t1']);
  });

  it('type-ahead: turn-start overrides markTimeMs to the dequeue-time event timestamp', () => {
    const q = new CodexBridgeQueue();
    q.mark('t1', 'prompt one', 1_000);
    q.mark('t2', 'prompt two', 1_001);  // type-ahead: marked ~immediately
    // t1 dequeued and processed much later; t2 still parked in CoCo's TUI queue.
    q.ingest([userEv('prompt one', 'u1', 5_000), asstEv('reply one', 'a1', 15_000)]);
    expect(q.peek().find(t => t.turnId === 't1')!.markTimeMs).toBe(5_000);   // overridden
    expect(q.peek().find(t => t.turnId === 't2')!.markTimeMs).toBe(1_001);   // untouched until it starts
  });

  it('markTimeMs override never moves the lower bound backwards (max, not assign)', () => {
    const q = new CodexBridgeQueue();
    q.mark('t1', 'a prompt', 10_000);
    // Event timestamp is BEFORE the mark (clock skew within the -5s tolerance):
    // override must keep the later mark so a previous turn's send can't leak in.
    q.ingest([userEv('a prompt', 'u1', 8_000)]);
    expect(q.peek()[0].markTimeMs).toBe(10_000);
  });

  it('drainEmittable holds turn that started but has no finalText yet', () => {
    const q = new CodexBridgeQueue();
    q.mark('t1', 'a query', 100);
    q.ingest([userEv('a query')]);  // started, no assistant_final yet
    expect(q.drainEmittable()).toEqual([]);
    expect(q.peek()[0].started).toBe(true);
    expect(q.peek()[0].finalText).toBeUndefined();
  });

  it('treats an empty assistant_final as a terminal boundary and preserves the attempt', () => {
    const q = new CodexBridgeQueue();
    q.mark('delivery-key', 'a query', 100, 4);
    q.ingest([userEv('a query'), asstEv('')]);

    expect(q.drainEmittable()).toMatchObject([
      { turnId: 'delivery-key', dispatchAttempt: 4, finalText: '' },
    ]);
  });

  it('peek exposes pending markTimeMs for the gate computation', () => {
    const q = new CodexBridgeQueue();
    q.mark('t1', 'first', 100);
    q.mark('t2', 'second', 200);
    expect(q.peek().map(t => t.markTimeMs)).toEqual([100, 200]);
  });

  it('ingest is idempotent on uuid (replay safe)', () => {
    const q = new CodexBridgeQueue();
    q.mark('t1', 'x', 100);
    const u = userEv('x', 'u-stable');
    const a = asstEv('answer', 'a-stable');
    q.ingest([u, a]);
    q.ingest([u, a]);  // replay — must not emit twice
    expect(q.drainEmittable()).toHaveLength(1);
    expect(q.drainEmittable()).toHaveLength(0);
  });

  it('user event older than mark - 5s does NOT start the turn (history guard)', () => {
    const q = new CodexBridgeQueue();
    q.mark('t1', 'lark prompt', 100_000);
    // Same fingerprint, but timestamp is well before mark - 5s skew.
    q.ingest([{ uuid: 'old', timestampMs: 80_000, kind: 'user', text: 'lark prompt' }]);
    expect(q.peek()[0].started).toBe(false);
  });

  it('user event within 5s skew below mark IS allowed (clock drift tolerance)', () => {
    const q = new CodexBridgeQueue();
    q.mark('t1', 'lark prompt', 100_000);
    // 4s before mark — within tolerance (mark - 5000 = 95000).
    q.ingest([{ uuid: 'recent', timestampMs: 96_000, kind: 'user', text: 'lark prompt' }]);
    expect(q.peek()[0].started).toBe(true);
  });

  it('user event after mark starts the turn (normal path with timestamps)', () => {
    const q = new CodexBridgeQueue();
    q.mark('t1', 'lark prompt', 100_000);
    q.ingest([
      { uuid: 'history', timestampMs: 50_000, kind: 'user', text: 'lark prompt' },
      { uuid: 'live', timestampMs: 110_000, kind: 'user', text: 'lark prompt' },
    ]);
    expect(q.peek()[0].started).toBe(true);
  });

  describe('adopt mode local-turn synthesis (setLocalTurns)', () => {
    it('non-matching user event creates a local turn after enabling localTurns', () => {
      const q = new CodexBridgeQueue();
      q.setLocalTurns(true, 0);
      q.ingest([
        { uuid: 'local-u', timestampMs: 100, kind: 'user', text: 'typed in iTerm directly' },
        { uuid: 'local-a', timestampMs: 200, kind: 'assistant_final', text: 'answer to iTerm input' },
      ]);
      const ready = q.drainEmittable();
      expect(ready).toHaveLength(1);
      expect(ready[0].isLocal).toBe(true);
      expect(ready[0].userText).toBe('typed in iTerm directly');
      expect(ready[0].finalText).toBe('answer to iTerm input');
    });

    it('non-matching user event below localLowerBoundMs - 5s does NOT create a local turn (history guard)', () => {
      const q = new CodexBridgeQueue();
      q.setLocalTurns(true, 100_000);
      q.ingest([
        { uuid: 'old-u', timestampMs: 80_000, kind: 'user', text: 'old iTerm input' },
        { uuid: 'old-a', timestampMs: 80_500, kind: 'assistant_final', text: 'old answer' },
      ]);
      expect(q.drainEmittable()).toEqual([]);
    });

    it('with both pending Lark turn AND local user event, Lark turn started first when fingerprint matches', () => {
      const q = new CodexBridgeQueue();
      q.setLocalTurns(true, 0);
      q.mark('lark1', 'lark prompt content', 100);
      q.ingest([
        // Local user event arrives first chronologically — but fingerprint
        // doesn't match the Lark mark, so it should NOT consume the Lark
        // pending turn. It synthesises a local turn ahead instead.
        { uuid: 'live-local-u', timestampMs: 110, kind: 'user', text: 'unrelated local input' },
        { uuid: 'live-local-a', timestampMs: 120, kind: 'assistant_final', text: 'reply to local' },
        // Then the Lark prompt's own user event with matching fingerprint
        { uuid: 'lark-u', timestampMs: 130, kind: 'user', text: 'lark prompt content' },
        { uuid: 'lark-a', timestampMs: 140, kind: 'assistant_final', text: 'reply to lark' },
      ]);
      const ready = q.drainEmittable();
      expect(ready).toHaveLength(2);
      expect(ready[0].isLocal).toBe(true);
      expect(ready[0].finalText).toBe('reply to local');
      expect(ready[1].turnId).toBe('lark1');
      expect(ready[1].finalText).toBe('reply to lark');
    });

    it('disabled localTurns (default) keeps non-adopt behaviour: orphan user is dropped', () => {
      const q = new CodexBridgeQueue();
      // No setLocalTurns call → default false
      q.ingest([
        { uuid: 'orphan-u', timestampMs: 100, kind: 'user', text: 'no pending lark turn' },
        { uuid: 'orphan-a', timestampMs: 110, kind: 'assistant_final', text: 'should not surface' },
      ]);
      expect(q.drainEmittable()).toEqual([]);
      expect(q.size()).toBe(0);
    });

    it('setLocalTurns(false) disables synthesis after previous enable', () => {
      const q = new CodexBridgeQueue();
      q.setLocalTurns(true, 0);
      q.setLocalTurns(false);
      q.ingest([
        { uuid: 'u', timestampMs: 100, kind: 'user', text: 'now ignored' },
      ]);
      expect(q.size()).toBe(0);
    });
  });

  it('ignores assistant_final from a different source session while collecting', () => {
    const q = new CodexBridgeQueue();
    q.mark('t1', 'lark prompt', 100);
    q.ingest([
      { uuid: 'u1', timestampMs: 110, kind: 'user', text: 'lark prompt', sourceSessionId: 'h1' },
      { uuid: 'a-other', timestampMs: 120, kind: 'assistant_final', text: 'wrong session reply', sourceSessionId: 'h2' },
    ]);
    expect(q.drainEmittable()).toEqual([]);

    q.ingest([{ uuid: 'a1', timestampMs: 130, kind: 'assistant_final', text: 'right session reply', sourceSessionId: 'h1' }]);
    const ready = q.drainEmittable()[0];
    expect(ready.finalText).toBe('right session reply');
    expect(ready.sourceSessionId).toBe('h1');
  });

  it('clearPending wipes queue state', () => {
    const q = new CodexBridgeQueue();
    q.mark('t1', 'one', 100);
    q.mark('t2', 'two', 200);
    const dropped = q.clearPending();
    expect(dropped).toHaveLength(2);
    expect(q.size()).toBe(0);
  });
});

describe('CodexBridgeQueue + bridge-fallback gate (type-ahead suppression windows)', () => {
  it('preserves Hermes markTime so late-committed user rows do not miss in-turn sends', () => {
    const q = new CodexBridgeQueue();
    q.mark('t1', 'hermes prompt', 1_000);
    q.ingest([
      { ...userEv('hermes prompt', 'u-hermes', 12_000), preserveMarkTimeMs: true },
      asstEv('hermes reply', 'a-hermes', 15_000),
    ]);

    const markers: BridgeSendMarker[] = [{ sentAtMs: 8_000 }];
    expect(emitDecisions(q, markers)).toEqual([{ turnId: 't1', suppressed: true }]);
  });

  it('keeps adjacent Hermes queued-turn windows separate during batch drains', () => {
    const makeQueue = () => {
      const q = new CodexBridgeQueue();
      q.mark('t1', 'first hermes prompt', 1_000);
      q.mark('t2', 'second hermes prompt', 1_001);
      q.ingest([
        { ...userEv('first hermes prompt', `u1-${++nextUuid}`, 12_000), preserveMarkTimeMs: true },
        asstEv('first hermes reply', `a1-${++nextUuid}`, 15_000),
        { ...userEv('second hermes prompt', `u2-${++nextUuid}`, 22_000), preserveMarkTimeMs: true },
        asstEv('second hermes reply', `a2-${++nextUuid}`, 25_000),
      ]);
      return q;
    };

    expect(emitDecisions(makeQueue(), [{ sentAtMs: 14_000 }, { sentAtMs: 20_000 }])).toEqual([
      { turnId: 't1', suppressed: true },
      { turnId: 't2', suppressed: true },
    ]);
    expect(emitDecisions(makeQueue(), [{ sentAtMs: 20_000 }])).toEqual([
      { turnId: 't1', suppressed: false },
      { turnId: 't2', suppressed: true },
    ]);
  });

  it('does not let explicit progress sends suppress a later transcript final answer', () => {
    const q = new CodexBridgeQueue();
    q.mark('t1', 'please design the sync plan', 1_000);
    q.ingest([
      userEv('please design the sync plan', 'u1', 5_000),
      asstEv(
        'I recommend a three-layer design: keep the repository-owned scripts, install them through a setup skill, and let a user-level systemd timer own the runtime synchronization loop.',
        'a1',
        15_000,
      ),
    ]);

    const markers: BridgeSendMarker[] = [
      markerForContent(7_000, 'I am checking the current repo'),
      markerForContent(10_000, 'I found the existing scripts'),
    ];
    expect(emitDecisions(q, markers)).toEqual([{ turnId: 't1', suppressed: false }]);
  });

  it('turn1 send no longer escapes its window when turn2 was type-ahead-marked early', () => {
    // The exact P1 regression: without the dequeue-time markTimeMs override +
    // started-only boundary, turn1's window would be the bunched [1000, 1001)
    // and its real send at 14000 would fall OUTSIDE → fallback NOT suppressed →
    // duplicate. turn1 emits (on asst1_final idle) while turn2 is still parked.
    const q = new CodexBridgeQueue();
    q.mark('t1', 'first prompt', 1_000);
    q.mark('t2', 'second prompt', 1_001);  // type-ahead early mark
    q.ingest([userEv('first prompt', 'u1', 5_000), asstEv('first reply', 'a1', 15_000)]);
    const markers: BridgeSendMarker[] = [{ sentAtMs: 14_000 }];  // turn1's model sent
    const d1 = emitDecisions(q, markers);
    expect(d1).toEqual([{ turnId: 't1', suppressed: true }]);  // correctly suppressed → no dup

    // turn2 dequeued only now (after turn1 finished); its own send at 20000.
    q.ingest([userEv('second prompt', 'u2', 16_000), asstEv('second reply', 'a2', 25_000)]);
    const d2 = emitDecisions(q, [...markers, { sentAtMs: 20_000 }]);
    expect(d2).toEqual([{ turnId: 't2', suppressed: true }]);  // turn1's send not mis-credited here
  });

  it('turn1 solo-emits before turn2 starts: open (∞) boundary is safe (no future send exists yet)', () => {
    // When turn1 finishes and emits while turn2 is still parked, the boundary
    // is ∞. That is safe because markers accumulate over wall-clock time: any
    // send already in the file at this moment was made DURING turn1 (so it is
    // turn1's), and turn2's send physically cannot exist yet. Here turn1 forgot
    // to send → no marker yet → fallback must fire.
    const q = new CodexBridgeQueue();
    q.mark('t1', 'first prompt', 1_000);
    q.mark('t2', 'second prompt', 1_001);
    q.ingest([userEv('first prompt', 'u1', 5_000), asstEv('first reply', 'a1', 15_000)]);
    expect(emitDecisions(q, [])).toEqual([{ turnId: 't1', suppressed: false }]);
  });

  it('batch drain: turn1 forgot to send, turn2 did — turn2 send is NOT leaked into turn1', () => {
    // Both turns drain together (delayed emit). turn1 boundary is turn2's
    // OVERRIDDEN mark (16000), so turn2's later send (20000) stays out of
    // turn1's window — turn1's fallback fires, turn2 is suppressed by its own.
    const q = new CodexBridgeQueue();
    q.mark('t1', 'first prompt', 1_000);
    q.mark('t2', 'second prompt', 1_001);
    q.ingest([
      userEv('first prompt', 'u1', 5_000), asstEv('first reply', 'a1', 15_000),
      userEv('second prompt', 'u2', 16_000), asstEv('second reply', 'a2', 25_000),
    ]);
    const decisions = emitDecisions(q, [{ sentAtMs: 20_000 }]);
    expect(decisions).toEqual([
      { turnId: 't1', suppressed: false },  // fallback fires — turn1 never sent
      { turnId: 't2', suppressed: true },   // turn2's own send, not leaked from anywhere
    ]);
  });

  it('both turns drain in one batch: in-batch boundary uses overridden marks', () => {
    const q = new CodexBridgeQueue();
    q.mark('t1', 'first prompt', 1_000);
    q.mark('t2', 'second prompt', 1_001);
    q.ingest([
      userEv('first prompt', 'u1', 5_000), asstEv('first reply', 'a1', 15_000),
      userEv('second prompt', 'u2', 16_000), asstEv('second reply', 'a2', 25_000),
    ]);
    // turn1 sent at 14000, turn2 sent at 20000 — each must land in its own window.
    const markers: BridgeSendMarker[] = [{ sentAtMs: 14_000 }, { sentAtMs: 20_000 }];
    const decisions = emitDecisions(q, markers);
    expect(decisions).toEqual([
      { turnId: 't1', suppressed: true },
      { turnId: 't2', suppressed: true },
    ]);
  });

  it('steer-merge: HOL-dropped t1 leaves t2 a correct suppression window for the single merged send', () => {
    // codex merged msg1+msg2 into one turn (user1 → user2 → merged final). HOL-
    // drop discards t1; only t2 drains, its window anchored to user2's dequeue
    // timestamp. The model's single botmux send for the combined reply lands in
    // t2's window → suppressed, no duplicate fallback.
    const q = new CodexBridgeQueue();
    q.mark('t1', 'first prompt', 1_000);
    q.mark('t2', 'second prompt', 1_001);
    q.ingest([
      userEv('first prompt', 'u1', 5_000),
      userEv('second prompt', 'u2', 8_000),
      asstEv('merged reply', 'a1', 15_000),
    ]);
    const decisions = emitDecisions(q, [{ sentAtMs: 12_000 }]);
    expect(decisions).toEqual([{ turnId: 't2', suppressed: true }]);
  });

  it('steer-merge: HOL-dropped t1, model forgot to send → merged fallback fires once on t2', () => {
    const q = new CodexBridgeQueue();
    q.mark('t1', 'first prompt', 1_000);
    q.mark('t2', 'second prompt', 1_001);
    q.ingest([
      userEv('first prompt', 'u1', 5_000),
      userEv('second prompt', 'u2', 8_000),
      asstEv('merged reply', 'a1', 15_000),
    ]);
    expect(emitDecisions(q, [])).toEqual([{ turnId: 't2', suppressed: false }]);
  });
});
