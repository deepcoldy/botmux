import { describe, expect, it } from 'vitest';
import {
  appendAcceptedCodexAppDispatch,
  cancelCodexAppDispatch,
  committedCodexAppSequence,
  hasUnsettledCodexAppDispatch,
  prepareCodexAppDispatch,
  retryPreparedCodexAppDispatch,
  retireCodexAppDispatchAfterBackingMissing,
  settleCodexAppDispatch,
  validateCodexAppManagedSendOrigin,
} from '../src/utils/codex-app-dispatch-ledger.js';

describe('Codex App durable dispatch ledger', () => {
  it('preserves frozen payload and settles only the exact prepared FIFO head', () => {
    let ledger = appendAcceptedCodexAppDispatch([], {
      dispatchId: 'dispatch-1',
      turnId: 'turn-1',
      replyTurnId: 'route-1',
      deliverySink: 'http_wait',
      content: 'frozen content',
      codexAppInput: { text: 'clean content' },
    });
    ledger = appendAcceptedCodexAppDispatch(ledger, {
      dispatchId: 'dispatch-2',
      turnId: 'turn-2',
      content: 'next content',
    });

    const first = prepareCodexAppDispatch(ledger, {
      dispatchId: 'dispatch-1', turnId: 'turn-1',
    });
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) return;
    expect(first.ledger[0]).toMatchObject({
      state: 'prepared',
      replyTurnId: 'route-1',
      deliverySink: 'http_wait',
      content: 'frozen content',
      codexAppInput: { text: 'clean content' },
    });

    const settled = settleCodexAppDispatch(
      first.ledger,
      [],
      { dispatchId: 'dispatch-1', turnId: 'turn-1' },
      'generation-1',
      7,
    );
    expect(settled).toMatchObject({ ok: true });
    if (!settled.ok) return;
    expect(settled.ledger.map(entry => entry.dispatchId)).toEqual(['dispatch-2']);
    expect(committedCodexAppSequence(settled.commits, 'generation-1', 7)).toBe(true);
  });

  it('treats every accepted or prepared entry as unsettled lifecycle ownership', () => {
    expect(hasUnsettledCodexAppDispatch(undefined)).toBe(false);
    expect(hasUnsettledCodexAppDispatch([])).toBe(false);
    expect(hasUnsettledCodexAppDispatch([
      { dispatchId: 'd1', turnId: 't1', state: 'accepted', content: 'one' },
    ])).toBe(true);
    expect(hasUnsettledCodexAppDispatch([
      { dispatchId: 'd1', turnId: 't1', state: 'prepared', content: 'one' },
    ])).toBe(true);
  });

  it('authorizes host relay only for the exact live Lark-bound Codex App entry', () => {
    const ledger = [{
      dispatchId: 'd1', turnId: 't1', dispatchAttempt: 3,
      state: 'prepared' as const, content: 'one', deliverySink: 'lark' as const,
    }];
    expect(validateCodexAppManagedSendOrigin(
      ledger,
      { turnId: 't1', dispatchAttempt: 3 },
      true,
    )).toEqual({ ok: true, requiresLedger: true });
    expect(validateCodexAppManagedSendOrigin(
      ledger,
      { turnId: 't1', dispatchAttempt: 4 },
      true,
    )).toMatchObject({ ok: false });
    expect(validateCodexAppManagedSendOrigin([
      ...ledger,
      { ...ledger[0]!, dispatchId: 'd2' },
    ], { turnId: 't1', dispatchAttempt: 3 }, true)).toEqual({
      ok: false,
      error: '2 Codex App ledger entries match the live relay origin',
    });
  });

  it('rejects a Codex App capability when settlement removed the ledger before relay admission', () => {
    expect(validateCodexAppManagedSendOrigin(
      [],
      { turnId: 't1', dispatchAttempt: 3 },
      true,
    )).toEqual({
      ok: false,
      error: '0 Codex App ledger entries match the live relay origin',
    });
    // A non-Codex managed receiver may legitimately carry a dispatch attempt
    // without owning the Codex ledger; do not blanket-block that path.
    expect(validateCodexAppManagedSendOrigin(
      [],
      { turnId: 'vc-turn', dispatchAttempt: 3 },
      false,
    )).toEqual({ ok: true, requiresLedger: false });
  });

  it('rejects Codex App host sends bound to non-Lark sinks', () => {
    for (const deliverySink of ['http_wait', 'http_async', 'suppressed'] as const) {
      expect(validateCodexAppManagedSendOrigin([{
        dispatchId: 'd1', turnId: 't1', state: 'prepared', content: 'one', deliverySink,
      }], { turnId: 't1' }, true)).toEqual({
        ok: false,
        error: `Codex App output is bound to ${deliverySink}`,
      });
    }
  });

  it('does not cancel a predecessor while a prepared successor exists', () => {
    const ledger = [
      { dispatchId: 'd1', turnId: 't1', state: 'prepared' as const, content: 'one' },
      { dispatchId: 'd2', turnId: 't2', state: 'prepared' as const, content: 'two' },
    ];
    expect(cancelCodexAppDispatch(ledger, { dispatchId: 'd1', turnId: 't1' }))
      .toEqual({ ok: false, error: 'prepared_successor_exists' });
  });

  it('returns an exactly untouched queued activation from prepared to accepted without losing its token', () => {
    const ledger = [{
      dispatchId: 'activation-dispatch',
      turnId: 'activation-turn',
      dispatchAttempt: 2,
      state: 'prepared' as const,
      content: 'exact queued opening',
      queuedActivationToken: 'activation-token',
    }];
    expect(retryPreparedCodexAppDispatch(ledger, {
      dispatchId: 'activation-dispatch',
      turnId: 'activation-turn',
      dispatchAttempt: 2,
    })).toEqual({
      ok: true,
      ledger: [{ ...ledger[0], state: 'accepted' }],
    });
  });

  it('refuses a prepared retry when a prepared successor could overtake it', () => {
    const ledger = [
      { dispatchId: 'activation', turnId: 't1', state: 'prepared' as const, content: 'one' },
      { dispatchId: 'successor', turnId: 't2', state: 'prepared' as const, content: 'two' },
    ];
    expect(retryPreparedCodexAppDispatch(ledger, {
      dispatchId: 'activation', turnId: 't1',
    })).toEqual({ ok: false, error: 'prepared_successor_exists' });
  });

  it.each(['accepted', 'prepared'] as const)(
    'retires an exact %s crashed delivery after backing-missing proof without dropping its successor',
    state => {
      const ledger = [
        {
          dispatchId: 'old-dispatch', turnId: 'delivery-old', dispatchAttempt: 3,
          state, content: 'old',
        },
        {
          dispatchId: 'successor', turnId: 'ordinary-successor',
          state: 'prepared' as const, content: 'new',
        },
      ];
      expect(retireCodexAppDispatchAfterBackingMissing(ledger, 'delivery-old', 3))
        .toEqual({ ok: true, ledger: [ledger[1]] });
    },
  );

  it('keeps exact crash retirement idempotent and fails closed on ambiguous receipt identity', () => {
    expect(retireCodexAppDispatchAfterBackingMissing([], 'delivery-old', 3))
      .toEqual({ ok: true, ledger: [] });
    const ambiguous = [
      { dispatchId: 'd1', turnId: 'delivery-old', dispatchAttempt: 3, state: 'accepted' as const, content: 'one' },
      { dispatchId: 'd2', turnId: 'delivery-old', dispatchAttempt: 3, state: 'prepared' as const, content: 'two' },
    ];
    expect(retireCodexAppDispatchAfterBackingMissing(ambiguous, 'delivery-old', 3))
      .toEqual({ ok: false, error: 'dispatch_identity_ambiguous' });
    for (const conflictingAttempt of [2, undefined]) {
      const conflict = [{
        dispatchId: 'old', turnId: 'delivery-old', dispatchAttempt: conflictingAttempt,
        state: 'accepted' as const, content: 'old',
      }];
      expect(retireCodexAppDispatchAfterBackingMissing(conflict, 'delivery-old', 3))
        .toEqual({ ok: false, error: 'dispatch_attempt_conflict' });
    }

    const duplicateDispatchId = [
      { dispatchId: 'same', turnId: 'delivery-old', dispatchAttempt: 3, state: 'accepted' as const, content: 'old' },
      { dispatchId: 'same', turnId: 'unrelated', state: 'prepared' as const, content: 'new' },
    ];
    expect(retireCodexAppDispatchAfterBackingMissing(duplicateDispatchId, 'delivery-old', 3))
      .toEqual({ ok: true, ledger: [duplicateDispatchId[1]] });
  });
});
