/**
 * Stage 3 per-session turn：同一 sessionId 上的命令跨 await 仍按入队顺序串行。
 *
 * Run:  bunx vitest run test/session-turn-queue.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  __testOnly_resetSessionTurnQueues,
  hasPendingSessionTurns,
  runSessionTurn,
} from '../src/core/session-turn-queue.js';

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  __testOnly_resetSessionTurnQueues();
});

describe('runSessionTurn', () => {
  it('runs commands for one session in enqueue order, even when an earlier one awaits', async () => {
    const order: string[] = [];
    const gate = deferred();
    const first = runSessionTurn('s1', async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:end');
      return 1;
    });
    const second = runSessionTurn('s1', () => {
      order.push('second');
      return 2;
    });
    // The second command must not start while the first is parked on its await.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    gate.resolve();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('does not serialize different sessions against each other', async () => {
    const order: string[] = [];
    const gate = deferred();
    const blocked = runSessionTurn('s1', async () => { await gate.promise; order.push('s1'); });
    await runSessionTurn('s2', () => { order.push('s2'); });
    expect(order).toEqual(['s2']);
    gate.resolve();
    await blocked;
    expect(order).toEqual(['s2', 's1']);
  });

  it('a rejected command surfaces to its caller and never blocks the next one', async () => {
    const failing = runSessionTurn('s1', () => { throw new Error('boom'); });
    const next = runSessionTurn('s1', () => 'ran');
    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ran');
  });

  it('reports pending turns only while a command is queued or running, then drops the chain', async () => {
    expect(hasPendingSessionTurns('s1')).toBe(false);
    const gate = deferred();
    const running = runSessionTurn('s1', async () => { await gate.promise; });
    const waiting = runSessionTurn('s1', () => undefined);
    expect(hasPendingSessionTurns('s1')).toBe(true);
    gate.resolve();
    await running;
    // The second command is still on the chain until it settles.
    expect(hasPendingSessionTurns('s1')).toBe(true);
    await waiting;
    expect(hasPendingSessionTurns('s1')).toBe(false);
  });

  it('a command enqueued after the chain drained starts a fresh chain in order', async () => {
    const order: number[] = [];
    await runSessionTurn('s1', () => { order.push(1); });
    expect(hasPendingSessionTurns('s1')).toBe(false);
    const gate = deferred();
    const a = runSessionTurn('s1', async () => { await gate.promise; order.push(2); });
    const b = runSessionTurn('s1', () => { order.push(3); });
    gate.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual([1, 2, 3]);
  });
});
