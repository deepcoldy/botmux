import { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginFinalOutputDelivery } from '../src/core/final-output-delivery-drain.js';
import type { DaemonSession } from '../src/core/types.js';
import { canAutoCloseMessageListenerSession, createMessageListenerAutoCloseScheduler, MESSAGE_LISTENER_CLOSE_DELAY_MS, MESSAGE_LISTENER_DELIVERY_DRAIN_TIMEOUT_MS } from '../src/core/message-listener-auto-close.js';

/** Build an idle listener session with positive, exact-turn completion evidence. */
function session(): DaemonSession {
  return {
    session: { sessionId: 'listener', status: 'active', messageListenerAutoClose: true },
    currentTurnId: 'turn-1',
    currentReplyTarget: { turnId: 'turn-1' },
    messageListenerCompletedTurnId: 'turn-1',
    lastScreenStatus: 'idle',
    worker: null,
  } as DaemonSession;
}

describe('message listener auto-close', () => {
  it('allows only a successfully completed idle listener session', () => {
    expect(canAutoCloseMessageListenerSession(session(), 'turn-1')).toBe(true);
  });

  it.each(['ordinary', 'failed', 'new-turn', 'new-reply', 'working', 'closed', 'attention', 'queued', 'raw-input', 'follow-up', 'initial-start', 'follow-up-input', 'xpi', 'shared-cwd-queue', 'continuation', 'recovery'])(
    'retains a session with %s state', kind => {
      const ds = session();
      if (kind === 'ordinary') ds.session.messageListenerAutoClose = undefined;
      if (kind === 'failed') ds.messageListenerCompletedTurnId = undefined;
      if (kind === 'new-turn') ds.currentTurnId = 'turn-2';
      if (kind === 'new-reply') ds.currentReplyTarget!.turnId = 'turn-2';
      if (kind === 'working') ds.lastScreenStatus = 'working';
      if (kind === 'closed') ds.session.status = 'closed';
      if (kind === 'attention') ds.agentAttention = { kind: 'decision', reason: 'approval', at: 1 };
      if (kind === 'queued') ds.session.queuedActivationPending = true;
      if (kind === 'raw-input') ds.pendingRawInput = 'next';
      if (kind === 'follow-up') ds.pendingFollowUps = ['next'];
      if (kind === 'initial-start') ds.initialStartPending = true;
      if (kind === 'follow-up-input') ds.pendingFollowUpInput = { userPrompt: 'next', cliInput: 'next' };
      if (kind === 'xpi') ds.session.crossPrincipalInterruptions = [{
        version: 1, id: 'xpi', ownerTurnId: 'turn-1', owner: {}, proposer: {}, phase: 'awaiting_owner', messages: [],
      }];
      if (kind === 'shared-cwd-queue') ds.session.xpiSharedCwdQueuedTurns = [{
        version: 1, id: 'queued', turnId: 'turn-2', caller: {}, userPrompt: 'next', cliInput: 'next',
        createdAt: '2026-10-09T00:00:00.000Z', resume: true,
      }];
      if (kind === 'continuation') ds.session.readonlyTaskContinuation = {
        leaseId: 'lease', logicalTurnId: 'turn-1', currentTurnId: 'turn-1', status: 'awaiting_user',
        createdAt: 1, expiresAt: 1000, maxContinuations: 3, continuationsStarted: 0,
      };
      if (kind === 'recovery') ds.session.ordinaryTurnRecovery = {
        logicalTurnId: 'turn-1', currentTurnId: 'turn-1', status: 'backoff', continuationsStarted: 0,
      };
      expect(canAutoCloseMessageListenerSession(ds, 'turn-1')).toBe(false);
    },
  );

  it('allows completed recovery and continuation with empty queues', () => {
    const ds = session();
    ds.session.readonlyTaskContinuation = {
      leaseId: 'lease', logicalTurnId: 'turn-1', currentTurnId: 'turn-1', status: 'completed',
      createdAt: 1, expiresAt: 1000, maxContinuations: 3, continuationsStarted: 0,
    };
    ds.session.ordinaryTurnRecovery = {
      logicalTurnId: 'turn-1', currentTurnId: 'turn-1', status: 'completed', continuationsStarted: 0,
    };
    ds.session.crossPrincipalInterruptions = [];
    ds.session.xpiSharedCwdQueuedTurns = [];
    expect(canAutoCloseMessageListenerSession(ds, 'turn-1')).toBe(true);
  });

  it('does not infer success from idle or unknown lineage after restart', () => {
    const ds = session();
    ds.messageListenerCompletedTurnId = undefined;
    expect(canAutoCloseMessageListenerSession(ds, 'turn-1')).toBe(false);
    ds.messageListenerCompletedTurnId = 'turn-1';
    ds.currentTurnId = undefined;
    expect(canAutoCloseMessageListenerSession(ds, 'turn-1')).toBe(false);
  });
});


describe('listener close scheduling', () => {
  const finishes: Array<() => void> = [];
  afterEach(() => { finishes.splice(0).forEach(finish => finish()); vi.useRealTimers(); });

  /** Register a real pending delivery and guarantee cleanup even when an assertion fails. */
  function pendingDelivery(ds: DaemonSession, turnId = 'turn-1'): () => void {
    const finish = beginFinalOutputDelivery(ds, turnId);
    finishes.push(finish);
    return finish;
  }

  /** Wait on an observed callback rather than a runner-specific microtask flush. */
  function completion(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }

  it('waits outside the mutation gate for slow final delivery', async () => {
    vi.useFakeTimers();
    const ds = session();
    const finish = pendingDelivery(ds);
    const closed = completion();
    const closeCompletedSession = vi.fn(async () => { closed.resolve(); });
    const mutate = vi.fn(async (_ds: DaemonSession, action: () => Promise<void>) => action());
    const schedule = createMessageListenerAutoCloseScheduler({ mutate, isCurrent: () => true, closeCompletedSession, onError: vi.fn() });
    schedule(ds);
    await vi.advanceTimersByTimeAsync(MESSAGE_LISTENER_CLOSE_DELAY_MS + 5_000);
    expect(mutate).not.toHaveBeenCalled();
    finish();
    await closed.promise;
    expect(closeCompletedSession).toHaveBeenCalledOnce();
  });

  it('closes the latest of two quick completed turns without another idle event', async () => {
    vi.useFakeTimers();
    const ds = session();
    const closeCompletedSession = vi.fn(async () => {});
    const schedule = createMessageListenerAutoCloseScheduler({
      mutate: async (_ds, action) => action(), isCurrent: () => true, closeCompletedSession, onError: vi.fn(),
    });
    schedule(ds);
    await vi.advanceTimersByTimeAsync(500);
    ds.currentTurnId = ds.messageListenerCompletedTurnId = 'turn-2';
    ds.currentReplyTarget!.turnId = 'turn-2';
    schedule(ds);
    await vi.advanceTimersByTimeAsync(MESSAGE_LISTENER_CLOSE_DELAY_MS);
    expect(closeCompletedSession).toHaveBeenCalledOnce();
  });


  it('retains the session on delivery timeout, even if the reply arrives later', async () => {
    vi.useFakeTimers();
    const ds = session();
    const finish = pendingDelivery(ds);
    const closeCompletedSession = vi.fn(async () => {});
    const mutate = vi.fn(async (_ds: DaemonSession, action: () => Promise<void>) => action());
    const onError = vi.fn();
    const schedule = createMessageListenerAutoCloseScheduler({ mutate, isCurrent: () => true, closeCompletedSession, onError });
    schedule(ds);
    await vi.advanceTimersByTimeAsync(MESSAGE_LISTENER_CLOSE_DELAY_MS + MESSAGE_LISTENER_DELIVERY_DRAIN_TIMEOUT_MS);
    expect(mutate).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(closeCompletedSession).not.toHaveBeenCalled();
  });

  it('deduplicates repeated idle events without postponing the same completed turn', async () => {
    vi.useFakeTimers();
    const ds = session();
    const closeCompletedSession = vi.fn(async () => {});
    const schedule = createMessageListenerAutoCloseScheduler({
      mutate: async (_ds, action) => action(), isCurrent: () => true, closeCompletedSession, onError: vi.fn(),
    });
    schedule(ds);
    await vi.advanceTimersByTimeAsync(500);
    schedule(ds);
    await vi.advanceTimersByTimeAsync(MESSAGE_LISTENER_CLOSE_DELAY_MS - 500);
    expect(closeCompletedSession).toHaveBeenCalledOnce();
  });

  it('does not let an old delivery drain delete the next turn schedule', async () => {
    vi.useFakeTimers();
    const ds = session();
    const first = pendingDelivery(ds);
    const closed = completion();
    const closeCompletedSession = vi.fn(async () => { closed.resolve(); });
    const schedule = createMessageListenerAutoCloseScheduler({
      mutate: async (_ds, action) => action(), isCurrent: () => true, closeCompletedSession, onError: vi.fn(),
    });
    schedule(ds);
    await vi.advanceTimersByTimeAsync(MESSAGE_LISTENER_CLOSE_DELAY_MS);
    ds.currentTurnId = ds.messageListenerCompletedTurnId = 'turn-2';
    ds.currentReplyTarget!.turnId = 'turn-2';
    const second = pendingDelivery(ds, 'turn-2');
    schedule(ds);
    first();
    await vi.advanceTimersByTimeAsync(MESSAGE_LISTENER_CLOSE_DELAY_MS);
    expect(closeCompletedSession).not.toHaveBeenCalled();
    second();
    await closed.promise;
    expect(closeCompletedSession).toHaveBeenCalledOnce();
  });

  it.each(['new-input', 'worker-replaced', 'pending-admission', 'late-delivery'])(
    'rechecks %s after delivery drains and mutation admission succeeds', async kind => {
      vi.useFakeTimers();
      const ds = session();
      const finish = pendingDelivery(ds);
      const closeCompletedSession = vi.fn(async () => {});
      const mutated = completion();
      let isCurrent = true;
      const schedule = createMessageListenerAutoCloseScheduler({
        mutate: async (_ds, action) => {
          if (kind === 'new-input') ds.pendingFollowUpInput = { userPrompt: 'next', cliInput: 'next' };
          if (kind === 'worker-replaced') ds.worker = new ChildProcess();
          if (kind === 'pending-admission') isCurrent = false;
          if (kind === 'late-delivery') pendingDelivery(ds);
          await action();
          mutated.resolve();
        },
        isCurrent: () => isCurrent, closeCompletedSession, onError: vi.fn(),
      });
      schedule(ds);
      await vi.advanceTimersByTimeAsync(MESSAGE_LISTENER_CLOSE_DELAY_MS);
      finish();
      await mutated.promise;
      expect(closeCompletedSession).not.toHaveBeenCalled();
    },
  );

  it('allows another session to close while one session is still delivering', async () => {
    vi.useFakeTimers();
    const first = session();
    const second = session();
    pendingDelivery(first);
    const closeCompletedSession = vi.fn(async () => {});
    const schedule = createMessageListenerAutoCloseScheduler({
      mutate: async (_ds, action) => action(), isCurrent: () => true, closeCompletedSession, onError: vi.fn(),
    });
    schedule(first);
    schedule(second);
    await vi.advanceTimersByTimeAsync(MESSAGE_LISTENER_CLOSE_DELAY_MS);
    expect(closeCompletedSession).toHaveBeenCalledTimes(1);
    expect(closeCompletedSession).toHaveBeenCalledWith(second);
  });
});
