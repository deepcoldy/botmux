import { describe, it, expect } from 'vitest';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { shouldSuppressBridgeEmit, type BridgeSendMarker } from '../src/services/bridge-fallback-gate.js';
import type { CodexBridgeEvent } from '../src/services/codex-transcript.js';

let nextUuid = 0;
function userEv(text: string, uuid?: string, ts = 0): CodexBridgeEvent {
  return { uuid: uuid ?? `u${++nextUuid}`, timestampMs: ts, kind: 'user', text };
}
function asstEv(text: string, uuid?: string, ts = 0): CodexBridgeEvent {
  return { uuid: uuid ?? `a${++nextUuid}`, timestampMs: ts, kind: 'assistant_final', text };
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
        { markTimeMs: turn.markTimeMs, isLocal: turn.isLocal }, nextBoundaryMs, markers, adoptMode,
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

  it('CoCo type-ahead: both turns marked upfront, interleaved events attribute in order', () => {
    // Models the CoCo type-ahead path: the worker writes msg1 AND msg2 to the
    // PTY back-to-back (type-ahead), so both turns are marked before either is
    // processed. CoCo parks msg2 in its TUI queue and writes its events.jsonl
    // user event only at dequeue time, so the transcript the bridge ingests is
    // strictly interleaved (user1 → asst1 → user2 → asst2). This is exactly
    // what keeps the single-`collecting` pointer correct. Marks land at t=100
    // while the user events arrive much later (dequeue time) — the tooOld gate
    // (ts < markTime - 5s) must NOT trip here because events come AFTER marks.
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
    expect(q.drainEmittable()[0].finalText).toBe('right session reply');
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
});
