import { describe, it, expect } from 'vitest';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import type { CodexBridgeEvent } from '../src/services/codex-transcript.js';

let nextUuid = 0;
function userEv(text: string, uuid?: string, ts = 0): CodexBridgeEvent {
  return { uuid: uuid ?? `u${++nextUuid}`, timestampMs: ts, kind: 'user', text };
}
function asstEv(text: string, uuid?: string, ts = 0): CodexBridgeEvent {
  return { uuid: uuid ?? `a${++nextUuid}`, timestampMs: ts, kind: 'assistant_final', text };
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

  it('clearPending wipes queue state', () => {
    const q = new CodexBridgeQueue();
    q.mark('t1', 'one', 100);
    q.mark('t2', 'two', 200);
    const dropped = q.clearPending();
    expect(dropped).toHaveLength(2);
    expect(q.size()).toBe(0);
  });
});
