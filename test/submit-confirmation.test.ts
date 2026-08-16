import { describe, expect, it } from 'vitest';
import {
  decideSubmitConfirmationAction,
  settleDeferredSubmitConfirmation,
  settleStaleWriteContinuation,
} from '../src/services/submit-confirmation.js';
import {
  CodexBridgeQueue,
  pruneExpiredPreStartHeadsAndEmit,
  STRUCTURED_SUBMIT_START_GRACE_MS,
} from '../src/services/codex-bridge-queue.js';

describe('decideSubmitConfirmationAction', () => {
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
