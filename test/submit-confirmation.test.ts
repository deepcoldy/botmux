import { describe, expect, it, vi } from 'vitest';
import { workerSubmitHarness } from './helpers/worker-submit-harness.js';
import {
  combineSubmitCurrentFences,
  decideSubmitConfirmationAction,
  selectSubmitActivityEvidence,
  settleDeferredSubmitConfirmation,
  settleStaleWriteContinuation,
} from '../src/services/submit-confirmation.js';
import {
  CodexBridgeQueue,
  pruneExpiredPreStartHeadsAndEmit,
  STRUCTURED_SUBMIT_START_GRACE_MS,
} from '../src/services/codex-bridge-queue.js';

describe('decideSubmitConfirmationAction', () => {
  it('keeps the worker structured head alive past verification grace after a weak-activity recheck', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = workerSubmitHarness();
    try {
      await h.flush();
      expect(h.scope.cliAdapter.writeInput).toHaveBeenCalledTimes(1);
      expect(h.queue.hasPendingTurn('delivery', 1)).toBe(true);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.settlements[0]).toMatchObject({
        action: { kind: 'suppress-active', evidence: 'pty-output' }, lifecycle: 'confirmed',
      });
      await vi.advanceTimersByTimeAsync(11_000);
      const emit = vi.fn();
      const terminal = vi.fn();
      expect(pruneExpiredPreStartHeadsAndEmit(h.queue, emit, Date.now(), terminal)).toEqual([]);
      expect(h.queue.hasPendingTurn('delivery', 1)).toBe(true);
      expect(terminal).not.toHaveBeenCalled();
      expect(h.scope.emitTurnTerminal).not.toHaveBeenCalled();
    } finally {
      h.submitFailureChains.clear();
      vi.useRealTimers();
    }
  });

  it('skips a late worker adapter recheck once the exact structured head has already expired', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = workerSubmitHarness();
    try {
      await h.flush();
      // A delayed callback can run after the 30s verification grace was pruned.
      vi.setSystemTime(31_000);
      expect(pruneExpiredPreStartHeadsAndEmit(h.queue, vi.fn(), Date.now()).map(t => t.turnId)).toEqual(['delivery']);
      await vi.advanceTimersToNextTimerAsync();
      expect(h.settlements[0]).toEqual({ stale: true, staleReason: 'attempt', lifecycle: 'unchanged' });
      expect(h.recheck).not.toHaveBeenCalled();
      expect(h.scope.persistCliSessionId).not.toHaveBeenCalled();
      expect(h.scope.releaseInputDeliveryQuarantine).not.toHaveBeenCalled();
    } finally {
      h.submitFailureChains.clear();
      vi.useRealTimers();
    }
  });

  it('does not claim a deferred recheck was queued after an early terminal settled its chain', async () => {
    vi.useFakeTimers();
    const h = workerSubmitHarness();
    const identity = { turnId: 'delivery', dispatchAttempt: 1, cliGeneration: 7 };
    try {
      h.submitFailureChains.observeTerminal(identity);
      h.schedule('payload', h.recheck, 'history', 'delivery', undefined, 1, identity, 'failed', true);
      expect(h.submitFailureChains.size()).toBe(0);
      expect(h.scope.log.mock.calls.some(([message]: [string]) => message.includes('recheck queued'))).toBe(false);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(h.recheck).not.toHaveBeenCalled();
    } finally {
      h.submitFailureChains.clear();
      vi.useRealTimers();
    }
  });

  it('notifies immediately when the adapter reports a hard failure reason', () => {
    expect(decideSubmitConfirmationAction({
      failureReason: 'unsupported submit key',
      recheckSubmitted: false,
      usageLimitDetected: false,
      activityEvidence: undefined,
    })).toEqual({ kind: 'notify-hard-failure', reason: 'unsupported submit key' });
  });

  it('suppresses the user warning when submit is unconfirmed but later activity proves the CLI consumed it', () => {
    expect(decideSubmitConfirmationAction({
      recheckSubmitted: false,
      usageLimitDetected: false,
      activityEvidence: 'pty-output',
    })).toEqual({ kind: 'suppress-active', evidence: 'pty-output' });
  });

  it('suppresses the user warning when the deferred recheck eventually confirms the submit', () => {
    expect(decideSubmitConfirmationAction({
      recheckSubmitted: true,
      usageLimitDetected: false,
      activityEvidence: undefined,
    })).toEqual({ kind: 'suppress-confirmed' });
  });

  it('suppresses the user warning when the turn hit a usage limit instead of a stuck input', () => {
    expect(decideSubmitConfirmationAction({
      recheckSubmitted: false,
      usageLimitDetected: true,
      activityEvidence: undefined,
    })).toEqual({ kind: 'suppress-usage-limit' });
  });

  it('notifies when submit is unconfirmed and there is no later activity evidence', () => {
    expect(decideSubmitConfirmationAction({
      recheckSubmitted: false,
      usageLimitDetected: false,
      activityEvidence: undefined,
    })).toEqual({ kind: 'notify-stuck' });
  });

  it('turns deferred active evidence into a bounded lease, then prunes and emits a buffered successor', async () => {
    let now = 0;
    const queue = new CodexBridgeQueue(() => now);
    queue.mark('active-but-no-start', 'first prompt never reached transcript', 0, 7);
    queue.beginSubmitVerification('active-but-no-start', 0, 7);

    const settlement = await settleDeferredSubmitConfirmation(queue, {
      turnId: 'active-but-no-start',
      dispatchAttempt: 7,
      structuredTarget: true,
      recheck: async () => false,
      usageLimitDetected: () => false,
      activityEvidence: () => 'pty-output',
    });
    expect(settlement).toMatchObject({
      action: { kind: 'suppress-active', evidence: 'pty-output' },
      lifecycle: 'confirmed',
    });
    expect(queue.peek()[0]).toMatchObject({
      turnId: 'active-but-no-start',
      dispatchAttempt: 7,
      submitConfirmedAtMs: 0,
    });
    expect(queue.peek()[0]?.submitVerificationStartedAtMs).toBeUndefined();

    now = 19_000;
    queue.mark('real-successor', 'second prompt really ran', now);
    queue.confirmPendingTurn('real-successor', now);
    queue.ingest([
      { kind: 'user', uuid: 'u-real-successor', text: 'second prompt really ran', timestampMs: 19_001 },
      { kind: 'assistant_final', uuid: 'a-real-successor', text: 'second prompt done', timestampMs: 19_002 },
    ]);
    expect(queue.peek().find(turn => turn.turnId === 'real-successor')?.started).toBe(false);

    now = STRUCTURED_SUBMIT_START_GRACE_MS + 1;
    const emitted: Array<{ turnId: string; finalText?: string }> = [];
    const ordering: string[] = [];
    const dropped = pruneExpiredPreStartHeadsAndEmit(queue, () => {
      ordering.push('successor-ready');
      emitted.push(...queue.drainEmittable());
    }, now, turns => {
      for (const turn of turns) {
        ordering.push(`terminal:${turn.turnId}:${turn.dispatchAttempt ?? '-'}`);
      }
    });

    expect(dropped.map(turn => turn.turnId)).toEqual(['active-but-no-start']);
    expect(dropped[0]?.dispatchAttempt).toBe(7);
    expect(ordering).toEqual([
      'terminal:active-but-no-start:7',
      'successor-ready',
    ]);
    expect(emitted).toEqual([
      expect.objectContaining({ turnId: 'real-successor', finalText: 'second prompt done' }),
    ]);
  });

  it('still runs Claude deferred rechecks whose bridge ID is not in the structured queue', async () => {
    const structuredQueue = new CodexBridgeQueue();
    let recheckCalls = 0;

    const settlement = await settleDeferredSubmitConfirmation(structuredQueue, {
      turnId: 'claude-bridge-turn',
      recheck: async () => {
        recheckCalls++;
        return false;
      },
      usageLimitDetected: () => false,
      activityEvidence: () => undefined,
      isCurrent: () => true,
    });

    expect(recheckCalls).toBe(1);
    expect(settlement).toMatchObject({
      stale: false,
      action: { kind: 'notify-stuck' },
      lifecycle: 'unchanged',
    });
  });

  it('does not run or settle a stale attempt-N timer after attempt N+1 replaced it', async () => {
    const queue = new CodexBridgeQueue();
    queue.mark('delivery', 'same durable body', 100, 1);
    queue.beginSubmitVerification('delivery', 110, 1);
    queue.dropPendingTurn('delivery', 1);
    queue.mark('delivery', 'same durable body', 200, 2);
    queue.beginSubmitVerification('delivery', 210, 2);
    let recheckCalls = 0;

    const settlement = await settleDeferredSubmitConfirmation(queue, {
      turnId: 'delivery',
      dispatchAttempt: 1,
      structuredTarget: true,
      recheck: async () => {
        recheckCalls++;
        return { submitted: true, cliSessionId: 'stale-session' };
      },
      usageLimitDetected: () => false,
      activityEvidence: () => 'pty-output',
      isCurrent: () => true,
    });

    expect(settlement).toEqual({
      stale: true,
      staleReason: 'attempt',
      lifecycle: 'unchanged',
    });
    expect(recheckCalls).toBe(0);
    expect(queue.peek()).toEqual([
      expect.objectContaining({
        turnId: 'delivery',
        dispatchAttempt: 2,
        submitVerificationStartedAtMs: 210,
      }),
    ]);
    expect(queue.peek()[0]?.submitConfirmedAtMs).toBeUndefined();
  });

  it('still settles an exact attempt whose native terminal is FIFO-held behind an open predecessor', async () => {
    // Two distinct native turns: the predecessor stays open, the successor
    // already closed. The successor is no longer pending but is not replaced
    // either — its recheck is the only release for an input-delivery hold.
    const queue = new CodexBridgeQueue();
    queue.mark('working', 'working ask', 100);
    queue.mark('capacity', 'correction', 101);
    queue.ingest([
      { uuid: 'u-working', timestampMs: 200, kind: 'user', text: 'working ask', sourceTurnId: 'native-working' },
      { uuid: 'u-capacity', timestampMs: 300, kind: 'user', text: 'correction', sourceTurnId: 'native-capacity' },
      { uuid: 'a-capacity', timestampMs: 400, kind: 'assistant_final', text: 'done', sourceTurnId: 'native-capacity' },
    ]);
    expect(queue.drainEmittable()).toEqual([]);
    expect(queue.hasPendingTurn('capacity')).toBe(false);
    expect(queue.hasTerminalTurn('capacity')).toBe(true);
    let recheckCalls = 0;

    // A missed receipt plus a usage-limit signal (or no activity) would
    // otherwise fail the attempt and drop its already-collected final.
    const settlement = await settleDeferredSubmitConfirmation(queue, {
      turnId: 'capacity',
      structuredTarget: true,
      recheck: async () => { recheckCalls++; return false; },
      usageLimitDetected: () => true,
      activityEvidence: () => undefined,
      isCurrent: () => true,
    });

    expect(recheckCalls).toBe(0);
    expect(settlement).toEqual({
      stale: false,
      action: { kind: 'suppress-active', evidence: 'structured-transcript' },
      lifecycle: 'unchanged',
    });
    expect(queue.hasTerminalTurn('capacity')).toBe(true);
  });

  it('treats an aborted (empty-final) native terminal as the same closed-but-undrained success', async () => {
    // turn_aborted closes the exact attempt with an EMPTY finalText, so a
    // hasTerminalTurn that required non-empty text would silently fall back to
    // the old stale:attempt drop — stranding the quarantine on TraeX and never
    // emitting the abort's terminal. An abort proves the input was received and
    // the turn ran; it is not an "input not submitted" signal.
    const queue = new CodexBridgeQueue();
    queue.mark('working', 'working ask', 100);
    queue.mark('capacity', 'correction', 101);
    queue.ingest([
      { uuid: 'u-working', timestampMs: 200, kind: 'user', text: 'working ask', sourceTurnId: 'native-working' },
      { uuid: 'u-capacity', timestampMs: 300, kind: 'user', text: 'correction', sourceTurnId: 'native-capacity' },
      { uuid: 't-capacity', timestampMs: 400, kind: 'turn_aborted', text: 'interrupted',
        terminalStatus: 'ambiguous', terminalErrorCode: 'structured_turn_aborted',
        sourceTurnId: 'native-capacity' },
    ]);
    expect(queue.drainEmittable()).toEqual([]);
    expect(queue.hasPendingTurn('capacity')).toBe(false);
    // The empty-string final must still count as a terminal (not as pending and
    // not as missing): this is the line a `finalText !== ''` regression breaks.
    expect(queue.hasTerminalTurn('capacity')).toBe(true);
    let recheckCalls = 0;

    const settlement = await settleDeferredSubmitConfirmation(queue, {
      turnId: 'capacity',
      structuredTarget: true,
      recheck: async () => { recheckCalls++; return false; },
      usageLimitDetected: () => true,
      activityEvidence: () => undefined,
      isCurrent: () => true,
    });

    expect(recheckCalls).toBe(0);
    expect(settlement).toEqual({
      stale: false,
      action: { kind: 'suppress-active', evidence: 'structured-transcript' },
      lifecycle: 'unchanged',
    });
    // The aborted turn is retained (empty final + ambiguous status) so the FIFO
    // drain still emits its exact terminal; it is not dropped as a failed mark.
    const aborted = queue.peek().find(turn => turn.turnId === 'capacity')!;
    expect(aborted.finalText).toBe('');
    expect(aborted.terminalStatus).toBe('ambiguous');
    expect(aborted.terminalErrorCode).toBe('structured_turn_aborted');
    expect(queue.hasTerminalTurn('capacity')).toBe(true);
  });

  it('rechecks generation after an awaited callback and returns no stale session side effect', async () => {
    const queue = new CodexBridgeQueue();
    queue.mark('delivery', 'durable body', 100, 1);
    queue.beginSubmitVerification('delivery', 110, 1);
    let current = true;
    let release!: (value: { submitted: true; cliSessionId: string }) => void;
    const recheck = new Promise<{ submitted: true; cliSessionId: string }>(resolve => { release = resolve; });

    const pending = settleDeferredSubmitConfirmation(queue, {
      turnId: 'delivery',
      dispatchAttempt: 1,
      structuredTarget: true,
      recheck: () => recheck,
      usageLimitDetected: () => false,
      activityEvidence: () => undefined,
      isCurrent: () => current,
    });
    await Promise.resolve();
    current = false;
    release({ submitted: true, cliSessionId: 'old-generation-session' });

    const settlement = await pending;
    expect(settlement).toEqual({
      stale: true,
      staleReason: 'generation',
      lifecycle: 'unchanged',
    });
    expect(settlement).not.toHaveProperty('cliSessionId');
    expect(queue.peek()[0]).toMatchObject({
      dispatchAttempt: 1,
      submitVerificationStartedAtMs: 110,
    });
    expect(queue.peek()[0]?.submitConfirmedAtMs).toBeUndefined();
  });
});

describe('selectSubmitActivityEvidence', () => {
  const target = { turnId: 'turn-a', dispatchAttempt: 2 };

  it('prefers exact strong evidence when the same turn also has PTY output', () => {
    expect(selectSubmitActivityEvidence({
      target,
      ptyActive: true,
      structuredTurns: [{ turnId: 'turn-a', dispatchAttempt: 2 }],
      sendMarkers: [],
    })).toBe('structured-transcript');
  });

  it('settles without warning or weak rearm when exact strong evidence accompanies PTY output', async () => {
    const queue = new CodexBridgeQueue();
    queue.mark('turn-a', 'payload', 100, 2);
    queue.beginSubmitVerification('turn-a', 110, 2);
    const evidence = selectSubmitActivityEvidence({
      target,
      ptyActive: true,
      structuredTurns: [{ turnId: 'turn-a', dispatchAttempt: 2 }],
      sendMarkers: [],
    });

    const settlement = await settleDeferredSubmitConfirmation(queue, {
      turnId: 'turn-a',
      dispatchAttempt: 2,
      structuredTarget: true,
      recheck: async () => false,
      usageLimitDetected: () => false,
      activityEvidence: () => evidence,
    });

    expect(settlement).toMatchObject({
      stale: false,
      action: { kind: 'suppress-active', evidence: 'structured-transcript' },
      lifecycle: 'confirmed',
    });
  });

  it('does not use a later turn transcript or send marker as strong evidence for the target', () => {
    expect(selectSubmitActivityEvidence({
      target,
      ptyActive: false,
      structuredTurns: [{ turnId: 'turn-b', dispatchAttempt: 1 }],
      sendMarkers: [{ turnId: 'turn-b', dispatchAttempt: 1 }],
    })).toBeUndefined();
  });

  it('does not let durable attempt N evidence suppress attempt N+1 or vice versa', () => {
    expect(selectSubmitActivityEvidence({
      target,
      ptyActive: false,
      structuredTurns: [{ turnId: 'turn-a', dispatchAttempt: 1 }],
      sendMarkers: [{ turnId: 'turn-a', dispatchAttempt: 1 }],
    })).toBeUndefined();
    expect(selectSubmitActivityEvidence({
      target: { turnId: 'turn-a', dispatchAttempt: 1 },
      ptyActive: false,
      structuredTurns: [{ turnId: 'turn-a', dispatchAttempt: 2 }],
      sendMarkers: [{ turnId: 'turn-a', dispatchAttempt: 2 }],
    })).toBeUndefined();
  });

  it('downgrades legacy unscoped strong signals to bounded PTY-style activity', () => {
    expect(selectSubmitActivityEvidence({
      target,
      ptyActive: false,
      structuredTurns: [{ turnId: 'turn-a' }],
      sendMarkers: [{}],
    })).toBeUndefined();
    expect(selectSubmitActivityEvidence({
      target: undefined,
      ptyActive: true,
      structuredTurns: [{ turnId: 'turn-a', dispatchAttempt: 2 }],
      sendMarkers: [{ turnId: 'turn-a', dispatchAttempt: 2 }],
    })).toBe('pty-output');
  });
});

describe('combineSubmitCurrentFences', () => {
  it('prevents a superseded in-flight callback from mutating replacement lifecycle state', async () => {
    let chainCurrent = true;
    let release!: (value: false) => void;
    const recheck = new Promise<false>(resolve => { release = resolve; });
    const queue = new CodexBridgeQueue(() => 500);
    queue.mark('turn-a', 'payload', 100, 2);
    queue.beginSubmitVerification('turn-a', 110, 2);

    const pending = settleDeferredSubmitConfirmation(queue, {
      turnId: 'turn-a',
      dispatchAttempt: 2,
      structuredTarget: true,
      recheck: () => recheck,
      usageLimitDetected: () => false,
      activityEvidence: () => 'structured-transcript',
      isCurrent: combineSubmitCurrentFences(
        () => chainCurrent,
        () => true,
      ),
    });
    await Promise.resolve();
    chainCurrent = false;
    release(false);
    await pending;

    expect(queue.peek()[0]).toMatchObject({
      turnId: 'turn-a',
      dispatchAttempt: 2,
      submitVerificationStartedAtMs: 110,
      unconfirmedAttributionStartedAtMs: 100,
    });
    expect(queue.peek()[0]?.submitConfirmedAtMs).toBeUndefined();
  });
});

describe('settleStaleWriteContinuation', () => {
  it('leaves a replacement ordinary mark untouched and relies on automatic carryover', () => {
    const replacementQueue = new CodexBridgeQueue();
    replacementQueue.mark('same-ordinary-turn', 'replayed body', 200);
    const terminals: Array<{ turnId: string; attempt: number }> = [];

    const disposition = settleStaleWriteContinuation(
      { turnId: 'same-ordinary-turn' },
      'write_generation_changed',
      (turnId, _errorCode, attempt) => terminals.push({ turnId, attempt }),
    );

    expect(disposition).toBe('ordinary-carryover');
    expect(terminals).toEqual([]);
    expect(replacementQueue.peek()).toEqual([
      expect.objectContaining({ turnId: 'same-ordinary-turn', started: false }),
    ]);
  });

  it('emits an exact ambiguous terminal for a durable stale continuation', () => {
    const terminals: Array<{ turnId: string; errorCode: string; attempt: number }> = [];
    const disposition = settleStaleWriteContinuation(
      { turnId: 'durable-turn', dispatchAttempt: 4 },
      'write_generation_changed',
      (turnId, errorCode, attempt) => terminals.push({ turnId, errorCode, attempt }),
    );

    expect(disposition).toBe('ambiguous-terminal');
    expect(terminals).toEqual([{
      turnId: 'durable-turn',
      errorCode: 'write_generation_changed',
      attempt: 4,
    }]);
  });
});
