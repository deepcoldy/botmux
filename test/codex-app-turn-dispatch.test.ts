import { describe, expect, it } from 'vitest';
import { CodexAppTurnDispatchQueue } from '../src/utils/codex-app-turn-dispatch.js';

describe('CodexAppTurnDispatchQueue', () => {
  it('attributes queued finals to immutable FIFO heads after later writes change worker globals', () => {
    const queue = new CodexAppTurnDispatchQueue();
    queue.reserve('turn-1', 4);
    queue.reserve('turn-2', 9);

    expect(queue.settleFinal({
      turnId: 'turn-1',
      nativeTurnId: 'native-1',
    })).toMatchObject({
      ok: true,
      turnId: 'turn-1',
      dispatchAttempt: 4,
      nativeTurnId: 'native-1',
      remaining: 1,
    });
    expect(queue.settleFinal({ turnId: 'turn-2' })).toMatchObject({
      ok: true,
      turnId: 'turn-2',
      dispatchAttempt: 9,
      remaining: 0,
    });
  });

  it('uses a complete empty final as the exact FIFO boundary', () => {
    const queue = new CodexAppTurnDispatchQueue();
    queue.reserve('empty-turn');
    queue.reserve('next-turn');

    expect(queue.settleFinal({ turnId: 'empty-turn' })).toMatchObject({
      ok: true,
      turnId: 'empty-turn',
      remaining: 1,
    });
    expect(queue.settleFinal({ turnId: 'next-turn' })).toMatchObject({
      ok: true,
      turnId: 'next-turn',
      remaining: 0,
    });
  });

  it('rejects mismatched turn and attempt assertions without advancing the head', () => {
    const queue = new CodexAppTurnDispatchQueue();
    queue.reserve('turn-1', 7);
    queue.reserve('turn-2', 8);

    expect(queue.settleFinal({ turnId: 'turn-2' })).toEqual({
      ok: false,
      reason: 'turn_mismatch',
      markerTurnId: 'turn-2',
      expectedTurnId: 'turn-1',
    });
    expect(queue.settleFinal({ turnId: 'turn-1', dispatchAttempt: 8 })).toEqual({
      ok: false,
      reason: 'dispatch_attempt_mismatch',
      markerDispatchAttempt: 8,
      expectedDispatchAttempt: 7,
    });
    expect(queue.size()).toBe(2);
    expect(queue.settleFinal({ turnId: 'turn-1', dispatchAttempt: 7 })).toMatchObject({
      ok: true,
      turnId: 'turn-1',
      dispatchAttempt: 7,
      remaining: 1,
    });
  });

  it('cancels only the exact failed write and preserves peers in FIFO order', () => {
    const queue = new CodexAppTurnDispatchQueue();
    const first = queue.reserve('turn-1', 1);
    const second = queue.reserve('turn-2', 2);
    const third = queue.reserve('turn-3', 3);

    expect(queue.cancelExact(second.handle)).toBe(true);
    expect(queue.cancelExact(second.handle)).toBe(false);
    expect(queue.settleFinal({ turnId: 'turn-1' })).toMatchObject({
      ok: true,
      turnId: first.turnId,
      remaining: 1,
    });
    expect(queue.settleFinal({ turnId: 'turn-3' })).toMatchObject({
      ok: true,
      turnId: third.turnId,
      remaining: 0,
    });
    // A late adapter rejection after an already-applied final must not emit a
    // second ambiguous/failed terminal for the settled turn.
    expect(queue.cancelExact(first.handle)).toBe(false);
  });

  it('recovers at most one daemon-frozen warm-reattach identity and clears on reset', () => {
    const queue = new CodexAppTurnDispatchQueue();
    expect(queue.recoverWarmReattach(undefined, 3)).toBeUndefined();
    expect(queue.recoverWarmReattach('reattached', 3)).toMatchObject({
      turnId: 'reattached',
      dispatchAttempt: 3,
    });
    expect(queue.recoverWarmReattach('must-not-overwrite', 4)).toBeUndefined();
    expect(queue.settleFinal({ turnId: 'reattached' })).toMatchObject({
      ok: true,
      turnId: 'reattached',
      dispatchAttempt: 3,
    });

    queue.reserve('stale');
    queue.clear();
    expect(queue.size()).toBe(0);
    expect(queue.settleFinal({ turnId: 'stale' })).toEqual({
      ok: false,
      reason: 'no_pending_turn',
    });
  });
});
