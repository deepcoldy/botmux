import { describe, expect, it } from 'bun:test';
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

  it('R5-B4-1: restore preserves codexAppSteerable onto the prepared reservation and surfaces it on settle', () => {
    const queue = new CodexAppTurnDispatchQueue();
    // A replacement worker restores the daemon-frozen prepared prefix. The head
    // was admitted from the plain-human path (steerable), a later peer was not.
    queue.restore([
      { dispatchId: 'd-head', turnId: 'turn-head', codexAppSteerable: true },
      { dispatchId: 'd-next', turnId: 'turn-next' },
    ]);
    // settleFinal (consume:false — the worker's mode) must surface steerable +
    // a remaining successor, so a legitimate superseded head is NOT wrongly
    // rejected at the worker (the exact wedge B4-1 fixes: without this the
    // restored reservation is steerable=false and superseded fails closed).
    const head = queue.settleFinal({ turnId: 'turn-head' }, false);
    expect(head).toMatchObject({ ok: true, turnId: 'turn-head', codexAppSteerable: true, remaining: 1 });
    // A non-steerable restored entry stays forced-serial (flag absent).
    queue.commitExactHead((head as any).handle);
    const next = queue.settleFinal({ turnId: 'turn-next' }, false);
    expect((next as any).codexAppSteerable).toBeUndefined();
    expect((next as any).remaining).toBe(0);
  });
});
