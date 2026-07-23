import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __testOnly_resetBotTurnMutationGates,
  runDetachedBotTurnAdmission,
  runDetachedBotTurnMutation,
  tryWithBotTurnMutation,
  withBotTurnAdmission,
  withBotTurnMutation,
} from '../src/core/bot-turn-mutation-gate.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('per-bot turn mutation gate', () => {
  afterEach(() => {
    vi.useRealTimers();
    __testOnly_resetBotTurnMutationGates();
  });

  it('drains an in-flight admission and blocks new turns through the mutation', async () => {
    const finishFirst = deferred();
    const finishMutation = deferred();
    const firstEntered = vi.fn();
    const mutationEntered = vi.fn();
    const secondEntered = vi.fn();

    const first = withBotTurnAdmission('app-a', async () => {
      firstEntered();
      await finishFirst.promise;
    });
    await vi.waitFor(() => expect(firstEntered).toHaveBeenCalledOnce());

    const mutation = withBotTurnMutation('app-a', async () => {
      mutationEntered();
      await finishMutation.promise;
    });
    await Promise.resolve();
    expect(mutationEntered).not.toHaveBeenCalled();

    const second = withBotTurnAdmission('app-a', () => { secondEntered(); });
    await Promise.resolve();
    expect(secondEntered).not.toHaveBeenCalled();

    finishFirst.resolve();
    await vi.waitFor(() => expect(mutationEntered).toHaveBeenCalledOnce());
    expect(secondEntered).not.toHaveBeenCalled();

    finishMutation.resolve();
    await Promise.all([first, mutation, second]);
    expect(secondEntered).toHaveBeenCalledOnce();
  });

  it('does not serialize an unrelated bot', async () => {
    const finishMutation = deferred();
    const mutation = withBotTurnMutation('app-a', () => finishMutation.promise);
    const other = vi.fn();
    await withBotTurnAdmission('app-b', () => other());
    expect(other).toHaveBeenCalledOnce();
    finishMutation.resolve();
    await mutation;
  });

  it('keeps woken waiters on the canonical state for the next mutation', async () => {
    const finishFirstMutation = deferred();
    const finishQueuedAdmission = deferred();
    const firstMutation = withBotTurnMutation('app-a', () => finishFirstMutation.promise);
    const queuedEntered = vi.fn();
    const queuedAdmission = withBotTurnAdmission('app-a', async () => {
      queuedEntered();
      await finishQueuedAdmission.promise;
    });
    await Promise.resolve();
    expect(queuedEntered).not.toHaveBeenCalled();

    finishFirstMutation.resolve();
    await firstMutation;
    await vi.waitFor(() => expect(queuedEntered).toHaveBeenCalledOnce());

    const nextMutationEntered = vi.fn();
    const nextMutation = withBotTurnMutation('app-a', () => nextMutationEntered());
    await Promise.resolve();
    expect(nextMutationEntered).not.toHaveBeenCalled();

    finishQueuedAdmission.resolve();
    await Promise.all([queuedAdmission, nextMutation]);
    expect(nextMutationEntered).toHaveBeenCalledOnce();
  });

  it('lets a draining admitted handler enter a nested same-bot boundary', async () => {
    const enterNested = deferred();
    const outerEntered = vi.fn();
    const nestedEntered = vi.fn();
    const mutationEntered = vi.fn();
    const outer = withBotTurnAdmission('app-a', async () => {
      outerEntered();
      await enterNested.promise;
      await withBotTurnAdmission('app-a', () => nestedEntered());
    });
    await vi.waitFor(() => expect(outerEntered).toHaveBeenCalledOnce());

    const mutation = withBotTurnMutation('app-a', () => mutationEntered());
    await Promise.resolve();
    expect(mutationEntered).not.toHaveBeenCalled();

    enterNested.resolve();
    await Promise.all([outer, mutation]);
    expect(nestedEntered).toHaveBeenCalledOnce();
    expect(mutationEntered).toHaveBeenCalledOnce();
  });

  it('revokes inherited reentrancy for a detached descendant after the outer lease ends', async () => {
    const releaseDetached = deferred();
    const finishMutation = deferred();
    const detachedEntered = vi.fn();
    let detached!: Promise<void>;

    await withBotTurnAdmission('app-a', async () => {
      detached = (async () => {
        await releaseDetached.promise;
        await withBotTurnAdmission('app-a', () => detachedEntered());
      })();
    });

    const mutation = withBotTurnMutation('app-a', () => finishMutation.promise);
    await Promise.resolve();
    releaseDetached.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(detachedEntered).not.toHaveBeenCalled();

    finishMutation.resolve();
    await Promise.all([mutation, detached]);
    expect(detachedEntered).toHaveBeenCalledOnce();
  });

  it('upgrades an admitted handler to a mutation without self-deadlock', async () => {
    const order: string[] = [];
    await withBotTurnAdmission('app-a', async () => {
      order.push('admission');
      await withBotTurnMutation('app-a', async () => {
        order.push('mutation');
        await withBotTurnAdmission('app-a', () => order.push('nested-admission'));
        await withBotTurnMutation('app-a', () => order.push('nested-mutation'));
      });
      order.push('after');
    });
    expect(order).toEqual([
      'admission',
      'mutation',
      'nested-admission',
      'nested-mutation',
      'after',
    ]);
  });

  it('upgrades through an awaited nested admission without retaining an ancestor count', async () => {
    const events: string[] = [];
    await withBotTurnAdmission('app-a', async () => {
      await withBotTurnAdmission('app-a', async () => {
        await withBotTurnMutation('app-a', () => events.push('mutated'));
      });
      events.push('outer-finished');
    });
    expect(events).toEqual(['mutated', 'outer-finished']);
  });

  it('an upgraded mutation drains peer admissions and blocks later turns', async () => {
    const letPeerFinish = deferred();
    const letCloseFinish = deferred();
    const startUpgrade = deferred();
    const events: string[] = [];

    const closer = withBotTurnAdmission('app-a', async () => {
      events.push('close-admitted');
      await startUpgrade.promise;
      await withBotTurnMutation('app-a', async () => {
        events.push('close-mutating');
        await letCloseFinish.promise;
      });
      events.push('close-after');
    });
    const peer = withBotTurnAdmission('app-a', async () => {
      events.push('peer-admitted');
      await letPeerFinish.promise;
      events.push('peer-finished');
    });
    await vi.waitFor(() => expect(events).toContain('peer-admitted'));

    startUpgrade.resolve();
    await Promise.resolve();
    expect(events).not.toContain('close-mutating');

    letPeerFinish.resolve();
    await vi.waitFor(() => expect(events).toContain('close-mutating'));

    const later = withBotTurnAdmission('app-a', () => events.push('later-admitted'));
    await Promise.resolve();
    expect(events).not.toContain('later-admitted');

    letCloseFinish.resolve();
    await Promise.all([closer, peer, later]);
    expect(events.indexOf('peer-finished')).toBeLessThan(events.indexOf('close-mutating'));
    expect(events.indexOf('close-mutating')).toBeLessThan(events.indexOf('close-after'));
  });

  it('revokes inherited mutation ownership for detached descendants', async () => {
    const releaseDetached = deferred();
    const holdNextMutation = deferred();
    const detachedEntered = vi.fn();
    let detached!: Promise<void>;

    await withBotTurnMutation('app-a', async () => {
      detached = (async () => {
        await releaseDetached.promise;
        await withBotTurnAdmission('app-a', () => detachedEntered());
      })();
    });

    const nextMutation = withBotTurnMutation('app-a', () => holdNextMutation.promise);
    await Promise.resolve();
    releaseDetached.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(detachedEntered).not.toHaveBeenCalled();

    holdNextMutation.resolve();
    await Promise.all([nextMutation, detached]);
    expect(detachedEntered).toHaveBeenCalledOnce();
  });

  it('runs a detached mutation only after its admission parent drains', async () => {
    const releaseDetachedMutation = deferred();
    const detachedEntered = vi.fn();
    let detached!: Promise<void>;

    await withBotTurnAdmission('app-a', () => {
      detached = runDetachedBotTurnMutation('app-a', async () => {
        detachedEntered();
        await releaseDetachedMutation.promise;
      });
      expect(detachedEntered).not.toHaveBeenCalled();
    });
    await vi.waitFor(() => expect(detachedEntered).toHaveBeenCalledOnce());

    releaseDetachedMutation.resolve();
    await detached;

    const laterMutation = vi.fn();
    const laterAdmission = vi.fn();
    await withBotTurnMutation('app-a', () => laterMutation());
    await withBotTurnAdmission('app-a', () => laterAdmission());
    expect(laterMutation).toHaveBeenCalledOnce();
    expect(laterAdmission).toHaveBeenCalledOnce();
  });

  it('counts an explicit detached admission begun before its parent returns', async () => {
    const releaseChild = deferred();
    const childEntered = vi.fn();
    let child!: Promise<void>;

    await withBotTurnAdmission('app-a', () => {
      child = runDetachedBotTurnAdmission('app-a', async () => {
        childEntered();
        await releaseChild.promise;
      });
    });
    expect(childEntered).toHaveBeenCalledOnce();

    const mutationEntered = vi.fn();
    const mutation = withBotTurnMutation('app-a', () => mutationEntered());
    await Promise.resolve();
    expect(mutationEntered).not.toHaveBeenCalled();

    releaseChild.resolve();
    await Promise.all([child, mutation]);
    expect(mutationEntered).toHaveBeenCalledOnce();
  });

  it('clears mutation context for an explicit detached mutation', async () => {
    const releaseChild = deferred();
    const childEntered = vi.fn();
    let child!: Promise<void>;

    const parent = withBotTurnMutation('app-a', () => {
      child = runDetachedBotTurnMutation('app-a', async () => {
        childEntered();
        await releaseChild.promise;
      });
    });
    await parent;
    await vi.waitFor(() => expect(childEntered).toHaveBeenCalledOnce());
    const admissionEntered = vi.fn();
    const admission = withBotTurnAdmission('app-a', () => admissionEntered());
    await Promise.resolve();
    expect(admissionEntered).not.toHaveBeenCalled();

    releaseChild.resolve();
    await Promise.all([child, admission]);
    expect(admissionEntered).toHaveBeenCalledOnce();
  });

  it('keeps an explicit detached admission behind its mutation parent', async () => {
    const holdParent = deferred();
    const detachedEntered = vi.fn();
    let detached!: Promise<void>;
    const parent = withBotTurnMutation('app-a', async () => {
      detached = runDetachedBotTurnAdmission('app-a', () => detachedEntered());
      await Promise.resolve();
      expect(detachedEntered).not.toHaveBeenCalled();
      await holdParent.promise;
    });
    await Promise.resolve();
    holdParent.resolve();
    await parent;
    await detached;
    expect(detachedEntered).toHaveBeenCalledOnce();
  });

  it('removes a bounded waiter on timeout so its action can never run later', async () => {
    const releaseOwner = deferred();
    const ownerEntered = vi.fn();
    const owner = withBotTurnMutation('app-a', async () => {
      ownerEntered();
      await releaseOwner.promise;
    });
    await vi.waitFor(() => expect(ownerEntered).toHaveBeenCalledOnce());

    const staleAction = vi.fn();
    await expect(tryWithBotTurnMutation('app-a', 10, staleAction)).resolves.toEqual({
      acquired: false,
      reason: 'timeout',
    });
    releaseOwner.resolve();
    await owner;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(staleAction).not.toHaveBeenCalled();

    const later = vi.fn();
    await expect(tryWithBotTurnMutation('app-a', 50, later)).resolves.toEqual({
      acquired: true,
      value: undefined,
    });
    expect(later).toHaveBeenCalledOnce();
  });

  it('rejects an overdue wake even when owner release runs before the timer callback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const releaseOwner = deferred();
    const ownerEntered = vi.fn();
    const owner = withBotTurnMutation('app-a', async () => {
      ownerEntered();
      await releaseOwner.promise;
    });
    await Promise.resolve();
    expect(ownerEntered).toHaveBeenCalledOnce();

    const staleAction = vi.fn();
    const bounded = tryWithBotTurnMutation('app-a', 10, staleAction);
    await Promise.resolve();
    // Advance wall time without running the overdue timer. Releasing the owner
    // wakes the waiter first; the wake path itself must enforce the deadline.
    vi.setSystemTime(1_020);
    releaseOwner.resolve();
    await owner;

    await expect(bounded).resolves.toEqual({ acquired: false, reason: 'timeout' });
    expect(staleAction).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(staleAction).not.toHaveBeenCalled();
  });

  it('rolls back a closed gate when admissions do not drain before the deadline', async () => {
    const releaseAdmission = deferred();
    const heldEntered = vi.fn();
    const held = withBotTurnAdmission('app-a', async () => {
      heldEntered();
      await releaseAdmission.promise;
    });
    await vi.waitFor(() => expect(heldEntered).toHaveBeenCalledOnce());

    const mutationAction = vi.fn();
    const bounded = tryWithBotTurnMutation('app-a', 10, mutationAction);
    const admittedAfterRollback = vi.fn();
    const queuedAdmission = withBotTurnAdmission('app-a', admittedAfterRollback);

    await expect(bounded).resolves.toEqual({ acquired: false, reason: 'timeout' });
    await queuedAdmission;
    expect(admittedAfterRollback).toHaveBeenCalledOnce();
    expect(mutationAction).not.toHaveBeenCalled();

    releaseAdmission.resolve();
    await held;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mutationAction).not.toHaveBeenCalled();
  });
});
